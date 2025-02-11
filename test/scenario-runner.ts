import { ChatService, DefaultOpenAIClient } from '../src/openai';
import { Player, UserInteraction } from '../src/types';
import * as fs from 'fs';
import * as path from 'path';

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
    console.log('Initializing scenario...');
    const scenarioHistory = await openAIService.initializeScenario(
      scenarioData.scenarioTopic,
      scenarioData.players
    );

    // Convert scenario history to message array format
    const scenarioMessages = [{
      role: 'assistant',
      content: JSON.stringify(scenarioHistory)
    }];

    // Process actions
    console.log('Processing actions...');
    const result = await openAIService.processActions(scenarioMessages, scenarioData.actions);

    // Output results
    console.log('\nResults:');
    console.log('=========\n');
    for (const message of result) {
      console.log(`Role: ${message.role}`);
      console.log(`Content: ${message.content}`);
      console.log('=========\n');
    }
  } catch (error) {
    console.error('Error running scenario:', error);
    process.exit(1);
  }
}

// Run the scenario with the file path from command line arguments
runScenario(process.argv[2]); 