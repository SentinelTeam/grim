import OpenAI from "openai";
import logger from "./logger";
import { ResponseCreateParamsNonStreaming, Response } from "openai/resources/responses";

export type ProviderType = "openai" | "anthropic";

const OPENAI_MODEL = "o3";
const ANTHROPIC_MODEL = "claude-3-7-sonnet-20250219";

export interface IAIClient {
  logAndCreateChatCompletion(params: ResponseCreateParamsNonStreaming): Promise<Response>;
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

    const options = {
      apiKey,
      ...(provider === "openai"
        ? {}
        : {
          baseURL: "https://api.anthropic.com/v1",
          defaultHeaders: {
            "anthropic-version": "2023-06-01",
            "x-api-key": apiKey,
          },
          defaultQuery: {
            model_map: JSON.stringify({
              [OPENAI_MODEL]: ANTHROPIC_MODEL,
            }),
          },
        }
      ),
    };

    this.client = new OpenAI(options);
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
    params: ResponseCreateParamsNonStreaming
  ): Promise<Response> {
    logger.debug(`Requesting completion (responses API) from ${this.provider}`, { params });

    try {
      const webSearchTool = { type: "web_search_preview" };
      const tools = [...(params.tools ?? []), webSearchTool];

      const expandedParams: ResponseCreateParamsNonStreaming = {
        ...params,
        tools,
        stream: false,
        seed: this.seed,
      };

      const res: any = await this.client.responses.create(expandedParams);

      logger.debug(`${this.provider} responses API result`, { res });

      return res;
    } catch (error) {
      logger.error(`Error calling ${this.provider} responses API`, { error });
      throw error;
    }
  }
}
