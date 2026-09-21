/**
 * Slack もカレンダーも繋がない開発用。busy は YAML/JSON で与える。
 */
import type { Character } from "../characters/schema.js";
import type { Interval } from "./rules.js";
import type { CalendarPort } from "../agent/types.js";
import { zonedDate } from "./rules.js";

export class FakeCalendar implements CalendarPort {
  created: Array<{ slot: Interval; title: string }> = [];
  constructor(private readonly busyIntervals: Interval[] = []) {}
  async busy(): Promise<Interval[]> {
    return this.busyIntervals;
  }
  async createEvent(_owner: Character, slot: Interval, title: string): Promise<{ id: string }> {
    this.created.push({ slot, title });
    return { id: `fake_${this.created.length}` };
  }
}

/** デモ用の「それっぽい」予定。今週〜来週に数件。 */
export function demoBusy(tz: string, base: Date): Interval[] {
  const d = new Date(base);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const at = (offsetDays: number, h: number, min = 0, durMin = 60): Interval => {
    const start = zonedDate(tz, y, m, day + offsetDays, h, min);
    return { start, end: new Date(start.getTime() + durMin * 60_000) };
  };
  return [at(1, 10, 0, 60), at(1, 13, 0, 90), at(2, 11, 0, 30), at(3, 10, 0, 180), at(4, 15, 0, 60), at(6, 10, 0, 60), at(7, 14, 0, 60)];
}
