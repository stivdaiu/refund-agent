import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TraceMode = "silent" | "pretty" | "json";

export class Tracer {
  readonly traceId: string;
  readonly events: Record<string, unknown>[] = [];

  constructor(
    traceId?: string,
    private readonly mode: TraceMode = "silent",
  ) {
    this.traceId = traceId ?? randomUUID().replace(/-/g, "").slice(0, 12);
  }

  event(name: string, data: Record<string, unknown> = {}): void {
    const record = {
      ts: new Date().toISOString(),
      traceId: this.traceId,
      event: name,
      ...data,
    };
    this.events.push(record);
    if (this.mode === "json") console.error(JSON.stringify(record));
    if (this.mode === "pretty") console.log(prettyLine(name, data));
  }

  save(dir: string | null): string | null {
    if (!dir) return null;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.traceId}.jsonl`);
    writeFileSync(
      path,
      this.events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8",
    );
    return path;
  }
}

function prettyLine(name: string, d: Record<string, unknown>): string {
  const j = (v: unknown) => JSON.stringify(v);
  switch (name) {
    case "agent_start":
      return `▶  start ticket ${d.ticketId} (model: ${d.llm}, prompt ${d.promptVersion})`;
    case "llm_call":
      return d.ok
        ? `🤖 step ${d.step}: model asks for ${(d.toolCalls as { name: string; args: unknown }[]).map((c) => `${c.name}(${j(c.args)})`).join(", ") || "nothing"}`
        : `⚠️  step ${d.step}: AI call failed (attempt ${d.attempt}): ${d.error}`;
    case "tool_call":
      return d.ok
        ? `🔧 ${d.tool} ✓ (${d.durationMs} ms)`
        : `🔧 ${d.tool} ✗ ${d.error}`;
    case "tool_retry":
      return `↻  ${d.tool} temporary error, retry ${d.attempt}: ${d.error}`;
    case "invalid_decision":
      return `⛔ decision rejected (attempt ${d.attempt}), asking the model to fix it`;
    case "decision_proposed":
      return `📝 model proposes: ${(d.payload as { decision: string }).decision}`;
    case "guardrail":
      return `🛡  guardrail ${d.rule}${d.detail ? `: ${d.detail}` : ""}`;
    case "agent_end":
      return `■  end: ${d.decision}${d.refundAmount != null ? ` ${d.refundAmount}` : ""}${d.requiresHuman ? " (human needed)" : ""}`;
    default:
      return `•  ${name} ${j(d)}`;
  }
}
