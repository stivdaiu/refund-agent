import type { Decision, DecisionPayload, ToolCallRecord } from "./models.js";
import type { EligibilityResult } from "./tools.js";

export const INJECTION_PATTERNS: Record<string, RegExp> = {
  ignore_instructions:
    /\b(ignore|disregard|forget|override)\b.{0,40}\b(instruction|rule|polic|prompt)/i,
  role_hijack:
    /\b(you are now|act as|pretend to be|new role|developer mode|jailbreak)\b/i,
  system_prompt_probe:
    /\b(system prompt|hidden prompt|your instructions|reveal .{0,20}prompt)\b/i,
  fake_authority:
    /\b(i am|this is) (the |an? )?(admin|administrator|developer|manager|ceo|support agent)\b/i,
  tool_coercion:
    /\b(call|use|run|execute)\b.{0,20}\b(issue_refund|escalate_to_human|lookup_order|tool|function)\b/i,
  forced_approval:
    /\b(approve|issue|process)\b.{0,30}\brefund\b.{0,30}\b(immediately|now|without|no matter)\b/i,
  tag_spoofing: /<\/?\s*(ticket|system|assistant|tool)\s*>/i,
};

const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
const TAG_RE = /<\/?\s*(ticket|system|assistant|tool)\s*>/gi;

export interface ScreenResult {
  subject: string;
  body: string;
  flags: string[];
  matchedPatterns: string[];
  blockSideEffects: boolean;
}

export function detectInjection(text: string): string[] {
  return Object.entries(INJECTION_PATTERNS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

export function redactPii(text: string): { text: string; count: number } {
  let count = 0;
  const out = text
    .replace(CARD_RE, () => (count++, "[REDACTED_CARD]"))
    .replace(IBAN_RE, () => (count++, "[REDACTED_IBAN]"));
  return { text: out, count };
}

export function screenTicket(subject: string, body: string): ScreenResult {
  const matchedPatterns = detectInjection(`${subject}\n${body}`);
  const s = redactPii(subject);
  const b = redactPii(body);
  const flags: string[] = [];
  if (matchedPatterns.length > 0) flags.push("possible_prompt_injection");
  if (s.count + b.count > 0) flags.push("pii_redacted");
  return {
    subject: s.text.replace(TAG_RE, "[tag removed]"),
    body: b.text.replace(TAG_RE, "[tag removed]"),
    flags,
    matchedPatterns,
    blockSideEffects: flags.includes("possible_prompt_injection"),
  };
}

const REPLY_TEMPLATES: Record<Exclude<Decision, "invalid_input">, string> = {
  approve_refund:
    "Good news - we've issued a refund of {amount} {currency} for order {order}. It should appear on your original payment method within 5-10 business days.",
  deny_refund:
    "Thank you for contacting us about order {order}. Unfortunately we're unable to offer a refund for this request under our refund policy. If you believe this is a mistake, just reply and a team member will take a look.",
  escalate:
    "Thanks for reaching out. We've passed your request to a senior member of our support team, who will review it and get back to you within 1 business day.",
  need_more_info:
    "Thanks for reaching out. To help, please reply with your order number (for example ORD-1234) and write from the email address used for the order.",
  order_status_info:
    "Thanks for reaching out about order {order}. We'll send you an update on its status shortly.",
  out_of_scope:
    "Thanks for your message. This inbox handles orders, returns and refunds only, so we're not able to help with this request here.",
};

export function templateReply(
  decision: Exclude<Decision, "invalid_input">,
  amount = "",
  currency = "",
  order = "your order",
) {
  return REPLY_TEMPLATES[decision]
    .replace("{amount}", amount)
    .replace("{currency}", currency)
    .replace("{order}", order);
}

const LEAK_RE =
  /(system prompt|tool call|check_refund_eligibility|issue_refund|guardrail)/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;

export function replyIsUnsafe(reply: string, customerEmail: string): boolean {
  const otherEmails = (reply.match(EMAIL_RE) ?? []).filter(
    (e) => e.toLowerCase() !== customerEmail,
  );
  return (
    otherEmails.length > 0 ||
    LEAK_RE.test(reply) ||
    new RegExp(CARD_RE.source).test(reply)
  );
}

export interface Enforced {
  decision: Exclude<Decision, "invalid_input">;
  refundAmount: number | null;
  customerReply: string;
  overrides: string[];
  requiresHuman: boolean;
  needsAutoEscalation: boolean;
}

export function enforce(
  payload: DecisionPayload,
  records: ToolCallRecord[],
  eligibility: Map<string, EligibilityResult>,
  flags: string[],
  customerEmail: string,
  currency: string,
): Enforced {
  const overrides: string[] = [];
  let decision = payload.decision;
  let amount = payload.refund_amount;

  const issued = records.filter((r) => r.tool === "issue_refund" && r.ok);
  const escalated = records.some((r) => r.tool === "escalate_to_human" && r.ok);
  const elig = payload.order_id ? eligibility.get(payload.order_id) : undefined;

  if (issued.length > 0) {
    const refund = issued[issued.length - 1].result as {
      amount: number;
      currency: string;
    };
    if (decision !== "approve_refund") {
      overrides.push(
        `A refund was issued but the AI chose '${decision}'; corrected to approve_refund.`,
      );
      decision = "approve_refund";
    }
    if (amount === null || Math.abs(amount - refund.amount) > 0.01) {
      if (amount !== null)
        overrides.push(
          `refund_amount ${amount} replaced with the issued amount ${refund.amount}.`,
        );
      amount = refund.amount;
    }
    currency = refund.currency;
  } else if (decision === "approve_refund") {
    overrides.push(
      "AI approved a refund without a successful issue_refund call; changed to escalate.",
    );
    decision = "escalate";
  } else if (decision === "deny_refund" && elig?.eligible) {
    overrides.push(
      "AI denied a refund that the eligibility check allows; changed to escalate.",
    );
    decision = "escalate";
  }

  if (decision !== "approve_refund") amount = null;

  let reply = payload.customer_reply.trim();
  const flagged = flags.includes("possible_prompt_injection");
  if (flagged) {
    overrides.push(
      "Ticket flagged as possible prompt injection; AI reply replaced with a safe template.",
    );
  } else if (overrides.length === 0 && replyIsUnsafe(reply, customerEmail)) {
    overrides.push(
      "customer_reply failed the safety check; replaced with a safe template.",
    );
  }
  if (overrides.length > 0) {
    reply = templateReply(
      decision,
      amount?.toFixed(2) ?? "",
      currency,
      payload.order_id ?? "your order",
    );
  }

  const requiresHuman = decision === "escalate" || flagged;
  return {
    decision,
    refundAmount: amount,
    customerReply: reply,
    overrides,
    requiresHuman,
    needsAutoEscalation: requiresHuman && !escalated,
  };
}
