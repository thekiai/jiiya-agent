/**
 * じいやのエージェントループ。
 * LLM は「どのツールを使うか」と「文章」を決める。候補の計算・ラベル・終了判定はハーネス側。
 */
import { findSlots, formatSlot, isSlotAllowed, type Slot } from "../calendar/rules.js";
import { decideLabel, withLabel, type TraceEntry } from "../harness/labels.js";
import { wrapIncoming } from "../harness/sanitize.js";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { config } from "../config.js";
import { systemPrompt } from "./prompt.js";
import { TOOLS } from "./tools.js";
import type { AgentContext, AgentResult } from "./types.js";
import { claimsCalendarAction, parseAskOptions } from "./options.js";

type ToolOutcome = { terminal: true; value: AgentResult } | { terminal: false; content: string };

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function numArr(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
}

export async function runAgent(llm: LlmClient, ctx: AgentContext): Promise<AgentResult> {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(ctx.owner, ctx.senderKind, ctx.now) }];
  for (const h of ctx.history) {
    // スレッド履歴は相手のじいやとも共有している。自分以外の発言は全部「相手側」として渡す
    if (h.role === "assistant" && h.sender !== ctx.owner.name) messages.push({ role: "user", content: `${h.sender}: ${h.content}` });
    else messages.push({ role: h.role, content: h.content });
  }
  if (ctx.proposedSlots && ctx.proposedSlots.length > 0) {
    const tz = ctx.owner.calendar.timezone;
    const list = ctx.proposedSlots.map((s) => `id=${s.id}: ${formatSlot(s, tz)}`).join(" / ");
    messages.push({ role: "system", content: `提示済みの候補: ${list}。相手がこの中から選んだら book_slot を呼ぶ。` });
  }
  messages.push({ role: "user", content: wrapIncoming(ctx.incoming, ctx.sender) });
  const trace: TraceEntry[] = [];
  let slots: Slot[] = ctx.proposedSlots ?? [];
  let errors = 0;

  for (let turn = 0; turn < config.maxTurns; turn++) {
    let resp;
    try {
      resp = await llm.chat({ messages, model: config.models.main, tools: TOOLS, tag: `${ctx.owner.id}:loop` });
    } catch (e) {
      errors += 1;
      if (errors >= 2) return { kind: "pending", pendingKind: "handoff", reason: `LLMエラーが続いたため: ${String(e)}` };
      continue;
    }

    if (resp.toolCalls.length === 0) {
      if (claimsCalendarAction(resp.text) && !trace.some((t) => t.name === "create_event")) {
        // やっていないこと（予定の作成・変更）を書こうとした → 出さずに本人へ
        return { kind: "pending", pendingKind: "handoff", reason: `予定を入れた・動かしたと書こうとしましたが、実際にはしていません: 「${resp.text.slice(0, 60)}」` };
      }
      const label = decideLabel(trace);
      // 根拠（カレンダー）のない自由文は、本人が見てから送る
      return { kind: "reply", text: withLabel(resp.text, label), label, needsApproval: label === "" };
    }

    messages.push(resp.assistantMessage);
    for (const call of resp.toolCalls) {
      const outcome = await runTool(call.name, call.args, ctx, slots, (s) => (slots = s));
      trace.push({ name: call.name, args: call.args, result: outcome.terminal ? outcome.value.kind : outcome.content });
      if (outcome.terminal) return outcome.value;
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
    }
  }
  return { kind: "pending", pendingKind: "handoff", reason: "判断がまとまらなかったため（ターン上限）" };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
  slots: Slot[],
  setSlots: (s: Slot[]) => void,
): Promise<ToolOutcome> {
  const tz = ctx.owner.calendar.timezone;
  switch (name) {
    case "get_free_slots": {
      const rangeDays = num(args.range_days, 7);
      const fromDays = num(args.earliest_days_from_now, 0);
      const from = new Date(ctx.now.getTime() + fromDays * 86_400_000);
      const to = new Date(from.getTime() + rangeDays * 86_400_000);
      const busy = await ctx.calendar.busy(ctx.owner, from, to);
      const found = findSlots({
        rules: ctx.owner.calendar,
        busy,
        from,
        to,
        ...(typeof args.duration_min === "number" ? { durationMin: args.duration_min } : {}),
        count: Math.max(ctx.owner.calendar.propose_count, 3),
      });
      setSlots(found);
      if (found.length === 0) return { terminal: false, content: "空き候補なし。ask_owner で本人に聞くこと。" };
      return { terminal: false, content: found.map((s) => `id=${s.id}: ${formatSlot(s, tz)}`).join("\n") };
    }
    case "check_slot": {
      const start = new Date(str(args.start));
      if (Number.isNaN(start.getTime())) return { terminal: false, content: "start が日時として読めません（ISO 8601 で）" };
      const durationMin = num(args.duration_min, ctx.owner.calendar.default_duration_min);
      const end = new Date(start.getTime() + durationMin * 60_000);
      const busy = await ctx.calendar.busy(ctx.owner, new Date(start.getTime() - 86_400_000), new Date(end.getTime() + 86_400_000));
      const reason = isSlotAllowed(ctx.owner.calendar, busy, { start, end });
      if (reason) return { terminal: false, content: `${formatSlot({ start, end }, tz)} は不可（${reason}）` };
      const id = slots.length > 0 ? Math.max(...slots.map((s) => s.id)) + 1 : 100;
      setSlots([...slots, { id, start, end }]);
      return { terminal: false, content: `id=${id}: ${formatSlot({ start, end }, tz)} は空き。book_slot で入れられる` };
    }
    case "propose_slots": {
      const ids = numArr(args.slot_ids);
      const chosen = slots.filter((s) => ids.includes(s.id)).slice(0, ctx.owner.calendar.propose_count);
      if (chosen.length === 0) return { terminal: false, content: "指定された候補がありません。get_free_slots の id を使ってください。" };
      const slotsText = chosen.map((s) => formatSlot(s, tz)).join("か");
      const raw = str(args.message, "");
      // 「動かした」など、していないことを書いていたら文面はテンプレに差し替える
      const template = !raw || claimsCalendarAction(raw) ? ctx.owner.phrases.propose_text : raw;
      const message = template.replace("{slots}", slotsText);
      const trace: TraceEntry[] = [{ name: "propose_slots", args, result: "ok" }];
      const label = decideLabel(trace);
      return { terminal: true, value: { kind: "schedule", text: withLabel(message, label), slots: chosen, label } };
    }
    case "book_slot": {
      const id = num(args.slot_id, -1);
      const slot = slots.find((s) => s.id === id);
      if (!slot) return { terminal: false, content: "その候補はありません。提示済みの候補の id を使ってください。" };
      const title = str(args.title, `${ctx.sender}と打ち合わせ`);
      if (ctx.owner.calendar.confirm) {
        // 慎重モード: 登録は主人の承認後。ここでは「入れたい」だけ返す
        const label = decideLabel([{ name: "check_slot", args, result: "ok" }]);
        return { terminal: true, value: { kind: "book_request", text: withLabel(str(args.message, "予定入れました！"), label), slot, title, label } };
      }
      const ev = await ctx.calendar.createEvent(ctx.owner, slot, title, ctx.counterpartEmail ? [ctx.counterpartEmail] : []);
      const trace: TraceEntry[] = [{ name: "create_event", args, result: ev.id }];
      const label = decideLabel(trace);
      return { terminal: true, value: { kind: "booked", text: withLabel(str(args.message, "予定入れました！"), label), slot, label, eventId: ev.id } };
    }
    case "ask_owner":
      return { terminal: true, value: { kind: "pending", pendingKind: "ask", question: str(args.question), options: parseAskOptions(args.options) } };
    case "request_approval":
      return { terminal: true, value: { kind: "pending", pendingKind: "approve", draft: str(args.draft) } };
    case "hand_off":
      return { terminal: true, value: { kind: "pending", pendingKind: "handoff", reason: str(args.reason) } };
    default:
      return { terminal: false, content: `unknown tool: ${name}` };
  }
}
