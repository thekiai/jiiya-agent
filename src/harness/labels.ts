/**
 * ラベルは LLM の出力ではなく、実際に何が起きたか（trace）からハーネスが決める。
 * じいやが本人に確認せずに返したときだけ付く。
 */
export interface TraceEntry {
  name: string;
  args: unknown;
  result: unknown;
}

export const LABEL_CALENDAR = "（カレンダー確認）";
export const LABEL_SELF = "（じいや判断）"; // MVP外。将来「自分で答える」用

const CALENDAR_TOOLS = new Set(["get_free_slots", "check_slot", "propose_slots", "create_event"]);

export function decideLabel(trace: readonly TraceEntry[]): string {
  if (trace.some((t) => CALENDAR_TOOLS.has(t.name))) return LABEL_CALENDAR;
  return ""; // 本人が答えた／承認した
}

/** LLM が本文にラベルを自称で書いてきたら消す。付けるのはハーネスだけ。 */
export function stripSelfClaimedLabels(text: string): string {
  return text
    .replace(/[（(]\s*(カレンダー確認|じいや判断|本人確認済み|本人未確認)\s*[)）]/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

export function withLabel(text: string, label: string): string {
  const body = stripSelfClaimedLabels(text);
  return label ? `${body} ${label}` : body;
}
