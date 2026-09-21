import "dotenv/config";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`環境変数 ${name} がありません（.env を確認）`);
  return v;
}

export const config = {
  orcarouter: {
    apiKey: process.env.ORCAROUTER_API_KEY ?? "",
    baseURL: env("ORCAROUTER_BASE_URL", "https://api.orcarouter.ai/v1"),
  },
  models: {
    cheap: env("MODEL_CHEAP", "deepseek/deepseek-v4.1-flash"),
    main: env("MODEL_MAIN", "orcarouter/auto"),
    strong: env("MODEL_STRONG", "anthropic/claude-opus-4.8"),
    // 要求したモデルが落ちているとき、順に試す
    fallbacks: env("MODEL_FALLBACK", "orcarouter/auto,anthropic/claude-sonnet-5").split(",").map((m) => m.trim()).filter(Boolean),
  },
  llmTimeoutMs: Number(env("LLM_TIMEOUT_MS", "45000")),
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN ?? "",
    appToken: process.env.SLACK_APP_TOKEN ?? "",
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },
  dbPath: env("DB_PATH", "data/jiiya.db"),
  maxTurns: 6,
  a2aMaxDepth: 6,
} as const;
