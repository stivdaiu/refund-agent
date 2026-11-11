import { z } from "zod";
import type { Settings } from "./config.js";
import {
  ORDER_ID_REGEX,
  ReasonCategorySchema,
  type Order,
  type ReasonCategory,
  type Ticket,
} from "./models.js";
import {
  round2,
  type CaseStore,
  type OrderStore,
  type PolicyIndex,
} from "./stores.js";

export class ToolError extends Error {}
export class TransientToolError extends Error {}

export interface ToolContext {
  ticket: Ticket;
  today: string;
  settings: Settings;
  orders: OrderStore;
  cases: CaseStore;
  policies: PolicyIndex;
  sideEffectsAllowed: boolean;
  eligibility: Map<string, EligibilityResult>;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  args: S;
  sideEffect: boolean;
  run: (args: z.infer<S>, ctx: ToolContext) => unknown;
}

function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

const OrderId = z
  .string()
  .regex(ORDER_ID_REGEX)
  .describe("Order id, e.g. ORD-1001");

function getOwnedOrder(orderId: string, ctx: ToolContext): Order {
  const order = ctx.orders.get(orderId);

  if (
    !order ||
    order.customer_email.toLowerCase() !== ctx.ticket.customer_email
  ) {
    throw new ToolError(
      `Order ${orderId} was not found for this customer's email address.`,
    );
  }
  return order;
}

export const REFUND_WINDOWS: Record<
  Exclude<ReasonCategory, "other">,
  number
> = {
  changed_mind: 30,
  damaged: 60,
  wrong_item: 60,
  not_as_described: 60,
  late_delivery: 30,
};

