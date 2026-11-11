import { loadSettings, type Settings } from "../src/config.js";
import { buildAgent } from "../src/factory.js";
import type { ChatMessage, LlmClient, LlmResponse } from "../src/llm.js";

export const TODAY = "2026-11-10";

export function call(name: string, args: object): LlmResponse {
  return {
    content: null,
    toolCalls: [
      {
        id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        args,
        rawArgs: JSON.stringify(args),
        argsParseError: false,
      },
    ],
  };
}

export function decision(fields: Record<string, unknown>): LlmResponse {
  return call("submit_decision", {
    intent: "refund_request",
    decision: "approve_refund",
    order_id: null,
    reason_category: null,
    refund_amount: null,
    policy_refs: [],
    reasons: ["test reason"],
    customer_reply: "Thanks for contacting us, we have handled your request.",
    ...fields,
  });
}

export class FakeLlm implements LlmClient {
  readonly name = "fake";
  readonly requests: ChatMessage[][] = [];

  constructor(private readonly script: (LlmResponse | Error)[]) {}

  async chat(messages: ChatMessage[]): Promise<LlmResponse> {
    this.requests.push(structuredClone(messages));
    const next = this.script.shift();
    if (!next)
      throw new Error(
        "FakeLlm: script is empty (the agent asked more times than expected)",
      );
    if (next instanceof Error) throw next;
    return next;
  }

  firstUserMessage(): string {
    return String(
      this.requests[0]?.find((m) => m.role === "user")?.content ?? "",
    );
  }
}

export function makeAgent(
  script: (LlmResponse | Error)[],
  overrides: Partial<Settings> = {},
) {
  const llm = new FakeLlm(script);
  const settings = loadSettings({
    traceDir: null,
    retryBaseDelayMs: 0,
    ...overrides,
  });
  const { agent, cases } = buildAgent({ llm, settings });
  return { agent, cases, llm };
}
