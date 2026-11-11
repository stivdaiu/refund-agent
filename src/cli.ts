import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildAgent } from "./factory.js";
import { compareWithExpected, loadSamples } from "./samples.js";

const HELP = `RefundDesk agent - command line

Usage:
  npm run agent -- list                      List the sample tickets
  npm run agent -- run <name|file.json>      Run one ticket and watch every step
  npm run agent -- batch [--out <folder>]    Run ALL samples and check them against the expected results

Options:
  --today YYYY-MM-DD   Date the agent should use (default: the date in samples/tickets.json)
  --samples <file>     Sample file (default: samples/tickets.json)
  --json               "run": print only the JSON result
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    today: { type: "string" },
    samples: { type: "string", default: "samples/tickets.json" },
    out: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, target] = positionals;
if (!command || values.help) {
  console.log(HELP);
  process.exit(0);
}

const samples = loadSamples(values.samples);
const today = values.today ?? samples.today;

if (command === "list") {
  for (const s of samples.tickets)
    console.log(`${s.name.padEnd(36)} ${s.description}`);
  process.exit(0);
}

if (command === "run") {
  if (!target)
    throw new Error(
      "Give a sample name or a .json file, e.g. npm run agent -- run 01_damaged_auto_approve",
    );
  const sample = samples.tickets.find(
    (s) => s.name === target || s.name.startsWith(target),
  );
  const ticket = sample
    ? sample.ticket
    : JSON.parse(readFileSync(target, "utf-8"));
  const { agent } = buildAgent();
  const result = await agent.run(ticket, {
    today,
    traceMode: values.json ? "silent" : "pretty",
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `\n${"=".repeat(20)} SUMMARY ${"=".repeat(20)}\n${result.summary}`,
    );
    console.log(
      `\n${"=".repeat(16)} REPLY TO CUSTOMER ${"=".repeat(14)}\n${result.customerReply || "(none)"}`,
    );
    if (sample) {
      const problems = compareWithExpected(result, sample.expected);
      console.log(
        problems.length === 0
          ? "\n✅ matches the expected result"
          : `\n❌ ${problems.join("; ")}`,
      );
    }
    console.log(`\nTrace: traces/${result.traceId}.jsonl`);
  }
  process.exit(0);
}

if (command === "batch") {
  const { agent, cases, settings } = buildAgent();
  if (values.out) mkdirSync(values.out, { recursive: true });
  console.log(
    `Running ${samples.tickets.length} tickets with ${settings.model} (today = ${today})\n`,
  );

  let passed = 0;
  const started = Date.now();
  for (const sample of samples.tickets) {
    const t0 = Date.now();
    const result = await agent.run(sample.ticket, { today });
    const problems = compareWithExpected(result, sample.expected);
    if (problems.length === 0) passed++;

    const amount =
      result.refundAmount !== null ? result.refundAmount.toFixed(2) : "-";
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${problems.length === 0 ? "✅" : "❌"} ${sample.name.padEnd(36)} ${result.decision.padEnd(18)} ${amount.padStart(7)}  ` +
        `${result.requiresHuman ? "human" : "     "}  ${String(result.steps).padStart(2)} steps  ${seconds.padStart(5)}s` +
        (problems.length > 0
          ? `\n   -> ${problems.join("; ")} (trace ${result.traceId})`
          : ""),
    );
    if (values.out)
      writeFileSync(
        join(values.out, `${sample.name}.json`),
        JSON.stringify(result, null, 2),
      );
  }

  const snapshot = cases.snapshot();
  console.log(
    `\n${passed}/${samples.tickets.length} passed in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  console.log(
    `Refunds issued: ${snapshot.refunds.length} (total ${snapshot.refunds.reduce((s, r) => s + r.amount, 0).toFixed(2)} EUR) | Escalations: ${snapshot.escalations.length}`,
  );
  process.exit(passed === samples.tickets.length ? 0 : 1); // non-zero exit code = failure (useful in CI)
}

console.error(`Unknown command '${command}'.\n\n${HELP}`);
process.exit(1);
