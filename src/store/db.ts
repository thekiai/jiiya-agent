import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type PendingKind = "ask" | "approve" | "handoff";

export interface PendingRow {
  id: number;
  owner_id: string;
  channel: string;
  thread_ts: string;
  kind: PendingKind;
  counterpart: string;
  counterpart_kind: "human" | "character";
  incoming: string;
  mention_ts: string;
  question: string | null;
  options_json: string | null;
  draft: string | null;
  permalink: string | null;
  dm_ts: string | null;
  created_at: number;
  resolved_at: number | null;
  answer: string | null;
}

export interface ThreadRow {
  channel: string;
  thread_ts: string;
  owner_id: string;
  counterpart_id: string;
  counterpart_kind: "human" | "character";
  state: string;
  depth: number;
  updated_at: number;
}

export interface MessageRow {
  role: "user" | "assistant";
  sender: string;
  content: string;
}

export interface LlmLogRow {
  tag: string;
  requested_model: string;
  served_model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number;
  headers_json: string;
}

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    this.db.exec(schema);
    this.migrate();
  }
  /** 既存DBに列を足す（schema.sql は CREATE IF NOT EXISTS なので） */
  private migrate(): void {
    const cols = (this.db.prepare("PRAGMA table_info(pending)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("dm_ts")) this.db.exec("ALTER TABLE pending ADD COLUMN dm_ts TEXT");
  }

  // ---- owners ----
  upsertOwner(slackUserId: string, characterId: string): void {
    this.db
      .prepare("INSERT INTO owners(slack_user_id, character_id) VALUES(?, ?) ON CONFLICT(slack_user_id) DO UPDATE SET character_id = excluded.character_id")
      .run(slackUserId, characterId);
  }
  setGcalToken(slackUserId: string, tokenJson: string): void {
    this.db.prepare("UPDATE owners SET gcal_token_json = ? WHERE slack_user_id = ?").run(tokenJson, slackUserId);
  }
  getGcalToken(slackUserId: string): string | null {
    const row = this.db.prepare("SELECT gcal_token_json FROM owners WHERE slack_user_id = ?").get(slackUserId) as { gcal_token_json: string | null } | undefined;
    return row?.gcal_token_json ?? null;
  }

  /** 初めて見たイベントなら true。二度目以降は false（重複排除） */
  markSeen(key: string): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO seen_events(key, created_at) VALUES(?, ?)").run(key, Date.now());
    if (r.changes === 1) {
      // 古いものは捨てる（1日）
      this.db.prepare("DELETE FROM seen_events WHERE created_at < ?").run(Date.now() - 86_400_000);
      return true;
    }
    return false;
  }

  // ---- queue（待ってから動く） ----
  enqueue(key: string, dueAt: number, payload: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO queue(key, due_at, payload) VALUES(?, ?, ?)").run(key, dueAt, JSON.stringify(payload));
  }
  cancelQueued(key: string): boolean {
    return this.db.prepare("DELETE FROM queue WHERE key = ?").run(key).changes > 0;
  }
  /** 待機中のものを取り出して削除する（今すぐ動かす用） */
  takeQueued(key: string): string | undefined {
    const row = this.db.prepare("SELECT payload FROM queue WHERE key = ?").get(key) as { payload: string } | undefined;
    if (row) this.db.prepare("DELETE FROM queue WHERE key = ?").run(key);
    return row?.payload;
  }
  /** あるチャンネルで待機中のもの（key は channel:ts:owner） */
  queuedIn(channel: string, owner: string): Array<{ key: string; due_at: number; payload: string }> {
    return this.db
      .prepare("SELECT key, due_at, payload FROM queue WHERE key LIKE ? ORDER BY due_at")
      .all(`${channel}:%:${owner}`) as Array<{ key: string; due_at: number; payload: string }>;
  }
  /** 期限が来たものを取り出して削除する */
  takeDue(now: number): Array<{ key: string; payload: string }> {
    const rows = this.db.prepare("SELECT key, payload FROM queue WHERE due_at <= ?").all(now) as Array<{ key: string; payload: string }>;
    for (const r of rows) this.db.prepare("DELETE FROM queue WHERE key = ?").run(r.key);
    return rows;
  }

  // ---- threads ----
  getThread(channel: string, threadTs: string, ownerId: string): ThreadRow | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE channel = ? AND thread_ts = ? AND owner_id = ?").get(channel, threadTs, ownerId) as ThreadRow | undefined;
  }
  /** このスレッドに関わっている全秘書の行 */
  threadsAt(channel: string, threadTs: string): ThreadRow[] {
    return this.db.prepare("SELECT * FROM threads WHERE channel = ? AND thread_ts = ?").all(channel, threadTs) as ThreadRow[];
  }
  deleteThread(channel: string, threadTs: string, ownerId: string): void {
    this.db.prepare("DELETE FROM threads WHERE channel = ? AND thread_ts = ? AND owner_id = ?").run(channel, threadTs, ownerId);
  }
  upsertThread(t: Omit<ThreadRow, "updated_at">): void {
    this.db
      .prepare(
        `INSERT INTO threads(channel, thread_ts, owner_id, counterpart_id, counterpart_kind, state, depth, updated_at)
         VALUES(@channel, @thread_ts, @owner_id, @counterpart_id, @counterpart_kind, @state, @depth, @updated_at)
         ON CONFLICT(channel, thread_ts, owner_id) DO UPDATE SET state = excluded.state, depth = excluded.depth, counterpart_id = excluded.counterpart_id, counterpart_kind = excluded.counterpart_kind, updated_at = excluded.updated_at`,
      )
      .run({ ...t, updated_at: Date.now() });
  }

  // ---- messages (スレッド履歴) ----
  appendMessage(channel: string, threadTs: string, m: MessageRow): void {
    this.db
      .prepare("INSERT INTO messages(channel, thread_ts, role, sender, content, created_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(channel, threadTs, m.role, m.sender, m.content, Date.now());
  }
  threadHistory(channel: string, threadTs: string, limit = 20): MessageRow[] {
    return this.db
      .prepare("SELECT role, sender, content FROM messages WHERE channel = ? AND thread_ts = ? ORDER BY id DESC LIMIT ?")
      .all(channel, threadTs, limit)
      .reverse() as MessageRow[];
  }

  // ---- pending ----
  addPending(p: Omit<PendingRow, "id" | "created_at" | "resolved_at" | "answer" | "dm_ts">): number {
    const r = this.db
      .prepare(
        `INSERT INTO pending(owner_id, channel, thread_ts, kind, counterpart, counterpart_kind, incoming, mention_ts, question, options_json, draft, permalink, created_at)
         VALUES(@owner_id, @channel, @thread_ts, @kind, @counterpart, @counterpart_kind, @incoming, @mention_ts, @question, @options_json, @draft, @permalink, @created_at)`,
      )
      .run({ ...p, created_at: Date.now() });
    return Number(r.lastInsertRowid);
  }
  /** 同じスレッドで開いている古い pending を閉じる（新しい質問・確認に置き換わったとき） */
  supersedeOpen(channel: string, threadTs: string, ownerId: string): number {
    return this.db
      .prepare("UPDATE pending SET resolved_at = ?, answer = 'superseded' WHERE channel = ? AND thread_ts = ? AND owner_id = ? AND resolved_at IS NULL")
      .run(Date.now(), channel, threadTs, ownerId).changes;
  }
  setDmTs(id: number, dmTs: string): void {
    this.db.prepare("UPDATE pending SET dm_ts = ? WHERE id = ?").run(dmTs, id);
  }
  pendingByDmTs(dmTs: string): PendingRow | undefined {
    return this.db.prepare("SELECT * FROM pending WHERE dm_ts = ?").get(dmTs) as PendingRow | undefined;
  }
  getPending(id: number): PendingRow | undefined {
    return this.db.prepare("SELECT * FROM pending WHERE id = ?").get(id) as PendingRow | undefined;
  }
  openPending(ownerId: string): PendingRow[] {
    return this.db.prepare("SELECT * FROM pending WHERE owner_id = ? AND resolved_at IS NULL ORDER BY id").all(ownerId) as PendingRow[];
  }
  resolvePending(id: number, answer: string | null): void {
    this.db.prepare("UPDATE pending SET resolved_at = ?, answer = ? WHERE id = ?").run(Date.now(), answer, id);
  }

  // ---- llm log ----
  logLlm(row: LlmLogRow): void {
    this.db
      .prepare(
        `INSERT INTO llm_log(ts, tag, requested_model, served_model, prompt_tokens, completion_tokens, latency_ms, headers_json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), row.tag, row.requested_model, row.served_model, row.prompt_tokens, row.completion_tokens, row.latency_ms, row.headers_json);
  }
}

export function resolveSchemaPath(): string {
  return fileURLToPath(new URL("./schema.sql", import.meta.url));
}
