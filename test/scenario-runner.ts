import { ChatService, DefaultOpenAIClient } from '../src/openai';
import { Player, UserInteraction, ScenarioState } from '../src/types';
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

  try {
    // Initialize scenario
    logger.info('Initializing scenario...');
    const scenarioUpdate = await openAIService.initializeScenario(
      scenarioData.scenarioTopic,
      scenarioData.players
    );

    // Create initial state
    const initialState: ScenarioState = {
      canon: [{
        role: 'assistant',
        content: scenarioUpdate.playerBriefing
      }],
      privateInfo: scenarioUpdate.privateInfo
    };

    // Log initial state
    logger.info('Initial scenario state:', {
      playerBriefing: scenarioUpdate.playerBriefing,
      privateInfo: scenarioUpdate.privateInfo
    });

    // Process actions
    logger.info('Processing actions...');
    const result = await openAIService.processActions(
      initialState.canon,
      scenarioData.actions
    );

    // TODO: update state with result

    // Output results
    logger.info(
      'Final results:\n' +
      'Messages:\n' +
      result.map((msg, i) => `[${i + 1}] ${msg.role}: ${msg.content}`).join('\n') +
      '\n\nPrivate Information:\n' +
      `Current time: ${initialState.privateInfo.currentDateTime}\n` +
      'Timeline:\n' +
      initialState.privateInfo.scenarioTimeline.map((event, i) => 
        `[${i + 1}] ${event.datetime}: ${event.event}`
      ).join('\n') +
      '\n\nScratchpad:\n' +
      initialState.privateInfo.scratchpad
    );

  } catch (error) {
    logger.error('Error running scenario:', error);
    process.exit(1);
  }
}

// Run the scenario with the file path from command line arguments
runScenario(process.argv[2]);