CREATE TABLE IF NOT EXISTS owners (
  slack_user_id   TEXT PRIMARY KEY,
  character_id    TEXT NOT NULL,
  gcal_token_json TEXT
);

CREATE TABLE IF NOT EXISTS threads (
  channel          TEXT NOT NULL,
  thread_ts        TEXT NOT NULL,
  owner_id         TEXT NOT NULL,
  counterpart_id   TEXT NOT NULL,
  counterpart_kind TEXT NOT NULL,           -- human / character
  state            TEXT NOT NULL DEFAULT '{}',  -- json
  depth            INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (channel, thread_ts, owner_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL,
  thread_ts  TEXT NOT NULL,
  role       TEXT NOT NULL,   -- user / assistant
  sender     TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(channel, thread_ts, id);

CREATE TABLE IF NOT EXISTS pending (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     TEXT NOT NULL,
  channel      TEXT NOT NULL,
  thread_ts    TEXT NOT NULL,
  kind         TEXT NOT NULL,   -- ask / approve / handoff
  counterpart  TEXT NOT NULL,   -- 相手の表示名
  counterpart_kind TEXT NOT NULL, -- human / character
  incoming     TEXT NOT NULL,   -- 相手のメッセージ本文
  mention_ts   TEXT NOT NULL,   -- 相手のメッセージの ts（✅ を付ける対象）
  question     TEXT,
  options_json TEXT,
  draft        TEXT,
  permalink    TEXT,
  dm_ts        TEXT,              -- 本人に聞いたDMの ts（スレッド返信で答えを紐づける）
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  answer       TEXT
);
CREATE INDEX IF NOT EXISTS pending_open ON pending(owner_id, resolved_at);

CREATE TABLE IF NOT EXISTS llm_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  tag               TEXT,
  requested_model   TEXT,
  served_model      TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  latency_ms        INTEGER,
  headers_json      TEXT
);

-- 処理済みイベント（Slack は 3 秒以内に ack しないと再送するので、同じ ts を二度処理しない）
CREATE TABLE IF NOT EXISTS seen_events (
  key        TEXT PRIMARY KEY,   -- channel:ts
  created_at INTEGER NOT NULL
);

-- 主人の返事を待ってから動く用のキュー（本人が先に返したら取り消す）
CREATE TABLE IF NOT EXISTS queue (
  key        TEXT PRIMARY KEY,   -- channel:ts:owner
  due_at     INTEGER NOT NULL,
  payload    TEXT NOT NULL       -- json
);
