import {
  getPgBossQueue,
  logger,
  QueueName,
  recordHistogram,
} from "@langfuse/shared/src/server";

export class DlqRetryService {
  private static retryQueues = [QueueName.BatchActionQueue] as const;

  // called each 10 minutes, defined by the bull cron job
  public static async retryDeadLetterQueue() {
    logger.info(
      `Retrying dead letter queues for queues: ${DlqRetryService.retryQueues.join(
        ", ",
      )}`,
    );
    const retryQueues = DlqRetryService.retryQueues;
    for (const queueName of retryQueues) {
      const queue = getPgBossQueue(queueName);
      const failedJobs = (await queue.findJobs()).filter(
        (job) => job.state === "failed",
      );
      logger.info(
        `Found ${failedJobs.length} failed jobs in queue ${queueName}`,
      );
      for (const job of failedJobs) {
        try {
          const projectId = (job.data as any)?.payload?.projectId;
          const ts = new Date((job.data as any)?.timestamp ?? job.createdOn);
          const dlxDelay = Date.now() - ts.getTime();

          recordHistogram("langfuse.dlq_retry_delay", dlxDelay, {
            unit: "milliseconds",
            projectId: projectId ?? "unknown",
            queueName,
          });

          await queue.retryJobs([job.id]);
          logger.info(
            `Retried job ${JSON.stringify(job)} in queue ${queueName}`,
          );
        } catch (error) {
          logger.error(
            `Failed to retry job ${JSON.stringify(job)} in queue ${queueName}:`,
            error,
          );
        }
      }
    }
  }
}
