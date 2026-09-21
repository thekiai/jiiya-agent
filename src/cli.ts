/**
 * Slack なしでじいやと会話する。あなたが「相手」役。
 *   npm run cli -- characters/panda.yaml --sender "高橋 健"
 * 本人への質問（pending）はその場で表示して、あなたが本人役でも答える。
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runAgent } from "./agent/loop.js";
import type { AgentContext } from "./agent/types.js";
import { demoBusy, FakeCalendar } from "./calendar/fake.js";
import { formatSlot, type Slot } from "./calendar/rules.js";
import { loadCharacter } from "./characters/load.js";
import { config } from "./config.js";
import { OrcaRouterClient } from "./llm/client.js";
import { Store } from "./store/db.js";
import type { MessageRow } from "./store/db.js";

const args = process.argv.slice(2);
const charPath = args.find((a) => !a.startsWith("--")) ?? "characters/panda.yaml";
const senderIdx = args.indexOf("--sender");
const sender = senderIdx >= 0 ? (args[senderIdx + 1] ?? "相手") : "相手";
const senderKind = args.includes("--as-character") ? "character" : "human";

const ch = loadCharacter(charPath);
const store = new Store(":memory:");
const llm = new OrcaRouterClient(store);
const now = new Date();
const calendar = new FakeCalendar(demoBusy(ch.calendar.timezone, now));
const history: MessageRow[] = [];
let proposedSlots: Slot[] | undefined;

if (!config.orcarouter.apiKey) {
  console.error("ORCAROUTER_API_KEY が未設定です（.env）。");
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
console.log(`${ch.emoji} ${ch.name}（${ch.owner.display_name}のじいや）が待機中。あなたは「${sender}」です。Ctrl-D で終了。\n`);

for (;;) {
  let incoming: string;
  try {
    incoming = (await rl.question(`${sender}> `)).trim();
  } catch {
    break;
  }
  if (!incoming) continue;

  const ctx: AgentContext = { owner: ch, incoming, sender, senderKind, history, now, calendar, ...(proposedSlots ? { proposedSlots } : {}) };
  const r = await runAgent(llm, ctx);
  history.push({ role: "user", sender, content: incoming });

  switch (r.kind) {
    case "reply":
      console.log(`\n${ch.emoji} ${ch.name}> ${r.text}\n`);
      history.push({ role: "assistant", sender: ch.name, content: r.text });
      break;
    case "schedule":
      console.log(`\n${ch.emoji} ${ch.name}> ${r.text}`);
      console.log(`   [候補: ${r.slots.map((s) => `${s.id}:${formatSlot(s, ch.calendar.timezone)}`).join(" / ")}]\n`);
      history.push({ role: "assistant", sender: ch.name, content: r.text });
      proposedSlots = r.slots;
      break;
    case "booked":
      console.log(`\n${ch.emoji} ${ch.name}> ${r.text}`);
      console.log(`   [予定作成: ${formatSlot(r.slot, ch.calendar.timezone)} / ${r.eventId}]`);
      console.log(`   ┌─ ${ch.emoji} → ${ch.owner.display_name}（DM・報告）\n   │ ${sender}と${formatSlot(r.slot, ch.calendar.timezone)}で入れたよ！\n`);
      history.push({ role: "assistant", sender: ch.name, content: r.text });
      proposedSlots = undefined;
      break;
    case "pending": {
      console.log(`\n   [スレッドには何も返さない → 本人にDM (${r.pendingKind})]`);
      console.log(`   ┌─ ${ch.emoji} → ${ch.owner.display_name}（DM）`);
      if (r.pendingKind === "ask") {
        console.log(`   │ ${r.question}`);
        r.options?.forEach((o, i) => console.log(`   │   ${i + 1}. ${o.label}  (${o.action})`));
        const ans = (await rl.question(`   └─ ${ch.owner.display_name}> `)).trim();
        const picked = r.options && /^\d+$/.test(ans) ? (r.options[Number(ans) - 1]?.label ?? ans) : ans;
        // 本人の答えを相手向けの文に
        const { relayAnswer } = await import("./agent/relay.js");
        const text = await relayAnswer(llm, ch, senderKind, incoming, r.question ?? "", picked);
        console.log(`\n${ch.emoji} ${ch.name}> ${text}\n`);
        history.push({ role: "assistant", sender: ch.name, content: text });
      } else if (r.pendingKind === "approve") {
        console.log(`   │ これで送っていい？\n   │ ---\n   │ ${r.draft}\n   │ ---\n   │   y: 送る / n: 送らない`);
        const ans = (await rl.question(`   └─ ${ch.owner.display_name}> `)).trim().toLowerCase();
        if (ans === "y") {
          console.log(`\n${ch.emoji} ${ch.name}> ${r.draft}\n`);
          history.push({ role: "assistant", sender: ch.name, content: r.draft ?? "" });
        } else console.log("   （送らなかった）\n");
      } else {
        console.log(`   │ これは本人から返した方がよさそう（${r.reason}）。${ch.name}は何も返してないよ。文案いる？\n`);
      }
      break;
    }
  }
}
rl.close();
