import Anthropic from "@anthropic-ai/sdk";
import { Player, UserInteraction, UserInteractionType } from "./types";
import logger from "./logger";
import { XMLBuilder } from 'fast-xml-parser';
import { partition } from "./utils/array";

// Using Sonnet 3.7 as requested
const MODEL = "claude-3-7-sonnet-20250219";

// Interface for chat messages
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Interface for developer/system messages - needed for compatibility
export interface SystemMessage {
  role: "system";
  content: string;
}

// ChatCompletionMessageParam is a union type of the message types we support
export type ChatCompletionMessageParam = ChatMessage | SystemMessage;

// Define an interface for the Claude client that's similar to the OpenAI one
export interface IAnthropicClient {
  logAndCreateChatCompletion(params: {
    model: string;
    messages: ChatCompletionMessageParam[];
    system?: string;
    tools?: any[];
    tool_choice?: string | {type: string};
  }): Promise<{
    choices: Array<{
      message: ChatMessage;
      tool_calls?: Array<{
        function: {
          name: string;
          arguments: string;
        }
      }>
    }>
  }>;
  setSeed(seed: number | undefined): void;
}

export class DefaultAnthropicClient implements IAnthropicClient {
  private client: Anthropic;
  private seed: number | undefined;

  constructor(apiKey: string, seed?: number) {
    this.client = new Anthropic({ apiKey });
    this.seed = seed;
  }

  setSeed(seed: number | undefined): void {
    this.seed = seed;
  }

  async logAndCreateChatCompletion(params: {
    model: string;
    messages: ChatCompletionMessageParam[];
    system?: string;
    tools?: any[];
    tool_choice?: string;
  }): Promise<{
    choices: Array<{
      message: ChatMessage;
      tool_calls?: Array<{
        function: {
          name: string;
          arguments: string;
        }
      }>
    }>
  }> {
    logger.debug("Requesting completion from Claude", { params });

    // Extract system message
    const systemContent = params.system || 
      params.messages.find(m => m.role === "system")?.content || "";
    
    // Convert to Claude format
    const claudeMessages = params.messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({
        role: m.role,
        content: m.content,
      }));

    try {
      // Check if we need to use a tool
      if (params.tools && params.tools.length > 0 && params.tool_choice === "required") {
        // Handle tool call case
        const response = await this.client.messages.create({
          model: MODEL,
          messages: claudeMessages as { role: "user" | "assistant", content: string }[],
          system: systemContent,
          tools: params.tools,
          tool_choice: { type: "any" },
          temperature: 0,
          max_tokens: 4000
        });

        logger.debug("Claude completion response (with tools)", { 
          responseData: response,
          responseContent: response.content,
          hasToolCalls: !!response.content.find(block => block.type === 'tool_use'),
          toolUseBlocks: response.content.filter(block => block.type === 'tool_use')
        });

        // Format response to match OpenAI format
        // Find tool_use blocks in the content array
        const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');
        const textBlock = response.content.find(block => block.type === 'text');
        
        const tool_calls = toolUseBlocks.length > 0 
          ? toolUseBlocks.map(block => ({
              function: {
                name: (block as any).name,
                arguments: JSON.stringify((block as any).input)
              }
            }))
          : undefined;

        return {
          choices: [{
            message: {
              role: "assistant",
              content: textBlock ? (textBlock as any).text : "",
            },
            tool_calls
          }]
        };
      } else {
        // Handle standard message case
        const response = await this.client.messages.create({
          model: MODEL,
          messages: claudeMessages as { role: "user" | "assistant", content: string }[],
          system: systemContent,
          temperature: 0,
          max_tokens: 4000
        });

        const textBlock = response.content.find(block => block.type === 'text');

        return {
          choices: [{
            message: {
              role: "assistant",
              content: textBlock ? (textBlock as any).text : "",
            }
          }]
        };
      }
    } catch (error) {
      logger.error("Error calling Claude API", { error });
      throw error;
    }
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
  constructor(private readonly anthropicClient: IAnthropicClient) { }

  async initializeScenario(scenario: string, players: Player[]): Promise<ChatCompletionMessageParam[]> {
    try {
      logger.info("Initializing scenario", {
        scenario,
        playerCount: players.length,
        players: players.map(p => ({ name: p.name, role: p.role }))
      });

      // Claude doesn't have a developer role, so we'll use system instead
      const systemPrompt = getInitialPrompt(players);

      const scenarioMessage: ChatCompletionMessageParam = {
        role: "user",
        content: scenario
      };

      logger.debug("Sending initial prompt to Claude", {
        messageLength: scenario.length
      });

      const completion = await this.anthropicClient.logAndCreateChatCompletion({
        model: MODEL,
        messages: [scenarioMessage],
        system: systemPrompt,
      });

      const response = completion.choices[0].message.content || "Failed to generate scenario";

      logger.info("Scenario initialized successfully", {
        responseLength: response.length
      });

      return [
        scenarioMessage,
        { role: "assistant", content: response }
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

      // Forecaster prompt as system message for Claude
      const forecasterSystemPrompt = `You are a superforecaster specialized in analyzing complex scenarios and predicting outcomes with high calibration.
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

      const actionPromises = nonFeeds.map(async (action, index) => {
        const contextAndTargetMessage: ChatCompletionMessageParam = {
          role: "user",
          content: `Here are all the concurrent user interactions for context:
${concurrentUserInteractions}

But please forecast the outcome for only this specific action:
${action.type} ${action.player.name}: ${action.content}

Please provide your response in this format:
OUTCOME: <your chosen outcome>

Consider:
- Complexity of the action
- Available resources and capabilities
- Time constraints
- External factors and opposition
- Previous related events in the scenario
- How this action may interact with other concurrent actions`
        };

        const forecastConfig = {
          model: MODEL,
          messages: [...canonicalScenarioMessages, contextAndTargetMessage],
          system: forecasterSystemPrompt,
          temperature: 0,
          max_tokens: 4000
        };

        logger.debug("Processing individual action", {
          action: `${action.type} ${action.player.name}: ${action.content}`,
          actionIndex: index
        });

        const completion = await this.anthropicClient.logAndCreateChatCompletion({
          ...forecastConfig,
          messages: [
            ...canonicalScenarioMessages,
            contextAndTargetMessage
          ],
          system: forecasterSystemPrompt
        });

        const response = completion.choices[0].message.content;
        const outcomeMatch = response.match(/OUTCOME:\s*(.+?)(?:\n|$)/);
        const outcome = outcomeMatch ? outcomeMatch[1].trim() : response;

        logger.debug("Received outcome for action", {
          action: `${action.type} ${action.player.name}: ${action.content}`,
          outcome
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

      // Game Master system prompt for Claude
      const gameMasterSystemPrompt = `You are an expert wargame game master who will take all the information from this chat that the players should know and write them an update of what has happened in the world during the time that's elapsed.
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

      const narratorCompletion = await this.anthropicClient.logAndCreateChatCompletion({
        model: MODEL,
        messages: [...canonicalScenarioMessages, gameMasterRequestMessage],
        system: gameMasterSystemPrompt
      });

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