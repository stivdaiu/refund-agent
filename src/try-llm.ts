import { loadSettings } from "./config.js";
import { OpenAiLlm, toolSpecs, type ChatMessage } from "./llm.js";
import { TicketSchema } from "./models.js";
import { renderUserMessage, SYSTEM_PROMPT } from "./prompts.js";
import { CaseStore, OrderStore, PolicyIndex } from "./stores.js";
import { ALL_TOOLS, type ToolContext } from "./tools.js";

const settings = loadSettings();
const llm = new OpenAiLlm(settings.model);

const ticket = TicketSchema.parse({
  ticket_id: "T-001",
  customer_email: "alice@example.com",
  subject: "Mug set arrived broken",
  body: "Hi, two of the mugs from order ORD-1001 arrived cracked. Can I get a refund please?",
});
const today = "2026-11-10";

const ctx: ToolContext = {
  ticket,
  today,
  settings,
  orders: new OrderStore("data/orders.json"),
  cases: new CaseStore(),
  policies: new PolicyIndex("data/policies"),
  sideEffectsAllowed: true,
  eligibility: new Map(),
};

const messages: ChatMessage[] = [
  { role: "system", content: SYSTEM_PROMPT },
  {
    role: "user",
    content: renderUserMessage(ticket, today, [], ticket.subject, ticket.body),
  },
];

console.log(
  "Tools we offer the model:",
  ALL_TOOLS.map((t) => t.name).join(", "),
);
console.log("\nAsking the model what to do first...");

const response = await llm.chat(messages, toolSpecs(ALL_TOOLS));
const call = response.toolCalls[0];
if (!call) {
  console.log("The model did not call a tool. Text answer:", response.content);
  process.exit(0);
}

console.log(`\n🤖 The model wants to call: ${call.name}`);
console.log("   with arguments:", call.rawArgs);
console.log("   tokens used:", response.usage);

// We (the code) execute the tool - the model can only ask.
const tool = ALL_TOOLS.find((t) => t.name === call.name);
if (!tool) throw new Error(`Unknown tool ${call.name}`);
const args = tool.args.parse(call.args); // never trust the model's arguments without validation
const result = await tool.run(args, ctx);
console.log(`\n🔧 Tool result:\n${JSON.stringify(result, null, 2)}`);
