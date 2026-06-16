// https://github.com/vercel/next.js/issues/51404
// There is no official best way to gracefully shutdown a Next.js app in Docker.
// This here is a workaround to handle SIGTERM and SIGINT signals.
// NEVER call process.exit() in this process. Kubernetes should kill the container: https://kostasbariotis.com/why-you-should-not-use-process-exit/
// We wait for 110 seconds to allow the app to finish processing requests. There is no native way to do this in Next.js.

import {
  DorisClientManager,
  logger,
  stopSharedPostgresPool,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { RateLimitService } from "@/src/features/public-api/server/RateLimitService";

const TIMEOUT = 110_000;

declare global {
  var sigtermReceived: boolean | undefined;
}

globalThis.sigtermReceived = globalThis.sigtermReceived ?? false;

export const setSigtermReceived = () => {
  console.log("Set sigterm received to true");
  globalThis.sigtermReceived = true;
};

export const isSigtermReceived = () =>
  Boolean(process.env.NEXT_MANUAL_SIG_HANDLE) && globalThis.sigtermReceived;

export const shutdown = async (signal: PrexitSignal) => {
  if (signal === "SIGTERM" || signal === "SIGINT") {
    console.log(
      `SIGTERM / SIGINT received. Shutting down in ${TIMEOUT / 1000} seconds.`,
    );
    setSigtermReceived();
    const { stopBackgroundProcessing } = await import(
      "@/src/server/background/bootstrap"
    );
    await stopBackgroundProcessing();

    return await new Promise<void>((resolve) => {
      setTimeout(async () => {
        RateLimitService.shutdown();

        // Give any straggler Stream Loads up to 10s to finish before
        // we tear down their HTTP/MySQL pools. The 110s upstream
        // timeout already gives in-flight HTTP requests time to drain,
        // but a request that started near the end of that window can
        // still be mid-Stream-Load when we get here. Without this,
        // closeAllConnections() races with active stream loads and
        // can cut their sockets, forcing SDK retries.
        await DorisClientManager.getInstance().waitForAllInflight(10_000);

        // Shutdown Doris connections
        await DorisClientManager.getInstance().closeAllConnections();

        await prisma.$disconnect();
        logger.info("Prisma connection has been closed.");
        await stopSharedPostgresPool();
        logger.info("Shared Postgres pool has been closed.");

        logger.info("Shutdown complete");
        resolve();
      }, TIMEOUT);
    });
  }
};
