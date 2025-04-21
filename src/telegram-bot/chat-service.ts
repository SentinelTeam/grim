import { ChatCompletion, ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { XMLBuilder } from 'fast-xml-parser';
import { partition } from "../utils/array";
import logger from "../logger";
import { Player, UserInteraction, UserInteractionType } from "./types";
import { IAIClient } from "../ai-client";

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

You will be given a scenario and your first message should set the stage of what is going on the in world, which may or may not clearly be a crisis. Your job is not to direct the players or make any assumptions about what they or their organizations are already doing. You are just laying out the scenario. The end of the message should include the starting scenario datetime, current scenario datetime, and time offset since the beginning of the scenario (e.g. T+1day,12hours). All times should be in UTC. The first message should be at the beginning of the scenario and always have a time offset of T+0.

Give concrete details when enthusiasts scanning the news would reasonably have the information but don't give information that would be hard to discover. For example, if you said: "International relations are tense due to unrelated trade disputes and technological competition." or "A legislative decision in the US has sparked protests", those would be overly vague because it would be well known which specific countries have strained relationships over what and which specific legislation has been passed that is causing protests. You should state specifics in cases like that. Do not create large fictious entities like countries or intergovernmental organizations. You are allowed to create some fictional small companies if the time is sufficiently far in the future, but you should prefer to use already-existing entities.

Your repsponse should be in the format:
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
  constructor(private readonly aiClient: IAIClient) { }

  async initializeScenario(scenario: string, players: Player[]): Promise<ChatCompletionMessageParam[]> {
    try {
      logger.info("Initializing scenario", {
        scenario,
        playerCount: players.length,
        players: players.map(p => ({ name: p.name, role: p.role }))
      });

      const instructions = getInitialPrompt(players);

      logger.debug(`Sending initial prompt to ${this.aiClient.getProvider()}`, {
        messageLength: scenario.length
      });

      const modelParams = this.aiClient.getSmartestModelParams();
      const params: any = {
        ...modelParams,
        instructions,
        input: scenario
      };

      const response = await this.aiClient.logAndCreateChatCompletion(params);

      const assistantContent = response.output.find(item => item.type === "message")?.content.find(item => item.type === "output_text")?.text || "Failed to generate scenario";

      logger.info("Scenario initialized successfully");

      return [
        { role: "user", content: scenario },
        { role: "assistant", content: assistantContent }
      ];
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
  ): Promise<ChatCompletionMessageParam[]> {
    try {
      logger.info("Processing actions with forecaster");

      // Forecaster prompt
      const forecasterPrompt = `You are a superforecaster specialized in analyzing complex scenarios and predicting outcomes with high calibration.
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
- How this action may interact with other concurrent actions`;

      logger.debug("actions", { actions });

      const concurrentUserInteractions = actions.map(action =>
        `${action.type} ${action.player.name}: ${action.content}`
      ).join("\n");

      const [feeds, nonFeeds] = partition(actions, action => action.type === UserInteractionType.FEED);

      // Get model parameters from the client
      const modelParams = this.aiClient.getSmartestModelParams();

      const forecastConfig: any = {
        ...modelParams,
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

        // Use same message format for both providers
        const forecasterDeveloperMessage: ChatCompletionMessageParam = {
          role: "developer",
          content: forecasterPrompt
        };

        const messages = [
          forecasterDeveloperMessage,
          ...canonicalScenarioMessages,
          contextAndTargetMessage
        ];

        const completion = await this.aiClient.logAndCreateChatCompletion({
          ...forecastConfig,
          messages
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

      // Game Master prompt
      const gameMasterPrompt = `You are an expert wargame game master who will take all the information from this chat that the players should know and write them an update of what has happened in the world during the time that's elapsed.
First, you must incorporate the FEED messages into your model of the world and treat them as true. The players do this so that they can correct your misunderstanding of the world in important ways. It must never consume any time in the world.
Then, tell the players the result of their INFO requests. This also doesn't take up any time in the world.
Then, tell the players the results of their ACTIONs. These do advance the game clock.

Important note because previous iterations of you kept making this mistake: If only a small amount of time has passed, such as a few hours, it's very unlikely that the world has changed too much. At certain times during certain crises, news will come out quickly, but usually significant changes take at least days to unfold. At the same time, these scenarios are more useful if they escalate. So if sufficient time has passed, you should include escalatory events.
    
Just like the previous messages in the chat describing the world, you should include the scenario datetime and offset since the beginning of the scenario (e.g. T+1day,12hours). All times are in UTC.

Your response should be in the following format:
# Current DateTime
<current datetime>
# Time Offset
<time offset>
# Result of Player Interactions
## INFO
## ACTION
# Narrative Update
<narrative>`;

      const gameMasterRequestMessage: ChatCompletionMessageParam = {
        role: "user",
        content: `Here are the player interactions and their outcomes:\n${allOutcomesStr}`
      };

      logger.debug("Sending forecaster results to narrator", {
        messageLength: gameMasterRequestMessage.content.length
      });

      const gameMasterDeveloperMessage: ChatCompletionMessageParam = {
        role: "developer",
        content: gameMasterPrompt
      };

      const narratorMessages = [
        gameMasterDeveloperMessage,
        ...canonicalScenarioMessages,
        gameMasterRequestMessage
      ];

      const params: any = {
        ...this.aiClient.getSmartestModelParams(),
        messages: narratorMessages,
      };

      const narratorCompletion = await this.aiClient.logAndCreateChatCompletion(params);

      const narratorResponse = narratorCompletion.choices[0].message.content || "Failed to generate narrative";

      logger.info("Narrator generated story update", {
        responseLength: narratorResponse.length
      });

      return [
        ...canonicalScenarioMessages,
        { role: "user", content: allOutcomesStr },
        { role: "assistant", content: narratorResponse }
      ];
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