/**
 * Slack への出力をまとめる。じいやの投稿は必ずここを通す（名前・アイコン・ラベルの一貫性のため）。
 */
import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import { displayName, type Character } from "../characters/schema.js";

export class NotInChannelError extends Error {
  constructor(readonly channel: string) {
    super(`bot がチャンネル ${channel} にいません（プライベートなら招待が必要）`);
  }
}

export class SlackOut {
  private readonly nameCache = new Map<string, string>();
  private dmCache = new Map<string, string>();

  constructor(private readonly client: WebClient) {}

  /** キャラ名義でスレッド（またはチャンネル）に投稿 */
  async postAs(ch: Character, channel: string, text: string, threadTs?: string): Promise<{ ts: string }> {
    // 末尾のラベル「（カレンダー確認）」は本文に混ぜず、下の小さな行（context）に出す
    const m = /\s*[（(]カレンダー確認[)）]\s*$/.exec(text);
    const body = m ? text.slice(0, m.index).trimEnd() : text;
    const blocks: KnownBlock[] | undefined = m
      ? [
          { type: "section", text: { type: "mrkdwn", text: body } },
          { type: "context", elements: [{ type: "mrkdwn", text: ":calendar: カレンダーを確認して返しました" }] },
        ]
      : undefined;
    const res = await this.withJoin(channel, () =>
      this.client.chat.postMessage({
        channel,
        text: body,
        username: displayName(ch),
        icon_emoji: ch.slack_icon,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(blocks ? { blocks } : {}),
      }),
    );
    return { ts: res.ts ?? "" };
  }

  /** bot がそのチャンネルにいなければ、公開チャンネルなら参加して再試行。プライベートなら NotInChannelError */
  private async withJoin<T>(channel: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!String(e).includes("not_in_channel")) throw e;
      try {
        await this.client.conversations.join({ channel });
      } catch {
        throw new NotInChannelError(channel);
      }
      return await fn();
    }
  }

  /** 本人へのDM。ボタン付きなら blocks を渡す */
  async dm(ch: Character, text: string, blocks?: KnownBlock[]): Promise<{ channel: string; ts: string }> {
    const dmChannel = await this.dmChannelOf(ch.owner.slack_user_id);
    const res = await this.client.chat.postMessage({
      channel: dmChannel,
      text,
      username: ch.name,
      icon_emoji: ch.slack_icon,
      ...(blocks ? { blocks } : {}),
    });
    return { channel: dmChannel, ts: res.ts ?? "" };
  }

  /** 特定の人にだけ見えるメッセージ（スレッド内にも出せる）。履歴には残らない */
  async ephemeral(ch: Character, channel: string, user: string, text: string, blocks?: KnownBlock[], threadTs?: string): Promise<void> {
    await this.withJoin(channel, () =>
      this.client.chat.postEphemeral({
        channel,
        user,
        text,
        username: ch.name,
        icon_emoji: ch.slack_icon,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(blocks ? { blocks } : {}),
      }),
    );
  }

  async updateMessage(channel: string, ts: string, text: string, blocks?: KnownBlock[]): Promise<void> {
    await this.client.chat.update({ channel, ts, text, ...(blocks ? { blocks } : { blocks: [] }) });
  }

  async permalink(channel: string, ts: string): Promise<string> {
    const res = await this.client.chat.getPermalink({ channel, message_ts: ts });
    return res.permalink ?? "";
  }

  /** メールアドレス（users:read.email が要る。取れなければ undefined） */
  async userEmail(userId: string): Promise<string | undefined> {
    try {
      const res = await this.client.users.info({ user: userId });
      return res.user?.profile?.email ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** 人間の表示名（キャッシュ） */
  async userName(userId: string): Promise<string> {
    const cached = this.nameCache.get(userId);
    if (cached) return cached;
    try {
      const res = await this.client.users.info({ user: userId });
      const name = res.user?.profile?.display_name || res.user?.real_name || res.user?.name || userId;
      this.nameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  async dmChannelOf(userId: string): Promise<string> {
    const cached = this.dmCache.get(userId);
    if (cached) return cached;
    const res = await this.client.conversations.open({ users: userId });
    const id = res.channel?.id ?? "";
    this.dmCache.set(userId, id);
    return id;
  }
}
