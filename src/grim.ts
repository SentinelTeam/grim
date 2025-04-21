import { config } from "dotenv";
import logger from "./logger";
import { botStart } from "./telegram-bot";

config();

async function main() {
  try {
    logger.info("Starting Telegram bot service.");

    await botStart();

    // Here we can add other services in the future

    logger.info("All services started successfully");
  } catch (error) {
    logger.error("Failed to start services", { error });
    process.exit(1);
  }
}

// Start the application
main().catch(error => {
  logger.error("Unhandled error in main process", { error });
  process.exit(1);
});
