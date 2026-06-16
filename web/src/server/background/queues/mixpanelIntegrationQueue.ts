import {
  instrumentAsync,
  logger,
  QueueJobs,
  type QueueName,
} from "@langfuse/shared/src/server";
import { handleMixpanelIntegrationSchedule } from "../features/mixpanel/handleMixpanelIntegrationSchedule";
import { handleMixpanelIntegrationProjectJob } from "../features/mixpanel/handleMixpanelIntegrationProjectJob";
import { SpanKind } from "@opentelemetry/api";
import type { QueueJobLike } from "./types";

export const mixpanelIntegrationProcessor = async (
  job: QueueJobLike<QueueName.MixpanelIntegrationQueue>,
) => {
  if (job.name === QueueJobs.MixpanelIntegrationJob) {
    logger.info("Executing Mixpanel Integration Job");
    try {
      return await handleMixpanelIntegrationSchedule();
    } catch (error) {
      logger.error("Error executing MixpanelIntegrationJob", error);
      throw error;
    }
  }
};

export const mixpanelIntegrationProcessingProcessor = async (
  job: QueueJobLike<QueueName.MixpanelIntegrationProcessingQueue>,
) => {
  if (job.name === QueueJobs.MixpanelIntegrationProcessingJob) {
    return await instrumentAsync(
      {
        name: "process mixpanel-integration-project",
        startNewTrace: true,
        spanKind: SpanKind.CONSUMER,
      },
      async () => {
        try {
          return await handleMixpanelIntegrationProjectJob(job);
        } catch (error) {
          logger.error(
            "Error executing MixpanelIntegrationProcessingJob",
            error,
          );
          throw error;
        }
      },
    );
  }
};
