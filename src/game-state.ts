import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { Player, PrivateInfo, UserInteraction } from "./types";
import crypto from 'crypto';
import { ChatService, DefaultOpenAIClient } from "./openai";
import { List, Map } from "immutable";

/**
 * Game state is immutable, using persistent data structures for efficient copying.
 * Methods that update game state return a new instance of the game state. The caller is responsible for storing the new instance.
 * See: https://github.com/immutable-js/immutable-js#the-case-for-immutability
 * This creates a consistent interface between sync/async updates, avoiding mutation while awaiting a promise.
 * 
 * Where values are not expected to evolve, native (mutable) types may be used for convenience.
 * If data is mutated inside of immutable structure, behavior is undefined.
 */

const openAIClient = new DefaultOpenAIClient(process.env.OPENAI_API_KEY || "");
const openAIService = new ChatService(openAIClient);

export class ScenarioState {
  readonly canon: List<ChatCompletionMessageParam>;
  readonly privateInfo: PrivateInfo;
  readonly hash: string;
  readonly parentHash: string | undefined;

  protected constructor(canon: List<ChatCompletionMessageParam>, privateInfo: PrivateInfo, parentHash: string | undefined) {
    this.canon = canon;
    this.privateInfo = privateInfo;
    this.parentHash = parentHash;
    const stateString = JSON.stringify({
      canon: this.canon.toArray(),
      privateInfo: this.privateInfo,
      parentHash: this.parentHash
    });
    this.hash = crypto.createHash('sha256').update(stateString).digest('hex').slice(0, 8);
  }

  static root(initialMessages: ChatCompletionMessageParam[], privateInfo: PrivateInfo): ScenarioState {
    return new ScenarioState(List(initialMessages), privateInfo, undefined);
  }

  child(newMessages: ChatCompletionMessageParam[], privateInfo: PrivateInfo): ScenarioState {
    return new ScenarioState(this.canon.concat(newMessages), privateInfo, this.hash);
  }
}

export class Game {

  private readonly openAIService: ChatService;
  private readonly scenarioStates: Map<string, ScenarioState>; // TODO: add nonce to states to prevent collisions?
  readonly currentState: ScenarioState;
  readonly userInteractions: List<UserInteraction>;

  protected constructor(openAIService: ChatService, scenarioStates: Map<string, ScenarioState>, currentState: ScenarioState, userInteractions: List<UserInteraction>) {
    this.openAIService = openAIService;
    this.scenarioStates = scenarioStates.set(currentState.hash, currentState);
    this.currentState = currentState;
    this.userInteractions = userInteractions;
  }

  static async startGame(openAIService: ChatService, scenarioText: string, players: Player[]): Promise<{
    newGame: Game;
    playerBriefing: string;
  }> {
    const scenarioUpdate = await openAIService.initializeScenario(scenarioText, players);
    const initialState = ScenarioState.root(
      [{ role: "assistant", content: scenarioUpdate.playerBriefing }],
      scenarioUpdate.privateInfo
    );
    return {
      newGame: new Game(openAIService, Map(), initialState, List()),
      playerBriefing: scenarioUpdate.playerBriefing
    };
  }

  protected update(updates: {
    scenarioStates?: Map<string, ScenarioState>;
    currentState?: ScenarioState;
    userInteractions?: List<UserInteraction>;
  }): Game {
    return new Game(
      this.openAIService,
      updates.scenarioStates ?? this.scenarioStates, 
      updates.currentState ?? this.currentState,
      updates.userInteractions ?? this.userInteractions
    );
  }

  queueUserInteraction(interaction: UserInteraction): Game {
    return this.update({ userInteractions: this.userInteractions.push(interaction) });
  }

  removeUserInteraction(index: number): Game {
    return this.update({ userInteractions: this.userInteractions.delete(index) });
  }

  stateHash(): string {
    return this.currentState.hash;
  }

  rollback(hash: string | undefined = undefined): Game | undefined {
    hash = hash ?? this.currentState.parentHash;
    if (!hash) {
      return undefined;
    }
    const state = this.scenarioStates.get(hash);
    if (!state) {
      return undefined;
    }
    return this.update({ currentState: state });
  }

  formatUserInteractions(): string {
    return this.userInteractions.map(interaction => {
      switch (interaction.type) {
        case 'ACTION':
          return `ACTION ${interaction.player.name}: ${interaction.content}`;
        default:
          return `${interaction.type}: ${interaction.content}`;
      }
    }).join("\n");
  }

  async processActions(): Promise<{
    updatedGame: Game;
    response: string;
  }> {
    const processActionsResult = await openAIService.processActions(
      this.currentState.canon.toArray(),
      this.userInteractions.toArray()
    );

    const assistantResponse = processActionsResult[processActionsResult.length - 1];
    const formattedUserInteractionMessage = this.formatUserInteractions();

    const newState = this.currentState.child(
      [
        { role: 'user', content: formattedUserInteractionMessage },
        assistantResponse
      ],
      this.currentState.privateInfo // TODO: update private info
    );

    return {
      updatedGame: this.update({
        currentState: newState,
        userInteractions: List()
      }),
      response: assistantResponse.content as string
    };
  }
}