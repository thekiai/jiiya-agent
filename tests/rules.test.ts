import { describe, expect, it } from "vitest";
import { findSlots, formatSlot, zonedDate } from "../src/calendar/rules.js";
import { CalendarRulesSchema } from "../src/characters/schema.js";

const tz = "Asia/Tokyo";
const rules = CalendarRulesSchema.parse({
  work_hours: { start: "10:00", end: "19:00" },
  buffer_min: 15,
  blocked: ["Fri 14:00-19:00"],
  max_meetings_per_day: 3,
  default_duration_min: 30,
  propose_count: 2,
});
// 2026-09-21 は月曜
const mon = (h: number, m = 0) => zonedDate(tz, 2026, 9, 21, h, m);
const day = (d: number, h: number, m = 0) => zonedDate(tz, 2026, 9, d, h, m);

describe("findSlots", () => {
  it("稼働開始から早い順に候補を出す", () => {
    const slots = findSlots({ rules, busy: [], from: day(20, 9), to: day(26, 0) });
    // 候補同士もバッファを取るので、10:00 の次は 11:00
    expect(slots.map((s) => formatSlot(s, tz))).toEqual(["9/21(月) 10時", "9/21(月) 11時"]);
  });

  it("busy の前後にバッファを取る", () => {
    const busy = [{ start: mon(10, 30), end: mon(11, 0) }];
    const slots = findSlots({ rules, busy, from: day(20, 9), to: day(22, 0), count: 3 });
    // 10:00-10:30 は 10:30 の予定の15分前に食い込むので不可。11:15 以降が最初。
    expect(formatSlot(slots[0]!, tz)).toBe("9/21(月) 11時30分");
  });

  it("blocked の曜日・時間帯を避ける", () => {
    // 金曜 9/25 の 14:00 以降は不可。金曜だけ見る。
    const slots = findSlots({ rules, busy: [], from: day(25, 13, 50), to: day(26, 0), count: 5 });
    expect(slots).toHaveLength(0);
  });

  it("1日の上限を超えない", () => {
    const busy = [
      { start: mon(10, 0), end: mon(10, 30) },
      { start: mon(12, 0), end: mon(12, 30) },
      { start: mon(15, 0), end: mon(15, 30) },
    ];
    const slots = findSlots({ rules, busy, from: day(20, 9), to: day(22, 0), count: 5 });
    // 月曜は既に3件なので候補なし
    expect(slots).toHaveLength(0);
  });

  it("週末は出さない", () => {
    const slots = findSlots({ rules, busy: [], from: day(19, 0), to: day(21, 0), count: 5 });
    expect(slots).toHaveLength(0);
  });

  it("from より前は出さない", () => {
    const slots = findSlots({ rules, busy: [], from: mon(15, 10), to: day(22, 0), count: 1 });
    expect(formatSlot(slots[0]!, tz)).toBe("9/21(月) 15時30分");
  });
});

import { isSlotAllowed } from "../src/calendar/rules.js";
describe("Daily blocked", () => {
  it("昼休みは毎日ブロック", () => {
    const rules = { work_hours: { start: "10:00", end: "19:00" }, buffer_min: 0, blocked: ["Daily 12:00-13:00"], max_meetings_per_day: 3, default_duration_min: 30, propose_count: 2, timezone: "Asia/Tokyo", confirm: false };
    const noon = { start: zonedDate("Asia/Tokyo", 2026, 9, 22, 12, 0), end: zonedDate("Asia/Tokyo", 2026, 9, 22, 12, 30) };
    const one = { start: zonedDate("Asia/Tokyo", 2026, 9, 22, 13, 0), end: zonedDate("Asia/Tokyo", 2026, 9, 22, 13, 30) };
    expect(isSlotAllowed(rules, [], noon)).toBe("ブロック時間");
    expect(isSlotAllowed(rules, [], one)).toBe("");
  });
});
