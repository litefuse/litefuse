/** @jest-environment node */

import { createMocks } from "node-mocks-http";
import Decimal from "decimal.js";
import { type NextApiRequest, type NextApiResponse } from "next";

jest.mock("@langfuse/shared/src/server", () => {
  const actual = jest.requireActual("@langfuse/shared/src/server");

  return {
    __esModule: true,
    ...actual,
    getObservationsV2FromEventsTableForPublicApi: jest.fn(),
    logger: {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    },
    traceException: jest.fn(),
    contextWithLangfuseProps: jest.fn(() => ({})),
  };
});

jest.mock(
  "../../features/public-api/server/createAuthedProjectAPIRoute",
  () => {
    return {
      __esModule: true,
      createAuthedProjectAPIRoute:
        (routeConfig: {
          querySchema?: { parse: (query: unknown) => unknown };
          bodySchema?: { parse: (body: unknown) => unknown };
          fn: (params: {
            query: unknown;
            body: unknown;
            req: NextApiRequest;
            res: NextApiResponse;
            auth: {
              validKey: true;
              scope: {
                projectId: string;
                accessLevel: "project";
              };
            };
          }) => Promise<unknown>;
          successStatusCode?: number;
        }) =>
        async (req: NextApiRequest, res: NextApiResponse) => {
          const query = routeConfig.querySchema
            ? routeConfig.querySchema.parse(req.query)
            : {};
          const body = routeConfig.bodySchema
            ? routeConfig.bodySchema.parse(req.body)
            : {};

          const response = await routeConfig.fn({
            query,
            body,
            req,
            res,
            auth: {
              validKey: true,
              scope: {
                projectId: "project-test",
                accessLevel: "project",
              },
            },
          });

          if (!res.writableEnded) {
            res.status(routeConfig.successStatusCode ?? 200).json(response);
          }
        },
    };
  },
);

jest.mock("../../features/public-api/server/cors", () => ({
  __esModule: true,
  cors: (_req: unknown, _res: unknown, next: () => void) => next(),
  runMiddleware: jest.fn(async () => undefined),
}));

import * as sharedServer from "@langfuse/shared/src/server";
import { env } from "@/src/env.mjs";
import { OBSERVATION_FIELD_GROUPS } from "@/src/features/public-api/types/observations";
import handler from "@/src/pages/api/public/v2/observations/index";

const mockGetObservationsV2FromEventsTableForPublicApi = jest.mocked(
  sharedServer.getObservationsV2FromEventsTableForPublicApi,
);

