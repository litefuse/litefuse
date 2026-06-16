import type { SendOptions } from "pg-boss";
import { v5 as uuidv5 } from "uuid";
import { QueueName } from "../queues";

const PG_BOSS_SINGLETON_JOB_ID_NAMESPACE =
  "2d280fcb-b6f0-4d6e-8a55-3afc4b6a35d0";

export const derivePgBossJobId = (
  queueName: QueueName,
  options: Pick<SendOptions, "id" | "singletonKey" | "singletonSeconds">,
  fallbackId: string,
): string => {
  if (options.id) {
    return options.id;
  }

  if (options.singletonKey && !options.singletonSeconds) {
    return uuidv5(
      `${queueName}:${options.singletonKey}`,
      PG_BOSS_SINGLETON_JOB_ID_NAMESPACE,
    );
  }

  return fallbackId;
};
