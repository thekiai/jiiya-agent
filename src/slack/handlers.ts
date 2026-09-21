/**
 * Slack イベントの入口。
 * - チャンネル: @本人 メンション → じいやが動く。スレッド返信 → 候補選択の続き
 * - DM（本人）: 発信依頼 or 保留中の質問への自由回答
 * - ボタン: まとめDMの ans / apv / hnd、発信の ann
 */
import type { App, BlockAction, ButtonAction, MessageShortcut } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { runAgent } from "../agent/loop.js";
import { announcementText, draftForOwner, reviseDraft } from "../agent/relay.js";
import type { AgentContext, AgentResult, CalendarPort, SenderKind } from "../agent/types.js";
import { findSlots, formatSlot, type Slot } from "../calendar/rules.js";
import { parseAskOptions, type AskOption } from "../agent/options.js";
import { relayAnswer } from "../agent/relay.js";
import { displayName, ownerName, say, withHonorific, type Character } from "../characters/schema.js";
import { config } from "../config.js";
import { buttonLabels, pendingBlocks, pressedBlock } from "./blocks.js";
import { stripSelfClaimedLabels, withLabel } from "../harness/labels.js";
import { isClosing } from "../harness/sanitize.js";
import { runOwnerAgent, type OwnerAction } from "../agent/owner.js";
import type { LlmClient } from "../llm/client.js";
import type { PendingRow, Store, ThreadRow } from "../store/db.js";
import { NotInChannelError, SlackOut } from "./post.js";

export interface Deps {
  app: App;
  out: SlackOut;
  store: Store;
  llm: LlmClient;
  characters: Map<string, Character>; // owner slack user id → character
  calendar: CalendarPort;
  botId: string; // 自分のアプリの bot_id（自分の投稿を見分ける）
}

