import type { TQueueJobTypes } from "@langfuse/shared/src/server";

export type QueueJobData<Q extends keyof TQueueJobTypes> = Omit<
  TQueueJobTypes[Q],
  "timestamp"
> & {
  timestamp: Date;
};

export type QueueJobLike<Q extends keyof TQueueJobTypes> = {
  id: string;
  name: TQueueJobTypes[Q]["name"];
  data: QueueJobData<Q>;
  opts: {
    repeat?: unknown;
    jobId?: string;
  };
  updateProgress(progress: number): Promise<void>;
};
