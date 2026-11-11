import { z } from "zod";

export const ORDER_ID_REGEX = /^ORD-\d{4,8}$/;

export const TicketSchema = z.strictObject({
  ticket_id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, "only letters, digits, _ and -"),
  customer_email: z.string().trim().toLowerCase().pipe(z.email()),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
  order_id: z
    .string()
    .trim()
    .toUpperCase()
    .regex(ORDER_ID_REGEX, "must look like ORD-1234")
    .optional(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const IntentSchema = z.enum(["refund_request", "order_status", "other"]);
export type Intent = z.infer<typeof IntentSchema>;

export const DecisionSchema = z.enum([
  "approve_refund",
  "deny_refund",
  "escalate",
  "need_more_info",
  "order_status_info",
  "out_of_scope",
  "invalid_input",
]);
export type Decision = z.infer<typeof DecisionSchema>;

export const ReasonCategorySchema = z.enum([
  "damaged",
  "wrong_item",
  "not_as_described",
  "changed_mind",
  "late_delivery",
  "other",
]);
export type ReasonCategory = z.infer<typeof ReasonCategorySchema>;

export const OrderItemSchema = z.object({
  sku: z.string(),
  name: z.string(),
  unit_price: z.number().nonnegative(),
  qty: z.number().int().positive(),
  final_sale: z.boolean(),
});

export const OrderSchema = z.object({
  order_id: z.string().regex(ORDER_ID_REGEX),
  customer_email: z.string(),
  status: z.enum(["processing", "shipped", "delivered", "cancelled"]),
  order_date: z.string(),
  delivered_at: z.string().nullable(),
  carrier_eta: z.string().optional(),
  delivered_late: z.boolean(),
  items: z.array(OrderItemSchema).min(1),
  shipping_fee: z.number().nonnegative(),
  total: z.number().nonnegative(),
  currency: z.string(),
  refunded_amount: z.number().nonnegative(),
});
export type Order = z.infer<typeof OrderSchema>;

export const DecisionPayloadSchema = z.strictObject({
  intent: IntentSchema,
  decision: DecisionSchema.exclude(["invalid_input"]),
  order_id: z.string().regex(ORDER_ID_REGEX).nullable(),
  reason_category: ReasonCategorySchema.nullable(),
  refund_amount: z.number().min(0).nullable(),
  policy_refs: z.array(z.string()).max(6),
  reasons: z.array(z.string()).min(1).max(6),
  customer_reply: z.string().min(20).max(1500),
});
export type DecisionPayload = z.infer<typeof DecisionPayloadSchema>;

export interface ToolCallRecord {
  step: number;
  tool: string;
  args: unknown;
  ok: boolean;
  result?: unknown;
  error?: string;
  attempts: number;
  durationMs: number;
}

export interface AgentResult {
  traceId: string;
  ticketId: string | null;
  intent: Intent | null;
  decision: Decision;
  orderId: string | null;
  reasonCategory: ReasonCategory | null;
  refundAmount: number | null;
  requiresHuman: boolean;
  reasons: string[];
  policyRefs: string[];
  customerReply: string;
  guardrailFlags: string[];
  overrides: string[];
  toolCalls: ToolCallRecord[];
  steps: number;
  summary: string;
}
