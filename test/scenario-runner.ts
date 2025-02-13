import { ChatService, DefaultOpenAIClient } from '../src/openai';
import { Player, UserInteraction } from '../src/types';
import { GameStateManager, ScenarioStateNode } from '../src/game-state';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../src/logger';

interface ScenarioFile {
  players: Player[];
  scenarioTopic: string;
  actionRounds: UserInteraction[][];
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
    const { rootState, playerBriefing } = await gameStateManager.initializeScenario(
      scenarioData.scenarioTopic,
      scenarioData.players
    );

    let currentState = rootState;

    let privateInfoSnapshots: string[] = [];

    function saveSnapshot(state: ScenarioStateNode) {
      privateInfoSnapshots.push(
        `Current time: ${state.state.privateInfo.currentDateTime}\n\n` +
        'Timeline:\n' +
        state.state.privateInfo.scenarioTimeline.map((event, i) =>
          `${event.datetime}: ${event.event}`
        ).join('\n') +
        '\n\nScratchpad:\n' +
        state.state.privateInfo.scratchpad
      );
    }

    for (let roundIndex = 0; roundIndex < scenarioData.actionRounds.length; roundIndex++) {

      saveSnapshot(currentState);

      const actions = scenarioData.actionRounds[roundIndex];

      // Process actions for this round
      const { newState, response } = await gameStateManager.processActions(
        currentState,
        actions
      );

      currentState = newState;
    }

    saveSnapshot(currentState);

    // TODO: save output to a file?

    logger.info(`Results of scenario ${scenarioPath}:\n\n`);

    for (let index = 0; index < privateInfoSnapshots.length; index++) {
      logger.info(`Private info at start of round ${index + 1}:\n\n${privateInfoSnapshots[index]}\n\n`);
    }

    logger.info(`Canonical messages:\n\n${currentState.state.canon.map((message, index) => `[${index}] ${message.role}:\n\n${message.content}`).join('\n\n')}`);

  } catch (error) {
    logger.error('Error running scenario:', error);
    process.exit(1);
  }
}

async function main() {
  const scenariosDir = path.resolve(__dirname, 'scenarios');
  const scenarioFiles = process.argv[2]
    ? [process.argv[2]]
    : fs.readdirSync(scenariosDir)
      .filter((file: string): boolean => file.endsWith('.json'))
      .map(file => path.join(scenariosDir, file));

  if (scenarioFiles.length === 0) {
    console.error(`No scenario files found in directory: ${scenariosDir}`);
    process.exit(1);
  }

  for (const scenarioPath of scenarioFiles) {
    console.info(`Running scenario file: ${scenarioPath}`);
    await runScenario(scenarioPath);
  }
}

main();