/**
 * 本人の答え（ボタン／単語）を、相手への返信文にする。伝聞・相手の口調にミラー。
 */
import { config } from "../config.js";
import { ownerName, type Character } from "../characters/schema.js";
import type { LlmClient } from "../llm/client.js";
import { stripSelfClaimedLabels } from "../harness/labels.js";
import { relayPrompt, relayUserMessage, toneFor } from "./prompt.js";
import type { SenderKind } from "./types.js";

export async function relayAnswer(
  llm: LlmClient,
  ch: Character,
  senderKind: SenderKind,
  incoming: string,
  question: string,
  answer: string,
): Promise<string> {
  const r = await llm.chat({
    model: config.models.main,
    messages: [
      { role: "system", content: relayPrompt(ch, senderKind) },
      { role: "user", content: relayUserMessage(question, answer, incoming) },
    ],
    tag: `${ch.id}:relay`,
    temperature: 0.4,
  });
  return stripSelfClaimedLabels(r.text) || `${answer}だそうです！`;
}

/** クレーム等に本人名義で返すための敬語の文案 */
export async function draftForOwner(llm: LlmClient, ch: Character, incoming: string, reason: string): Promise<string> {
  const r = await llm.chat({
    model: config.models.strong,
    messages: [
      {
        role: "system",
        content: `あなたは ${ch.owner.display_name} 本人の代筆をする。次のメッセージに対して、本人の名前で送る返信文案を日本語の丁寧な敬語で書く。3〜4文。言い訳をしない。事実関係は断定せず「確認します」と書く。文案だけを出力する。
背景: ${reason}`,
      },
      { role: "user", content: incoming },
    ],
    tag: `${ch.id}:draft`,
    temperature: 0.3,
  });
  return r.text;
}

/** 本人の「みんなに伝えて」を告知文にする */
export async function announcementText(llm: LlmClient, ch: Character, request: string): Promise<string> {
  const r = await llm.chat({
    model: config.models.main,
    messages: [
      {
        role: "system",
        content: `あなたは「${ch.name}」${ch.emoji}、${ownerName(ch)} の${ch.role_label}。本人から頼まれた内容を、チャンネルのみんなに伝える告知文にする。
- 伝聞で（「〜だそうです」「〜とのことです」）。儀礼表現なし。1〜2文。絵文字は1個まで。
${toneFor(ch, "human")}
- 告知文だけを出力する。`,
      },
      { role: "user", content: request },
    ],
    tag: `${ch.id}:announce`,
    temperature: 0.4,
  });
  return stripSelfClaimedLabels(r.text);
}

/** 文面案に対する本人の修正指示を反映する。足りない情報はでっち上げず、本人に聞く */
export async function reviseDraft(llm: LlmClient, ch: Character, senderKind: SenderKind, incoming: string, draft: string, instruction: string): Promise<string> {
  const r = await llm.chat({
    model: config.models.main,
    messages: [
      {
        role: "system",
        content: `あなたは「${ch.name}」${ch.emoji}、${ownerName(ch)} の${ch.role_label}。相手への返信の文面案に、本人から修正指示が来た。指示を反映した文面だけを出力する。
- 伝聞（「〜だそうです」「〜とのことです」）は維持する。
- 指示に「理由を考えて」「適当に埋めて」など、本人しか知らない内容を作る必要がある場合は、文面を作らず「（本人に確認）」から始めて、何を教えてほしいか1文で書く。事実をでっち上げない。
${toneFor(ch, senderKind)}`,
      },
      { role: "user", content: `相手のメッセージ: ${incoming}\n現在の文面案: ${draft}\n本人の修正指示: ${instruction}` },
    ],
    tag: `${ch.id}:revise`,
    temperature: 0.3,
  });
  return stripSelfClaimedLabels(r.text);
}
