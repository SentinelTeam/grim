import { Bot, Context, session, SessionFlavor } from "grammy";
import { config } from "dotenv";
import { ChatService, DefaultOpenAIClient } from "./openai";
import logger from "./logger";
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Player, UserInteraction, UserInteractionType } from "./types";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { GameStateManager, ScenarioStateNode, ScenarioStateRoot } from "./game-state";

config();

type InactiveGrimState = {
  playing: false;
}

type ActiveGrimState = {
  playing: true;
  pendingUserInteractions: UserInteraction[];
  rootState: ScenarioStateRoot;
  currentState: ScenarioStateNode;
}

type GrimState = { players: Player[] } & (InactiveGrimState | ActiveGrimState);

type SessionData = { grimState: GrimState };

type BotContext = Context & SessionFlavor<SessionData>;

// Create bot instance
const bot = new Bot<BotContext>(process.env.TELEGRAM_BOT_TOKEN || "");

const openAIClient = new DefaultOpenAIClient(process.env.OPENAI_API_KEY || "");
const openAIService = new ChatService(openAIClient);
const gameStateManager = new GameStateManager(openAIService);

const reply = async (ctx: BotContext, message: string) => {
  return ctx.reply(message);
};

// Helper function for chunking text
const chunkText = (text: string, maxLength: number): string[] => {
  const findLastNewlineBeforeLimit = (text: string, limit: number): number => {
    const endIndex = Math.min(limit, text.length);
    const searchFrom = text.slice(0, endIndex).lastIndexOf('\n');
    return searchFrom === -1 ? endIndex : searchFrom;
  };

  if (text.length <= maxLength) return [text];

  const splitIndex = findLastNewlineBeforeLimit(text, maxLength);
  const firstChunk = text.slice(0, splitIndex);
  const remainder = text.slice(splitIndex + 1);

  return [firstChunk, ...chunkText(remainder, maxLength)];
};

// Helper function to send chunked replies
const sendChunkedReply = async (ctx: BotContext, text: string) => {
  const chunks = chunkText(text, 4096);
  for (const chunk of chunks) {
    await reply(ctx, chunk);
  }
};

// Initialize session storage
bot.use(session({
  initial: (): SessionData => ({
    grimState: {
      playing: false,
      players: [],
    }
  })
}));

// Middleware to check if user has a role
const requireRole = (ctx: BotContext): boolean => {
  const userId = ctx.from?.id;
  if (!userId || !ctx.session.grimState.players.find(p => p.id === userId)) {
    reply(ctx, "You need to select a role first using /role`");
    return false;
  }
  return true;
};

// Middleware to check if scenario is active
const requireScenario = (ctx: BotContext): boolean => {
  if (!ctx.session.grimState.playing) {
    reply(ctx, "No active scenario. Start one using /scenario first");
    return false;
  }
  return true;
};

// Middleware to check if scenario is NOT active
const requireNoScenario = (ctx: BotContext): boolean => {
  if (ctx.session.grimState.playing) {
    return false;
  }
  return true;
};

// Help command
bot.command("help", async (ctx) => {
  const baseCommands = [
    "/role - Create your role",
    "/help - Show this help message"
  ];

  const scenarioCommands = [
    "/scenario - Start a new scenario",
    "/info - Queue an information request",
    "/feed - Queue information to incorporate into the world",
    "/action - Queue an action in the world",
    "/process - Process all queued actions",
    "/remove - Remove an item from the action queue",
    "/rollback - Roll back the scenario to a previous checkpoint"
  ];

  const hasRole = ctx.from && ctx.session.grimState.players.find(p => p.id === ctx.from?.id);
  const availableCommands = [...baseCommands, ...(hasRole ? scenarioCommands : [])];

  await reply(ctx, "Available commands:\n" + availableCommands.join("\n"));
});

