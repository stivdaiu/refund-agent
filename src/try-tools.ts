import { loadSettings } from "./config.js";
import { TicketSchema } from "./models.js";
import { CaseStore, OrderStore, PolicyIndex } from "./stores.js";
import {
  checkRefundEligibility,
  issueRefund,
  lookupOrder,
  searchPolicy,
  ToolError,
  type ToolContext,
} from "./tools.js";

const settings = loadSettings();
const orders = new OrderStore("data/orders.json");
const cases = new CaseStore();
const policies = new PolicyIndex("data/policies");

function makeContext(email: string): ToolContext {
  const ticket = TicketSchema.parse({
    ticket_id: "T-TRY",
    customer_email: email,
    subject: "test",
    body: "test",
  });
  return {
    ticket,
    today: "2026-11-10",
    settings,
    orders,
    cases,
    policies,
    sideEffectsAllowed: true,
    eligibility: new Map(),
  };
}

function attempt(label: string, fn: () => unknown) {
  try {
    console.log(`\n✅ ${label}\n`, JSON.stringify(fn(), null, 2));
  } catch (e) {
    if (e instanceof ToolError)
      console.log(`\n⛔ ${label}\n   ToolError: ${e.message}`);
    else throw e;
  }
}

const alice = makeContext("alice@example.com");
const mallory = makeContext("mallory@example.com");

attempt("1. Alice looks up her own order", () =>
  lookupOrder.run({ order_id: "ORD-1001" }, alice),
);
attempt("2. Mallory tries to look up Alice's order", () =>
  lookupOrder.run({ order_id: "ORD-1001" }, mallory),
);
attempt("3. Policy search: 'damaged item refund'", () =>
  searchPolicy.run({ query: "damaged item refund", top_k: 2 }, alice),
);
attempt("4. Refund BEFORE eligibility check", () =>
  issueRefund.run({ order_id: "ORD-1001", amount: 39.9 }, alice),
);
attempt("5. Eligibility check (damaged)", () =>
  checkRefundEligibility.run(
    { order_id: "ORD-1001", reason_category: "damaged" },
    alice,
  ),
);
attempt("6. Refund with the WRONG amount", () =>
  issueRefund.run({ order_id: "ORD-1001", amount: 500 }, alice),
);
attempt("7. Refund with the correct amount", () =>
  issueRefund.run({ order_id: "ORD-1001", amount: 39.9 }, alice),
);
attempt("8. Same refund again (must fail)", () =>
  issueRefund.run({ order_id: "ORD-1001", amount: 39.9 }, alice),
);
