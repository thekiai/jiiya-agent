/**
 * OrcaRouter（OpenAI互換）クライアント。全リクエストを llm_log に記録してコスト測定に使う。
 * ここは薄いラッパーに留め、テストでは差し替える（LlmClient インターフェース）。
 */
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { config } from "../config.js";
import type { Store } from "../store/db.js";

export type ChatMessage = ChatCompletionMessageParam;
export type ToolDef = ChatCompletionTool;

export interface ToolCallOut {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCallOut[];
  /** OpenAI 形式の assistant メッセージ（履歴に積む用） */
  assistantMessage: ChatMessage;
}

export interface ChatOptions {
  messages: ChatMessage[];
  model: string;
  tools?: ToolDef[];
  tag?: string;
  temperature?: number;
}

export interface LlmClient {
  chat(opts: ChatOptions): Promise<ChatResult>;
}

export class OrcaRouterClient implements LlmClient {
  private readonly client: OpenAI;

  constructor(private readonly store?: Store) {
    // 既定（10分・2回リトライ）だと障害時に「止まった」ように見えるので短く。フェイルオーバーは chat() 側で
    this.client = new OpenAI({ apiKey: config.orcarouter.apiKey, baseURL: config.orcarouter.baseURL, timeout: config.llmTimeoutMs, maxRetries: 1 });
  }

  /** 要求モデル → フォールバック候補の順に試す。全滅なら最後のエラーを投げる */
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const chain = [opts.model, ...config.models.fallbacks.filter((m) => m !== opts.model)];
    let lastErr: unknown;
    for (const [i, model] of chain.entries()) {
      try {
        const r = await this.chatOnce({ ...opts, model });
        if (i > 0) console.warn(`[llm] ${opts.model} が使えず ${model} にフォールバック`);
        return r;
      } catch (e) {
        lastErr = e;
        console.warn(`[llm] ${model} 失敗: ${String(e).slice(0, 120)}`);
      }
    }
    throw lastErr;
  }

  private async chatOnce(opts: ChatOptions): Promise<ChatResult> {
    const t0 = Date.now();
    const { data, response } = await this.client.chat.completions
      .create({
        model: opts.model,
        messages: opts.messages,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      })
      .withResponse();

    // OrcaRouter はルーティング先やコストをヘッダで返すことがあるので拾っておく
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      if (/^(x-orca|x-router|x-cost|openai-)/i.test(k)) headers[k] = v;
    });
    this.store?.logLlm({
      tag: opts.tag ?? "",
      requested_model: opts.model,
      served_model: data.model ?? null,
      prompt_tokens: data.usage?.prompt_tokens ?? null,
      completion_tokens: data.usage?.completion_tokens ?? null,
      latency_ms: Date.now() - t0,
      headers_json: JSON.stringify(headers),
    });

    const msg = data.choices[0]?.message;
    const toolCalls: ToolCallOut[] = [];
    for (const tc of msg?.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, args });
    }
    return {
      text: (msg?.content ?? "").trim(),
      toolCalls,
      assistantMessage: {
        role: "assistant",
        content: msg?.content ?? null,
        ...(msg?.tool_calls ? { tool_calls: msg.tool_calls } : {}),
      },
    };
  }
}
