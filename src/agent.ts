import { z } from "zod";
import type { Settings } from "./config.js";
import { sleep, ToolExecutor } from "./executor.js";
import { enforce, screenTicket } from "./guardrails.js";
import {
  toToolSpec,
  toolSpecs,
  type ChatMessage,
  type LlmClient,
  type LlmResponse,
} from "./llm.js";
import {
  DecisionPayloadSchema,
  TicketSchema,
  type AgentResult,
  type DecisionPayload,
  type Ticket,
  type ToolCallRecord,
} from "./models.js";
import {
  findOrderIds,
  PROMPT_VERSION,
  renderUserMessage,
  SYSTEM_PROMPT,
} from "./prompts.js";
import type { CaseStore, OrderStore, PolicyIndex } from "./stores.js";
import { ALL_TOOLS, type AnyTool, type ToolContext } from "./tools.js";
import { Tracer, type TraceMode } from "./tracer.js";

const SUBMIT = "submit_decision";
const ESCALATION_REPLY =
  "Thanks for reaching out. We've passed your request to a senior member of our support team, who will review it and get back to you within 1 business day.";

export interface AgentDeps {
  settings: Settings;
  llm: LlmClient;
  orders: OrderStore;
  cases: CaseStore;
  policies: PolicyIndex;
  tools?: AnyTool[];
  wait?: (ms: number) => Promise<void>;
}

export interface RunOptions {
  today?: string;
  traceMode?: TraceMode;
}

