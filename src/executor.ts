import { z } from "zod";
import type { ToolCallRecord } from "./models.js";
import {
  ToolError,
  TransientToolError,
  type AnyTool,
  type ToolContext,
} from "./tools.js";
import type { Tracer } from "./tracer.js";

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ToolExecutor {
  private readonly tools: Map<string, AnyTool>;

  constructor(
    tools: AnyTool[],
    private readonly tracer: Tracer,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  async execute(
    step: number,
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<ToolCallRecord> {
    const started = performance.now();
    const record: ToolCallRecord = {
      step,
      tool: name,
      args: rawArgs,
      ok: false,
      attempts: 0,
      durationMs: 0,
    };

    try {
      const tool = this.tools.get(name);
      if (!tool)
        throw new ToolError(
          `Unknown tool '${name}'. Available: ${[...this.tools.keys()].join(", ")}`,
        );

      const parsed = tool.args.safeParse(rawArgs);
      if (!parsed.success)
        throw new ToolError(
          `Invalid arguments: ${z.prettifyError(parsed.error)}`,
        );

      if (tool.sideEffect && !ctx.sideEffectsAllowed) {
        this.tracer.event("guardrail", {
          rule: "side_effects_blocked",
          detail: name,
        });
        throw new ToolError(
          "Blocked by guardrail: this ticket was flagged as suspicious, so actions that move money are disabled. Escalate to a human instead.",
        );
      }

      const maxAttempts = ctx.settings.maxToolRetries;
      for (let attempt = 1; ; attempt++) {
        record.attempts = attempt;
        try {
          record.result = await tool.run(parsed.data, ctx);
          record.ok = true;
          break;
        } catch (e) {
          if (e instanceof TransientToolError && attempt < maxAttempts) {
            this.tracer.event("tool_retry", {
              tool: name,
              attempt,
              error: e.message,
            });
            await this.wait(ctx.settings.retryBaseDelayMs * 2 ** (attempt - 1)); // 500ms, 1s, 2s...
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof ToolError) record.error = e.message;
      else if (e instanceof TransientToolError)
        record.error = `Tool temporarily unavailable after ${record.attempts} attempts: ${e.message}`;
      else {
        record.error = `Internal tool error: ${(e as Error).name}`;
        this.tracer.event("tool_exception", { tool: name, error: String(e) });
      }
    }

    record.durationMs = Math.round((performance.now() - started) * 100) / 100;
    this.tracer.event("tool_call", { ...record });
    return record;
  }
}