// Role creation command
bot.command("role", async (ctx) => {
  const userId = ctx.from?.id;

  // Get role description from command
  const roleDescription = ctx.match;
  if (!roleDescription) {
    await reply(
      ctx,
      "Please provide your role after the /role command. Format: /role <Your Name> - <Your Role>\n" +
      "Example: /role John Smith - Chief Technology Officer at TechCorp"
    );
    return;
  }

  const invalidRoleFormatMessage = "Invalid role format. Please use: /role <Your Name> - <Your Role>\n" +
    "Example: /role John Smith - Chief Technology Officer at TechCorp";
  const indexOfDash = roleDescription.indexOf('-');
  if (indexOfDash === -1) {
    await reply(
      ctx,
      invalidRoleFormatMessage
    );
    return;
  }
  const parts = [
    roleDescription.substring(0, indexOfDash),
    roleDescription.substring(indexOfDash + 1)
  ].map(part => part.trim());
  if (parts.length !== 2) {
    await reply(
      ctx,
      invalidRoleFormatMessage
    );
    return;
  }

  const [name, role] = parts;

  // Create new player
  const player: Player = {
    id: userId!,
    name,
    role
  };

  // Assign role to user
  ctx.session.grimState.players.push(player);
  await reply(ctx, `@${ctx.from?.username} is now ${name} (${role})`);
});

// Parse command-line arguments
const argv = yargs(hideBin(process.argv))
  .option('scenario-file', {
    type: 'string',
    description: 'Path to the scenario file',
  })
  .help()
  .argv;

// Load scenario from file if provided
let preloadedScenario: string | undefined = undefined;
if (argv['scenario-file']) {
  const fs = require('fs');
  try {
    preloadedScenario = fs.readFileSync(argv['scenario-file'], 'utf8');
    console.log(`Loaded scenario from file: ${argv['scenario-file']}`);
  } catch (err) {
    console.error(`Failed to load scenario file: ${err.message}`);
  }
}

// Create a composer for scenario-related commands that require a role
const scenarioCommands = bot.filter(requireRole);

// Scenario command - also requires no active scenario
scenarioCommands
  .filter(requireNoScenario)
  .command("scenario", async (ctx) => {
    const providedScenarioText = ctx.match;
    const scenarioText = providedScenarioText || preloadedScenario;
    if (!scenarioText) {
      await reply(ctx, "Please provide a scenario description after the /scenario command");
      return;
    }

    try {
      await reply(ctx, "Starting new scenario…");
      logger.info("Starting new scenario", {
        userId: ctx.from?.id,
        username: ctx.from?.username,
        scenarioText,
        scenarioLength: scenarioText.length
      });

      const players = ctx.session.grimState.players;
      const { rootState, playerBriefing } = await gameStateManager.initializeScenario(scenarioText, players);

      ctx.session.grimState = {
        playing: true,
        players,
        pendingUserInteractions: [],
        rootState,
        currentState: rootState
      };

      await sendChunkedReply(ctx, playerBriefing);
      await reply(ctx, "Initial state saved with hash:");
      await reply(ctx, ctx.session.grimState.currentState.stateHash);

      logger.info("Scenario started successfully", {
        userId: ctx.from?.id,
        username: ctx.from?.username,
        initialStateHash: ctx.session.grimState.currentState.stateHash
      });
    } catch (error) {
      logger.error("Failed to initialize scenario", {
        error,
        userId: ctx.from?.id,
        username: ctx.from?.username,
        scenarioText
      });
      await reply(ctx, "Failed to initialize scenario. Please try again later.");
    }
  });

// Create a composer for commands that require both role and active scenario
const gameCommands = scenarioCommands.filter(requireScenario);

// Helper function to format queue for display
const formatQueue = (queue: UserInteraction[]): string => {
  if (queue.length === 0) return "Queue is empty";

  return queue.map((action, index) =>
    `${index + 1}. ${action.player.name} - ${action.type}: ${action.content}`
  ).join('\n');
};

// Info command
gameCommands.command("info", async (ctx) => {
  const message = ctx.match;
  if (!message) {
    await reply(ctx, "Please provide your information request after the /info command");
    return;
  }

  const player = ctx.session.grimState.players.find(p => p.id === ctx.from?.id)!;
  const grimState = ctx.session.grimState as ActiveGrimState;
  grimState.pendingUserInteractions.push({
    type: UserInteractionType.INFO,
    player,
    content: message
  });

  await reply(
    ctx,
    "Information request queued. Use /process to process all pending actions. Use /remove <number> to remove an item from the queue.\n\n" +
    "Current queue:\n" +
    formatQueue(grimState.pendingUserInteractions)
  );
});

