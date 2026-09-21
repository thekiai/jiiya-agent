/**
 * 主人との会話（DM）。主人が何を言っているかは LLM が文脈で判断し、実行はツール（ハーネス）で行う。
 * 相手側のループと同じ構造。ルールで仕分けしない。
 */
import type { ToolDef, ChatMessage, LlmClient } from "../llm/client.js";
import { config } from "../config.js";
import { ownerName, type Character } from "../characters/schema.js";
import type { PendingRow, MessageRow } from "../store/db.js";
import { toneFor } from "./prompt.js";

export type OwnerAction =
  | { kind: "answer"; pendingId: number; answer: string }
  | { kind: "revise"; pendingId: number; instruction: string }
  | { kind: "send"; pendingId: number }
  | { kind: "skip"; pendingId: number }
  | { kind: "draft"; pendingId: number }
  | { kind: "take_over"; instruction?: string }
  | { kind: "announce"; request: string }
  | { kind: "chat"; text: string };

export const OWNER_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "answer",
      description: "主人が、開いている質問（kind=ask）に答えた。answer はそのまま相手への返信の材料になる。",
      parameters: {
        type: "object",
        properties: { pending_id: { type: "number" }, answer: { type: "string", description: "主人の答え。言い換えず、要点だけ" } },
        required: ["pending_id", "answer"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "revise",
      description: "主人が、確認中の文面（kind=approve）に修正を求めた。",
      parameters: {
        type: "object",
        properties: { pending_id: { type: "number" }, instruction: { type: "string", description: "修正指示。主人の言葉のまま" } },
        required: ["pending_id", "instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send",
      description: "主人が、確認中の文面（kind=approve）をそのまま送ってよいと言った（「送って」「OK」「それでいい」）。",
      parameters: { type: "object", properties: { pending_id: { type: "number" } }, required: ["pending_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "skip",
      description: "主人が、確認中の文面を送らない・その件はもういい、と言った。",
      parameters: { type: "object", properties: { pending_id: { type: "number" } }, required: ["pending_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "draft",
      description: "主人が、引き継ぎ案件（kind=handoff）について「何て返せばいい」「文案を作って」と求めた。主人の名前で送る文案を用意する。",
      parameters: { type: "object", properties: { pending_id: { type: "number" } }, required: ["pending_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "take_over",
      description:
        "主人が共有してきたメッセージについて、返し方を求めた（「何て返せばいい」「任せた」「返しておいて」「対応して」）。じいやが文案を作って主人に見せる（勝手に送らない）。instruction があれば、それを主人の答えとして伝聞で返す（「了解ですって返して」「来週なら空いてると伝えて」）。共有メッセージが無いときは使わない。",
      parameters: { type: "object", properties: { instruction: { type: "string", description: "主人が指定した返し方・内容。無ければ空" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "announce",
      description: "主人が、チャンネルのみんなに何かを伝えてほしいと言った（「〜って伝えて」「みんなに周知して」）。",
      parameters: { type: "object", properties: { request: { type: "string", description: "伝える内容。主人の言葉のまま" } }, required: ["request"] },
    },
  },
];

export interface SharedRef {
  text: string;
  author: string;
  ts: string;
  channel: string;
  url: string;
}

function matchesShared(p: PendingRow, s: SharedRef | undefined): boolean {
  if (!s) return false;
  return (!!s.url && p.permalink === s.url) || (!!s.ts && (p.mention_ts === s.ts || p.thread_ts === s.ts));
}

function describePending(p: PendingRow, shared?: SharedRef): string {
  const kind = p.kind === "ask" ? "質問" : p.kind === "approve" ? "文面確認" : "引き継ぎ（じいやは何も返していない）";
  const body = p.kind === "ask" ? `質問: ${p.question ?? ""}` : p.kind === "approve" ? `文面案: ${p.draft ?? ""}` : `引き継いだ理由: ${p.question ?? ""}`;
  const age = Math.round((Date.now() - p.created_at) / 60_000);
  const mark = matchesShared(p, shared) ? " ← 主人が今共有したメッセージの件" : "";
  return `- id=${p.id} [${kind}] 相手: ${p.counterpart} / 相手の発言: 「${p.incoming.slice(0, 60)}」 / ${body} （${age}分前）${mark}`;
}

export function ownerSystemPrompt(ch: Character, open: PendingRow[], shared?: SharedRef): string {
  const list = open.length > 0 ? open.map((p) => describePending(p, shared)).join("\n") : "（なし）";
  return `あなたは「${ch.name}」${ch.emoji}、${ownerName(ch)} の${ch.role_label}。今は主人本人と DM で話している。
主人の発言が、開いている件のどれについてか（あるいはどれでもないか）を文脈から判断し、該当するツールを呼ぶ。

## 開いている件
${list}

## 判断の指針
- 主人の発言が、開いている質問への答えなら answer。文面確認への修正なら revise。
- send は「送って」「OK」「それでいい」のように、文面そのものを承認する発言だけ。内容を述べている発言（「いい感じです」「今週中に終わる」「税別」）は質問への answer。
- skip は「やめて」「送らないで」「その件はもういい」。
- 引き継ぎ案件について「何て返せばいい」「文案作って」なら draft。
- 「〜って伝えて」「周知して」など、みんなへの連絡なら announce。
- 主人がメッセージを共有してきたら、← 印の付いた件だけが対象。印の無い件をその共有に結びつけない。
  - 印が無ければ、共有メッセージへの対応を求めている発言はすべて take_over（文案を作って主人に見せる。勝手には送らない）。決まった言い回しはない。「これどうしよ」「頼む」「いい感じに」「返しといて」「何て返す？」などどんな表現でも、意図がそうなら take_over。返し方の内容を指定していれば instruction に入れる。
- 新しい件ほど主人の頭にある可能性が高い。ただし内容が明らかに古い件のものなら古い方。
- どの件か決められないとき、あるいは世間話・お礼・確認のときは、ツールを呼ばずに主人へ返事を書く。1〜2文だけ。開いている件を毎回催促しない。曖昧なら「〜の件でございますか」と1文で聞き返す。
- 主人の言葉を勝手に膨らませない。answer / instruction / request は主人の言葉のまま短く。

## 喋り方
${toneFor(ch, "human")}
- 主人は「${ownerName(ch)}」と呼ぶ。「ご主人さま」とは呼ばない。簡潔に。`;
}

export async function runOwnerAgent(llm: LlmClient, ch: Character, open: PendingRow[], history: MessageRow[], text: string, shared?: SharedRef): Promise<OwnerAction> {
  const messages: ChatMessage[] = [{ role: "system", content: ownerSystemPrompt(ch, open, shared) }];
  for (const h of history) messages.push({ role: h.role, content: h.content });
  const userText = shared ? `${text}\n\n[主人が共有したメッセージ] ${shared.author || "相手"}: 「${shared.text}」` : text;
  messages.push({ role: "user", content: userText });
  // 共有メッセージが無いときは take_over を渡さない（選びようをなくす）
  const tools = shared ? OWNER_TOOLS : OWNER_TOOLS.filter((t) => !("function" in t && t.function.name === "take_over"));
  const r = await llm.chat({ model: config.models.main, messages, tools, tag: `${ch.id}:owner`, temperature: 0.2 });
  const call = r.toolCalls[0];
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (!call) return { kind: "chat", text: r.text || "かしこまりました。" };
  const id = num(call.args.pending_id);
  const target = open.find((p) => p.id === id);
  // 共有メッセージがあるのに、それに該当しない件を指したら、その件は触らず相談に切り替える
  if (shared && target && !matchesShared(target, shared) && ["answer", "revise", "send", "skip", "draft"].includes(call.name)) {
    return { kind: "take_over" }; // 共有された件は手元に無い → 文案を作って見せる
  }
  const valid = (k: PendingRow["kind"]) => open.some((p) => p.id === id && p.kind === k);
  switch (call.name) {
    case "answer":
      return valid("ask") ? { kind: "answer", pendingId: id, answer: str(call.args.answer) || text } : { kind: "chat", text: "どの件へのお答えでございましょうか。" };
    case "revise":
      return valid("approve") ? { kind: "revise", pendingId: id, instruction: str(call.args.instruction) || text } : { kind: "chat", text: "どの文面のことでございましょうか。" };
    case "send":
      return valid("approve") ? { kind: "send", pendingId: id } : { kind: "chat", text: "お送りする文面が見当たりませんでした。" };
    case "skip":
      return valid("approve") || valid("ask") ? { kind: "skip", pendingId: id } : { kind: "chat", text: "取り下げる件が見当たりませんでした。" };
    case "draft":
      return open.some((p) => p.id === id) ? { kind: "draft", pendingId: id } : { kind: "chat", text: "どの件の文案でございましょうか。" };
    case "take_over":
      return shared ? { kind: "take_over", ...(str(call.args.instruction) ? { instruction: str(call.args.instruction) } : {}) } : { kind: "chat", text: "どのメッセージのことでございましょう。共有していただければ対応いたします。" };
    case "announce":
      return { kind: "announce", request: str(call.args.request) || text };
    default:
      return { kind: "chat", text: r.text || "かしこまりました。" };
  }
}
