/**
 * 本人が1回だけブラウザで Google Calendar へのアクセスを許可する（インストール型 OAuth）。
 *   npm run gcal:auth -- characters/panda.yaml
 * ローカルの一時HTTPサーバで認可コードを受け取り、トークンを owners.gcal_token_json に保存する。
 */
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { loadCharacter } from "../src/characters/load.js";
import { GCAL_SCOPES, oauthClient } from "../src/calendar/google.js";
import { config } from "../src/config.js";
import { Store } from "../src/store/db.js";

const charPath = process.argv[2] ?? "characters/panda.yaml";
const ch = loadCharacter(charPath);
const store = new Store(config.dbPath);
store.upsertOwner(ch.owner.slack_user_id, ch.id);

const PORT = 53682;
const redirectUri = `http://127.0.0.1:${PORT}/callback`;
const auth = oauthClient();
const url = auth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GCAL_SCOPES, redirect_uri: redirectUri });

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", redirectUri);
  if (u.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = u.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("code がありません");
    return;
  }
  try {
    const { tokens } = await auth.getToken({ code, redirect_uri: redirectUri });
    store.setGcalToken(ch.owner.slack_user_id, JSON.stringify(tokens));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<p>${ch.emoji} ${ch.name}がカレンダーを見られるようになりました。このタブは閉じてOK。</p>`);
    console.log(`保存しました: ${ch.owner.display_name} (${ch.owner.slack_user_id}) → ${config.dbPath}`);
  } catch (e) {
    res.writeHead(500).end(String(e));
    console.error(e);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log(`${ch.owner.display_name} の Google アカウントでブラウザから許可してください:\n${url}\n`);
  exec(`open "${url}"`);
});
