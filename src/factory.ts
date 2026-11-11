import { join } from "node:path";
import { RefundAgent } from "./agent.js";
import { loadSettings, type Settings } from "./config.js";
import { OpenAiLlm, type LlmClient } from "./llm.js";
import { CaseStore, OrderStore, PolicyIndex } from "./stores.js";

export function buildAgent(
  options: { settings?: Settings; llm?: LlmClient; cases?: CaseStore } = {},
) {
  const settings = options.settings ?? loadSettings();
  const cases = options.cases ?? new CaseStore();
  const agent = new RefundAgent({
    settings,
    llm: options.llm ?? new OpenAiLlm(settings.model),
    orders: new OrderStore(join(settings.dataDir, "orders.json")),
    cases,
    policies: new PolicyIndex(join(settings.dataDir, "policies")),
  });
  return { agent, cases, settings };
}
