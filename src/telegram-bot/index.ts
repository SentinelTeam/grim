import { Bot, Context, session, SessionFlavor } from "grammy";
import { config } from "dotenv";
import { DefaultAIClient } from "../ai-client";
import { ChatService } from "./chat-service";
import logger from "../logger";
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import crypto from 'crypto';
import { Player, UserInteraction, UserInteractionType } from "./types";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

interface ScenarioState {
  isActive: boolean;
  messages: Array<ChatCompletionMessageParam>;
}

interface SessionData {
  roleAssignments: Map<number, Player>;
  scenarioState: ScenarioState;
  actionQueue: UserInteraction[];
  scenarioCheckpoints: Map<string, ScenarioState>;
}

type BotContext = Context & SessionFlavor<SessionData>;

export async function botStart(): Promise<void> {
  config();

  // Parse command-line arguments first to get the provider
  const argv = yargs(hideBin(process.argv))
    .option('scenario-file', {
      type: 'string',
      description: 'Path to the scenario file',
    })
    .option('provider', {
      choices: ['openai', 'anthropic'] as const,
      default: 'openai',
      description: 'AI provider to use'
    })
    .help()
    .argv as { [x: string]: unknown; "scenario-file": string | undefined; scenarioFile: string | undefined; provider: "openai" | "anthropic"; _: (string | number)[]; $0: string; };

  const provider = argv.provider;
  const apiKeyEnvVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const apiKey = process.env[apiKeyEnvVar];

  if (!apiKey) {
    console.error(`Error: ${apiKeyEnvVar} is not set in the environment variables.`);
    process.exit(1);
  }

  // Create bot instance
  const bot = new Bot<BotContext>(process.env.TELEGRAM_BOT_TOKEN || "");

  const aiClient = new DefaultAIClient(apiKey, provider);
  const chatService = new ChatService(aiClient);

  // Helper function to generate hash for scenario state
  const generateStateHash = (state: ScenarioState): string => {
    const stateString = JSON.stringify(state);
    return crypto.createHash('sha256').update(stateString).digest('hex').slice(0, 8);
  };

  // Helper function to save current state
  const saveState = (ctx: BotContext) => {
    const hash = generateStateHash(ctx.session.scenarioState);
    ctx.session.scenarioCheckpoints.set(hash, JSON.parse(JSON.stringify(ctx.session.scenarioState)));
    return hash;
  };

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
  const sendChunkedReply = async (ctx: BotContext, content: string) => {
    const chunks = chunkText(content, 4096);
    for (const chunk of chunks) {
      await reply(ctx, chunk);
    }
  };

  // Initialize session storage
  bot.use(session({
    initial: (): SessionData => ({
      roleAssignments: new Map(),
      scenarioState: {
        isActive: false,
        messages: []
      },
      actionQueue: [],
      scenarioCheckpoints: new Map()
    })
  }));

  // Middleware to check if user has a role
  const requireRole = (ctx: BotContext): boolean => {
    const userId = ctx.from?.id;
    if (!userId || !ctx.session.roleAssignments.has(userId)) {
      reply(ctx, "You need to select a role first using /role`");
      return false;
    }
    return true;
  };

  // Middleware to check if scenario is active
  const requireScenario = (ctx: BotContext): boolean => {
    if (!ctx.session.scenarioState.isActive) {
      reply(ctx, "No active scenario. Start one using /scenario first");
      return false;
    }
    return true;
  };

  // Middleware to check if scenario is NOT active
  const requireNoScenario = (ctx: BotContext): boolean => {
    if (ctx.session.scenarioState.isActive) {
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

    const hasRole = ctx.from && ctx.session.roleAssignments.has(ctx.from.id);
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
    ctx.session.roleAssignments.set(player.id, player);
    await reply(ctx, `@${ctx.from?.username} is now ${name} (${role})`);
  });

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

        const players = Array.from(ctx.session.roleAssignments.values());
        const messages = await chatService.initializeScenario(scenarioText, players);

        ctx.session.scenarioState.isActive = true;
        ctx.session.scenarioState.messages = messages;

        const hash = saveState(ctx);

        await sendChunkedReply(ctx, messages[messages.length - 1].content as string);
        await reply(ctx, "Initial state saved with hash:");
        await reply(ctx, hash);

        logger.info("Scenario started successfully", {
          userId: ctx.from?.id,
          username: ctx.from?.username,
          messageCount: messages.length,
          initialStateHash: hash
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

    const player = ctx.session.roleAssignments.get(ctx.from?.id!)!;
    ctx.session.actionQueue.push({
      type: UserInteractionType.INFO,
      player,
      content: message
    });

    await reply(
      ctx,
      "Information request queued. Use /process to process all pending actions. Use /remove <number> to remove an item from the queue.\n\n" +
      "Current queue:\n" +
      formatQueue(ctx.session.actionQueue)
    );
  });

  // Feed command
  gameCommands.command("feed", async (ctx) => {
    const message = ctx.match;
    if (!message) {
      await reply(ctx, "Please provide the information after the /feed command");
      return;
    }

    const player = ctx.session.roleAssignments.get(ctx.from?.id!)!;
    ctx.session.actionQueue.push({
      type: UserInteractionType.FEED,
      player,
      content: message
    });

    await reply(ctx,
      "Information feed queued. Use /process to process all pending actions.\n\n" +
      "Current queue:\n" +
      formatQueue(ctx.session.actionQueue)
    );
  });

  // Action command
  gameCommands.command("action", async (ctx) => {
    const message = ctx.match;
    if (!message) {
      await reply(ctx, "Please provide your action after the /action command");
      return;
    }

    const player = ctx.session.roleAssignments.get(ctx.from?.id!)!;
    ctx.session.actionQueue.push({
      type: UserInteractionType.ACTION,
      player,
      content: message
    });

    await reply(ctx,
      "Action queued. Use /process to process all pending actions.\n\n" +
      "Current queue:\n" +
      formatQueue(ctx.session.actionQueue)
    );
  });

  // Remove command
  gameCommands.command("remove", async (ctx) => {
    const param = ctx.match;
    if (!param) {
      await reply(ctx, "Please provide the item number to remove.");
      return;
    }

    const index = parseInt(param, 10);
    if (Number.isNaN(index) || index < 1 || index > ctx.session.actionQueue.length) {
      await reply(ctx, "Invalid item number.");
      return;
    }

    ctx.session.actionQueue = ctx.session.actionQueue.filter((_, i) => i !== (index - 1));
    await reply(ctx, `Removed item #${index} from the queue.\n\nCurrent queue: \n${formatQueue(ctx.session.actionQueue)}`);
  });

  // Process command
  gameCommands.command("process", async (ctx) => {
    if (ctx.session.actionQueue.length === 0) {
      await reply(ctx, "No actions to process.");
      return;
    }
    await reply(ctx, "Processing actions… Please don't add any more actions until the response arrives.");

    try {
      const processActionsResult = await chatService.processActions(
        ctx.session.scenarioState.messages,
        ctx.session.actionQueue,
      );

      const lastMessage = processActionsResult[processActionsResult.length - 1];

      const formattedMessages = ctx.session.actionQueue.map(action => {
        switch (action.type) {
          case 'ACTION':
            return `ACTION ${action.player.name}: ${action.content}`;
          default:
            return `${action.type}: ${action.content}`;
        }
      }).join("\n");

      ctx.session.scenarioState.messages.push({
        role: "user",
        content: formattedMessages
      });
      ctx.session.scenarioState.messages.push(lastMessage);

      const hash = saveState(ctx);

      logger.info("Canonical scenario messages", ctx.session.scenarioState.messages);

      await sendChunkedReply(ctx, lastMessage.content as string);
      await reply(ctx, `State saved with hash:`);
      await reply(ctx, hash);

      // Clear the queue after successful processing
      ctx.session.actionQueue = [];

    } catch (error) {
      logger.error("Failed to process actions", { error });
      await reply(ctx, "Failed to process actions. Please try again later.");
    }
  });

  // Rollback command
  gameCommands.command("rollback", async (ctx) => {
    const hash = ctx.match;
    if (!hash) {
      await reply(ctx, "Please provide a state hash after the /rollback command");
      return;
    }

    const state = ctx.session.scenarioCheckpoints.get(hash);
    if (!state) {
      await reply(ctx, "Invalid state hash. Please provide a valid hash from a previous state.");
      return;
    }

    // Restore the state
    ctx.session.scenarioState = JSON.parse(JSON.stringify(state));

    await reply(ctx, `Successfully rolled back to state ${hash}`);
    await sendChunkedReply(ctx, "Current state:\n" + state.messages[state.messages.length - 1].content);
  });

  // Error handling
  bot.catch((err) => {
    logger.error("Bot error", {
      error: err.error,
      stack: err.error instanceof Error ? err.error.stack : undefined,
      ctx: err.ctx.update
    });
  });

  logger.info("Starting Telegram bot...");
  bot.start();
  logger.info("Telegram bot started successfully");
} 