import type { Character } from "../src/characters/schema.js";
import type { Interval } from "../src/calendar/rules.js";
import type { CalendarPort } from "../src/agent/types.js";
import type { ChatOptions, ChatResult, LlmClient, ToolCallOut } from "../src/llm/client.js";

/** 順番に返事を返す LLM。テスト用。 */
export class ScriptedLlm implements LlmClient {
  readonly calls: ChatOptions[] = [];
  private i = 0;
  constructor(private readonly script: Array<{ text?: string; tools?: Array<[string, Record<string, unknown>]> }>) {}
  async chat(opts: ChatOptions): Promise<ChatResult> {
    this.calls.push(opts);
    const step = this.script[this.i++];
    if (!step) throw new Error("script exhausted");
    const toolCalls: ToolCallOut[] = (step.tools ?? []).map(([name, args], k) => ({ id: `call_${this.i}_${k}`, name, args }));
    return {
      text: step.text ?? "",
      toolCalls,
      assistantMessage: {
        role: "assistant",
        content: step.text ?? null,
        ...(toolCalls.length
          ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      },
    };
  }
}

export class FakeCalendar implements CalendarPort {
  created: Array<{ slot: Interval; title: string }> = [];
  constructor(private readonly busyIntervals: Interval[] = []) {}
  async busy(): Promise<Interval[]> {
    return this.busyIntervals;
  }
  async createEvent(_o: Character, slot: Interval, title: string) {
    this.created.push({ slot, title });
    return { id: `evt_${this.created.length}` };
  }
}
