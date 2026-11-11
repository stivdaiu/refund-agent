import "dotenv/config"; // loads the .env file into process.env
import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("❌ OPENAI_API_KEY is missing. Put it in the .env file.");
  process.exit(1);
}

const client = new OpenAI({ apiKey });
const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const response = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
});

console.log("✅ OpenAI says:", response.choices[0].message.content);
