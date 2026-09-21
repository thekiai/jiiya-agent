/**
 * 本人へのDMの Block Kit。pending 1件ごとに「元メッセージのリンク → 質問 → ボタン」。
 * action_id の形式:
 *   ans:<pendingId>:<optionIndex>   本人が選択肢を押した
 *   apv:<pendingId>:send|edit|skip  承認
 *   hnd:<pendingId>:draft|self      引っ込んだ件の文案
 */
import type { KnownBlock } from "@slack/types";
import type { Character } from "../characters/schema.js";
import type { PendingRow } from "../store/db.js";
import { say } from "../characters/schema.js";
import { parseAskOptions, type AskOption } from "../agent/options.js";

function parseOptions(p: PendingRow): AskOption[] {
  try {
    return parseAskOptions(JSON.parse(p.options_json ?? "[]"));
  } catch {
    return [];
  }
}

/**
 * pressed を渡すと、ボタン行を「✅ *押したやつ* ・ 他の選択肢」のグレー文字に置き換える
 * （質問・文面・選択肢は残す＝あとで何を選んだか追える。Slack にボタンの disabled は無い）
 */
export interface PendingView {
  head: string; // 1行目（「〇〇さまよりお尋ねがございました」など）
  pressed?: string; // 押したボタン。ボタン行を「✅ 押したやつ ・ 他」に置き換える
  note?: string; // pressed の下に添える1行
}

/**
 * 本人へのDM 1件分。見出し（＋スレッドへのリンク）→ 質問 or 文面 → ボタン。
 * 元メッセージは Slack のリンク展開カードで見せる（自前の引用は出さない）。
 */
export function pendingBlocks(ch: Character, p: PendingRow, view: PendingView): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  const open = p.permalink ? `  <${p.permalink}|スレッド ↗>` : "";
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `${view.head}${open}` } });

  if (p.kind === "ask") {
    const options = parseOptions(p);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${p.question ?? ""}*` } });
    if (options.length > 0) {
      blocks.push({
        type: "actions",
        elements: options.map((o, i) => ({
          type: "button",
          text: { type: "plain_text", text: o.label },
          action_id: `ans:${p.id}:${i}`,
          value: o.action, // 押した後に何をするかはこのタグで決まる（LLM に再解釈させない）
        })),
      });
    } else {
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: say(ch, "freeform_hint") }] });
    }
  } else if (p.kind === "approve") {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${say(ch, "approve_hint")}\n> ${(p.draft ?? "").replace(/\n/g, "\n> ")}` } });
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "送る" }, style: "primary", action_id: `apv:${p.id}:send`, value: "send" },
        { type: "button", text: { type: "plain_text", text: "直して送る" }, action_id: `apv:${p.id}:edit`, value: "edit" },
        { type: "button", text: { type: "plain_text", text: "送らない" }, action_id: `apv:${p.id}:skip`, value: "skip" },
      ],
    });
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: say(ch, "handoff_hint", { reason: p.question ?? "理由なし" }) } });
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "文案を見る" }, action_id: `hnd:${p.id}:draft`, value: "draft" },
        { type: "button", text: { type: "plain_text", text: "自分で書く" }, style: "primary", action_id: `hnd:${p.id}:self`, value: "self" },
      ],
    });
  }
  if (view.pressed !== undefined) {
    const i = blocks.findIndex((b) => b.type === "actions");
    const labels = i >= 0 ? buttonLabels(blocks[i]!) : [];
    const doneBlock = pressedBlock(labels, view.pressed);
    if (i >= 0) blocks.splice(i, 1, doneBlock);
    else blocks.push(doneBlock);
    if (view.note) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: view.note }] });
  }
  return blocks;
}

export function buttonLabels(block: KnownBlock): string[] {
  if (block.type !== "actions") return [];
  return block.elements.flatMap((e) => (e.type === "button" ? [e.text.text] : []));
}

/** ボタン行の代わり。押したものだけ ✅ 太字、他はグレーの文字 */
export function pressedBlock(labels: string[], pressed: string): KnownBlock {
  const parts = labels.length > 0 ? labels : [pressed];
  const text = parts.map((l) => (l === pressed ? `✅ *${l}*` : l)).join("   ·   ");
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

