// ── LITEFUSE PORT ───────────────────────────────────────────────────────────
// Copied from upstream Langfuse 4.56.0
// `web/src/features/public-api/server/stablePublicApiRoute.ts`: new public
// endpoints opt into the structured error contract instead of the legacy
// `{ message, error }` body. Upstream implements this through an `errorContract`
// option on `createAuthedProjectAPIRoute`/`withMiddlewares`; Litefuse has that
// option too now (see the Litefuse notes in both files), so this file is a thin
// wrapper exactly like upstream's.
//
// Upstream's route config additionally carries `action` (RBAC policy action).
// Litefuse's `AuthHeaderValidVerificationResult` scope has no policy layer
// (`web/src/features/public-api/server/createAuthedProjectAPIRoute.ts` only
// checks basic auth + project access level), so the action is not accepted
// here.
// ─────────────────────────────────────────────────────────────────────────────
import { type NextApiRequest, type NextApiResponse } from "next";
import { type ZodType } from "zod/v4";
import {
  createAuthedProjectAPIRoute,
  type AuthedProjectAPIRouteConfig,
} from "@/src/features/public-api/server/createAuthedProjectAPIRoute";
import {
  withMiddlewares,
  type HttpMethod,
} from "@/src/features/public-api/server/withMiddlewares";
import { structuredPublicApiErrorContract } from "./structuredPublicApiErrorContract";

type StablePublicApiRouteConfig<
  TQuery extends ZodType<any>,
  TBody extends ZodType<any>,
  TResponse extends ZodType<any>,
> = Omit<
  AuthedProjectAPIRouteConfig<TQuery, TBody, TResponse>,
  "errorContract"
>;

type StablePublicApiHandlers = {
  [Method in HttpMethod]?: (
    req: NextApiRequest,
    res: NextApiResponse,
  ) => Promise<void>;
};

export const createStablePublicApiRoute = <
  TQuery extends ZodType<any>,
  TBody extends ZodType<any>,
  TResponse extends ZodType<any>,
>(
  routeConfig: StablePublicApiRouteConfig<TQuery, TBody, TResponse>,
) =>
  createAuthedProjectAPIRoute({
    ...routeConfig,
    errorContract: structuredPublicApiErrorContract,
  });

export const withStablePublicApiMiddlewares = (
  handlers: StablePublicApiHandlers,
) =>
  withMiddlewares(handlers, {
    errorContract: structuredPublicApiErrorContract,
  });
