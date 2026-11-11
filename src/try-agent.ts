import { RefundAgent } from "./agent.js";
import { loadSettings } from "./config.js";
import { OpenAiLlm } from "./llm.js";
import { CaseStore, OrderStore, PolicyIndex } from "./stores.js";

const TICKETS: Record<string, object> = {
  damaged: {
    ticket_id: "T-001",
    customer_email: "alice@example.com",
    subject: "Mug set arrived broken",
    body: "Hi, two of the mugs from order ORD-1001 arrived cracked. Can I get a refund please?",
  },
  expensive: {
    ticket_id: "T-003",
    customer_email: "carol@example.com",
    subject: "Espresso machine defective",
    body: "My espresso machine from order ORD-1003 stopped working after two days. I want my money back.",
  },
  late: {
    ticket_id: "T-004",
    customer_email: "bob@example.com",
    order_id: "ORD-1002",
    subject: "Return headphones",
    body: "I changed my mind about the headphones, I'd like a refund.",
  },
  status: {
    ticket_id: "T-009",
    customer_email: "dan@example.com",
    subject: "Where is my order?",
    body: "Hi, where is my order ORD-1004? It hasn't arrived yet.",
  },
  invalid: {
    ticket_id: "T-014",
    customer_email: "not-an-email",
    subject: "",
    body: "refund",
  },
};

const name = process.argv[2] ?? "damaged";
const ticket = TICKETS[name];
if (!ticket) {
  console.error(
    `Unknown ticket '${name}'. Choose one of: ${Object.keys(TICKETS).join(", ")}`,
  );
  process.exit(1);
}

const settings = loadSettings();
const agent = new RefundAgent({
  settings,
  llm: new OpenAiLlm(settings.model),
  orders: new OrderStore("data/orders.json"),
  cases: new CaseStore(),
  policies: new PolicyIndex("data/policies"),
});

const result = await agent.run(ticket, {
  today: "2026-11-10",
  traceMode: "pretty",
});

console.log("\n================ SUMMARY ================");
console.log(result.summary);
console.log("\n============ REPLY TO CUSTOMER ==========");
console.log(result.customerReply || "(none)");
console.log("\n============ STRUCTURED JSON ============");
console.log(
  JSON.stringify(
    {
      ...result,
      toolCalls: `${result.toolCalls.length} calls (see trace file)`,
    },
    null,
    2,
  ),
);
