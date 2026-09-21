import type { Character } from "../characters/schema.js";
import type { Interval, Slot } from "../calendar/rules.js";
import type { MessageRow } from "../store/db.js";
import type { AskOption } from "./options.js";

export type SenderKind = "human" | "character";

/** じいやが使える「世界」。Slack とカレンダーは差し替え可能（CLI・テスト用）。 */
export interface CalendarPort {
  /** 本人の予定の busy 区間 */
  busy(owner: Character, from: Date, to: Date): Promise<Interval[]>;
  /** 本人のカレンダーに予定を作る。戻り値は予定のURL等 */
  createEvent(owner: Character, slot: Interval, title: string, attendees: string[]): Promise<{ id: string; htmlLink?: string }>;
}

export interface AgentContext {
  owner: Character;
  incoming: string;
  sender: string; // 表示名
  senderKind: SenderKind;
  /** スレッドの直近履歴（古い順） */
  history: MessageRow[];
  /** 相手が候補を選ぶ段階なら、提示済みの候補 */
  proposedSlots?: Slot[];
  now: Date;
  calendar: CalendarPort;
  /** 相手のメール（予定に招待する用）。不明なら undefined */
  counterpartEmail?: string;
}

/** run_agent の結果。この4種類しかない。 */
export type AgentResult =
  /** needsApproval: LLM が自由に書いた文（カレンダー等の根拠なし）。本人が見てから送る */
  | { kind: "reply"; text: string; label: string; needsApproval?: boolean }
  | { kind: "schedule"; text: string; slots: Slot[]; label: string }
  | { kind: "booked"; text: string; slot: Slot; label: string; eventId: string }
  /** confirm モード: まだ登録していない。主人が承認したら登録して送る */
  | { kind: "book_request"; text: string; slot: Slot; title: string; label: string }
  | { kind: "pending"; pendingKind: "ask" | "approve" | "handoff"; question?: string; options?: AskOption[]; draft?: string; reason?: string };
