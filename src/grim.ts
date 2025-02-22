import { Bot, Context, session, SessionFlavor } from "grammy";
import { config } from "dotenv";
import { ChatService, DefaultOpenAIClient } from "./openai";
import logger from "./logger";
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Player, UserInteractionType } from "./types";
import { Game } from "./game-state";

config();

type SessionData = { players: Player[], game: Game | undefined };

type BotContext = Context & SessionFlavor<SessionData>;

// Create bot instance
const bot = new Bot<BotContext>(process.env.TELEGRAM_BOT_TOKEN || "");

const openAIClient = new DefaultOpenAIClient(process.env.OPENAI_API_KEY || "");
const openAIService = new ChatService(openAIClient);

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
    players: [],
    game: undefined
  })
}));

const getRole = (ctx: BotContext): Player | undefined => {
  const userId = ctx.from?.id;
  if (!userId) {
    return undefined;
  }
  return ctx.session.players.find(p => p.id === userId);
};

// Middleware to check if user has a role
const requireRole = (ctx: BotContext): boolean => {
  return getRole(ctx) !== undefined;
};

// Middleware to check if scenario is active
const requireScenario = (ctx: BotContext): boolean => {
  if (!ctx.session.game) {
    reply(ctx, "No active scenario. Start one using /scenario first");
    return false;
  }
  return true;
};

// Middleware to check if scenario is NOT active
const requireNoScenario = (ctx: BotContext): boolean => {
  if (ctx.session.game) {
    reply(ctx, "That command is not allowed after scenario has started");
    return false;
  }
  return true;
};

// Help command
bot.command("help", async (ctx) => {
  const baseCommands = [
    "/help - Show this help message"
  ];

  const setupCommands = [
    "/role - Create your role",
    "/scenario - Start a new scenario"
  ];

  const scenarioCommands = [
    "/info - Queue an information request",
    "/feed - Queue information to incorporate into the world",
    "/action - Queue an action in the world",
    "/process - Process all queued actions",
    "/remove - Remove an item from the action queue",
    "/rollback - Roll back the scenario to a previous checkpoint"
  ];

  const beforeGame = ctx.session.game === undefined;
  const hasRole = ctx.from && requireRole(ctx);
  const availableCommands = [...baseCommands, ...(beforeGame ? setupCommands : (hasRole ? scenarioCommands : []))];

  await reply(ctx, "Available commands:\n" + availableCommands.join("\n"));
});

// Create a composer for commands that require no active scenario
const setupCommands = bot.filter(requireNoScenario);

// Role creation command
setupCommands.command("role", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await reply(ctx, "Error: unable to determine sender of /role command");
    return;
  }

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
    id: userId,
    name,
    role
  };

  // Assign role to user
  ctx.session.players.push(player);
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

// Scenario command - also requires no active scenario
setupCommands.command("scenario", async (ctx) => {
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

      const { newGame: game, playerBriefing } = await Game.startGame(openAIService, scenarioText, ctx.session.players);

      ctx.session.game = game;

      await sendChunkedReply(ctx, playerBriefing);
      await reply(ctx, "Initial state saved with hash:");
      await reply(ctx, game.stateHash());

      logger.info("Scenario started successfully", {
        userId: ctx.from?.id,
        username: ctx.from?.username,
        initialStateHash: game.stateHash()
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
const gameCommands = bot.filter(requireRole).filter(requireScenario);

// Info command
gameCommands.command("info", async (ctx) => {
  const message = ctx.match;
  if (!message) {
    await reply(ctx, "Please provide your information request after the /info command");
    return;
  }

  const player = getRole(ctx)!;
  ctx.session.game = ctx.session.game?.queueUserInteraction({
    type: UserInteractionType.INFO,
    player,
    content: message
  });

  await reply(
    ctx,
    "Information request queued. Use /process to process all pending actions. Use /remove <number> to remove an item from the queue.\n\n" +
    "Current queue:\n" +
    ctx.session.game?.formatUserInteractions()
  );
});

// Feed command
gameCommands.command("feed", async (ctx) => {
  const message = ctx.match;
  if (!message) {
    await reply(ctx, "Please provide the information after the /feed command");
    return;
  }

  const player = getRole(ctx)!;
  ctx.session.game = ctx.session.game?.queueUserInteraction({
    type: UserInteractionType.FEED,
    player,
    content: message
  });

  await reply(ctx,
    "Information feed queued. Use /process to process all pending actions.\n\n" +
    "Current queue:\n" +
    ctx.session.game?.formatUserInteractions()
  );
});

// Action command
gameCommands.command("action", async (ctx) => {
  const message = ctx.match;
  if (!message) {
    await reply(ctx, "Please provide your action after the /action command");
    return;
  }

  const player = getRole(ctx)!;
  ctx.session.game = ctx.session.game?.queueUserInteraction({
    type: UserInteractionType.ACTION,
    player,
    content: message
  });

  await reply(ctx,
    "Action queued. Use /process to process all pending actions.\n\n" +
    "Current queue:\n" +
    ctx.session.game?.formatUserInteractions()
  );
});

// Start Generation Here
gameCommands.command("remove", async (ctx) => {
  const param = ctx.match;
  if (!param) {
    await reply(ctx, "Please provide the item number to remove.");
    return;
  }

  const index = parseInt(param, 10);
  if (Number.isNaN(index) || index < 1 || index > ctx.session.game!.userInteractions.size) {
    await reply(ctx, "Invalid item number.");
    return;
  }

  ctx.session.game = ctx.session.game?.removeUserInteraction(index - 1);
  await reply(ctx, `Removed item #${index} from the queue.\n\nCurrent queue: \n${ctx.session.game?.formatUserInteractions()}`);
});

// Process command
gameCommands.command("process", async (ctx) => {
  if (ctx.session.game?.userInteractions.size === 0) {
    await reply(ctx, "No actions to process.");
    return;
  }
  await reply(ctx, "Processing actions… Please don't add any more actions until the response arrives.");

  try {
    const { updatedGame: game, response } = await ctx.session.game!.processActions();

    ctx.session.game = game;
    await sendChunkedReply(ctx, response);
    await reply(ctx, `State saved with hash:`);
    await reply(ctx, game.stateHash());

  } catch (error) {
    logger.error("Failed to process actions", { error });
    await reply(ctx, "Failed to process actions. Please try again later.");
  }
});

// Rollback command
gameCommands.command("rollback", async (ctx) => {
  const targetHash = ctx.match;

  const game = ctx.session.game!.rollback(targetHash);
  if (!game) {
    const invalid = targetHash ? "Invalid state hash" : "Already at initial state";
    await reply(ctx, `${invalid}. Please provide a valid hash from a previous state.`);
    return;
  }

  ctx.session.game = game;

  await sendChunkedReply(ctx, `Successfully rolled back to state ${targetHash}`);
  const lastMessage = game.currentState.canon.last()!;
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
