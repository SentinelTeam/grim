import OpenAI from "openai";
import logger from "./logger";
import { ChatCompletion, ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

export type { ChatCompletionMessageParam };

export type ProviderType = "openai" | "anthropic";

const OPENAI_MODEL = "o3";
const ANTHROPIC_MODEL = "claude-3-7-sonnet-20250219";

export interface IAIClient {
  logAndCreateChatCompletion(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
  setSeed(seed: number | undefined): void;
  getProvider(): ProviderType;
  getSmartestModelParams(): any;
}

export class DefaultAIClient implements IAIClient {
  private client: OpenAI;
  private seed: number | undefined;
  private provider: ProviderType;

  constructor(apiKey: string, provider: ProviderType = "openai", seed?: number) {
    this.provider = provider;
    this.seed = seed;

    if (provider === "anthropic") {
      // Configure OpenAI client to use Anthropic API
      this.client = new OpenAI({
        apiKey,
        baseURL: "https://api.anthropic.com/v1",
        defaultHeaders: {
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
        },
        defaultQuery: {
          model_map: JSON.stringify({
            [OPENAI_MODEL]: ANTHROPIC_MODEL
          }),
        }
      });
    } else {
      // Standard OpenAI client
      this.client = new OpenAI({ apiKey });
    }
  }

  setSeed(seed: number | undefined): void {
    this.seed = seed;
  }

  getProvider(): ProviderType {
    return this.provider;
  }

  getSmartestModelParams(): any {
    if (this.provider === "anthropic") {
      return {
        model: ANTHROPIC_MODEL
      };
    } else {
      return {
        model: OPENAI_MODEL,
        reasoning: {
          effort: 'high'
        }
      };
    }
  }

  async logAndCreateChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming
  ): Promise<ChatCompletion> {
    logger.debug(`Requesting completion (responses API) from ${this.provider}`, { params });

    try {
      // Extract messages if provided in "chat" style and remap to the `input` field.
      const { messages, tools: existingTools = [], ...rest } = params;

      // Inject the web‑search tool on every call (avoid duplicates).
      const webSearchTool = { type: "web_search_preview" } as const;
      const tools = [...existingTools, webSearchTool];

      const responseParams: any = {
        ...rest,
        tools,
        stream: false,
        seed: this.seed,
        // Prefer messages if supplied, otherwise allow callers to specify `input` directly.
        input: messages ?? (rest as any).input,
      };

      // Remove the legacy field if present to avoid API validation errors.
      delete responseParams.messages;

      const res: any = await (this.client as any).responses.create(responseParams);

      logger.debug(`${this.provider} responses API result`, { res });

      // Convert the Responses API structure back to a ChatCompletion‑like object.
      const toolCalls = (res.output || [])
        .filter((item: any) => item.type === "tool_call")
        .map((item: any) => ({
          id: item.id,
          type: "function",
          function: {
            name: item.name,
            // Ensure arguments are a JSON string to match previous behaviour.
            arguments: JSON.stringify(item.arguments ?? {})
          }
        }));

      const assistantMessages = (res.output || []).filter((item: any) => item.type === "message");
      const lastAssistant = assistantMessages[assistantMessages.length - 1] || {};

      // Flatten assistant content into plain string for downstream systems (e.g., Telegram)
      const contentText: string = (() => {
        const raw = lastAssistant.content;
        if (typeof raw === "string") return raw;
        if (Array.isArray(raw)) {
          return raw
            .map((block: any) => {
              if (typeof block === "string") return block;
              if (block && typeof block.text === "string") return block.text;
              return "";
            })
            .join("\n\n");
        }
        return "";
      })();

      const pseudoChatCompletion = {
        id: res.id,
        choices: [
          {
            index: 0,
            finish_reason: res.finish_reason ?? "stop",
            message: {
              role: lastAssistant.role ?? "assistant",
              content: contentText || res.output_text || "",
              tool_calls: toolCalls.length ? toolCalls : undefined,
            },
          },
        ],
        usage: res.usage ?? undefined,
      };

      return pseudoChatCompletion as unknown as ChatCompletion;
    } catch (error) {
      logger.error(`Error calling ${this.provider} responses API`, { error });
      throw error;
    }
  }
}
