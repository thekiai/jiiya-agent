/**
 * Google Calendar を CalendarPort として使う。
 * - 各じいやは「本人のトークン」でしか読み書きしない（owners.gcal_token_json）
 * - トークンが無い本人は FakeCalendar（デモ予定）にフォールバックする
 */
import { google, type calendar_v3 } from "googleapis";
import type { CalendarPort } from "../agent/types.js";
import type { Character } from "../characters/schema.js";
import { config } from "../config.js";
import type { Store } from "../store/db.js";
import { demoBusy, FakeCalendar } from "./fake.js";
import type { Interval } from "./rules.js";

export const GCAL_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"];

export function oauthClient() {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です（.env）");
  }
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
}

export class GoogleCalendar implements CalendarPort {
  private readonly fallback: FakeCalendar;

  constructor(private readonly store: Store) {
    this.fallback = new FakeCalendar(demoBusy("Asia/Tokyo", new Date()));
  }

  private api(owner: Character): calendar_v3.Calendar | null {
    const tokenJson = this.store.getGcalToken(owner.owner.slack_user_id);
    if (!tokenJson || !config.google.clientId) return null;
    const auth = oauthClient();
    auth.setCredentials(JSON.parse(tokenJson));
    // refresh されたトークンは保存し直す
    auth.on("tokens", (t) => {
      const merged = { ...JSON.parse(tokenJson), ...t };
      this.store.setGcalToken(owner.owner.slack_user_id, JSON.stringify(merged));
    });
    return google.calendar({ version: "v3", auth });
  }

  async busy(owner: Character, from: Date, to: Date): Promise<Interval[]> {
    const cal = this.api(owner);
    if (!cal) return this.fallback.busy();
    const res = await cal.freebusy.query({
      requestBody: { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: owner.calendar.timezone, items: [{ id: "primary" }] },
    });
    const periods = res.data.calendars?.primary?.busy ?? [];
    return periods.flatMap((p) => (p.start && p.end ? [{ start: new Date(p.start), end: new Date(p.end) }] : []));
  }

  async createEvent(owner: Character, slot: Interval, title: string, attendees: string[]): Promise<{ id: string; htmlLink?: string }> {
    const cal = this.api(owner);
    if (!cal) return this.fallback.createEvent(owner, slot, title);
    const res = await cal.events.insert({
      calendarId: "primary",
      sendUpdates: attendees.length > 0 ? "all" : "none", // 相手に招待メールを送る
      requestBody: {
        summary: title,
        description: `${owner.name}（じいや）が入れました`,
        start: { dateTime: slot.start.toISOString(), timeZone: owner.calendar.timezone },
        end: { dateTime: slot.end.toISOString(), timeZone: owner.calendar.timezone },
        attendees: attendees.map((email) => ({ email })),
      },
    });
    return { id: res.data.id ?? "", ...(res.data.htmlLink ? { htmlLink: res.data.htmlLink } : {}) };
  }

  /** 本人がカレンダーを繋いでいるか（起動時のログ用） */
  isConnected(owner: Character): boolean {
    return this.store.getGcalToken(owner.owner.slack_user_id) !== null;
  }
}
