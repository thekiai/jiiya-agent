/**
 * 相手の発言は「データ」であって「指示」ではない。
 * LLM に渡す前に <incoming> で囲み、タグの偽装を潰す。
 */
export function wrapIncoming(text: string, sender: string): string {
  const safe = text.replace(/<\/?incoming[^>]*>/gi, "");
  const safeSender = sender.replace(/["<>]/g, "");
  return `<incoming from="${safeSender}">\n${safe}\n</incoming>`;
}

/**
 * 「ありがとう」「了解です」など締めの言葉か。短くて質問でなければ LLM を呼ばずに一言返す。
 */
export function isClosing(text: string): boolean {
  const t = text.replace(/\s+/g, "").replace(/[。、．，!！]/g, "");
  if (t.length === 0 || t.length > 20) return false;
  if (/[?？\d]|ますか|ですか|でしょうか|かな$|ください|お願いしたい|お願いできま|では|なら/.test(t)) return false;
  return /(ありがと|感謝|助かり|了解|承知|りょうかい|りょ$|わかりました|了解です|OK|おk|おっけ|はーい|はい$|よろしく|失礼します|お疲れ)/i.test(t);
}
