import { ChatService, DefaultOpenAIClient } from '../src/openai';
import { Player, UserInteraction } from '../src/types';
import { Game } from '../src/game-state';
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

  try {
    // Initialize scenario
    const { newGame } = await Game.startGame(openAIService, scenarioData.scenarioTopic, scenarioData.players);
    let game = newGame;

    let stateHashes: string[] = [];

    for (const round of scenarioData.actionRounds) {
      stateHashes.push(game.stateHash());
      game = round.reduce(
        (currentGame, interaction) => currentGame.queueUserInteraction(interaction),
        game
      );
      const { updatedGame } = await game.processActions();
      game = updatedGame;
    }

    // TODO: save output to a file?

    function formatPrivateInfo(game: Game): string {
      const privateInfo = game.currentState.privateInfo;
      return 'Timeline:\n' +
        privateInfo.scenarioTimeline.map((event, i) =>
          `${event.datetime}: ${event.event}`
        ).join('\n') +
        '\n\nScratchpad:\n' +
        privateInfo.scratchpad;
    }

    logger.info(`Results of scenario ${scenarioPath}:\n\n`);

    for (let index = 0; index < stateHashes.length; index++) {
      logger.info(`Private info at start of round ${index + 1}:\n\n${formatPrivateInfo(game.rollback(stateHashes[index])!)}\n\n`);
    }
    
    logger.info(`Private info at end of scenario:\n\n${formatPrivateInfo(game)}\n\n`);

    logger.info(`Canonical messages:\n\n${game.currentState.canon.map((message, index) => `[${index}] ${message.role}:\n\n${message.content}`).join('\n\n')}`);

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