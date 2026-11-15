/** @jest-environment jsdom */
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { PeekViewObservationDetail } from "@/src/components/table/peek/peek-observation-detail";
import { useParsedObservation } from "@/src/hooks/useParsedObservation";

const mockQuery: Record<string, string | undefined> = {};
let mockBeta = false;
const mockCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
let mockTrace: ReturnType<typeof deferred<Record<string, unknown>>>;
let mockIO: ReturnType<typeof deferred<Record<string, unknown>>>;
const startTime = new Date("2026-08-02T00:01:00Z");
const traceTime = new Date("2026-08-01T23:59:00Z");
const reference = { id: "obs-a", traceId: "trace-a", startTime };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Real React Query scheduling/cache; only the authenticated transport is mocked.
function useMockQuery(
  name: string,
  input: Record<string, unknown>,
  options: Record<string, unknown> = {},
) {
  return useQuery({
    ...options,
    queryKey: [name, input],
    queryFn: async () => {
      mockCalls.push({ name, input });
      if (name === "trace") return mockTrace.promise;
      const io = await mockIO.promise;
      return name === "events" ? [io] : io;
    },
    retry: false,
  });
}
jest.mock("@/src/utils/api", () => ({
  api: {
    traces: {
      byIdWithObservationsAndScores: {
        useQuery: (
          input: Record<string, unknown>,
          opts: Record<string, unknown>,
        ) => useMockQuery("trace", input, opts),
      },
    },
    observations: {
      byId: {
        useQuery: (
          input: Record<string, unknown>,
          opts: Record<string, unknown>,
        ) => useMockQuery("observation", input, opts),
      },
    },
    events: {
      batchIO: {
        useQuery: (
          input: Record<string, unknown>,
          opts: Record<string, unknown>,
        ) => useMockQuery("events", input, opts),
      },
    },
  },
}));
jest.mock("next/router", () => ({ useRouter: () => ({ query: mockQuery }) }));
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (value: string) => value }),
}));
jest.mock("use-query-params", () => ({
  StringParam: {},
  withDefault: jest.fn(),
  useQueryParam: () => ["details", jest.fn()],
}));
jest.mock("@/src/features/events/hooks/useV4Beta", () => ({
  useV4Beta: () => ({ isBetaEnabled: mockBeta }),
}));
jest.mock("@/src/features/events/hooks/useEventsTraceData", () => ({
  useEventsTraceData: ({ enabled }: { enabled: boolean }) =>
    useMockQuery("trace", { beta: true }, { enabled }),
}));
jest.mock("@/src/utils/clientSideDomainTypes", () => ({
  stringifyMetadata: (value: unknown) => JSON.stringify(value),
}));
jest.mock("@langfuse/shared", () => ({
  deepParseJsonIterative: (value: unknown) => value,
}));
jest.mock("@/src/components/trace2/Trace", () => ({ Trace: MockDetail }));
function MockDetail() {
  const result = useParsedObservation({
    projectId: "project-a",
    traceId: mockQuery.traceId!,
    observationId: mockQuery.observation ?? mockQuery.peek!,
    startTime,
    baseObservation: undefined,
  });
  return <div>{String(result.observation?.input ?? "detail-loading")}</div>;
}

const clients: QueryClient[] = [];
function mount(references = [reference]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const tree = (refs = references) => (
    <QueryClientProvider client={client}>
      <PeekViewObservationDetail
        projectId="project-a"
        observationReferences={refs}
      />
    </QueryClientProvider>
  );
  return { ...render(tree()), tree, client };
}
beforeEach(() => {
  Object.keys(mockQuery).forEach((key) => delete mockQuery[key]);
  Object.assign(mockQuery, {
    peek: "obs-a",
    observation: "obs-a",
    traceId: "trace-a",
    timestamp: traceTime.toISOString(),
  });
  mockBeta = false;
  mockCalls.length = 0;
  mockTrace = deferred();
  mockIO = deferred();
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
});

it.each([false, true])(
  "starts full content while Trace is pending, reuses it after mount (beta=%s)",
  async (beta) => {
    mockBeta = beta;
    mount();
    const name = beta ? "events" : "observation";
    await waitFor(() =>
      expect(mockCalls.map((call) => call.name)).toEqual(
        expect.arrayContaining(["trace", name]),
      ),
    );
    expect(screen.queryByText("full-content")).toBeNull();
    const input = mockCalls.find((call) => call.name === name)!.input;
    if (beta) {
      expect(input).toMatchObject({
        minStartTime: startTime,
        maxStartTime: startTime,
        truncated: false,
      });
    } else {
      expect(input).toEqual({
        projectId: "project-a",
        traceId: "trace-a",
        observationId: "obs-a",
        startTime,
      });
    }
    await act(async () =>
      mockIO.resolve({ input: "full-content", output: "complete-output" }),
    );
    await act(async () =>
      mockTrace.resolve({
        id: "trace-a",
        projectId: "project-a",
        observations: [],
        scores: [],
        corrections: [],
      }),
    );
    await waitFor(() => expect(screen.getByText("full-content")).toBeTruthy());
    expect(mockCalls.filter((call) => call.name === name)).toHaveLength(1);
  },
);

