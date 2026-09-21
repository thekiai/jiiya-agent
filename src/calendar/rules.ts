/**
 * 空き候補の計算。LLM は関与しない。
 * 入力: busy 区間（カレンダー由来）とルール（YAML）。出力: 候補スロット（早い順）。
 * タイムゾーンは常に本人の tz（Asia/Tokyo）で考える。
 */
import type { CalendarRules } from "../characters/schema.js";

export interface Interval {
  start: Date;
  end: Date;
}

export interface Slot extends Interval {
  id: number;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** tz でのローカル時刻の各部を取る。 */
function partsIn(tz: string, d: Date): { y: number; m: number; day: number; h: number; min: number; wd: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(d)) p[type] = value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    day: Number(p.day),
    h: Number(p.hour),
    min: Number(p.minute),
    wd: DAY_NAMES.indexOf(p.weekday as (typeof DAY_NAMES)[number]),
  };
}

/** tz の y-m-d HH:MM を UTC Date に。 */
export function zonedDate(tz: string, y: number, m: number, day: number, h: number, min: number): Date {
  // 一旦 UTC として作り、tz でのズレを補正する（DST のない JST 前提でも汎用に書く）
  const guess = new Date(Date.UTC(y, m - 1, day, h, min));
  const p = partsIn(tz, guess);
  const asIfUtc = Date.UTC(p.y, p.m - 1, p.day, p.h, p.min);
  const offset = asIfUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

function parseHHMM(s: string): [number, number] {
  const [h, m] = s.split(":").map(Number);
  return [h ?? 0, m ?? 0];
}

/** "Fri 14:00-19:00" → その週の該当区間を返す関数 */
function parseBlocked(rule: string): { wd: number; start: [number, number]; end: [number, number] } | null {
  // "Fri 14:00-19:00"（曜日）または "Daily 12:00-13:00"（毎日。昼休みなど）
  const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Daily)\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(rule.trim());
  if (!m) return null;
  const wd = m[1] === "Daily" ? -1 : DAY_NAMES.indexOf(m[1] as (typeof DAY_NAMES)[number]);
  return { wd, start: parseHHMM(m[2]!), end: parseHHMM(m[3]!) };
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export interface FindSlotsInput {
  rules: CalendarRules;
  busy: Interval[];
  /** 探索開始（この時刻より後のみ） */
  from: Date;
  /** 探索終了 */
  to: Date;
  durationMin?: number;
  /** 何件返すか（省略時 rules.propose_count） */
  count?: number;
  /** 候補の刻み（分） */
  stepMin?: number;
}

/**
 * ルールの範囲内で空いているスロットを早い順に返す。
 * - 稼働時間内に収まる
 * - busy と（前後 buffer を含めて）重ならない
 * - blocked に重ならない
 * - 1日の会議数（busy の件数 + 既に採用した候補）が上限未満
 */
export function findSlots(input: FindSlotsInput): Slot[] {
  const { rules, busy, from, to } = input;
  const tz = rules.timezone;
  const duration = (input.durationMin ?? rules.default_duration_min) * 60_000;
  const buffer = rules.buffer_min * 60_000;
  const step = (input.stepMin ?? 30) * 60_000;
  const want = input.count ?? rules.propose_count;
  const blocked = rules.blocked.map(parseBlocked).filter((b): b is NonNullable<typeof b> => b !== null);
  const [wsH, wsM] = parseHHMM(rules.work_hours.start);
  const [weH, weM] = parseHHMM(rules.work_hours.end);

  const out: Slot[] = [];
  // 日ごとに走査
  const startDay = partsIn(tz, from);
  let cursor = zonedDate(tz, startDay.y, startDay.m, startDay.day, 0, 0);
  while (cursor < to && out.length < want) {
    const p = partsIn(tz, cursor);
    const dayStart = zonedDate(tz, p.y, p.m, p.day, wsH, wsM);
    const dayEnd = zonedDate(tz, p.y, p.m, p.day, weH, weM);
    const dayBlocked: Interval[] = blocked
      .filter((b) => b.wd === -1 || b.wd === p.wd)
      .map((b) => ({
        start: zonedDate(tz, p.y, p.m, p.day, b.start[0], b.start[1]),
        end: zonedDate(tz, p.y, p.m, p.day, b.end[0], b.end[1]),
      }));
    const dayBusy = busy.filter((b) => overlaps(b, { start: dayStart, end: dayEnd }));
    let meetingsToday = dayBusy.length;

    // 週末は稼働しない（blocked で表現しなくてもいいように既定で除外）
    if (p.wd !== 0 && p.wd !== 6) {
      for (let t = dayStart.getTime(); t + duration <= dayEnd.getTime(); t += step) {
        if (out.length >= want || meetingsToday >= rules.max_meetings_per_day) break;
        const slot: Interval = { start: new Date(t), end: new Date(t + duration) };
        if (slot.start <= from) continue;
        const padded: Interval = { start: new Date(t - buffer), end: new Date(t + duration + buffer) };
        if (dayBusy.some((b) => overlaps(b, padded))) continue;
        if (dayBlocked.some((b) => overlaps(b, slot))) continue;
        if (out.some((s) => overlaps(s, padded))) continue;
        out.push({ id: out.length, ...slot });
        meetingsToday += 1;
      }
    }
    cursor = zonedDate(tz, p.y, p.m, p.day + 1, 0, 0);
  }
  return out;
}

/**
 * 特定の時間がルール上・予定上 OK か。OK なら ""、ダメなら理由。
 * findSlots と同じ条件（稼働時間・週末・blocked・busy＋buffer・1日の件数）
 */
export function isSlotAllowed(rules: CalendarRules, busy: Interval[], slot: Interval): string {
  const tz = rules.timezone;
  const p = partsIn(tz, slot.start);
  if (p.wd === 0 || p.wd === 6) return "週末";
  const [wsH, wsM] = parseHHMM(rules.work_hours.start);
  const [weH, weM] = parseHHMM(rules.work_hours.end);
  const dayStart = zonedDate(tz, p.y, p.m, p.day, wsH, wsM);
  const dayEnd = zonedDate(tz, p.y, p.m, p.day, weH, weM);
  if (slot.start < dayStart || slot.end > dayEnd) return `稼働時間外（${rules.work_hours.start}〜${rules.work_hours.end}）`;
  const blocked = rules.blocked.map(parseBlocked).filter((b): b is NonNullable<typeof b> => b !== null);
  for (const b of blocked) {
    if (b.wd !== -1 && b.wd !== p.wd) continue;
    const bi = { start: zonedDate(tz, p.y, p.m, p.day, b.start[0], b.start[1]), end: zonedDate(tz, p.y, p.m, p.day, b.end[0], b.end[1]) };
    if (overlaps(bi, slot)) return "ブロック時間";
  }
  const buffer = rules.buffer_min * 60_000;
  const padded: Interval = { start: new Date(slot.start.getTime() - buffer), end: new Date(slot.end.getTime() + buffer) };
  if (busy.some((b) => overlaps(b, padded))) return "予定あり";
  const dayBusy = busy.filter((b) => overlaps(b, { start: dayStart, end: dayEnd }));
  if (dayBusy.length >= rules.max_meetings_per_day) return `1日の上限（${rules.max_meetings_per_day}件）`;
  return "";
}

const JA_WD = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 「木曜 14:00」のような短い表記。相手に見せる用。 */
export function formatSlot(slot: Interval, tz: string): string {
  const p = partsIn(tz, slot.start);
  const mm = p.min === 0 ? "" : `${p.min}分`;
  return `${p.m}/${p.day}(${JA_WD[p.wd]}) ${p.h}時${mm}`;
}
