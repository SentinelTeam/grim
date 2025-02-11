import { ChatService, DefaultOpenAIClient } from '../src/openai';
import { Player, UserInteraction } from '../src/types';
import { GameStateManager } from '../src/game-state';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../src/logger';

interface ScenarioFile {
  players: Player[];
  scenarioTopic: string;
  actions: UserInteraction[];
}

async function runScenario(scenarioPath: string) {
  // Validate command line argument
  if (!scenarioPath) {
    console.error('Please provide a path to the scenario file.');
    console.error('Usage: ts-node test/scenario-runner.ts <path-to-scenario-file>');
    process.exit(1);
  }

  // Read and parse the scenario file
  const fullPath = path.resolve(scenarioPath);
  let scenarioData: ScenarioFile;
  
  try {
    const fileContent = fs.readFileSync(fullPath, 'utf-8');
    scenarioData = JSON.parse(fileContent);
  } catch (error) {
    console.error(`Error reading scenario file: ${error.message}`);
    process.exit(1);
  }

  // Initialize OpenAI client and service
  const SEED = 42;
  const openAIClient = new DefaultOpenAIClient(process.env.OPENAI_API_KEY || "", SEED);
  const openAIService = new ChatService(openAIClient);
  const gameStateManager = new GameStateManager(openAIService);

  try {
    // Initialize scenario
    logger.info('Initializing scenario...');
    const { rootState, playerBriefing } = await gameStateManager.initializeScenario(
      scenarioData.scenarioTopic,
      scenarioData.players
    );

    // Log initial state
    logger.info('Initial scenario state:', {
      playerBriefing,
      privateInfo: rootState.state.privateInfo
    });

    // Process actions
    const { newState, response } = await gameStateManager.processActions(
      rootState,
      scenarioData.actions
    );

    // Output results
    logger.info(
      'Final results:\n' +
      'Messages:\n' +
      newState.state.canon.map((msg, i) => `[${i + 1}] ${msg.role}: ${msg.content}`).join('\n') +
      '\n\nPrivate Information:\n' +
      `Current time: ${newState.state.privateInfo.currentDateTime}\n` +
      'Timeline:\n' +
      newState.state.privateInfo.scenarioTimeline.map((event, i) => 
        `${event.datetime}: ${event.event}`
      ).join('\n') +
      '\n\nScratchpad:\n' +
      newState.state.privateInfo.scratchpad
    );

  } catch (error) {
    logger.error('Error running scenario:', error);
    process.exit(1);
  }
}

// Run the scenario with the file path from command line arguments
runScenario(process.argv[2]);