// Feed command
gameCommands.command("feed", async (ctx) => {
  const message = ctx.match;
  if (!message) {
    await reply(ctx, "Please provide the information after the /feed command");
    return;
  }

  const player = ctx.session.grimState.players.find(p => p.id === ctx.from?.id)!;
  const grimState = ctx.session.grimState as ActiveGrimState;
  grimState.pendingUserInteractions.push({
    type: UserInteractionType.FEED,
    player,
    content: message
  });

  await reply(ctx,
    "Information feed queued. Use /process to process all pending actions.\n\n" +
    "Current queue:\n" +
    formatQueue(grimState.pendingUserInteractions)
  );
});

// Action command
gameCommands.command("action", async (ctx) => {
  const message = ctx.match;
  if (!message) {
    await reply(ctx, "Please provide your action after the /action command");
    return;
  }

  const player = ctx.session.grimState.players.find(p => p.id === ctx.from?.id)!;
  const grimState = ctx.session.grimState as ActiveGrimState;
  grimState.pendingUserInteractions.push({
    type: UserInteractionType.ACTION,
    player,
    content: message
  });

  await reply(ctx,
    "Action queued. Use /process to process all pending actions.\n\n" +
    "Current queue:\n" +
    formatQueue(grimState.pendingUserInteractions)
  );
});

// Start Generation Here
gameCommands.command("remove", async (ctx) => {
  const grimState = ctx.session.grimState as ActiveGrimState;
  const param = ctx.match;
  if (!param) {
    await reply(ctx, "Please provide the item number to remove.");
    return;
  }

  const index = parseInt(param, 10);
  if (Number.isNaN(index) || index < 1 || index > grimState.pendingUserInteractions.length) {
    await reply(ctx, "Invalid item number.");
    return;
  }

  grimState.pendingUserInteractions = grimState.pendingUserInteractions.filter((_, i) => i !== (index - 1));
  await reply(ctx, `Removed item #${index} from the queue.\n\nCurrent queue: \n${formatQueue(grimState.pendingUserInteractions)}`);
});

// Process command
gameCommands.command("process", async (ctx) => {
  const grimState = ctx.session.grimState as ActiveGrimState;
  if (grimState.pendingUserInteractions.length === 0) {
    await reply(ctx, "No actions to process.");
    return;
  }
  await reply(ctx, "Processing actions… Please don't add any more actions until the response arrives.");

  try {
    const { newState, response } = await gameStateManager.processActions(
      grimState.currentState,
      grimState.pendingUserInteractions
    );

    grimState.currentState = newState;
    await sendChunkedReply(ctx, response);
    await reply(ctx, `State saved with hash:`);
    await reply(ctx, grimState.currentState.stateHash);

    // Clear the queue after successful processing
    grimState.pendingUserInteractions = [];

  } catch (error) {
    logger.error("Failed to process actions", { error });
    await reply(ctx, "Failed to process actions. Please try again later.");
  }
});

// Rollback command
gameCommands.command("rollback", async (ctx) => {
  const targetHash = ctx.match;
  if (!targetHash) {
    await reply(ctx, "Please provide a state hash after the /rollback command");
    return;
  }

  const grimState = ctx.session.grimState as ActiveGrimState;
  const scenarioStateNodeSearchResult = gameStateManager.findNodeByHash(grimState.rootState, targetHash);
  if (!scenarioStateNodeSearchResult) {
    await reply(ctx, "Invalid state hash. Please provide a valid hash from a previous state.");
    return;
  }

  grimState.currentState = scenarioStateNodeSearchResult;

  await sendChunkedReply(ctx, `Successfully rolled back to state ${targetHash}`);
  const { canon } = scenarioStateNodeSearchResult.state;
  const lastMessage = canon[canon.length - 1];
  await sendChunkedReply(ctx, "Current state:\n" + lastMessage.content);
});

// Error handling
bot.catch((err) => {
  logger.error("Bot error", {
    error: err.error,
    stack: err.error instanceof Error ? err.error.stack : undefined,
    ctx: err.ctx.update
  });
});

bot.start();
