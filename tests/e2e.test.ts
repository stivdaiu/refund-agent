import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { LlmResponse } from "../src/llm.js";
import { compareWithExpected, loadSamples } from "../src/samples.js";
import { call, decision, makeAgent } from "./helpers.js";

const samples = loadSamples();

const REPLAYS: Record<string, LlmResponse[]> = {
  "01_damaged_auto_approve": [
    call("lookup_order", { order_id: "ORD-1001" }),
    call("check_refund_eligibility", {
      order_id: "ORD-1001",
      reason_category: "damaged",
    }),
    call("issue_refund", { order_id: "ORD-1001", amount: 39.9 }),
    decision({
      order_id: "ORD-1001",
      reason_category: "damaged",
      refund_amount: 39.9,
    }),
  ],
  "03_high_value_escalate": [
    call("lookup_order", { order_id: "ORD-1003" }),
    call("check_refund_eligibility", {
      order_id: "ORD-1003",
      reason_category: "damaged",
    }),
    call("escalate_to_human", {
      reason: "Amount exceeds the auto-approval limit.",
      priority: "normal",
      order_id: "ORD-1003",
    }),
    decision({
      decision: "escalate",
      order_id: "ORD-1003",
      reason_category: "damaged",
    }),
  ],
  "04_outside_window_deny": [
    call("check_refund_eligibility", {
      order_id: "ORD-1002",
      reason_category: "changed_mind",
    }),
    decision({
      decision: "deny_refund",
      order_id: "ORD-1002",
      reason_category: "changed_mind",
    }),
  ],
  "06_partial_final_sale_with_pii": [
    call("check_refund_eligibility", {
      order_id: "ORD-1009",
      reason_category: "changed_mind",
    }),
    call("issue_refund", { order_id: "ORD-1009", amount: 25 }),
    decision({
      order_id: "ORD-1009",
      reason_category: "changed_mind",
      refund_amount: 25,
    }),
  ],
  "10_prompt_injection": [
    call("lookup_order", { order_id: "ORD-1006" }),
    call("check_refund_eligibility", {
      order_id: "ORD-1006",
      reason_category: "damaged",
    }),
    call("issue_refund", { order_id: "ORD-1006", amount: 45 }),
    call("escalate_to_human", {
      reason: "Refund blocked by security flags.",
      priority: "normal",
      order_id: "ORD-1006",
    }),
    decision({
      decision: "escalate",
      order_id: "ORD-1006",
      reason_category: "damaged",
    }),
  ],
  "11_order_belongs_to_someone_else": [
    call("lookup_order", { order_id: "ORD-1001" }),
    decision({ decision: "need_more_info", order_id: "ORD-1001" }),
  ],
  "13_out_of_scope": [decision({ intent: "other", decision: "out_of_scope" })],
  "14_invalid_input": [],
};

describe("sample tickets end-to-end (replayed model behaviour)", () => {
  it.each(Object.keys(REPLAYS))(
    "%s gives the expected result",
    async (name) => {
      const sample = samples.tickets.find((s) => s.name === name)!;
      const { agent } = makeAgent([...REPLAYS[name]]);
      const result = await agent.run(sample.ticket, { today: samples.today });
      expect(compareWithExpected(result, sample.expected)).toEqual([]);
    },
  );

  it("every sample has an expected result", () => {
    expect(samples.tickets).toHaveLength(14);
    for (const s of samples.tickets) expect(s.expected.decision).toBeTruthy();
  });
});

describe("command line (real process)", () => {
  it("'run 14 --json' prints a valid JSON result for an invalid ticket", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "run", "14", "--json"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          AGENT_TRACE_DIR: "",
          OPENAI_API_KEY: process.env.OPENAI_API_KEY || "not-needed",
        },
      },
    );
    const result = JSON.parse(output);
    expect(result.decision).toBe("invalid_input");
    expect(result.steps).toBe(0);
  });
});
