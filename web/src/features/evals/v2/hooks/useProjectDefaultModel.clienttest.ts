import { act, renderHook } from "@testing-library/react";
import { LLMAdapter } from "@langfuse/shared";
import { useProjectDefaultModel } from "./useProjectDefaultModel";

// NOTE (Litefuse): upstream used `vi.hoisted(...)` here. jest has no equivalent,
// and none is needed: every read of `mocks` below happens lazily, inside the arrow
// functions this module factory exposes (i.e. after this module finished
// evaluating), so a plain module-scope object is safe.
const mocks = {
  refetchConnections: jest.fn(),
  invalidateDefaultModel: jest.fn(),
  invalidateEvaluatorList: jest.fn(),
  invalidateEvaluatorOptions: jest.fn(),
  invalidateEvaluatorFilterOptions: jest.fn(),
  upsertDefaultModel: jest.fn(),
};

// NOTE (Litefuse): jest.mock() specifiers must be relative here. The `@/` alias is
// only rewritten by the SWC transform inside import/export statements, so a bare
// `@/...` string argument reaches jest's resolver verbatim and fails with
// "Cannot find module" (jest.config.mjs has no `@/` moduleNameMapper entry).
jest.mock("../../../../env.mjs", () => ({
  env: { NEXT_PUBLIC_BASE_PATH: "" },
}));

jest.mock("../../../../features/notifications/showSuccessToast", () => ({
  showSuccessToast: jest.fn(),
}));

jest.mock(
  "../../../../features/posthog-analytics/usePostHogClientCapture",
  () => ({
    usePostHogClientCapture: () => jest.fn(),
  }),
);

jest.mock("../../../../features/rbac/utils/checkProjectAccess", () => ({
  useHasProjectAccess: () => true,
}));

jest.mock("../../../../utils/api", () => ({
  api: {
    useUtils: () => ({
      defaultLlmModel: {
        fetchDefaultModel: { invalidate: mocks.invalidateDefaultModel },
      },
      evalsV2: {
        list: { invalidate: mocks.invalidateEvaluatorList },
        options: { invalidate: mocks.invalidateEvaluatorOptions },
        filterOptions: { invalidate: mocks.invalidateEvaluatorFilterOptions },
      },
    }),
    defaultLlmModel: {
      fetchDefaultModel: {
        useQuery: () => ({ data: null }),
      },
      upsertDefaultModel: {
        useMutation: () => ({
          isPending: false,
          mutate: mocks.upsertDefaultModel,
        }),
      },
    },
    llmApiKey: {
      all: {
        useQuery: () => ({
          data: { data: [] },
          isPending: false,
          refetch: mocks.refetchConnections,
        }),
      },
    },
  },
}));

jest.mock("../../../../utils/trpcErrorToast", () => ({
  trpcErrorToast: jest.fn(),
}));

describe("useProjectDefaultModel", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    jest.spyOn(window, "open").mockImplementation(() => null);
  });

  it("refreshes model filter options after updating the project default", async () => {
    const { result } = renderHook(() =>
      useProjectDefaultModel({ projectId: "project-1", source: "overview" }),
    );

    act(() =>
      result.current.update.requestUpdate({
        provider: "openai",
        model: "gpt-4.1",
        adapter: LLMAdapter.OpenAI,
        modelParams: {},
      }),
    );
    const mutationOptions = mocks.upsertDefaultModel.mock.calls[0]?.[1];
    await act(async () => mutationOptions?.onSuccess());

    expect(mocks.invalidateEvaluatorFilterOptions).toHaveBeenCalledWith({
      projectId: "project-1",
    });
  });

  it("refreshes model connections after returning from provider settings", () => {
    const { result } = renderHook(() =>
      useProjectDefaultModel({ projectId: "project-1", source: "editor" }),
    );

    act(() => result.current.openProviderSettings());
    expect(window.open).toHaveBeenCalledWith(
      "/project/project-1/settings/llm-connections",
      "_blank",
      "noopener,noreferrer",
    );

    act(() => window.dispatchEvent(new Event("focus")));

    expect(mocks.refetchConnections).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new Event("focus")));

    expect(mocks.refetchConnections).toHaveBeenCalledTimes(1);
  });
});
