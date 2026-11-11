import "dotenv/config";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../../src/config.js";
import { buildAgent } from "../../src/factory.js";
import { compareWithExpected, loadSamples } from "../../src/samples.js";

const samples = loadSamples();

describe.skipIf(!process.env.OPENAI_API_KEY)(
  "real model: all sample tickets",
  () => {
    let agent: ReturnType<typeof buildAgent>["agent"] | undefined;
    const getAgent = () =>
      (agent ??= buildAgent({
        settings: loadSettings({ traceDir: "traces" }),
      }).agent);

    it.each(samples.tickets.map((s) => [s.name, s] as const))(
      "%s",
      async (_name, sample) => {
        const result = await getAgent().run(sample.ticket, {
          today: samples.today,
        });
        expect(
          compareWithExpected(result, sample.expected),
          `trace ${result.traceId}`,
        ).toEqual([]);
      },
      60_000,
    );
  },
);