it("deduplicates the still-pending content request when Trace finishes first", async () => {
  mount();
  await waitFor(() =>
    expect(mockCalls.some((call) => call.name === "observation")).toBe(true),
  );
  await act(async () =>
    mockTrace.resolve({
      id: "trace-a",
      observations: [],
      scores: [],
      corrections: [],
    }),
  );
  await waitFor(() => expect(screen.getByText("detail-loading")).toBeTruthy());
  await act(async () => mockIO.resolve({ input: "full-content" }));
  await waitFor(() => expect(screen.getByText("full-content")).toBeTruthy());
  expect(mockCalls.filter((call) => call.name === "observation")).toHaveLength(
    1,
  );
});

it.each([
  "missing",
  "wrong-trace",
  "invalid-time",
  "other-selection",
  "ambiguous",
])("does not speculate from %s references", async (mode) => {
  if (mode === "other-selection") mockQuery.observation = "obs-b";
  const refs =
    mode === "missing"
      ? []
      : mode === "wrong-trace"
        ? [{ ...reference, traceId: "other" }]
        : mode === "invalid-time"
          ? [{ ...reference, startTime: new Date(NaN) }]
          : mode === "ambiguous"
            ? [reference, { ...reference, startTime: traceTime }]
            : [reference];
  mount(refs);
  await waitFor(() =>
    expect(mockCalls.filter((call) => call.name === "trace")).toHaveLength(1),
  );
  expect(mockCalls.filter((call) => call.name !== "trace")).toHaveLength(0);
});

it("falls back to the existing detail load when a link has no list reference", async () => {
  mount([]);
  await act(async () =>
    mockTrace.resolve({
      id: "trace-a",
      observations: [],
      scores: [],
      corrections: [],
    }),
  );
  await waitFor(() =>
    expect(
      mockCalls.filter((call) => call.name === "observation"),
    ).toHaveLength(1),
  );
  await act(async () => mockIO.resolve({ input: "full-content" }));
  await waitFor(() => expect(screen.getByText("full-content")).toBeTruthy());
});

it("starts a new keyed request when switching rows before the old response arrives", async () => {
  const page = mount();
  await waitFor(() =>
    expect(
      mockCalls.filter((call) => call.name === "observation"),
    ).toHaveLength(1),
  );
  Object.assign(mockQuery, {
    peek: "obs-b",
    observation: "obs-b",
    traceId: "trace-b",
  });
  const nextIO = deferred<Record<string, unknown>>();
  const previousIO = mockIO;
  mockIO = nextIO;
  page.rerender(page.tree([{ ...reference, id: "obs-b", traceId: "trace-b" }]));
  await waitFor(() =>
    expect(
      mockCalls.filter((call) => call.name === "observation"),
    ).toHaveLength(2),
  );
  await act(async () => previousIO.resolve({ input: "old-content" }));
  await act(async () =>
    mockTrace.resolve({
      id: "trace-b",
      observations: [],
      scores: [],
      corrections: [],
    }),
  );
  await waitFor(() => expect(screen.getByText("detail-loading")).toBeTruthy());
  expect(screen.queryByText("old-content")).toBeNull();
  await act(async () => nextIO.resolve({ input: "new-content" }));
  await waitFor(() => expect(screen.getByText("new-content")).toBeTruthy());
  expect(mockCalls.filter((call) => call.name === "observation")).toHaveLength(
    2,
  );
});

it("does not display prefetched content if Trace authorization fails", async () => {
  mount();
  await waitFor(() =>
    expect(mockCalls.some((call) => call.name === "observation")).toBe(true),
  );
  await act(async () => mockIO.resolve({ input: "full-content" }));
  await act(async () => mockTrace.reject(new Error("UNAUTHORIZED")));
  expect(screen.queryByText("full-content")).toBeNull();
});

it("does not fetch content when the peek is closed", async () => {
  delete mockQuery.peek;
  delete mockQuery.observation;
  mount();
  await waitFor(() =>
    expect(mockCalls.filter((call) => call.name === "trace")).toHaveLength(1),
  );
  expect(mockCalls.filter((call) => call.name !== "trace")).toHaveLength(0);
});

it("keeps disabled content query keys stable across list rerenders", async () => {
  delete mockQuery.peek;
  delete mockQuery.observation;
  const page = mount();
  await waitFor(() =>
    expect(mockCalls.filter((call) => call.name === "trace")).toHaveLength(1),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  page.rerender(page.tree());
  const inactiveQueries = page.client
    .getQueryCache()
    .getAll()
    .filter((query) => query.queryKey[0] === "events");
  expect(inactiveQueries).toHaveLength(1);
  expect(mockCalls.filter((call) => call.name !== "trace")).toHaveLength(0);
});
