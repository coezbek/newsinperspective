import { env } from "./config/env.js";
import { buildApp } from "./app.js";
import { createFileLogger } from "./lib/file-logger.js";
import { startScheduler } from "./workers/scheduler.js";
import { startPipelineRunner } from "./services/pipeline-runner.js";

const logger = createFileLogger("api.log");

buildApp()
  .then((app) => {
    logger.info("api starting", { host: env.HOST, port: env.PORT });
    startPipelineRunner();
    startScheduler();
    return app.listen({
      host: env.HOST,
      port: env.PORT,
    });
  })
  .then(() => {
    logger.info("api started", { host: env.HOST, port: env.PORT });
  })
  .catch((error) => {
    logger.error("api failed to start", {
      message: error instanceof Error ? error.message : String(error),
    });
    console.error(error);
    process.exit(1);
  });
