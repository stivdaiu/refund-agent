import "dotenv/config";

export interface Settings {
  model: string;
  dataDir: string;
  traceDir: string | null;
  autoRefundLimit: number;
  maxSteps: number;
  maxLlmRetries: number;
  maxToolRetries: number;
  maxRepairAttempts: number;
  retryBaseDelayMs: number;
}

export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  const env = process.env;
  return {
    model: env.OPENAI_MODEL ?? "gpt-4o-mini",
    dataDir: env.AGENT_DATA_DIR ?? "data",
    traceDir:
      env.AGENT_TRACE_DIR === "" ? null : (env.AGENT_TRACE_DIR ?? "traces"),
    autoRefundLimit: Number(env.AUTO_REFUND_LIMIT ?? 150),
    maxSteps: Number(env.AGENT_MAX_STEPS ?? 8),
    maxLlmRetries: 3,
    maxToolRetries: 3,
    maxRepairAttempts: 2,
    retryBaseDelayMs: 500,
    ...overrides,
  };
}