export interface EligibilityResult {
  orderId: string;
  reasonCategory: ReasonCategory;
  eligible: boolean;
  amount: number;
  currency: string;
  requiresHuman: boolean;
  reasons: string[];
  policyRefs: string[];
  daysSinceDelivery?: number;
  windowDays?: number;
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

export function evaluateEligibility(
  order: Order,
  reason: ReasonCategory,
  today: string,
  autoLimit: number,
  alreadyRefunded = false,
): EligibilityResult {
  const out: EligibilityResult = {
    orderId: order.order_id,
    reasonCategory: reason,
    eligible: false,
    amount: 0,
    currency: order.currency,
    requiresHuman: false,
    reasons: [],
    policyRefs: [],
  };
  const deny = (msg: string, ref: string): EligibilityResult => {
    out.reasons.push(msg);
    out.policyRefs.push(ref);
    return out;
  };

  if (alreadyRefunded || order.refunded_amount > 0) {
    return deny(
      "This order has already been refunded.",
      "refund_policy#one-refund-per-order",
    );
  }
  if (order.status !== "delivered" || !order.delivered_at) {
    return deny(
      `Order is not delivered yet (status: ${order.status}).`,
      "refund_policy#eligibility",
    );
  }
  if (reason === "other") {
    out.requiresHuman = true;
    return deny(
      "Reason does not match a standard refund category; needs human review.",
      "refund_policy#exceptions",
    );
  }

  const days = daysBetween(order.delivered_at, today);
  const window = REFUND_WINDOWS[reason];
  out.daysSinceDelivery = days;
  out.windowDays = window;
  if (days > window) {
    return deny(
      `Request is ${days} days after delivery; the window for '${reason}' is ${window} days.`,
      "refund_policy#refund-windows",
    );
  }

  let amount: number;
  if (reason === "late_delivery") {
    if (!order.delivered_late) {
      return deny(
        "Carrier records show the order was delivered on time.",
        "shipping_policy#late-deliveries",
      );
    }
    amount = order.shipping_fee;
    out.policyRefs.push("shipping_policy#late-deliveries");
  } else {
    let items = order.items;
    if (reason === "changed_mind") {
      items = items.filter((i) => !i.final_sale);
      if (items.length === 0) {
        return deny(
          "All items are final sale and cannot be returned for a change of mind.",
          "refund_policy#final-sale-items",
        );
      }
      if (items.length < order.items.length) {
        out.reasons.push(
          "Final-sale items were excluded from the refund amount.",
        );
        out.policyRefs.push("refund_policy#final-sale-items");
      }
    }
    amount = items.reduce((sum, i) => sum + i.unit_price * i.qty, 0);
    out.policyRefs.push("refund_policy#refund-windows");
    if (reason === "damaged")
      out.policyRefs.push("damaged_items#damaged-or-defective-items");
  }

  out.eligible = true;
  out.amount = round2(amount);
  out.reasons.unshift(
    `Within the ${window}-day window (${days} days since delivery).`,
  );
  if (out.amount > autoLimit) {
    out.requiresHuman = true;
    out.reasons.push(
      `Amount ${out.amount.toFixed(2)} exceeds the auto-approval limit of ${autoLimit.toFixed(2)}.`,
    );
    out.policyRefs.push("refund_policy#approval-limits");
  }
  return out;
}

export const lookupOrder = defineTool({
  name: "lookup_order",
  description:
    "Fetch a customer's order (status, items, dates, totals). Verifies the order belongs to the customer.",
  args: z.strictObject({ order_id: OrderId }),
  sideEffect: false,
  run: ({ order_id }, ctx) => {
    const o = getOwnedOrder(order_id, ctx);
    return {
      orderId: o.order_id,
      status: o.status,
      orderDate: o.order_date,
      deliveredAt: o.delivered_at,
      carrierEta: o.carrier_eta ?? null,
      items: o.items.map((i) => ({
        name: i.name,
        unitPrice: i.unit_price,
        qty: i.qty,
        finalSale: i.final_sale,
      })),
      shippingFee: o.shipping_fee,
      total: o.total,
      currency: o.currency,
      alreadyRefunded: o.refunded_amount > 0 || ctx.cases.hasRefund(o.order_id),
    };
  },
});

export const searchPolicy = defineTool({
  name: "search_policy",
  description:
    "Search the store's refund and shipping policies. Returns matching sections with a ref to cite.",
  args: z.strictObject({
    query: z.string().min(3).max(200),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe("How many sections to return (1-5)"),
  }),
  sideEffect: false,
  run: ({ query, top_k }, ctx) => ({
    results: ctx.policies.search(query, top_k),
  }),
});

export const checkRefundEligibility = defineTool({
  name: "check_refund_eligibility",
  description:
    "Deterministically check if an order can be refunded for a reason, and the exact refundable amount.",
  args: z.strictObject({
    order_id: OrderId,
    reason_category: ReasonCategorySchema,
  }),
  sideEffect: false,
  run: ({ order_id, reason_category }, ctx) => {
    const o = getOwnedOrder(order_id, ctx);
    const result = evaluateEligibility(
      o,
      reason_category,
      ctx.today,
      ctx.settings.autoRefundLimit,
      ctx.cases.hasRefund(o.order_id),
    );
    ctx.eligibility.set(o.order_id, result); // remembered so issue_refund can verify it
    return result;
  },
});

export const issueRefund = defineTool({
  name: "issue_refund",
  description:
    "Issue a refund. Only allowed after check_refund_eligibility returned eligible, for the exact eligible amount, within the auto-approval limit.",
  args: z.strictObject({
    order_id: OrderId,
    amount: z.number().positive().max(10_000),
  }),
  sideEffect: true,
  run: ({ order_id, amount }, ctx) => {
    const o = getOwnedOrder(order_id, ctx);
    const elig = ctx.eligibility.get(o.order_id);
    if (!elig)
      throw new ToolError(
        "Call check_refund_eligibility for this order before issuing a refund.",
      );
    if (!elig.eligible)
      throw new ToolError(
        `Order is not eligible for a refund: ${elig.reasons.join("; ")}`,
      );
    if (elig.requiresHuman)
      throw new ToolError(
        "Refund requires human approval; call escalate_to_human instead.",
      );
    if (Math.abs(amount - elig.amount) > 0.01) {
      throw new ToolError(
        `Amount must equal the eligible amount ${elig.amount.toFixed(2)}.`,
      );
    }
    try {
      return ctx.cases.createRefund(
        o.order_id,
        elig.amount,
        o.currency,
        ctx.ticket.ticket_id,
      );
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
  },
});

export const escalateToHuman = defineTool({
  name: "escalate_to_human",
  description: "Create a case for the human support team (tier 2).",
  args: z.strictObject({
    reason: z.string().min(5).max(500),
    priority: z.enum(["low", "normal", "high"]),
    order_id: OrderId.nullable(),
  }),
  sideEffect: false,
  run: ({ reason, priority, order_id }, ctx) =>
    ctx.cases.createEscalation(
      ctx.ticket.ticket_id,
      order_id ?? ctx.ticket.order_id ?? null,
      reason,
      priority,
    ),
});

export type AnyTool = Tool<any>;

export const ALL_TOOLS: AnyTool[] = [
  lookupOrder,
  searchPolicy,
  checkRefundEligibility,
  issueRefund,
  escalateToHuman,
];
