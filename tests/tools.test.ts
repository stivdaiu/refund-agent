import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadSettings } from "../src/config.js";
import { ToolExecutor } from "../src/executor.js";
import { TicketSchema } from "../src/models.js";
import { findOrderIds } from "../src/prompts.js";
import { CaseStore, OrderStore, PolicyIndex } from "../src/stores.js";
import {
  ALL_TOOLS,
  TransientToolError,
  type AnyTool,
  type ToolContext,
} from "../src/tools.js";
import { Tracer } from "../src/tracer.js";
import { TODAY } from "./helpers.js";

const orders = new OrderStore("data/orders.json");
const policies = new PolicyIndex("data/policies");

function context(
  email = "alice@example.com",
  sideEffectsAllowed = true,
): ToolContext {
  return {
    ticket: TicketSchema.parse({
      ticket_id: "T-TEST",
      customer_email: email,
      subject: "s",
      body: "b",
    }),
    today: TODAY,
    settings: loadSettings({ traceDir: null, retryBaseDelayMs: 0 }),
    orders,
    cases: new CaseStore(),
    policies,
    sideEffectsAllowed,
    eligibility: new Map(),
  };
}
const executor = (tools: AnyTool[] = ALL_TOOLS) =>
  new ToolExecutor(tools, new Tracer(), async () => {});

describe("ownership and argument validation", () => {
  it("a customer can see their own order", async () => {
    const r = await executor().execute(
      1,
      "lookup_order",
      { order_id: "ORD-1001" },
      context(),
    );
    expect(r.ok).toBe(true);
  });

  it("another customer gets the same 'not found' message (no order enumeration)", async () => {
    const r = await executor().execute(
      1,
      "lookup_order",
      { order_id: "ORD-1001" },
      context("mallory@example.com"),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });

  it("rejects invalid arguments and unknown tools without crashing", async () => {
    const bad = await executor().execute(
      1,
      "lookup_order",
      { order_id: "1001; DROP TABLE" },
      context(),
    );
    expect(bad.error).toContain("Invalid arguments");
    const unknown = await executor().execute(
      1,
      "delete_database",
      {},
      context(),
    );
    expect(unknown.error).toContain("Unknown tool");
  });
});

describe("issue_refund protects itself", () => {
  it("requires an eligibility check, the exact amount, and refunds only once", async () => {
    const ex = executor();
    const ctx = context();
    const refund = (amount: number) =>
      ex.execute(9, "issue_refund", { order_id: "ORD-1001", amount }, ctx);

    expect((await refund(39.9)).error).toContain("check_refund_eligibility");
    await ex.execute(
      1,
      "check_refund_eligibility",
      { order_id: "ORD-1001", reason_category: "damaged" },
      ctx,
    );
    expect((await refund(500)).error).toContain("must equal");
    expect((await refund(39.9)).ok).toBe(true);
    expect((await refund(39.9)).error).toContain("already");
    expect(ctx.cases.refunds.size).toBe(1);
  });

  it("refuses refunds above the auto-approval limit", async () => {
    const ex = executor();
    const ctx = context("carol@example.com");
    await ex.execute(
      1,
      "check_refund_eligibility",
      { order_id: "ORD-1003", reason_category: "damaged" },
      ctx,
    );
    const r = await ex.execute(
      2,
      "issue_refund",
      { order_id: "ORD-1003", amount: 349 },
      ctx,
    );
    expect(r.error).toContain("human approval");
  });

  it("is blocked completely for suspicious tickets, while safe tools still work", async () => {
    const ex = executor();
    const ctx = context("alice@example.com", false);
    await ex.execute(
      1,
      "check_refund_eligibility",
      { order_id: "ORD-1001", reason_category: "damaged" },
      ctx,
    );
    expect(
      (
        await ex.execute(
          2,
          "issue_refund",
          { order_id: "ORD-1001", amount: 39.9 },
          ctx,
        )
      ).error,
    ).toContain("guardrail");
    expect(
      (
        await ex.execute(
          3,
          "escalate_to_human",
          { reason: "suspicious", priority: "high", order_id: null },
          ctx,
        )
      ).ok,
    ).toBe(true);
  });
});

describe("retries for temporary failures", () => {
  const flaky = (failures: number): AnyTool => {
    let calls = 0;
    return {
      name: "lookup_order",
      description: "",
      args: z.object({}),
      sideEffect: false,
      run: () => {
        if (++calls <= failures)
          throw new TransientToolError("503 from order API");
        return { ok: true };
      },
    };
  };

  it("succeeds after temporary errors", async () => {
    const r = await executor([flaky(2)]).execute(
      1,
      "lookup_order",
      {},
      context(),
    );
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it("gives up after the maximum attempts with a clear error", async () => {
    const r = await executor([flaky(10)]).execute(
      1,
      "lookup_order",
      {},
      context(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("temporarily unavailable");
  });
});

describe("policy search and order-id extraction", () => {
  it("finds the most relevant policy section", () => {
    expect(policies.search("final sale clearance change of mind")[0].ref).toBe(
      "refund_policy#final-sale-items",
    );
    expect(policies.search("zzzz qqqq")).toEqual([]);
  });

  it("finds order ids in free text", () => {
    expect(
      findOrderIds("my order ord-1003 and ORD-1003 again, plus ORD-12"),
    ).toEqual(["ORD-1003"]);
  });
});
