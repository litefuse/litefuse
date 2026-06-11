import { env } from "../env";

export const isEeAvailable: boolean =
  env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION !== undefined ||
  env.LITEFUSE_EE_LICENSE_KEY !== undefined;
