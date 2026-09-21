import { describe, expect, it } from "vitest";
import { runOwnerAgent } from "../src/agent/owner.js";
import { loadCharacter } from "../src/characters/load.js";
import type { PendingRow } from "../src/store/db.js";
import { ScriptedLlm } from "./fakes.js";

const ch = loadCharacter("characters/jiiya.yaml");
const base = { owner_id: "U1", channel: "C1", thread_ts: "1.0", counterpart: "高橋健", counterpart_kind: "human" as const, mention_ts: "1.0", options_json: "[]", permalink: null, dm_ts: null, created_at: Date.now(), resolved_at: null, answer: null };
const ask: PendingRow = { ...base, id: 1, kind: "ask", incoming: "進捗どうですか", question: "何とお伝えしますか", draft: null };
const approve: PendingRow = { ...base, id: 2, kind: "approve", incoming: "締切伸ばせますか", question: null, draft: "金曜は難しいとのことです。" };

describe("runOwnerAgent", () => {
  it("開いている質問への答えは answer", async () => {
    const llm = new ScriptedLlm([{ tools: [["answer", { pending_id: 1, answer: "今週中に終わる" }]] }]);
    const a = await runOwnerAgent(llm, ch, [ask, approve], [], "今週中には終わるよ");
    expect(a).toEqual({ kind: "answer", pendingId: 1, answer: "今週中に終わる" });
  });
  it("文面への修正は revise、送ってと言えば send", async () => {
    const llm = new ScriptedLlm([{ tools: [["revise", { pending_id: 2, instruction: "もっと柔らかく" }]] }, { tools: [["send", { pending_id: 2 }]] }]);
    expect(await runOwnerAgent(llm, ch, [ask, approve], [], "もっと柔らかく")).toEqual({ kind: "revise", pendingId: 2, instruction: "もっと柔らかく" });
    expect(await runOwnerAgent(llm, ch, [ask, approve], [], "それで送って")).toEqual({ kind: "send", pendingId: 2 });
  });
  it("存在しない id や種類違いはツールを実行せず聞き返す", async () => {
    const llm = new ScriptedLlm([{ tools: [["answer", { pending_id: 2, answer: "x" }]] }]);
    const a = await runOwnerAgent(llm, ch, [ask, approve], [], "x");
    expect(a.kind).toBe("chat");
  });
  it("ツールなしなら会話（お礼など）", async () => {
    const llm = new ScriptedLlm([{ text: "勿体ないお言葉でございます。" }]);
    const a = await runOwnerAgent(llm, ch, [], [], "ありがとう");
    expect(a).toEqual({ kind: "chat", text: "勿体ないお言葉でございます。" });
  });
});