describe("/api/public/v2/observations handler", () => {
  const originalFlag = env.LITEFUSE_ENABLE_EVENTS_TABLE_V2_APIS;

  beforeEach(() => {
    jest.clearAllMocks();
    (
      env as unknown as { LITEFUSE_ENABLE_EVENTS_TABLE_V2_APIS: string }
    ).LITEFUSE_ENABLE_EVENTS_TABLE_V2_APIS = "true";
  });

  afterAll(() => {
    (
      env as unknown as { LITEFUSE_ENABLE_EVENTS_TABLE_V2_APIS: string }
    ).LITEFUSE_ENABLE_EVENTS_TABLE_V2_APIS = originalFlag;
  });

  const createReqRes = (query: Record<string, unknown> = {}) =>
    createMocks({
      method: "GET",
      query,
      headers: {
        authorization: "Basic dGVzdDp0ZXN0",
      },
    });

  it("returns normalized observations with price strings and trace context", async () => {
    mockGetObservationsV2FromEventsTableForPublicApi.mockResolvedValue([
      {
        id: "obs-1",
        traceId: "trace-1",
        startTime: new Date("2026-05-15T10:00:00.000Z"),
        endTime: new Date("2026-05-15T10:00:02.000Z"),
        projectId: "project-test",
        parentObservationId: "",
        type: "GENERATION",
        usagePricingTierName: "Standard",
        traceName: "checkout-trace",
        tags: ["prod", "checkout"],
        release: "2026.05.15",
        modelId: "model-1",
        inputPrice: new Decimal("0.03"),
        outputPrice: new Decimal("0.06"),
        totalPrice: new Decimal("0.09"),
      },
    ] as Awaited<
      ReturnType<
        typeof sharedServer.getObservationsV2FromEventsTableForPublicApi
      >
    >);

    const { req, res } = createReqRes({
      limit: "10",
      fields: "core,usage,trace_context,model",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(
      mockGetObservationsV2FromEventsTableForPublicApi,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-test",
        limit: 10,
        fields: ["core", "usage", "trace_context", "model"],
      }),
    );
    expect(res._getJSONData()).toEqual({
      data: [
        {
          id: "obs-1",
          traceId: "trace-1",
          startTime: "2026-05-15T10:00:00.000Z",
          endTime: "2026-05-15T10:00:02.000Z",
          projectId: "project-test",
          parentObservationId: null,
          type: "GENERATION",
          usagePricingTierName: "Standard",
          traceName: "checkout-trace",
          tags: ["prod", "checkout"],
          release: "2026.05.15",
          modelId: "model-1",
          inputPrice: "0.03",
          outputPrice: "0.06",
          totalPrice: "0.09",
        },
      ],
      meta: {},
    });
  });

  it("returns a cursor based on the last returned item when more than limit items are fetched", async () => {
    mockGetObservationsV2FromEventsTableForPublicApi.mockResolvedValue([
      {
        id: "obs-1",
        traceId: "trace-1",
        startTime: new Date("2026-05-15T10:00:00.000Z"),
        endTime: null,
        projectId: "project-test",
        parentObservationId: null,
        type: "SPAN",
      },
      {
        id: "obs-2",
        traceId: "trace-2",
        startTime: new Date("2026-05-15T09:59:00.000Z"),
        endTime: null,
        projectId: "project-test",
        parentObservationId: null,
        type: "SPAN",
      },
    ] as Awaited<
      ReturnType<
        typeof sharedServer.getObservationsV2FromEventsTableForPublicApi
      >
    >);

    const { req, res } = createReqRes({ limit: "1" });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      data: [
        {
          id: "obs-1",
          traceId: "trace-1",
          startTime: "2026-05-15T10:00:00.000Z",
          endTime: null,
          projectId: "project-test",
          parentObservationId: null,
          type: "SPAN",
        },
      ],
      meta: {
        cursor: Buffer.from(
          JSON.stringify({
            lastStartTimeTo: "2026-05-15T10:00:00.000Z",
            lastTraceId: "trace-1",
            lastId: "obs-1",
          }),
        ).toString("base64"),
      },
    });
  });

  it("treats empty string filters as omitted filters", async () => {
    mockGetObservationsV2FromEventsTableForPublicApi.mockResolvedValue([]);

    const { req, res } = createReqRes({
      limit: "50",
      traceId: "",
      userId: "",
      name: "",
      environment: "",
      version: "",
      parentObservationId: "",
      expandMetadata: "",
      fields: "",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(
      mockGetObservationsV2FromEventsTableForPublicApi,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: undefined,
        userId: undefined,
        name: undefined,
        environment: undefined,
        version: undefined,
        parentObservationId: undefined,
        fields: [...OBSERVATION_FIELD_GROUPS],
        expandMetadataKeys: undefined,
      }),
    );
    expect(res._getJSONData()).toEqual({ data: [], meta: {} });
  });

  it("rejects an empty observation type filter", async () => {
    const { req, res } = createReqRes({
      type: "",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().message).toBe("Invalid request data");
    expect(
      mockGetObservationsV2FromEventsTableForPublicApi,
    ).not.toHaveBeenCalled();
  });

  it("rejects parseIoAsJson=true with 400", async () => {
    const { req, res } = createReqRes({
      parseIoAsJson: "true",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().message).toBe("Invalid request data");
    expect(
      mockGetObservationsV2FromEventsTableForPublicApi,
    ).not.toHaveBeenCalled();
  });

  it("rejects an invalid cursor", async () => {
    const { req, res } = createReqRes({
      cursor: "not-base64-json",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({
      message: "Invalid cursor format",
      error: "InvalidRequestError",
    });
    expect(
      mockGetObservationsV2FromEventsTableForPublicApi,
    ).not.toHaveBeenCalled();
  });

  it("returns 404 when the v2 feature flag is disabled", async () => {
    (
      env as unknown as { LITEFUSE_ENABLE_EVENTS_TABLE_V2_APIS: string }
    ).LITEFUSE_ENABLE_EVENTS_TABLE_V2_APIS = "false";

    const { req, res } = createReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toEqual({
      message:
        "v2 APIs are currently in beta and only available on Litefuse Cloud",
      error: "LangfuseNotFoundError",
    });
  });
});
