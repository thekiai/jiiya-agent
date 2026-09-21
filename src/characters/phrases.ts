/**
 * 本人へのDMなど、ハーネスが自分で出す定型文。キャラごとに YAML の phrases: で上書きできる。
 * {sender} {when} {reason} {count} {list} {owner} {channel} を差し込む。{sender} と {owner} には敬称（honorific）が付く。
 * 既定は執事調（polite）。formality: casual のキャラはハチワレ調。
 */
export const POLITE_PHRASES = {
  ask: "{sender}からお尋ねがありました。いかがいたしましょう。",
  // 主人が「任せる」を押した直後の出だし
  ask_summoned: "承りました。{sender}へのお返事について、ひとつお伺いします。",
  approve_summoned: "承りました。{sender}への文面です。ご確認ください。",
  handoff_summoned: "承りましたが、こちらは{owner}ご自身でお返しになった方がよろしいかと存じます。",
  approve: "{sender}への返信文です。ご確認ください。",
  handoff: "{sender}から、{owner}ご自身でお返しになった方がよさそうな話が届いています。",
  draft_confirm: "{sender}には、このようにお返しします。",
  revised_confirm: "このように直しました。",
  booked: "{sender}と{when}でお約束を入れました。カレンダーをご確認ください。",
  a2a_long: "{sender}とのやり取りが長くなっています。一度ご覧ください。",
  approve_hint: "この文面でよろしいですか。",
  freeform_hint: "このDMにお返事をお書きください。",
  handoff_hint: "こちらは{owner}ご自身でお返しになるのがよいかと（{reason}）。何もお返ししていません。文案をご用意しましょうか。",
  handoff_draft: "{owner}のお名前でお送りになる文案です。お直しの上お使いください。",
  already_done: "その件はすでに片付いています。",
  thread_not_found: "このスレッドの質問が見当たりませんでした。新しいご用命は、スレッドではなく普通にお書きください。",
  which_one: "お尋ねしていることが{count}件あります。どちらへのお答えか分かるよう、その質問のスレッドにお返しください。\n{list}",
  announce_confirm: "この文面で {channel} にお伝えしてよろしいですか。",
  no_announce_channel: "お伝えする先のチャンネルが設定されていません（characters の announce_channel）。",
  // 相手の締めの言葉（ありがとう等）への一言。LLM を呼ばずにこれを返す
  closing: "こちらこそ、よろしくお願いいたします。",
  // ハーネスが候補を出すときの文（本人の指示で出し直すとき等）。{slots}
  propose_text: "{slots} が空いております。いかがでしょうか。",
  // 短縮して候補を出すとき。{slots} {min}
  propose_short_text: "{min}分でしたら {slots} が空いております。いかがでしょうか。",
  // ハーネスが予定を入れたときの文。{when}
  booked_text: "{when} でお約束を入れました。",
  // 空きが無かったとき（本人に確認する文面）
  no_slots: "直近2週間に空きがありませんでした。改めて調整させてください。",
  dismissed: "かしこまりました。その件は控えております。",
  owner_closing: "恐れ入ります。",
  not_in_channel: "{channel} にわたくしが入っておらず、お送りできませんでした。チャンネルに招待いただけますでしょうか。",
  // 主人が DM から「任せた」「何て返せばいい」と頼んだときの文案提示
  suggest_head: "{sender}には、こう返してはいかがでしょう。私からお送りすることもできます。",
  invited: "{sender}が予定を入れ、招待をお送りしています。カレンダーをご確認ください。",
  // 主人が在席中、スレッド内に「あなたにだけ表示」で出す
  standby: "{sender}よりお尋ねです。わたくしが対応いたしましょうか。",
  standby_ack: "かしこまりました。ただいま対応いたします。",
  // 相手のじいやが予定を入れて招待してきたときの、スレッドでの受け答え（受けるかどうかは主人が決めるので「伝える」まで）
  invite_ack: "承知いたしました。{owner}にその旨お伝えいたします。",
  confirm_propose: "{sender}に、この候補をお出ししてよろしいですか。",
  confirm_book: "{sender}と {when} で予定を入れ、お返事してよろしいですか。",
  nothing_to_dismiss: "その件は待機しておりませんでした。",
} as const;

export const CASUAL_PHRASES: Phrases = {
  ask: "{sender}から聞かれてるよ。教えて！",
  ask_summoned: "りょうかい！{sender}への返事、ひとつ教えて！",
  approve_summoned: "りょうかい！{sender}に返す文面、これでいい？",
  handoff_summoned: "りょうかい！でもこれは本人から返した方がよさそう",
  approve: "{sender}に返す文面、確認して！",
  handoff: "{sender}から、本人が返した方がよさそうな話が来てるよ",
  draft_confirm: "{sender}にこう返すよ！",
  revised_confirm: "こう直したよ！",
  booked: "{sender}と{when}で予定入れたよ！カレンダー見てみて！",
  a2a_long: "{sender}とのやり取りが長くなってるから、一回見てほしい！",
  approve_hint: "こんな感じで送っていい？",
  freeform_hint: "このDMに返事を書いてね",
  handoff_hint: "これは本人から返した方がよさそう（{reason}）。何も返してないよ。文案、作っとこうか？",
  handoff_draft: "{owner}の名前で送る用の文案だよ。コピーして直して使ってね！",
  already_done: "その件はもう片付いてるよ！",
  thread_not_found: "このスレッドの質問が見つからなかった…。新しく頼みたいことは、スレッドじゃなくて普通に書いてね",
  which_one: "聞いてることが{count}件あるから、どれの答えか分かるように、その質問のスレッドに返してほしい！\n{list}",
  announce_confirm: "こんな感じで {channel} に流していい？",
  no_announce_channel: "みんなに伝える先のチャンネルが設定されてないよ（characters の announce_channel）",
  closing: "こちらこそ！",
  propose_text: "{slots} が空いてるよ！どっちがいい？",
  propose_short_text: "{min}分なら {slots} が空いてるよ！",
  booked_text: "{when}で予定入れたよ！",
  no_slots: "直近2週間は空きがなくて…また改めて調整させてください！",
  dismissed: "りょうかい！その件は下がってるね",
  owner_closing: "どういたしまして！",
  not_in_channel: "{channel} にぼくが入ってなくて送れなかった…招待してほしい！",
  suggest_head: "{sender}には、こう返すのはどう？ぼくから送ることもできるよ！",
  invited: "{sender}が予定入れて招待送ってくれたよ！カレンダー見てみて！",
  standby: "{sender}から聞かれてるよ。ぼくが返そうか？",
  standby_ack: "りょうかい！すぐやるね！",
  invite_ack: "りょうかい！{owner}に伝えておくね！",
  confirm_propose: "{sender}にこの候補を出していい？",
  confirm_book: "{sender}と{when}で予定入れて返事していい？",
  nothing_to_dismiss: "その件は待ってなかったよ！",
};

export type PhraseKey = keyof typeof POLITE_PHRASES;
export type Phrases = Record<PhraseKey, string>;

export function defaultPhrasesFor(formality: "mirror" | "casual" | "polite"): Phrases {
  return formality === "casual" ? CASUAL_PHRASES : POLITE_PHRASES;
}

export function fill(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}
