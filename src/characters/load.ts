import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { CharacterSchema, type Character } from "./schema.js";

export function loadCharacter(path: string): Character {
  const raw = parse(readFileSync(path, "utf8"));
  return CharacterSchema.parse(raw);
}

/** characters/*.yaml を全部読む。本人の Slack user id → キャラ。 */
export function loadAllCharacters(dir = "characters"): Map<string, Character> {
  const map = new Map<string, Character>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const ch = loadCharacter(join(dir, f));
    map.set(ch.owner.slack_user_id, ch);
  }
  return map;
}
