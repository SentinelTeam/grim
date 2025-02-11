import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { Player, PrivateInfo, UserInteraction } from "./types";
import crypto from 'crypto';
import { ChatService } from "./openai";
import logger from "./logger";

export interface ScenarioState {
  canon: Array<ChatCompletionMessageParam>;
  privateInfo: PrivateInfo;
}

export type ScenarioStateNode = ScenarioStateRoot | ScenarioStateChild;

export interface ScenarioStateRoot {
  state: ScenarioState;
  stateHash: string;
  children: ScenarioStateChild[];
}

export interface ScenarioStateChild extends ScenarioStateRoot {
  parent: ScenarioStateChild | ScenarioStateRoot;
}

export class GameStateManager {
  private openAIService: ChatService;

  constructor(openAIService: ChatService) {
    this.openAIService = openAIService;
  }

  generateStateHash(state: ScenarioState): string {
    const stateString = JSON.stringify(state);
    return crypto.createHash('sha256').update(stateString).digest('hex').slice(0, 8);
  }

  createScenarioStateRoot(state: ScenarioState): ScenarioStateRoot {
    return {
      state,
      stateHash: this.generateStateHash(state),
      children: []
    };
  }

  createScenarioStateChildNode(state: ScenarioState, parent: ScenarioStateNode): ScenarioStateChild {
    return {
      ...this.createScenarioStateRoot(state),
      parent
    };
  }

  findNodeByHash(node: ScenarioStateNode, hash: string): ScenarioStateNode | undefined {
    if (node.stateHash === hash) return node;
    return node.children.reduce<ScenarioStateNode | undefined>(
      (found, child) => found || this.findNodeByHash(child, hash),
      undefined
    );
  }

  async initializeScenario(scenarioText: string, players: Player[]): Promise<{
    rootState: ScenarioStateRoot;
    playerBriefing: string;
  }> {
    const scenarioUpdate = await this.openAIService.initializeScenario(scenarioText, players);

    const rootState = this.createScenarioStateRoot({
      canon: [{ role: "assistant", content: scenarioUpdate.playerBriefing }],
      privateInfo: scenarioUpdate.privateInfo
    });

    return {
      rootState,
      playerBriefing: scenarioUpdate.playerBriefing
    };
  }

  formatUserInteractions(interactions: UserInteraction[]): string {
    return interactions.map(action => {
      switch (action.type) {
        case 'ACTION':
          return `ACTION ${action.player.name}: ${action.content}`;
        default:
          return `${action.type}: ${action.content}`;
      }
    }).join("\n");
  }

  async processActions(currentState: ScenarioStateNode, pendingActions: UserInteraction[]): Promise<{
    newState: ScenarioStateNode;
    response: string;
  }> {
    const processActionsResult = await this.openAIService.processActions(
      currentState.state.canon,
      pendingActions
    );

    const assistantResponse = processActionsResult[processActionsResult.length - 1];
    const formattedUserInteractionMessage = this.formatUserInteractions(pendingActions);

    const newState = this.createScenarioStateChildNode(
      {
        canon: [...currentState.state.canon, 
          { role: 'user', content: formattedUserInteractionMessage }, 
          assistantResponse
        ],
        privateInfo: currentState.state.privateInfo // TODO: update private info
      },
      currentState
    );

    return {
      newState,
      response: assistantResponse.content as string
    };
  }
} 