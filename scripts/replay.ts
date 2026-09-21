/**
 * コスト測定：同じメッセージ群を 3 構成で流して、トークン・レイテンシ・判断の当たり具合を表にする。
 *   npm run replay                     # 3構成すべて
 *   npm run replay -- --config auto    # 1構成だけ
 *   npm run replay -- --limit 5        # 先頭5件だけ
 *   npm run replay -- --model a,b,c    # 任意のモデルを比較（構成名=モデル名）
 *   npm run replay -- --messages scripts/replay-engineer.json   # 別のメッセージ集
 * 各構成の llm_log はメモリDBに溜めて集計。OrcaRouter ダッシュボードの請求と突合する。
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { runAgent } from "../src/agent/loop.js";
import type { AgentContext, AgentResult } from "../src/agent/types.js";
import { demoBusy, FakeCalendar } from "../src/calendar/fake.js";
import { loadCharacter } from "../src/characters/load.js";
import { config } from "../src/config.js";
import { OrcaRouterClient, type ChatOptions, type ChatResult, type LlmClient } from "../src/llm/client.js";
import { Store } from "../src/store/db.js";

interface ReplayMsg {
  sender: string;
  text: string;
  expect: "reply" | "schedule" | "ask" | "approve" | "handoff";
}

/** モデル名を差し替えるだけの薄いラッパ */
class ModelOverride implements LlmClient {
  constructor(private readonly inner: LlmClient, private readonly model: string) {}
  chat(opts: ChatOptions): Promise<ChatResult> {
    return this.inner.chat({ ...opts, model: this.model });
  }
}

const CONFIGS: Record<string, string> = {
  cheap: config.models.cheap,
  auto: config.models.main,
  strong: config.models.strong,
};

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt("config");
const models = opt("model")?.split(",").map((m) => m.trim()).filter(Boolean);
const limit = Number(opt("limit") ?? "0");
const charPath = opt("character") ?? "characters/panda.yaml";
const messagesPath = opt("messages") ?? "scripts/replay-messages.json";

if (!config.orcarouter.apiKey) {
  console.error("ORCAROUTER_API_KEY が未設定です（.env）。");
  process.exit(1);
}

const ch = loadCharacter(charPath);
const all = JSON.parse(readFileSync(messagesPath, "utf8")) as ReplayMsg[];
const messages = limit > 0 ? all.slice(0, limit) : all;
const now = new Date();

function outcome(r: AgentResult): ReplayMsg["expect"] {
  return r.kind === "pending" ? r.pendingKind : r.kind === "booked" || r.kind === "book_request" ? "schedule" : r.kind;
}

interface Row {
  config: string;
  model: string;
  calls: number;
  prompt: number;
  completion: number;
  latencyMs: number;
  hit: number;
  served: Record<string, number>;
  details: string[];
}

async function runConfig(name: string, model: string): Promise<Row> {
  const store = new Store(":memory:");
  const llm = new ModelOverride(new OrcaRouterClient(store), model);
  const calendar = new FakeCalendar(demoBusy(ch.calendar.timezone, now));
  const row: Row = { config: name, model, calls: 0, prompt: 0, completion: 0, latencyMs: 0, hit: 0, served: {}, details: [] };

  for (const [i, m] of messages.entries()) {
    const ctx: AgentContext = { owner: ch, incoming: m.text, sender: m.sender, senderKind: "human", history: [], now, calendar };
    const t0 = Date.now();
    let got: string;
    try {
      const r = await runAgent(llm, ctx);
      got = outcome(r);
    } catch (e) {
      got = `error: ${String(e).slice(0, 60)}`;
    }
    const ok = got === m.expect;
    if (ok) row.hit += 1;
    row.details.push(`${ok ? "○" : "×"} ${String(i + 1).padStart(2)} ${m.expect.padEnd(8)} → ${got.padEnd(8)} ${Date.now() - t0}ms  ${m.text.slice(0, 30)}`);
    process.stderr.write(`[${name}] ${i + 1}/${messages.length} ${ok ? "○" : "×"} ${m.expect}→${got}\n`);
  }

  const logs = store.db.prepare("SELECT served_model, prompt_tokens, completion_tokens, latency_ms FROM llm_log").all() as Array<{
    served_model: string | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    latency_ms: number;
  }>;
  for (const l of logs) {
    row.calls += 1;
    row.prompt += l.prompt_tokens ?? 0;
    row.completion += l.completion_tokens ?? 0;
    row.latencyMs += l.latency_ms;
    const s = l.served_model ?? "?";
    row.served[s] = (row.served[s] ?? 0) + 1;
  }
  return row;
}

const rows: Row[] = [];
const targets = models ? models.map((m) => [m, m] as const) : Object.entries(CONFIGS);
for (const [name, model] of targets) {
  if (only && only !== name) continue;
  rows.push(await runConfig(name, model));
}

const n = messages.length;
const lines: string[] = [];
lines.push(`# replay ${now.toISOString().slice(0, 16)}  （${n}件 × ${rows.length}構成、キャラ: ${ch.name}）`, "");
lines.push("| 構成 | モデル | LLM呼び出し | prompt tok | completion tok | 平均レイテンシ | 判断一致 |");
lines.push("|---|---|---:|---:|---:|---:|---:|");
for (const r of rows) {
  lines.push(`| ${r.config} | ${r.model} | ${r.calls} | ${r.prompt} | ${r.completion} | ${r.calls ? Math.round(r.latencyMs / r.calls) : 0}ms | ${r.hit}/${n} |`);
}
lines.push("", "実際に使われたモデル（OrcaRouter のレスポンス `model`）:");
for (const r of rows) lines.push(`- ${r.config}: ${Object.entries(r.served).map(([m, c]) => `${m}×${c}`).join(", ")}`);
for (const r of rows) {
  lines.push("", `## ${r.config}`, "```", ...r.details, "```");
}
const report = lines.join("\n");
console.log(report);
mkdirSync("data", { recursive: true });
const outPath = `data/replay-${now.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
writeFileSync(outPath, report);
console.error(`\n保存: ${outPath}`);
