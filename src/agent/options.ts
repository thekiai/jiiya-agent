/**
 * 本人に出す選択肢。表示文（label）は LLM が状況に合わせて作るが、
 * 押した後に何が起きるか（action）はこの4種類だけ。押された後は LLM に再解釈させず、ハーネスが action 通りに動く。
 */
export const ASK_ACTIONS = ["relay", "reschedule", "shorten", "book"] as const;
export type AskAction = (typeof ASK_ACTIONS)[number];

export interface AskOption {
  /** relay: label を本人の答えとして伝聞で伝える / reschedule: 空きから候補を出し直す / shorten: 短縮して候補を出す / book: 提示済み候補で予定を入れる */
  action: AskAction;
  label: string;
  /** book のとき、提示済み候補の id */
  slot_id?: number;
}

export function parseAskOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AskOption[] = [];
  for (const v of raw) {
    if (typeof v === "string") {
      out.push({ action: "relay", label: v });
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const label = typeof o.label === "string" ? o.label : "";
      if (!label) continue;
      const action = (ASK_ACTIONS as readonly string[]).includes(String(o.action)) ? (o.action as AskAction) : "relay";
      out.push({ action, label, ...(typeof o.slot_id === "number" ? { slot_id: o.slot_id } : {}) });
    }
  }
  return out.slice(0, 5);
}

/** 「入れました」「動かしました」など、予定を作った・変えたと主張する文か */
export function claimsCalendarAction(text: string): boolean {
  return /(予定|お約束|枠|ご予定)[^。！!]{0,12}(入れ|おさえ|押さえ|動かし|移動|変更|調整(いた|し)まし|確保)|(入れ|おさえ|押さえ)(まし|ておき|ておりま|とい)/.test(text);
}