export class RefundAgent {
  private readonly tools: AnyTool[];
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly deps: AgentDeps) {
    this.tools = deps.tools ?? ALL_TOOLS;
    this.wait = deps.wait ?? sleep;
  }

  async run(
    rawTicket: unknown,
    options: RunOptions = {},
  ): Promise<AgentResult> {
    const tracer = new Tracer(undefined, options.traceMode ?? "silent");
    const today = options.today ?? new Date().toISOString().slice(0, 10);
    const ticketId =
      (rawTicket as { ticket_id?: string } | null)?.ticket_id ?? null;
    tracer.event("agent_start", {
      ticketId,
      llm: this.deps.llm.name,
      promptVersion: PROMPT_VERSION,
      today,
    });

    let result: AgentResult;
    try {
      result = await this.process(rawTicket, today, tracer);
    } catch (e) {
      tracer.event("agent_crash", { error: String(e) });
      result = baseResult(tracer.traceId, ticketId, {
        decision: "escalate",
        requiresHuman: true,
        reasons: [`Internal error: ${(e as Error).name}`],
        customerReply: ESCALATION_REPLY,
      });
    }

    result.summary = renderSummary(result);
    tracer.event("agent_end", {
      decision: result.decision,
      refundAmount: result.refundAmount,
      requiresHuman: result.requiresHuman,
      steps: result.steps,
      overrides: result.overrides,
    });
    tracer.save(this.deps.settings.traceDir);
    return result;
  }

  private async process(
    rawTicket: unknown,
    today: string,
    tracer: Tracer,
  ): Promise<AgentResult> {
    const { settings, orders, cases, policies } = this.deps;
    const parsed = TicketSchema.safeParse(rawTicket);
    if (!parsed.success) {
      const errors = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "ticket"}: ${i.message}`,
      );
      tracer.event("guardrail", {
        rule: "invalid_input",
        detail: errors.join("; "),
      });
      return baseResult(
        tracer.traceId,
        (rawTicket as { ticket_id?: string })?.ticket_id ?? null,
        {
          decision: "invalid_input",
          reasons: errors.slice(0, 6),
        },
      );
    }
    const ticket = parsed.data;

    const screen = screenTicket(ticket.subject, ticket.body);
    const { flags, subject, body } = screen;
    if (flags.length > 0) {
      const patterns =
        screen.matchedPatterns.length > 0
          ? ` [${screen.matchedPatterns.join(", ")}]`
          : "";
      tracer.event("guardrail", {
        rule: "input_screen",
        detail: `${flags.join(", ")}${patterns}`,
      });
    }

    const ctx: ToolContext = {
      ticket,
      today,
      settings,
      orders,
      cases,
      policies,
      sideEffectsAllowed: !screen.blockSideEffects,
      eligibility: new Map(),
    };
    const executor = new ToolExecutor(this.tools, tracer, this.wait);
    const specs = [
      ...toolSpecs(this.tools),
      toToolSpec(
        SUBMIT,
        "Submit the final structured decision. Call exactly once, as the last step.",
        DecisionPayloadSchema,
      ),
    ];
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: renderUserMessage(ticket, today, flags, subject, body),
      },
    ];

    const records: ToolCallRecord[] = [];
    let decision: DecisionPayload | null = null;
    let failure: string | null = null;
    let repairs = 0;
    let steps = 0;

    while (steps < settings.maxSteps && !decision && !failure) {
      steps++;
      let response: LlmResponse;
      try {
        response = await this.callLlm(messages, specs, tracer, steps);
      } catch (e) {
        failure = `AI unavailable after ${settings.maxLlmRetries} attempts (${(e as Error).message}).`;
        break;
      }

      messages.push(assistantMessage(response));
      if (response.toolCalls.length === 0) {
        messages.push({
          role: "user",
          content:
            "You must respond by calling a tool. Finish with submit_decision.",
        });
        continue;
      }

      for (const call of response.toolCalls) {
        let content: unknown;
        if (call.argsParseError) {
          const error = "Arguments were not valid JSON. Retry with valid JSON.";
          records.push({
            step: steps,
            tool: call.name,
            args: call.rawArgs,
            ok: false,
            error,
            attempts: 0,
            durationMs: 0,
          });
          content = { ok: false, error };
        } else if (call.name === SUBMIT) {
          const check = DecisionPayloadSchema.safeParse(call.args);
          const problem = check.success
            ? consistencyProblem(check.data, records, ticket)
            : z.prettifyError(check.error);
          if (check.success && !problem) {
            decision = check.data;
            content = { ok: true, result: "Decision recorded." };
            tracer.event("decision_proposed", {
              step: steps,
              payload: check.data,
            });
          } else {
            repairs++;
            tracer.event("invalid_decision", {
              step: steps,
              attempt: repairs,
              error: problem,
            });
            content = {
              ok: false,
              error: `Decision rejected, fix it and call submit_decision again:\n${problem}`,
            };
            if (repairs > settings.maxRepairAttempts)
              failure = "The AI could not produce a valid decision.";
          }
        } else {
          const record = await executor.execute(
            steps,
            call.name,
            call.args,
            ctx,
          );
          records.push(record);
          content = record.ok
            ? { ok: true, result: record.result }
            : { ok: false, error: record.error };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(content),
        });
      }
    }
    if (!decision && !failure)
      failure = `Step limit (${settings.maxSteps}) reached without a decision.`;

    return this.finalize(
      ticket,
      ctx,
      decision,
      failure,
      records,
      flags,
      steps,
      tracer,
    );
  }

  private async callLlm(
    messages: ChatMessage[],
    specs: ReturnType<typeof toolSpecs>,
    tracer: Tracer,
    step: number,
  ) {
    const { maxLlmRetries, retryBaseDelayMs } = this.deps.settings;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxLlmRetries; attempt++) {
      const started = performance.now();
      try {
        const response = await this.deps.llm.chat(messages, specs);
        tracer.event("llm_call", {
          step,
          attempt,
          ok: true,
          latencyMs: Math.round(performance.now() - started),
          usage: response.usage,
          toolCalls: response.toolCalls.map((c) => ({
            name: c.name,
            args: c.args,
          })),
        });
        return response;
      } catch (e) {
        lastError = e;
        tracer.event("llm_call", {
          step,
          attempt,
          ok: false,
          error: String(e).slice(0, 300),
        });
        if (attempt < maxLlmRetries)
          await this.wait(retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private finalize(
    ticket: Ticket,
    ctx: ToolContext,
    decision: DecisionPayload | null,
    failure: string | null,
    records: ToolCallRecord[],
    flags: string[],
    steps: number,
    tracer: Tracer,
  ): AgentResult {
    const common = { toolCalls: records, guardrailFlags: flags, steps };

    if (!decision) {
      const reason = failure ?? "No decision.";
      const esc = this.deps.cases.createEscalation(
        ticket.ticket_id,
        ticket.order_id ?? null,
        reason,
        "high",
      );
      tracer.event("guardrail", {
        rule: "fail_safe_escalation",
        detail: `${reason} -> ${esc.escalationId}`,
      });
      return baseResult(tracer.traceId, ticket.ticket_id, {
        ...common,
        decision: "escalate",
        orderId: ticket.order_id ?? null,
        requiresHuman: true,
        reasons: [reason],
        overrides: [`Fail-safe escalation: ${reason}`],
        customerReply: ESCALATION_REPLY,
      });
    }

    const lookup = records.find((r) => r.tool === "lookup_order" && r.ok)
      ?.result as { currency?: string } | undefined;
    const enforced = enforce(
      decision,
      records,
      ctx.eligibility,
      flags,
      ticket.customer_email,
      lookup?.currency ?? "EUR",
    );
    for (const o of enforced.overrides)
      tracer.event("guardrail", { rule: "decision_override", detail: o });

    const overrides = [...enforced.overrides];
    if (enforced.needsAutoEscalation) {
      const esc = this.deps.cases.createEscalation(
        ticket.ticket_id,
        decision.order_id,
        decision.reasons.join("; ").slice(0, 500),
        "normal",
      );
      overrides.push(
        `Auto-created escalation ${esc.escalationId} for human review.`,
      );
    }

    const knownRefs = this.deps.policies.refs();
    return baseResult(tracer.traceId, ticket.ticket_id, {
      ...common,
      intent: decision.intent,
      decision: enforced.decision,
      orderId: decision.order_id,
      reasonCategory: decision.reason_category,
      refundAmount: enforced.refundAmount,
      requiresHuman: enforced.requiresHuman,
      reasons: decision.reasons,
      policyRefs: decision.policy_refs.filter((ref) => knownRefs.has(ref)),
      customerReply: enforced.customerReply,
      overrides,
    });
  }
}

function consistencyProblem(
  d: DecisionPayload,
  records: ToolCallRecord[],
  ticket: Ticket,
): string | null {
  const knownIds = ticket.order_id
    ? [ticket.order_id]
    : findOrderIds(`${ticket.subject}\n${ticket.body}`);
  const triedLookup = records.some((r) => r.tool === "lookup_order");
  if (d.decision === "need_more_info" && knownIds.length > 0 && !triedLookup) {
    return `The ticket contains order id ${knownIds.join(", ")}. Call lookup_order before asking the customer for information.`;
  }
  return null;
}

function assistantMessage(r: LlmResponse): ChatMessage {
  return {
    role: "assistant",
    content: r.content,
    ...(r.toolCalls.length > 0 && {
      tool_calls: r.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.rawArgs },
      })),
    }),
  };
}

function baseResult(
  traceId: string,
  ticketId: string | null,
  fields: Partial<AgentResult>,
): AgentResult {
  return {
    traceId,
    ticketId,
    intent: null,
    decision: "escalate",
    orderId: null,
    reasonCategory: null,
    refundAmount: null,
    requiresHuman: false,
    reasons: [],
    policyRefs: [],
    customerReply: "",
    guardrailFlags: [],
    overrides: [],
    toolCalls: [],
    steps: 0,
    summary: "",
    ...fields,
  };
}

export function renderSummary(r: AgentResult): string {
  const headline: Record<AgentResult["decision"], string> = {
    approve_refund: `APPROVED refund of ${r.refundAmount?.toFixed(2) ?? "?"}`,
    deny_refund: "DENIED refund",
    escalate: "ESCALATED to a human agent",
    need_more_info: "Asked the customer for more information",
    order_status_info: "Answered an order-status question",
    out_of_scope: "Declined: out of scope",
    invalid_input: "Rejected: invalid ticket input",
  };
  const lines = [
    `Ticket ${r.ticketId ?? "?"}: ${headline[r.decision]}${r.orderId ? ` for ${r.orderId}` : ""}.`,
  ];
  if (r.intent && r.intent !== "other") {
    lines.push(
      `Intent: ${r.intent}${r.reasonCategory ? `, reason: ${r.reasonCategory}` : ""}`,
    );
  }
  for (const reason of r.reasons) lines.push(`- ${reason}`);
  if (r.toolCalls.length > 0) {
    lines.push(
      `Tools used: ${r.toolCalls.map((t) => (t.ok ? t.tool : `${t.tool}(failed)`)).join(" -> ")}`,
    );
  }
  if (r.guardrailFlags.length > 0)
    lines.push(`Guardrail flags: ${r.guardrailFlags.join(", ")}`);
  for (const o of r.overrides) lines.push(`Override: ${o}`);
  if (r.requiresHuman) lines.push("Human review REQUIRED.");
  return lines.join("\n");
}
