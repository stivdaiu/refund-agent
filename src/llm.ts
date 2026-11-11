import OpenAI from "openai";
import { z } from "zod";
import type { AnyTool } from "./tools.js";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolSpec = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ToolCallRequest {
  id: string;
  name: string;
  args: unknown;
  rawArgs: string;
  argsParseError: boolean;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: ToolCallRequest[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LlmClient {
  name: string;
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<LlmResponse>;
}

export function toToolSpec(
  name: string,
  description: string,
  schema: z.ZodType,
): ToolSpec {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(schema) as Record<
    string,
    unknown
  >;
  return { type: "function", function: { name, description, parameters } };
}

export function toolSpecs(tools: AnyTool[]): ToolSpec[] {
  return tools.map((t) => toToolSpec(t.name, t.description, t.args));
}

export class OpenAiLlm implements LlmClient {
  readonly name: string;
  private readonly client: OpenAI;

  constructor(
    private readonly model: string,
    apiKey = process.env.OPENAI_API_KEY,
  ) {
    if (!apiKey)
      throw new Error("OPENAI_API_KEY is missing. Put it in the .env file.");
    this.name = `openai:${model}`;
    this.client = new OpenAI({
      apiKey,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      timeout: 30_000,
      maxRetries: 0,
    });
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<LlmResponse> {
    const supportsTemperature = !/^(o\d|gpt-5)/.test(this.model);
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools,
      tool_choice: "required",
      parallel_tool_calls: false,
      ...(supportsTemperature ? { temperature: 0 } : {}),
    });

    const message = response.choices[0]?.message;
    const toolCalls: ToolCallRequest[] = [];
    for (const call of message?.tool_calls ?? []) {
      if (call.type !== "function") continue;
      const rawArgs = call.function.arguments || "{}";
      let args: unknown = {};
      let argsParseError = false;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        argsParseError = true;
      }
      toolCalls.push({
        id: call.id,
        name: call.function.name,
        args,
        rawArgs,
        argsParseError,
      });
    }

    return {
      content: message?.content ?? null,
      toolCalls,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  }
}
