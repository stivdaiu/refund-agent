import { readFileSync } from "node:fs";
import { z } from "zod";
import { OrderSchema, TicketSchema } from "../src/models.js";

// 1) A good ticket: note how the email is lower-cased and spaces are trimmed.
const good = TicketSchema.safeParse({
  ticket_id: "T-001",
  customer_email: "  Alice@Example.com ",
  order_id: "ord-1001",
  subject: "Mug set arrived broken",
  body: "Two mugs arrived cracked. Can I get a refund?",
});
console.log("Good ticket valid?", good.success);
if (good.success) console.log(good.data);

// 2) A bad ticket: wrong email, empty subject, unknown extra field.
const bad = TicketSchema.safeParse({
  ticket_id: "T-002",
  customer_email: "not-an-email",
  subject: "",
  body: "refund",
  hacker_field: "x",
});
console.log("\nBad ticket valid?", bad.success);
if (!bad.success) console.log(z.prettifyError(bad.error));

// 3) Load and validate every order in data/orders.json.
const raw = JSON.parse(readFileSync("data/orders.json", "utf-8"));
const orders = z.array(OrderSchema).parse(raw);
console.log(
  `\nLoaded ${orders.length} valid orders. First one: ${orders[0].order_id} (${orders[0].items[0].name})`,
);
