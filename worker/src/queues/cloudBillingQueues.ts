import {
  CloudUsageMeteringQueue,
  instrumentAsync,
  QueueJobs,
} from "@langfuse/shared/src/server";
import { SpanKind } from "@opentelemetry/api";
import type { Processor } from "bullmq";
import { processCloudUsageMetering } from "../features/billing/usageMetering";
import { processUsageThresholds } from "../features/billing/usageThresholds";

export const cloudUsageMeteringQueueProcessor: Processor = async (job) => {
  if (job.name !== QueueJobs.CloudUsageMeteringJob) return;
  const result = await instrumentAsync(
    {
      name: "process cloud-usage-metering",
      startNewTrace: true,
      spanKind: SpanKind.CONSUMER,
    },
    () => processCloudUsageMetering(job),
  );
  if (!result.caughtUp) {
    await CloudUsageMeteringQueue.getInstance()?.add(
      QueueJobs.CloudUsageMeteringJob,
      {},
    );
  }
  return result;
};

export const cloudFreeTierUsageThresholdQueueProcessor: Processor = async (
  job,
) => {
  if (job.name !== QueueJobs.CloudFreeTierUsageThresholdJob) return;
  return instrumentAsync(
    {
      name: "process developer-usage-thresholds",
      startNewTrace: true,
      spanKind: SpanKind.CONSUMER,
    },
    () => processUsageThresholds(),
  );
};
