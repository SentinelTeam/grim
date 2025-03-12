import OpenAI from "openai";
import logger from "./logger";
import { ChatCompletion, ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

export type { ChatCompletionMessageParam };

export type ProviderType = "openai" | "anthropic";

const OPENAI_MODEL = "o1";
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
        reasoning_effort: 'high'
      };
    }
  }

  async logAndCreateChatCompletion(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion> {
    logger.debug(`Requesting completion from ${this.provider}`, { params });

    try {
      const completion = await this.client.chat.completions.create({
        ...params,
        stream: false,
        seed: this.seed
      });

      logger.debug(`${this.provider} completion response`, { completion });
      return completion as ChatCompletion;
    } catch (error) {
      logger.error(`Error calling ${this.provider} API`, { error });
      throw error;
    }
  }
}
