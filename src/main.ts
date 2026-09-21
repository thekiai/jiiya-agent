/**
 * じいや本体。Slack (Socket Mode) に繋いで待機する。
 */
import { App, LogLevel } from "@slack/bolt";
import { GoogleCalendar } from "./calendar/google.js";
import { loadAllCharacters } from "./characters/load.js";
import { config } from "./config.js";
import { OrcaRouterClient } from "./llm/client.js";
import { registerHandlers } from "./slack/handlers.js";
import { SlackOut } from "./slack/post.js";
import { Store } from "./store/db.js";

function requireEnv(): void {
  const missing = [
    ["ORCAROUTER_API_KEY", config.orcarouter.apiKey],
    ["SLACK_BOT_TOKEN", config.slack.botToken],
    ["SLACK_APP_TOKEN", config.slack.appToken],
  ].filter(([, v]) => !v);
  if (missing.length > 0) {
    console.error(`未設定の環境変数: ${missing.map(([k]) => k).join(", ")}（.env を確認）`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  requireEnv();
  const store = new Store(config.dbPath);
  const characters = loadAllCharacters("characters");
  for (const ch of characters.values()) store.upsertOwner(ch.owner.slack_user_id, ch.id);

  // ignoreSelf: false — じいや同士（A2A）は自分の bot の投稿を起点にするので、自分の投稿イベントも受け取る（判定は handlers 側）
  const app = new App({ token: config.slack.botToken, appToken: config.slack.appToken, socketMode: true, logLevel: LogLevel.INFO, ignoreSelf: false });
  const auth = await app.client.auth.test({ token: config.slack.botToken });
  const botId = (auth as { bot_id?: string }).bot_id ?? "";

  const calendar = new GoogleCalendar(store);
  registerHandlers({ app, out: new SlackOut(app.client), store, llm: new OrcaRouterClient(store), characters, calendar, botId });

  await app.start();
  console.log(`じいや 起動（bot_id=${botId}）`);
  for (const ch of characters.values()) {
    const cal = calendar.isConnected(ch) ? "Google Calendar" : "デモ予定（未接続）";
    console.log(`  ${ch.emoji} ${ch.name} — ${ch.owner.display_name} (${ch.owner.slack_user_id}) / ${cal}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
