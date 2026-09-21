import { z } from "zod";
import { defaultPhrasesFor, fill, type PhraseKey, type Phrases } from "./phrases.js";

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "HH:MM 形式");

export const CalendarRulesSchema = z.object({
  work_hours: z.object({ start: hhmm, end: hhmm }).default({ start: "10:00", end: "19:00" }),
  buffer_min: z.number().int().min(0).default(15),
  // 例: "Fri 14:00-19:00"（曜日は Mon..Sun）
  blocked: z.array(z.string()).default([]),
  max_meetings_per_day: z.number().int().min(1).default(3),
  default_duration_min: z.number().int().min(5).default(30),
  propose_count: z.number().int().min(1).max(5).default(2),
  timezone: z.string().default("Asia/Tokyo"),
  // true: 候補提示・予約を相手に送る前に主人が承認する（承認＝登録＋送信）。false: カレンダー根拠で自律
  confirm: z.boolean().default(false),
});

export const PolicySchema = z.object({
  must_approve: z.array(z.string()).default([]),
  must_ask_owner: z.array(z.string()).default([]),
  owner_only: z.array(z.string()).default([]),
});

const CharacterBase = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().default("🤵‍♂️"), // ログや CLI での表示
  slack_icon: z.string().default(":man_in_tuxedo:"), // Slack の投稿アイコン（絵文字名）
  owner: z.object({
    slack_user_id: z.string(),
    display_name: z.string(), // 敬称なしの名前。「尾崎」
    email: z.string().optional(), // カレンダー招待用。Slack から取れないときに使う
  }),
  // 敬称。執事は主人にも相手にも「さま」。casual なキャラは「さん」
  honorific: z.string().default("さま"),
  // >0: 主人が在席中（presence=active）なら、主人にだけ見えるボタンを出して控える（時間差の DM はしない）。0: 待たずに DM。離席中は常に即 DM
  wait_min: z.number().min(0).default(10),
  // 投稿者名の肩書き。「尾崎さまのじいや」
  role_label: z.string().default("じいや"),
  // polite: 執事調（既定） / casual: ハチワレ調のタメ口 / mirror: 公開スレッドは相手に合わせる
  formality: z.enum(["mirror", "casual", "polite"]).default("polite"),
  // 性格・口調・口ぐせ・例文。書くと formality の既定の口調より優先される
  persona: z.string().optional(),
  // 本人へのDMの定型文（部分的に上書き）。キーは phrases.ts を参照。既定は formality に応じた文
  phrases: z.record(z.string(), z.string()).default({}),
  // 本人から「みんなに伝えて」と言われたときの既定の投稿先（チャンネルID or 名前）
  announce_channel: z.string().optional(),
  policy: PolicySchema.default(() => PolicySchema.parse({})),
  calendar: CalendarRulesSchema.default(() => CalendarRulesSchema.parse({})),
});

export const CharacterSchema = CharacterBase.transform((c) => ({
  ...c,
  phrases: { ...defaultPhrasesFor(c.formality), ...c.phrases } as Phrases,
}));

export type Character = z.infer<typeof CharacterSchema>;
export type CalendarRules = z.infer<typeof CalendarRulesSchema>;
export type Policy = z.infer<typeof PolicySchema>;

/** 本人の呼び名（敬称つき）。「尾崎さま」 */
export function ownerName(ch: Character): string {
  return `${ch.owner.display_name}${ch.honorific}`;
}
/** 相手の呼び名（敬称つき）。相手がじいや（「〇〇さまのじいや」）なら既に敬称を含むので付けない */
export function withHonorific(ch: Character, name: string): string {
  if (/さま|さん|様/.test(name)) return name;
  return `${name}${ch.honorific}`;
}

/** Slack の投稿者名。じいやと本人を常に区別する。「尾崎さまのじいや」 */
export function displayName(ch: Character): string {
  return `${ownerName(ch)}の${ch.role_label}`;
}

/** キャラの定型文を取り出して差し込む */
export function say(ch: Character, key: PhraseKey, vars: Record<string, string | number> = {}): string {
  const v = { ...vars };
  if (typeof v.sender === "string") v.sender = withHonorific(ch, v.sender);
  return fill(ch.phrases[key], { owner: ownerName(ch), ...v });
}
