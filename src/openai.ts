import OpenAI from "openai";
import { Player, PrivateInfo, ScenarioTimeline, ScenarioUpdate, ScenarioUpdateSchema, UserInteraction, UserInteractionType } from "./types";
import logger from "./logger";
import { ChatCompletion, ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { XMLBuilder } from 'fast-xml-parser';
import { partition } from "./utils/array";
import { zodResponseFormat } from "openai/helpers/zod";
import { ParsedChatCompletion } from "openai/resources/beta/chat/completions.mjs";

const maxIntelligenceModelParams: Pick<ChatCompletionCreateParamsNonStreaming, "model" | "reasoning_effort"> = { model: "o1", reasoning_effort: 'high' };

export interface IOpenAIClient {
  logAndCreateChatCompletion(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
  logAndCreateParsedChatCompletion<T>(params: ChatCompletionCreateParamsNonStreaming): Promise<ParsedChatCompletion<T>>;
  setSeed(seed: number | undefined): void;
}

export class DefaultOpenAIClient implements IOpenAIClient {
  private client: OpenAI;
  private seed: number | undefined;

  constructor(apiKey: string, seed?: number) {
    this.client = new OpenAI({ apiKey });
    this.seed = seed;
  }

  setSeed(seed: number | undefined): void {
    this.seed = seed;
  }

  async logAndCreateChatCompletion(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion> {
    logger.debug("Requesting completion", { params });
    const completion = await this.client.chat.completions.create({
      ...params,
      stream: false,
      seed: this.seed
    });
    logger.debug("Completion response", { completion });
    return completion as ChatCompletion;
  }

  async logAndCreateParsedChatCompletion<T>(params: ChatCompletionCreateParamsNonStreaming): Promise<ParsedChatCompletion<T>> {
    logger.debug("Requesting parsed completion", { params });
    const completion = await this.client.beta.chat.completions.parse({
      ...params,
      stream: false,
      seed: this.seed
    });
    logger.debug("Parsed completion response", { completion });
    return completion as ParsedChatCompletion<T>;
  }


}

export const playerDescriptionsXml = (players: Player[]): string => {
  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: true,
  });

  const xml = builder.build({
    playerDescriptions: {
      player: players.map(p => ({
        name: p.name,
        role: p.role
      }))
    }
  });

  logger.debug("Player descriptions", { xml });

  return xml;
};




export const getInitialPrompt = (players: Player[]) => `You are an expert wargame facilitator, applying the best practices from military and other emergency response wargaming.

The players in the game and their roles are:

${playerDescriptionsXml(players)}

You will be given a scenario request.
You'll first envision a globally catastrophic or even potentially existential crisis that could happen in the context of the scenario request.
You'll create a timeline of events in that world, write notes, and create a briefing for the players.
* The timeline should be in chronological order, starting from the beginning of the scenario and going forward.
* The timeline should occur in the future. The date today is ${new Date().toISOString().split('T')[0]}.
* The briefing should be of a time before any of the events in the timeline have happened.
* All times in the timeline, briefing, etc. should be in UTC.

Give concrete details about the scenario. For example, if you said: "International relations are tense due to unrelated trade disputes and technological competition." or "A legislative decision in the US has sparked protests", those would be overly vague because it would be well known which specific countries have strained relationships over what and which specific legislation has been passed that is causing protests. You should state specifics in cases like that. If notable companies or people are involved, name them. Do not create large fictious entities like countries or intergovernmental organizations. You are allowed to create some fictional small companies if the time is sufficiently far in the future, but you should prefer to use already-existing entities.

Your briefing should be in the format:
# Starting DateTime
<starting datetime>

# Current DateTime
<current datetime>

# Time Offset
<time offset>

# Scenario
<scenario>
`;

interface Outcome {
  outcome: string;
  weight: number;
}

function sampleFromWeightedOutcomes(outcomes: Outcome[]): string {
  const totalWeight = outcomes.reduce((sum, o) => sum + o.weight, 0);
  const normalizedWeights = outcomes.map(o => o.weight / totalWeight);

  const rand = Math.random();
  let cumSum = 0;

  for (let i = 0; i < outcomes.length; i++) {
    cumSum += normalizedWeights[i];
    if (rand <= cumSum) {
      return outcomes[i].outcome;
    }
  }

  return outcomes[outcomes.length - 1].outcome;
}
export class ChatService {

  constructor(private readonly openAIClient: IOpenAIClient) { }

  async initializeScenario(scenario: string, players: Player[]): Promise<ScenarioUpdate> {
    try {
      logger.info("Initializing scenario", {
        scenario,
        playerCount: players.length,
        players: players.map(p => ({ name: p.name, role: p.role }))
      });

      const gameMasterDeveloperMessage: ChatCompletionMessageParam = {
        role: "developer",
        content: getInitialPrompt(players)
      };

      const scenarioMessage: ChatCompletionMessageParam = {
        role: "user",
        content: scenario
      };

      logger.debug("Sending initial prompt to OpenAI", {
        messageLength: scenario.length
      });

      const completion = await this.openAIClient.logAndCreateParsedChatCompletion<ScenarioUpdate>({
        ...maxIntelligenceModelParams,
        messages: [gameMasterDeveloperMessage, scenarioMessage],
        response_format: zodResponseFormat(ScenarioUpdateSchema, "scenarioUpdate")
      });

      const scenarioUpdate = completion.choices[0].message.parsed;

      if (!scenarioUpdate) {
        throw new Error("No scenario update received or parse failed");
      }

      return scenarioUpdate;
    } catch (error) {
      logger.error("Failed to initialize scenario", {
        error,
        scenario,
        playerCount: players.length
      });
      throw error;
    }
  }

  async processActions(
    canonicalScenarioMessages: ChatCompletionMessageParam[],
    actions: UserInteraction[],
    timeline: ScenarioTimeline,
    scratchpad: string
  ): Promise<ScenarioUpdate> {
    try {
      logger.info("Processing actions with forecaster");

      const forecasterDeveloperMessage: ChatCompletionMessageParam = {
        role: "developer",
        content: `You are a superforecaster specialized in analyzing complex scenarios and predicting outcomes with high calibration.
You are a master of coupling your fine-grained world-models and knowledge of base-rates with mathematical rules like Laplace's rule of succession and Bayes' rule. You are working in the context of a wargame.

You will see a few kinds of interactions from the players:
- ACTION: This is an action that the players take in the world. They will include the time they would try to spend getting this information and the rough strategy they'd use. Given the strategy and time, simulate the degree to which it succeeds and incorporate the results in your next message. This does advance the game clock.
- INFO: This is a request for information that would already know about the world. It must not advance the scenario clock.

You will be given a list of all concurrent actions happening in the world, but you will be asked to forecast the outcome of a specific action.
For that action, you should:
1. Analyze the action in the context of all other concurrent actions
2. Break down possible outcomes into at least 3 possibilities
3. Sample from those outcomes using the tools/functions at your disposal to determine what happens
4. Incorporate the result into your response

When providing outcomes for actions, at the very least consider the following:
- Complexity of the action
- Available resources and capabilities
- Time constraints
- External factors and opposition
- Previous related events in the scenario
- How this action may interact with other concurrent actions`
      };

      const timelineMessage: ChatCompletionMessageParam = {
        role: "user",
        content: `Here is your planned timeline of events:\n${timeline.map(event => `${event.datetime}: ${event.event}`).join("\n")}`
      };

      const scratchpadMessage: ChatCompletionMessageParam = {
        role: "user",
        content: `Here is your scratchpad:\n${scratchpad}`
      };

      logger.debug("actions", { actions });

      const forecastConfig = {
        ...maxIntelligenceModelParams,
        tool_choice: "required" as const,
        tools: [{
          type: "function" as const,
          function: {
            name: "sample_from_weighted_outcomes",
            description: "Randomly selects an outcome from a weighted list of possibilities",
            parameters: {
              type: "object",
              properties: {
                outcomes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      outcome: {
                        type: "string",
                        description: "The description of the outcome"
                      },
                      weight: {
                        type: "number",
                        description: "The weight/probability of this outcome"
                      }
                    },
                    required: ["outcome", "weight"]
                  }
                }
              },
              required: ["outcomes"]
            }
          }
        }],
      };

      const concurrentUserInteractions = actions.map(action =>
        `${action.type} ${action.player.name}: ${action.content}`
      ).join("\n");

      const [feeds, nonFeeds] = partition(actions, action => action.type === UserInteractionType.FEED);

      const actionPromises = nonFeeds.map(async (action, index) => {
        const contextAndTargetMessage: ChatCompletionMessageParam = {
          role: "user",
          content: `Here are all the concurrent user interactions for context:
${concurrentUserInteractions}

But please forecast the outcome for only this specific action:
${action.type} ${action.player.name}: ${action.content}`
        };

        logger.debug("Processing individual action", {
          action: `${action.type} ${action.player.name}: ${action.content}`,
          actionIndex: index
        });

        const completion = await this.openAIClient.logAndCreateChatCompletion({
          ...forecastConfig,
          messages: [
            forecasterDeveloperMessage,
            ...canonicalScenarioMessages,
            timelineMessage,
            scratchpadMessage,
            contextAndTargetMessage
          ],
        });

        const forecasterResponse = completion.choices[0].message;

        if (!forecasterResponse.tool_calls?.[0]) {
          logger.error("No tool call received when required", { forecasterResponse });
          return null;
        }

        const toolCall = forecasterResponse.tool_calls[0];
        const args = JSON.parse(toolCall.function.arguments);
        const { outcomes } = args;
        const outcome = sampleFromWeightedOutcomes(outcomes);

        logger.debug("Sampled outcome for action", {
          action: `${action.type} ${action.player.name}: ${action.content}`,
          outcome,
          numOutcomes: outcomes.length
        });

        return `${action.type} ${action.player.name}: ${action.content}\nOutcome: ${outcome}`;
      });

      const outcomes = (await Promise.all(actionPromises)).filter(outcome => outcome !== null && outcome !== undefined);
      logger.debug("ACTION Outcomes", { outcomes });

      const feedMessages = feeds.map(feed => `${feed.type}: ${feed.content}`);
      const allOutcomesStr = [
        ...feedMessages,
        ...outcomes
      ].join("\n\n");

      const gameMasterDeveloperMessage: ChatCompletionMessageParam = {
        role: "developer",
        content: `You are an expert wargame game master who will take all the information from this chat that the players should know and write them an update of what has happened in the world during the time that's elapsed.
First, you must incorporate the FEED messages into your model of the world and treat them as true. The players do this so that they can correct your misunderstanding of the world in important ways. It must never consume any time in the world.
Then, tell the players the result of their INFO requests. This also doesn't take up any time in the world.
Then, tell the players the results of their ACTIONs. These do advance the game clock.

Important note because previous iterations of you kept making this mistake: If only a small amount of time has passed, such as a few hours, it's very unlikely that the world has changed too much. At certain times during certain crises, news will come out quickly, but usually significant changes take at least days to unfold.
    
Just like the previous messages in the chat describing the world, you should include the scenario datetime and offset since the beginning of the scenario (e.g. T+1day,12hours). All times are in UTC.

You have access to a scratchpad and a timeline of events that players can't see, which you use to remember your plan for the game. Use these to refresh your memory, and update them as you see fit.`
      };

      const outcomesMessage = `Here are the player interactions and their outcomes:\n${allOutcomesStr}`;

      const gameMasterRequestMessage: ChatCompletionMessageParam = {
        role: "user",
        content: outcomesMessage
      };

      logger.debug("Sending forecaster results to narrator", {
        timelineMessageLength: timelineMessage.content.length,
        scratchpadMessageLength: scratchpadMessage.content.length,
        outcomesMessageLength: outcomesMessage.length
      });

      const narratorCompletion = await this.openAIClient.logAndCreateParsedChatCompletion<ScenarioUpdate>({
        ...maxIntelligenceModelParams,
        messages: [gameMasterDeveloperMessage, ...canonicalScenarioMessages, timelineMessage, scratchpadMessage, gameMasterRequestMessage],
        response_format: zodResponseFormat(ScenarioUpdateSchema, "scenarioUpdate")
      });

      const narratorResponse = narratorCompletion.choices[0].message.parsed;

      if (!narratorResponse) {
        throw new Error("No narrator response received or parse failed");
      }

      logger.info("Narrator generated story update", {
        responseLength: narratorResponse.playerBriefing.length
      });

      return narratorResponse;
    } catch (error) {
      logger.error("Failed to process actions", {
        error,
        actionCount: actions.length,
        historyLength: canonicalScenarioMessages.length
      });
      throw error;
    }
  }
} 
