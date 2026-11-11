import { readFileSync } from "node:fs";
import { z } from "zod";
import { DecisionSchema, type AgentResult } from "./models.js";

const SampleFileSchema = z.object({
  today: z.string(),
  tickets: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      ticket: z.unknown(),
      expected: z.object({
        decision: DecisionSchema,
        refundAmount: z.number().nullable().optional(),
        requiresHuman: z.boolean().optional(),
        flags: z.array(z.string()).optional(),
      }),
    }),
  ),
});
export type SampleFile = z.infer<typeof SampleFileSchema>;
export type Sample = SampleFile["tickets"][number];

export function loadSamples(path = "samples/tickets.json"): SampleFile {
  return SampleFileSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

export function compareWithExpected(
  result: AgentResult,
  expected: Sample["expected"],
): string[] {
  const problems: string[] = [];
  if (result.decision !== expected.decision)
    problems.push(
      `decision ${result.decision} (expected ${expected.decision})`,
    );
  if (
    expected.refundAmount !== undefined &&
    result.refundAmount !== expected.refundAmount
  ) {
    problems.push(
      `amount ${result.refundAmount} (expected ${expected.refundAmount})`,
    );
  }
  if (
    expected.requiresHuman !== undefined &&
    result.requiresHuman !== expected.requiresHuman
  ) {
    problems.push(
      `requiresHuman ${result.requiresHuman} (expected ${expected.requiresHuman})`,
    );
  }
  for (const flag of expected.flags ?? []) {
    if (!result.guardrailFlags.includes(flag))
      problems.push(`missing flag ${flag}`);
  }
  return problems;
}