/** 受け取る message イベントのうち、使うフィールドだけ */
interface MsgEvent {
  type: "message";
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

/** 共有されたメッセージ */
interface SharedMsg {
  text: string;
  author: string;
  ts: string;
  channel: string;
  url: string;
  threadTs?: string; // スレッド内のメッセージなら親の ts
}
/** 本文中の Slack パーマリンク（共有メッセージはこの形で届く。カードは後から非同期で付くので本文から読む） */
const PERMALINK_RE = /<?(https:\/\/[\w.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?[^|>\s]*)?)(?:\|[^>]*)?>?/;
function parsePermalink(text: string): { url: string; channel: string; ts: string; threadTs?: string; rest: string } | undefined {
  const m = PERMALINK_RE.exec(text);
  if (!m) return undefined;
  const url = m[1]!.replace(/&amp;/g, "&");
  const threadTs = /[?&]thread_ts=([\d.]+)/.exec(url)?.[1];
  const rest = text.replace(m[0], "").trim();
  return { url, channel: m[2]!, ts: `${m[3]}.${m[4]}`, ...(threadTs ? { threadTs } : {}), rest };
}

interface ThreadState {
  phase: "proposed" | "booked" | "pending" | "done";
  slots?: Array<{ id: number; start: string; end: string }>;
  pendingId?: number;
  /** confirm モード: 承認されたら登録する予定 */
  book?: { slot: { id: number; start: string; end: string }; title: string };
}

const IGNORED_SUBTYPES = new Set(["message_changed", "message_deleted", "channel_join", "channel_leave", "thread_broadcast"]);
const MENTION_RE = /<@([UW][A-Z0-9]+)>/g;

function parseState(raw: string): ThreadState {
  try {
    return JSON.parse(raw) as ThreadState;
  } catch {
    return { phase: "done" };
  }
}
function slotsFromState(st: ThreadState): Slot[] {
  return (st.slots ?? []).map((s) => ({ id: s.id, start: new Date(s.start), end: new Date(s.end) }));
}
function slotsToState(slots: Slot[]): NonNullable<ThreadState["slots"]> {
  return slots.map((s) => ({ id: s.id, start: s.start.toISOString(), end: s.end.toISOString() }));
}

export function registerHandlers(d: Deps): void {
  const { app, out, store, llm, characters } = d;

  // ---------------------------------------------------------------- messages
  app.event("message", async ({ event }) => {
    const ev = event as unknown as MsgEvent;
    if (ev.subtype && IGNORED_SUBTYPES.has(ev.subtype)) return;
    const isOurBot = !!ev.bot_id && ev.bot_id === d.botId;
    if (ev.bot_id && !isOurBot) return; // 他の bot は無視
    const text = (ev.text ?? "").trim();
    if (!text) return;
    if (!store.markSeen(`${ev.channel}:${ev.ts}`)) return; // 再送の重複
    console.log(`[event] ${ev.channel_type ?? "?"} ${ev.channel} ${ev.ts} ${ev.subtype ?? ""} ${isOurBot ? "(自分)" : ev.user ?? ""}: ${text.slice(0, 40)}`);

    if (ev.channel_type === "im") {
      if (isOurBot || !ev.user) return;
      await handleOwnerDm(ev.user, text, ev.thread_ts).catch(logErr("dm"));
      return;
    }

    const senderKind: SenderKind = isOurBot ? "character" : "human";
    // 投稿したのが自分のキャラなら、その主人の id を「相手」として扱う（A2A で相手側の行に主人 id を残すため）
    const senderCharacter = isOurBot ? [...characters.values()].find((c) => displayName(c) === ev.username) : undefined;
    if (senderCharacter && !ev.user) ev.user = senderCharacter.owner.slack_user_id;
    const senderId = ev.user ?? "";
    const senderName = isOurBot ? (ev.username ?? "じいや") : await out.userName(senderId);
    const rootTs = ev.thread_ts ?? ev.ts;
    const mentions = [...text.matchAll(MENTION_RE)].map((m) => m[1]!);
    const handledOwners = new Set<string>();

    // 1) じいやが絡んだスレッドへの返信は、メンションなしでも拾う
    if (ev.thread_ts) {
      for (const row of store.threadsAt(ev.channel, rootTs)) {
        const ch = characters.get(row.owner_id);
        if (!ch) continue;
        if (isOurBot && ev.username === displayName(ch)) continue; // 自分の投稿
        if (!isOurBot && senderId === row.owner_id) {
          // 本人が直接返したときは秘書は黙る。ただし文脈として覚えておく
          store.appendMessage(ev.channel, rootTs, { role: "user", sender: `${ownerName(ch)}（本人）`, content: text });
          continue;
        }
        if (mentions.length > 0 && !mentions.includes(row.owner_id) && !isOurBot) continue; // 他の人宛て
        const st = parseState(row.state);
        if (st.phase === "pending") {
          // 本人に聞いてる最中。追加の発言は文脈に入れるだけ（返事は本人の答え待ち）
          store.appendMessage(ev.channel, rootTs, { role: "user", sender: senderName, content: text.replace(MENTION_RE, "").trim() });
          handledOwners.add(ch.owner.slack_user_id);
          continue;
        }
        if (senderKind === "character" && row.depth >= config.a2aMaxDepth) {
          await out.dm(ch, say(ch, "a2a_long", { sender: senderName }));
          continue;
        }
        if (senderKind === "character" && st.phase === "booked") {
          // 相手のじいやが「入れました」と言ってきた → 締めの一言だけ返して終わり（定型文。これ以上は続けない）
          handledOwners.add(ch.owner.slack_user_id);
          await closeA2A(ch, ev, rootTs, row).catch(logErr("close"));
          continue;
        }
        if (senderKind === "character" && st.phase === "done") continue;
        if (senderKind === "character" && senderCharacter && senderBooked(ev, rootTs, senderCharacter)) {
          // 相手のじいやが予定を作って招待済み → こちらは入れずに締める。主人には招待が届く
          handledOwners.add(ch.owner.slack_user_id);
          await acceptInvite(ch, ev, rootTs, row, senderName).catch(logErr("invite"));
          continue;
        }
        handledOwners.add(ch.owner.slack_user_id);
        const slots = st.phase === "proposed" ? slotsFromState(st) : undefined;
        await dispatch(ch, { ev, rootTs, text, senderName, senderKind, ...(slots ? { slots } : {}), depth: row.depth + (senderKind === "character" ? 1 : 0) }).catch(logErr("thread"));
      }
    }

    // 1') A2A: じいやがスレッドに投稿したら、そのスレッドの相手が主人（キャラ持ち）なら相手のじいやが受ける
    if (isOurBot) console.log(`[a2a] username=${ev.username} character=${senderCharacter?.id ?? "?"} thread=${ev.thread_ts ?? "-"} rows=${store.threadsAt(ev.channel, rootTs).map((r) => `${r.owner_id}>${r.counterpart_id}`).join(",")}`);
    if (ev.thread_ts && senderCharacter) {
      let rows = store.threadsAt(ev.channel, rootTs).filter((r) => r.owner_id === senderCharacter.owner.slack_user_id);
      if (rows.length === 0) {
        // 投稿側の状態書き込みと競合したかもしれない → 少し待ってもう一度
        await new Promise((r) => setTimeout(r, 1500));
        rows = store.threadsAt(ev.channel, rootTs).filter((r) => r.owner_id === senderCharacter.owner.slack_user_id);
      }
      for (const row of rows) {
        const other = characters.get(row.counterpart_id);
        if (!other || handledOwners.has(other.owner.slack_user_id)) continue;
        if (row.depth >= config.a2aMaxDepth) {
          await out.dm(other, say(other, "a2a_long", { sender: senderName }));
          continue;
        }
        const own = store.getThread(ev.channel, rootTs, other.owner.slack_user_id);
        const st = own ? parseState(own.state) : undefined;
        if (st?.phase === "pending") continue; // 相手側は主人の答え待ち
        if (st?.phase === "booked" && own) {
          handledOwners.add(other.owner.slack_user_id);
          await closeA2A(other, ev, rootTs, own).catch(logErr("close"));
          continue;
        }
        if (st?.phase === "done") continue;
        if (senderBooked(ev, rootTs, senderCharacter)) {
          handledOwners.add(other.owner.slack_user_id);
          const ownRow = own ?? { channel: ev.channel, thread_ts: rootTs, owner_id: other.owner.slack_user_id, counterpart_id: senderCharacter.owner.slack_user_id, counterpart_kind: "character" as const, state: "{}", depth: row.depth + 1, updated_at: 0 };
          await acceptInvite(other, ev, rootTs, ownRow, senderName).catch(logErr("invite"));
          continue;
        }
        const slots = st?.phase === "proposed" ? slotsFromState(st) : undefined;
        handledOwners.add(other.owner.slack_user_id);
        await dispatch(other, { ev, rootTs, text, senderName, senderKind: "character", ...(slots ? { slots } : {}), depth: row.depth + 1 }).catch(logErr("a2a"));
      }
    }

    // 2) 新しいメンション
    for (const uid of new Set(mentions)) {
      const ch = characters.get(uid);
      if (!ch || uid === senderId || handledOwners.has(uid)) continue;
      if (isOurBot && ev.username === displayName(ch)) continue;
      await dispatch(ch, { ev, rootTs, text, senderName, senderKind, depth: senderKind === "character" ? 1 : 0 }).catch(logErr("mention"));
    }
  });

  // ---------------------------------------------------------------- 主人優先、不在なら執事
  interface Job {
    ev: MsgEvent;
    rootTs: string;
    incoming: string;
    senderName: string;
    senderKind: SenderKind;
    depth: number;
    result: AgentResult; // pending のみ入る
  }
  const queueKey = (ch: Character, ev: MsgEvent) => `${ev.channel}:${ev.ts}:${ch.owner.slack_user_id}`;
  const inflight = new Map<string, Promise<AgentResult>>(); // 判断中の件
  const summoned = new Set<string>(); // 判断が終わる前に「任せる」が押された件
  const handled = new Set<string>(); // 自律で返した件（ボタンが後から押されたとき用）

  async function dispatch(ch: Character, job: { ev: MsgEvent; rootTs: string; text: string; senderName: string; senderKind: SenderKind; slots?: Slot[]; depth: number }, force = false): Promise<void> {
    return handleMention(ch, job.ev, job.rootTs, job.text, job.senderName, job.senderKind, job.slots, job.depth, force);
  }

  /** 主人が離席中か（presence=away）。取れなければ在席扱い */
  async function ownerAway(ch: Character): Promise<boolean> {
    try {
      const pr = await app.client.users.getPresence({ user: ch.owner.slack_user_id });
      return pr.presence === "away";
    } catch (e) {
      logErr("presence")(e);
      return false;
    }
  }

  setInterval(() => {
    for (const row of store.takeDue(Date.now())) {
      const { owner, job } = JSON.parse(row.payload) as { owner: string; job: Job };
      const ch = characters.get(owner);
      if (!ch) continue;
      // 期限切れ（24時間）: 主人が自分で対応したとみなして破棄
      console.log(`[wait] ${displayName(ch)}: 控えていた件を破棄 (${job.ev.channel}/${job.ev.ts})`);
    }
  }, 15_000).unref();

  // ショートカット「じいやに任せる」: 待たずに今すぐ動く / 「じいやは下がって」: 待機を取り消す
  app.shortcut("summon", async ({ ack, shortcut }) => {
    await ack();
    const sc = shortcut as MessageShortcut;
    console.log(`[summon] by ${sc.user.id} on ${sc.channel.id}/${sc.message.ts}: ${(sc.message.text ?? "").slice(0, 40)}`);
    const ch = characters.get(sc.user.id);
    if (!ch) return;
    const m = sc.message;
    if (!m.ts || m.user === ch.owner.slack_user_id) return; // 自分の発言には呼べない
    const ev: MsgEvent = { type: "message", channel: sc.channel.id, ts: m.ts, ...(m.user ? { user: m.user } : {}), text: m.text ?? "", ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}) };
    const queued = store.takeQueued(queueKey(ch, ev));
    if (queued) {
      // 考え済みで主人の返事を待っていた → 待たずに出す
      const { job } = JSON.parse(queued) as { job: Job };
      await applyResult(ch, job.result, job.ev, job.rootTs, job.incoming, job.senderName, job.senderKind, job.depth, true).catch(logErr("summon"));
      return;
    }
    const rootTs = m.thread_ts ?? m.ts;
    const senderName = m.user ? await out.userName(m.user) : "相手";
    const row = store.getThread(ev.channel, rootTs, ch.owner.slack_user_id);
    const st = row ? parseState(row.state) : undefined;
    const slots = st?.phase === "proposed" ? slotsFromState(st) : undefined;
    await dispatch(ch, { ev, rootTs, text: ev.text ?? "", senderName, senderKind: "human", ...(slots ? { slots } : {}), depth: 0 }, true).catch(logErr("summon"));
  });
  // /jiiya: このチャンネルで待機中の件を今すぐ出す / 下がって / 状況
  app.command("/jiiya", async ({ ack, command, respond }) => {
    await ack();
    const ch = characters.get(command.user_id);
    if (!ch) {
      await respond({ response_type: "ephemeral", text: "あなたのじいやは登録されていません（characters/*.yaml）" });
      return;
    }
    const arg = (command.text ?? "").trim();
    const queued = store.queuedIn(command.channel_id, ch.owner.slack_user_id);
    const describe = (payload: string) => {
      const { job } = JSON.parse(payload) as { job: Job };
      const kind = job.result.kind === "pending" ? job.result.pendingKind : job.result.kind;
      return `• ${withHonorific(ch, job.senderName)}: ${job.incoming.slice(0, 40)} （${kind}）`;
    };
    if (/下が|やめ|cancel|off/i.test(arg)) {
      for (const q of queued) store.cancelQueued(q.key);
      await respond({ response_type: "ephemeral", text: queued.length ? `${queued.length}件、控えました。` : "待機中の件はございません。" });
      return;
    }
    if (/状況|status|一覧/i.test(arg)) {
      await respond({ response_type: "ephemeral", text: queued.length ? `待機中 ${queued.length}件:\n${queued.map((q) => describe(q.payload)).join("\n")}` : "待機中の件はございません。" });
      return;
    }
    if (queued.length === 0) {
      await respond({ response_type: "ephemeral", text: "待機中の件はございません。特定のメッセージなら「⋯」→「じいやに任せる」でお呼びください。" });
      return;
    }
    for (const q of queued) {
      const payload = store.takeQueued(q.key);
      if (!payload) continue;
      const { job } = JSON.parse(payload) as { job: Job };
      await applyResult(ch, job.result, job.ev, job.rootTs, job.incoming, job.senderName, job.senderKind, job.depth, true).catch(logErr("command"));
    }
    await respond({ response_type: "ephemeral", text: `${queued.length}件、すぐに対応いたします。` });
  });

  // スレッド内の「あなたにだけ表示」ボタン
  app.action<BlockAction<ButtonAction>>(/^eph:/, async ({ ack, action, body, respond }) => {
    await ack();
    const ch = characters.get(body.user.id);
    const key = action.value ?? "";
    if (!ch || !key.endsWith(`:${ch.owner.slack_user_id}`)) return; // 自分のじいやの件だけ
    if (action.action_id === "eph:summon") {
      if (inflight.has(key)) {
        // まだ判断中 → 終わり次第すぐ実行するよう印を付ける
        summoned.add(key);
        await respond({ replace_original: true, text: say(ch, "standby_ack") });
        return;
      }
      const payload = store.takeQueued(key);
      if (!payload) {
        await respond({ replace_original: true, text: handled.has(key) ? say(ch, "already_done") : say(ch, "nothing_to_dismiss") });
        return;
      }
      await respond({ delete_original: true });
      const { job } = JSON.parse(payload) as { job: Job };
      await applyResult(ch, job.result, job.ev, job.rootTs, job.incoming, job.senderName, job.senderKind, job.depth, true).catch(logErr("eph"));
    } else {
      summoned.delete(key);
      store.cancelQueued(key);
      await respond({ delete_original: true });
    }
  });

  app.shortcut("dismiss", async ({ ack, shortcut }) => {
    await ack();
    const sc = shortcut as MessageShortcut;
    console.log(`[dismiss] by ${sc.user.id} on ${sc.channel.id}/${sc.message.ts}`);
    const ch = characters.get(sc.user.id);
    if (!ch || !sc.message.ts) return;
    const ev: MsgEvent = { type: "message", channel: sc.channel.id, ts: sc.message.ts };
    const cancelled = store.cancelQueued(queueKey(ch, ev));
    await out.dm(ch, cancelled ? say(ch, "dismissed") : say(ch, "nothing_to_dismiss"));
  });

  async function handleMention(
    ch: Character,
    ev: MsgEvent,
    rootTs: string,
    text: string,
    senderName: string,
    senderKind: SenderKind,
    proposedSlots: Slot[] | undefined,
    depth: number,
    force = false, // true: 主人の在席に関わらずすぐ動く（離席中・ショートカット）
  ): Promise<void> {
    const incoming = text.replace(MENTION_RE, "").trim();
    let history = store.threadHistory(ev.channel, rootTs);
    // A2A: 相手のじいやの投稿は履歴に既に入っている（投稿側が先に書く）ので二重にしない
    const last = history.at(-1);
    const norm = (t: string) => stripSelfClaimedLabels(t).replace(/\s+/g, "");
    if (last && norm(last.content) === norm(incoming)) history = history.slice(0, -1);
    else store.appendMessage(ev.channel, rootTs, { role: "user", sender: senderName, content: incoming });

    // 締めの言葉には LLM を呼ばず一言だけ（新規メンションでなくスレッド内のときだけ）
    if (ev.thread_ts && senderKind === "human" && isClosing(incoming)) {
      await applyResult(ch, { kind: "reply", text: say(ch, "closing"), label: "" }, ev, rootTs, incoming, senderName, senderKind, depth);
      return;
    }
    // 主人が在席なら、LLM の判断を待たずに「あなたにだけ表示」のボタンを先に出す（速さ優先）
    const key = queueKey(ch, ev);
    const standby = !force && ch.wait_min > 0 && senderKind === "human" && !(await ownerAway(ch));
    if (standby) {
      const head = say(ch, "standby", { sender: senderName });
      await out
        .ephemeral(ch, ev.channel, ch.owner.slack_user_id, head, [
          { type: "section", text: { type: "mrkdwn", text: head } },
          {
            type: "actions",
            elements: [
              { type: "button", text: { type: "plain_text", text: "じいやに任せる" }, style: "primary", action_id: "eph:summon", value: key },
              { type: "button", text: { type: "plain_text", text: "自分で返す" }, action_id: "eph:dismiss", value: key },
            ],
          },
        ], ev.thread_ts) // 本文へのメンションならチャンネルに、スレッド内ならそのスレッドに出す
        .catch(logErr("ephemeral"));
    }

    const counterpartEmail = await emailOf(ev.user);
    const ctx: AgentContext = {
      owner: ch,
      incoming,
      sender: senderName,
      senderKind,
      history,
      now: new Date(),
      calendar: d.calendar,
      ...(proposedSlots && proposedSlots.length > 0 ? { proposedSlots } : {}),
      ...(counterpartEmail ? { counterpartEmail } : {}),
    };
    const run = runAgent(llm, ctx);
    inflight.set(key, run);
    let result: AgentResult;
    try {
      result = await run;
    } finally {
      inflight.delete(key);
    }
    // カレンダーで答えられるもの（候補・予約）は執事の仕事なのですぐ返す。
    // 主人の判断が要るもの（聞く・承認・引っ込む）は、主人が在席ならボタンが押されるまで控える（メンション自体が通知なので時間差 DM はしない）
    if (result.kind === "pending" && standby) {
      if (summoned.delete(key)) {
        // 判断が終わる前に「任せる」が押されていた → すぐ実行
        await applyResult(ch, result, ev, rootTs, incoming, senderName, senderKind, depth, true);
        return;
      }
      const job: Job = { ev, rootTs, incoming, senderName, senderKind, depth, result };
      store.enqueue(key, Date.now() + 24 * 60 * 60_000, { owner: ch.owner.slack_user_id, job });
      console.log(`[wait] ${displayName(ch)}: 主人が在席なので控える (${result.pendingKind})`);
      return;
    }
    if (standby) handled.add(key); // 自律で返した（ボタンを後で押されたら「済み」と答える）
    await applyResult(ch, result, ev, rootTs, incoming, senderName, senderKind, depth);
  }

  /** pending の相手（スレッド行の counterpart_id）のメール */
  async function attendeesFor(ch: Character, p: PendingRow): Promise<string[]> {
    const row = store.getThread(p.channel, p.thread_ts, ch.owner.slack_user_id);
    const email = await emailOf(row?.counterpart_id);
    return email ? [email] : [];
  }

  /** 相手（人 or じいやの主人）のメール。キャラ YAML → Slack の順 */
  async function emailOf(userId: string | undefined): Promise<string | undefined> {
    if (!userId) return undefined;
    const c = characters.get(userId);
    if (c?.owner.email) return c.owner.email;
    return out.userEmail(userId);
  }

  /** applyResult の文脈から、confirmDraft 用の仮 pending を作る */
  function syntheticPending(ch: Character, ev: MsgEvent, rootTs: string, incoming: string, senderName: string, senderKind: SenderKind): PendingRow {
    return { id: 0, owner_id: ch.owner.slack_user_id, channel: ev.channel, thread_ts: rootTs, kind: "ask", counterpart: senderName, counterpart_kind: senderKind, incoming, mention_ts: ev.ts, question: null, options_json: "[]", draft: null, permalink: null, dm_ts: null, created_at: Date.now(), resolved_at: Date.now(), answer: null };
  }

  /** DM の末尾に付ける「スレッド ↗」リンク。取れなければ空 */
  async function threadLink(channel: string, ts: string): Promise<string> {
    const url = await out.permalink(channel, ts).catch(() => "");
    return url ? `  <${url}|スレッド ↗>` : "";
  }

  /** 投稿したじいや側のスレッドが「予約済み」か */
  function senderBooked(ev: MsgEvent, rootTs: string, sender: Character): boolean {
    const r = store.getThread(ev.channel, rootTs, sender.owner.slack_user_id);
    return !!r && parseState(r.state).phase === "booked";
  }

  /** 相手のじいやが予定を作って主人を招待した → こちらは予定を作らず、締めて主人に知らせる */
  async function acceptInvite(ch: Character, ev: MsgEvent, rootTs: string, row: ThreadRow, senderName: string): Promise<void> {
    await postWithState(ch, ev, rootTs, say(ch, "invite_ack"), { ...row, state: JSON.stringify({ phase: "done" } satisfies ThreadState) });
    await out.dm(ch, `${say(ch, "invited", { sender: senderName })}${await threadLink(ev.channel, rootTs)}`);
  }

  /** じいや同士の日程調整が両側で決まった後の締め。1回だけ、定型文で */
  async function closeA2A(ch: Character, ev: MsgEvent, rootTs: string, row: ThreadRow): Promise<void> {
    await postWithState(ch, ev, rootTs, say(ch, "closing"), { ...row, state: JSON.stringify({ phase: "done" } satisfies ThreadState) });
  }

  /**
   * スレッド状態を書いてから投稿する。投稿は即イベントになって相手のじいやが読むので、状態が先。
   * 投稿に失敗したら状態を元に戻す（Slack と SQLite は別システムなので本当のアトミックにはできない。順序＋補償）
   */
  async function postWithState(ch: Character, ev: MsgEvent, rootTs: string, text: string, row: Omit<ThreadRow, "updated_at">): Promise<void> {
    const prev = store.getThread(ev.channel, rootTs, ch.owner.slack_user_id);
    store.upsertThread(row);
    store.appendMessage(ev.channel, rootTs, { role: "assistant", sender: ch.name, content: text });
    try {
      await out.postAs(ch, ev.channel, text, rootTs);
    } catch (e) {
      if (prev) store.upsertThread(prev);
      else store.deleteThread(ev.channel, rootTs, ch.owner.slack_user_id);
      throw e;
    }
  }

  async function applyResult(
    ch: Character,
    r: AgentResult,
    ev: MsgEvent,
    rootTs: string,
    incoming: string,
    senderName: string,
    senderKind: SenderKind,
    depth: number,
    summoned = false, // 主人が「任せる」を押した直後（DM の出だしを変える）
  ): Promise<void> {
    const base = { channel: ev.channel, thread_ts: rootTs, owner_id: ch.owner.slack_user_id, counterpart_id: ev.user ?? ev.username ?? "", counterpart_kind: senderKind, depth };
    switch (r.kind) {
      case "reply":
        if (r.needsApproval) {
          // LLM が書いた文はそのまま出さず、本人に確認してもらう
          await applyResult(ch, { kind: "pending", pendingKind: "approve", draft: r.text }, ev, rootTs, incoming, senderName, senderKind, depth);
          return;
        }
        await postWithState(ch, ev, rootTs, r.text, { ...base, state: JSON.stringify({ phase: "done" } satisfies ThreadState) });
        return;
      case "schedule":
        if (ch.calendar.confirm) {
          // 慎重モード: 候補を出す前に主人が見る
          await confirmDraft(ch, syntheticPending(ch, ev, rootTs, incoming, senderName, senderKind), r.text, say(ch, "confirm_propose", { sender: senderName }), r.slots);
          return;
        }
        await postWithState(ch, ev, rootTs, r.text, { ...base, state: JSON.stringify({ phase: "proposed", slots: slotsToState(r.slots) } satisfies ThreadState) });
        return;
      case "book_request": {
        // 慎重モード: 承認＝登録＋送信
        const p = syntheticPending(ch, ev, rootTs, incoming, senderName, senderKind);
        const id = store.addPending({ ...pendingBase(p), kind: "approve", question: null, options_json: "[]", draft: r.text });
        const state: ThreadState = { phase: "pending", pendingId: id, book: { slot: slotsToState([r.slot])[0]!, title: r.title } };
        store.upsertThread({ ...base, state: JSON.stringify(state) });
        const np = store.getPending(id);
        if (np) {
          const head = say(ch, "confirm_book", { sender: senderName, when: formatSlot(r.slot, ch.calendar.timezone) });
          const sent = await out.dm(ch, head, pendingBlocks(ch, np, { head }));
          store.setDmTs(id, sent.ts);
        }
        return;
      }
      case "booked": {
        await postWithState(ch, ev, rootTs, r.text, { ...base, state: JSON.stringify({ phase: "booked" } satisfies ThreadState) });
        const when = formatSlot(r.slot, ch.calendar.timezone);
        await out.dm(ch, `${say(ch, "booked", { sender: senderName, when })}${await threadLink(ev.channel, rootTs)}`);
        return;
      }
      case "pending": {
        const permalink = await out.permalink(ev.channel, ev.ts).catch(() => "");
        store.supersedeOpen(ev.channel, rootTs, ch.owner.slack_user_id); // 同じスレッドの古い質問・確認は閉じる
        const id = store.addPending({
          owner_id: ch.owner.slack_user_id,
          channel: ev.channel,
          thread_ts: rootTs,
          kind: r.pendingKind,
          counterpart: senderName,
          counterpart_kind: senderKind,
          incoming,
          mention_ts: ev.ts,
          question: r.pendingKind === "handoff" ? (r.reason ?? null) : (r.question ?? null),
          options_json: JSON.stringify(r.options ?? []),
          draft: r.draft ?? null,
          permalink,
        });
        store.upsertThread({ ...base, state: JSON.stringify({ phase: "pending", pendingId: id } satisfies ThreadState) });
        // 本人にすぐDM（聞く／承認／引っ込む）
        const p = store.getPending(id);
        if (p) {
          const head = say(ch, summoned ? `${r.pendingKind}_summoned` : r.pendingKind, { sender: senderName });
          const sent = await out.dm(ch, head, pendingBlocks(ch, p, { head }));
          store.setDmTs(id, sent.ts);
        }
        return;
      }
    }
  }

  async function fetchShared(link: NonNullable<ReturnType<typeof parsePermalink>>): Promise<SharedMsg | undefined> {
    const res = link.threadTs
      ? await app.client.conversations.replies({ channel: link.channel, ts: link.threadTs, oldest: link.ts, latest: link.ts, inclusive: true, limit: 1 })
      : await app.client.conversations.history({ channel: link.channel, latest: link.ts, oldest: link.ts, inclusive: true, limit: 1 });
    const m = (res.messages ?? []).find((x) => x.ts === link.ts) ?? res.messages?.[0];
    if (!m) return undefined;
    const author = m.user ? await out.userName(m.user) : ((m as { username?: string }).username ?? "相手");
    return { text: (m.text ?? "").trim(), author, ts: link.ts, channel: link.channel, url: link.url, ...(link.threadTs ? { threadTs: link.threadTs } : {}) };
  }

  // ---------------------------------------------------------------- owner DM
  async function handleOwnerDm(userId: string, text: string, threadTs?: string): Promise<void> {
    const ch = characters.get(userId);
    if (!ch) return;
    // 共有メッセージ（本文のパーマリンク）→ 中身を取りに行く
    let shared: SharedMsg | undefined;
    const link = parsePermalink(text);
    if (link) {
      text = link.rest;
      shared = await fetchShared(link).catch((e) => {
        logErr("shared")(e);
        return undefined;
      });
    }
    // 質問のDMにスレッドで返した → その質問への答え
    if (threadTs) {
      const p = store.pendingByDmTs(threadTs);
      if (p && !p.resolved_at && p.kind === "ask") {
        await markPressed(p, await out.dmChannelOf(userId), threadTs, text).catch(() => undefined);
        await resolveAsk(ch, p, text);
      } else if (p && !p.resolved_at && p.kind === "approve") {
        // 文面の確認に対してテキスト → 修正指示として文面を直し、もう一度確認
        await markPressed(p, await out.dmChannelOf(userId), threadTs, "直して送る", `指示: ${text}`).catch(() => undefined);
        await reviseAndConfirm(ch, p, text);
      } else {
        await out.dm(ch, say(ch, p ? "already_done" : "thread_not_found"));
      }
      return;
    }
    // トップレベルの DM: 何のことかは LLM が文脈（開いている件・直近の会話）で判断し、実行はここで行う
    const dmKey = { channel: `dm:${userId}`, thread: "dm" };
    const open = store.openPending(userId);
    const history = store.threadHistory(dmKey.channel, dmKey.thread, 10);
    store.appendMessage(dmKey.channel, dmKey.thread, { role: "user", sender: ownerName(ch), content: text });
    // 共有だけで何も書いていない → 「返し方を考えて」とみなす（LLM は呼ばない）
    const act: OwnerAction = shared && !text ? { kind: "take_over" } : await runOwnerAgent(llm, ch, open, history, text, shared);
    const dmCh = await out.dmChannelOf(userId);
    const pick = (id: number) => open.find((p) => p.id === id);
    switch (act.kind) {
      case "answer": {
        const p = pick(act.pendingId);
        if (!p) break;
        if (p.dm_ts) await markPressed(p, dmCh, p.dm_ts, act.answer).catch(() => undefined);
        await resolveAsk(ch, p, act.answer);
        return;
      }
      case "revise": {
        const p = pick(act.pendingId);
        if (!p) break;
        if (p.dm_ts) await markPressed(p, dmCh, p.dm_ts, "直して送る", `指示: ${act.instruction}`).catch(() => undefined);
        await reviseAndConfirm(ch, p, act.instruction);
        return;
      }
      case "send": {
        const p = pick(act.pendingId);
        if (!p) break;
        store.resolvePending(p.id, p.draft ?? "");
        if (p.dm_ts) await markPressed(p, dmCh, p.dm_ts, "送る").catch(() => undefined);
        await sendApproved(ch, p, p.draft ?? "");
        return;
      }
      case "skip": {
        const p = pick(act.pendingId);
        if (!p) break;
        store.resolvePending(p.id, null);
        setPhase(ch, p, "done");
        if (p.dm_ts) await markPressed(p, dmCh, p.dm_ts, "送らない").catch(() => undefined);
        await out.dm(ch, say(ch, "dismissed"));
        return;
      }
      case "draft": {
        const p = pick(act.pendingId);
        if (!p) break;
        const draft = await draftForOwner(llm, ch, p.incoming, p.question ?? "");
        await out.dm(ch, `${say(ch, "handoff_draft")}\n\`\`\`\n${draft}\n\`\`\``);
        return;
      }
      case "take_over": {
        if (!shared || !shared.ts || !shared.channel) break;
        const rootTs = shared.threadTs ?? shared.ts;
        const ev: MsgEvent = { type: "message", channel: shared.channel, ts: shared.ts, text: shared.text, ...(shared.threadTs ? { thread_ts: shared.threadTs } : {}) };
        const counterpart = shared.author || "相手";
        if (act.instruction) {
          // 主人の指示を答えとして、伝聞の文面を作って確認 → 送る
          const synthetic: PendingRow = { id: 0, owner_id: userId, channel: shared.channel, thread_ts: rootTs, kind: "ask", counterpart, counterpart_kind: "human", incoming: shared.text, mention_ts: shared.ts, question: null, options_json: "[]", draft: null, permalink: shared.url || null, dm_ts: null, created_at: Date.now(), resolved_at: Date.now(), answer: act.instruction };
          const reply = await relayAnswer(llm, ch, "human", shared.text, "", act.instruction);
          await confirmDraft(ch, synthetic, withLabel(reply, ""));
          return;
        }
        // 指示なし → じいやが考えて、文面を主人に提示（主人が DM から頼んだものは、見てから送る。日程の候補も同じ）
        store.appendMessage(ev.channel, rootTs, { role: "user", sender: counterpart, content: shared.text });
        const r = await runAgent(llm, { owner: ch, incoming: shared.text, sender: counterpart, senderKind: "human", history: store.threadHistory(ev.channel, rootTs).slice(0, -1), now: new Date(), calendar: d.calendar });
        const synthetic: PendingRow = { id: 0, owner_id: userId, channel: shared.channel, thread_ts: rootTs, kind: "ask", counterpart, counterpart_kind: "human", incoming: shared.text, mention_ts: shared.ts, question: null, options_json: "[]", draft: null, permalink: shared.url || null, dm_ts: null, created_at: Date.now(), resolved_at: Date.now(), answer: null };
        if (r.kind === "reply") {
          await confirmDraft(ch, synthetic, r.text, say(ch, "suggest_head", { sender: counterpart }));
        } else if (r.kind === "schedule") {
          await confirmDraft(ch, synthetic, r.text, say(ch, "suggest_head", { sender: counterpart }), r.slots);
        } else {
          await applyResult(ch, r, ev, rootTs, shared.text, counterpart, "human", 0);
        }
        return;
      }
      case "announce":
        text = act.request;
        break;
      case "chat":
        store.appendMessage(dmKey.channel, dmKey.thread, { role: "assistant", sender: ch.name, content: act.text });
        await out.dm(ch, act.text);
        return;
    }
    // 発信依頼
    if (!ch.announce_channel) {
      await out.dm(ch, say(ch, "no_announce_channel"));
      return;
    }
    const body = await announcementText(llm, ch, text);
    const chanId = ch.announce_channel.replace(/^#/, "");
    await out.dm(ch, `${say(ch, "announce_confirm", { channel: `#${chanId}` })}\n> ${body}`, [
      { type: "section", text: { type: "mrkdwn", text: `${say(ch, "announce_confirm", { channel: `<#${chanId}>` })}\n> ${body}` } },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "送る" }, style: "primary", action_id: "ann:send", value: body.slice(0, 1900) },
          { type: "button", text: { type: "plain_text", text: "やめる" }, action_id: "ann:cancel", value: "cancel" },
        ],
      },
    ]);
  }

  // ---------------------------------------------------------------- resolve helpers
  /** 本人の答え → 伝聞の文面を作って「こう返すよ？」と確認（承認 pending にする）。投稿はまだしない */
  /**
   * 本人が押した選択肢の action 通りに動く。ここでは LLM に「何をするか」を決めさせない。
   * relay: 伝聞の文面を作って本人に確認 / reschedule・shorten: 空きを計算して候補を投稿 / book: 予定を入れる
   */
  async function runOption(ch: Character, p: PendingRow, opt: AskOption): Promise<void> {
    store.resolvePending(p.id, `${opt.action}:${opt.label}`);
    const ev: MsgEvent = { type: "message", channel: p.channel, ts: p.mention_ts, thread_ts: p.thread_ts, user: p.counterpart };
    const tz = ch.calendar.timezone;
    switch (opt.action) {
      case "reschedule":
      case "shorten": {
        const now = new Date();
        const from = new Date(now.getTime() + 86_400_000); // 明日から
        const to = new Date(from.getTime() + 14 * 86_400_000);
        const durationMin = opt.action === "shorten" ? 15 : ch.calendar.default_duration_min;
        const busy = await d.calendar.busy(ch, from, to);
        const slots = findSlots({ rules: ch.calendar, busy, from, to, durationMin, count: ch.calendar.propose_count });
        if (slots.length === 0) {
          await confirmDraft(ch, p, say(ch, "no_slots"));
          return;
        }
        const slotsText = slots.map((s) => formatSlot(s, tz)).join("か");
        const text = opt.action === "shorten" ? say(ch, "propose_short_text", { slots: slotsText, min: durationMin }) : say(ch, "propose_text", { slots: slotsText });
        await applyResult(ch, { kind: "schedule", text: withLabel(text, "（カレンダー確認）"), slots, label: "（カレンダー確認）" }, ev, p.thread_ts, p.incoming, p.counterpart, p.counterpart_kind, 0);
        return;
      }
      case "book": {
        const row = store.getThread(p.channel, p.thread_ts, ch.owner.slack_user_id);
        const slots = row ? slotsFromState(parseState(row.state)) : [];
        const slot = slots.find((s) => s.id === opt.slot_id);
        if (!slot) {
          await resolveAsk(ch, p, opt.label); // 候補が見つからなければ、答えとして伝えるだけ
          return;
        }
        const evt = await d.calendar.createEvent(ch, slot, `${p.counterpart}と打ち合わせ`, await attendeesFor(ch, p));
        const text = say(ch, "booked_text", { when: formatSlot(slot, tz) });
        await applyResult(ch, { kind: "booked", text: withLabel(text, "（カレンダー確認）"), slot, label: "（カレンダー確認）", eventId: evt.id }, ev, p.thread_ts, p.incoming, p.counterpart, p.counterpart_kind, 0);
        return;
      }
      default:
        await resolveAsk(ch, p, opt.label);
    }
  }
  /** 本人の答え（文字）→ 伝聞の文面 → 本人が確認してから送る。ツールは使わない */
  async function resolveAsk(ch: Character, p: PendingRow, answer: string): Promise<void> {
    if (!p.resolved_at) store.resolvePending(p.id, answer);
    const reply = await relayAnswer(llm, ch, p.counterpart_kind, p.incoming, p.question ?? "", answer);
    await confirmDraft(ch, p, withLabel(reply, "")); // 本人が答えた → ラベルなし
  }
  /** 文面を承認 pending にして本人に確認。slots を渡すと、送ったあとスレッドは「候補提示済み」になる */
  async function confirmDraft(ch: Character, p: PendingRow, draft: string, headText?: string, slots?: Slot[]): Promise<void> {
    const id = store.addPending({ ...pendingBase(p), kind: "approve", question: null, options_json: "[]", draft });
    const state: ThreadState = { phase: "pending", pendingId: id, ...(slots ? { slots: slotsToState(slots) } : {}) };
    store.upsertThread({ channel: p.channel, thread_ts: p.thread_ts, owner_id: ch.owner.slack_user_id, counterpart_id: p.counterpart, counterpart_kind: p.counterpart_kind, state: JSON.stringify(state), depth: 0 });
    const np = store.getPending(id);
    if (np) {
      const head = headText ?? say(ch, "draft_confirm", { sender: p.counterpart });
      const sent = await out.dm(ch, head, pendingBlocks(ch, np, { head }));
      store.setDmTs(id, sent.ts);
    }
  }
  /** 修正指示で文面を直して、新しい承認 pending として再確認 */
  async function reviseAndConfirm(ch: Character, p: PendingRow, instruction: string): Promise<void> {
    const revised = await reviseDraft(llm, ch, p.counterpart_kind, p.incoming, p.draft ?? "", instruction);
    store.resolvePending(p.id, `revise: ${instruction}`);
    if (revised.startsWith("（本人に確認）")) {
      // 情報が足りない → 文面は作らず、自由回答の質問に切り替える
      const id = store.addPending({ ...pendingBase(p), kind: "ask", question: revised.replace(/^（本人に確認）/, "").trim(), options_json: "[]", draft: null });
      const np = store.getPending(id);
      if (np) {
        const head = say(ch, "ask", { sender: p.counterpart });
        const sent = await out.dm(ch, head, pendingBlocks(ch, np, { head }));
        store.setDmTs(id, sent.ts);
      }
      return;
    }
    const id = store.addPending({ ...pendingBase(p), kind: "approve", question: null, options_json: "[]", draft: revised });
    store.upsertThread({ channel: p.channel, thread_ts: p.thread_ts, owner_id: ch.owner.slack_user_id, counterpart_id: p.counterpart, counterpart_kind: p.counterpart_kind, state: JSON.stringify({ phase: "pending", pendingId: id } satisfies ThreadState), depth: 0 });
    const np = store.getPending(id);
    if (np) {
      const head = say(ch, "revised_confirm");
      const sent = await out.dm(ch, head, pendingBlocks(ch, np, { head }));
      store.setDmTs(id, sent.ts);
    }
  }
  function pendingBase(p: PendingRow) {
    return { owner_id: p.owner_id, channel: p.channel, thread_ts: p.thread_ts, counterpart: p.counterpart, counterpart_kind: p.counterpart_kind, incoming: p.incoming, mention_ts: p.mention_ts, permalink: p.permalink };
  }
  async function sendApproved(ch: Character, p: PendingRow, text: string): Promise<void> {
    store.resolvePending(p.id, text);
    const row0 = store.getThread(p.channel, p.thread_ts, ch.owner.slack_user_id);
    const st0 = row0 ? parseState(row0.state) : undefined;
    let body = withLabel(text, ""); // 承認済み文面はそのまま。ラベルなし
    if (st0?.book) {
      // 慎重モードの予約: 承認されたので登録してから送る
      const slot = slotsFromState({ phase: "pending", slots: [st0.book.slot] })[0]!;
      await d.calendar.createEvent(ch, slot, st0.book.title, await attendeesFor(ch, p));
      body = withLabel(text, "（カレンダー確認）");
      store.upsertThread({ channel: p.channel, thread_ts: p.thread_ts, owner_id: ch.owner.slack_user_id, counterpart_id: p.counterpart, counterpart_kind: p.counterpart_kind, state: JSON.stringify({ phase: "booked" } satisfies ThreadState), depth: row0?.depth ?? 0 });
      store.appendMessage(p.channel, p.thread_ts, { role: "assistant", sender: ch.name, content: body });
      await out.postAs(ch, p.channel, body, p.thread_ts);
      await out.dm(ch, `${say(ch, "booked", { sender: p.counterpart, when: formatSlot(slot, ch.calendar.timezone) })}${await threadLink(p.channel, p.thread_ts)}`);
      return;
    }
    if (st0?.slots && st0.slots.length > 0) body = withLabel(text, "（カレンダー確認）"); // 候補提示はカレンダー根拠
    try {
      await out.postAs(ch, p.channel, body, p.thread_ts);
    } catch (e) {
      if (e instanceof NotInChannelError) {
        await out.dm(ch, say(ch, "not_in_channel", { channel: `<#${p.channel}>` }));
        return;
      }
      throw e;
    }
    store.appendMessage(p.channel, p.thread_ts, { role: "assistant", sender: ch.name, content: body });
    if (st0?.slots && st0.slots.length > 0) {
      // 候補の文面を送った → 相手が選ぶ段階
      store.upsertThread({ channel: p.channel, thread_ts: p.thread_ts, owner_id: ch.owner.slack_user_id, counterpart_id: p.counterpart, counterpart_kind: p.counterpart_kind, state: JSON.stringify({ phase: "proposed", slots: st0.slots } satisfies ThreadState), depth: row0?.depth ?? 0 });
    } else {
      setPhase(ch, p, "done");
    }
  }
  /** pending が片付いたらスレッドを次の発言を拾える状態に戻す */
  function setPhase(ch: Character, p: PendingRow, phase: ThreadState["phase"]): void {
    store.upsertThread({ channel: p.channel, thread_ts: p.thread_ts, owner_id: ch.owner.slack_user_id, counterpart_id: p.counterpart, counterpart_kind: p.counterpart_kind, state: JSON.stringify({ phase } satisfies ThreadState), depth: 0 });
  }

  /** ボタンを押した直後に、そのDMのボタン行を「✅ 押したやつ ・ 他」に置き換える（元の質問・文面・選択肢は残す） */
  async function markPressed(p: PendingRow, channel: string, ts: string, pressed: string, note?: string): Promise<void> {
    const ch = characters.get(p.owner_id);
    if (!ch) return;
    const head = say(ch, p.kind, { sender: p.counterpart });
    const view = { head, pressed, ...(note ? { note } : {}) };
    await out.updateMessage(channel, ts, `${head} ✅ ${pressed}`, pendingBlocks(ch, p, view));
  }
  function containerOf(body: BlockAction): { channel: string; ts: string } | undefined {
    const c = body.container;
    return c.type === "message" && c.message_ts && c.channel_id ? { channel: c.channel_id, ts: c.message_ts } : undefined;
  }

  /** ボタンの action_id から pending を引く。本人以外が押したもの・済みのものは undefined */
  function pendingFromAction(actionId: string, pressedBy?: string): { p: PendingRow | undefined; arg: string } {
    const [, idStr, arg] = actionId.split(":");
    const p = store.getPending(Number(idStr));
    if (!p || p.resolved_at) return { p: undefined, arg: arg ?? "" };
    if (pressedBy && pressedBy !== p.owner_id) return { p: undefined, arg: arg ?? "" };
    return { p, arg: arg ?? "" };
  }

  // ---------------------------------------------------------------- buttons
  app.action<BlockAction<ButtonAction>>(/^ans:/, async ({ ack, action, body }) => {
    await ack();
    const { p, arg } = pendingFromAction(action.action_id, body.user.id);
    if (!p) return;
    const ch = characters.get(p.owner_id);
    if (!ch) return;
    const options = parseAskOptions(JSON.parse(p.options_json ?? "[]"));
    const opt: AskOption = options[Number(arg)] ?? { action: "relay", label: action.value ?? "" };
    store.resolvePending(p.id, `${opt.action}:${opt.label}`); // 二重押し防止：先に済みにする
    const c = containerOf(body);
    if (c) await markPressed(p, c.channel, c.ts, opt.label);
    await runOption(ch, p, opt);
  });

  app.action<BlockAction<ButtonAction>>(/^apv:/, async ({ ack, action, body, client }) => {
    await ack();
    const { p, arg } = pendingFromAction(action.action_id, body.user.id);
    if (!p) return;
    const ch = characters.get(p.owner_id);
    if (!ch) return;
    const container = body.container.type === "message" ? body.container : undefined;
    const c = containerOf(body);
    if (arg === "send") {
      store.resolvePending(p.id, p.draft ?? ""); // 二重押し防止
      if (c) await markPressed(p, c.channel, c.ts, "送る");
      await sendApproved(ch, p, p.draft ?? "");
    } else if (arg === "skip") {
      store.resolvePending(p.id, null);
      setPhase(ch, p, "done");
      if (c) await markPressed(p, c.channel, c.ts, "送らない");
    } else if (arg === "edit") {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: "modal",
          callback_id: "apv_edit",
          private_metadata: JSON.stringify({ pendingId: p.id, channel: container?.channel_id ?? "", ts: container?.message_ts ?? "" }),
          title: { type: "plain_text", text: "直して送る" },
          submit: { type: "plain_text", text: "送る" },
          close: { type: "plain_text", text: "やめる" },
          blocks: [
            {
              type: "input",
              block_id: "draft",
              label: { type: "plain_text", text: `${withHonorific(ch, p.counterpart)}への返信` },
              element: { type: "plain_text_input", action_id: "text", multiline: true, initial_value: p.draft ?? "" },
            },
          ],
        },
      });
    }
  });

  app.view("apv_edit", async ({ ack, view }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || "{}") as { pendingId: number; channel: string; ts: string };
    const p = store.getPending(meta.pendingId);
    if (!p || p.resolved_at) return;
    const ch = characters.get(p.owner_id);
    if (!ch) return;
    const text = view.state.values.draft?.text?.value ?? p.draft ?? "";
    await sendApproved(ch, p, text);
    if (meta.channel && meta.ts) await markPressed(p, meta.channel, meta.ts, "直して送る", `送った文面:\n> ${text.replace(/\n/g, "\n> ")}`);
  });

  app.action<BlockAction<ButtonAction>>(/^hnd:/, async ({ ack, action, body }) => {
    await ack();
    const { p, arg } = pendingFromAction(action.action_id, body.user.id);
    if (!p) return;
    const ch = characters.get(p.owner_id);
    if (!ch) return;
    const c = containerOf(body);
    if (c) await markPressed(p, c.channel, c.ts, arg === "draft" ? "文案を見る" : "自分で書く");
    store.resolvePending(p.id, arg);
    setPhase(ch, p, "done");
    if (arg === "draft") {
      const draft = await draftForOwner(llm, ch, p.incoming, p.question ?? "");
      await out.dm(ch, `${say(ch, "handoff_draft")}\n\`\`\`\n${draft}\n\`\`\``);
    }
  });

  app.action<BlockAction<ButtonAction>>(/^ann:/, async ({ ack, action, body }) => {
    await ack();
    const userId = body.user.id;
    const ch = characters.get(userId);
    if (!ch) return;
    const container = body.container.type === "message" ? body.container : undefined;
    const send = action.action_id === "ann:send" && !!ch.announce_channel;
    if (container?.message_ts && container.channel_id) {
      // 告知文は残して、ボタン行だけ「押したやつ」に置き換える
      const original = (body.message as { blocks?: KnownBlock[] } | undefined)?.blocks ?? [];
      const i = original.findIndex((b) => b.type === "actions");
      const labels = i >= 0 ? buttonLabels(original[i]!) : [];
      const pressed = action.text?.text ?? (send ? "送る" : "やめる");
      const blocks = [...original];
      if (i >= 0) blocks.splice(i, 1, pressedBlock(labels, pressed));
      await out.updateMessage(container.channel_id, container.message_ts, `✅ ${pressed}`, blocks);
    }
    if (send && ch.announce_channel) await out.postAs(ch, ch.announce_channel, action.value ?? "");
  });

}

function logErr(where: string) {
  return (e: unknown) => console.error(`[${where}]`, e);
}
