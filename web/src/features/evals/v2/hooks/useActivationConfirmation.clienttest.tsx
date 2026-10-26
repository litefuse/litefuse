import { act, renderHook } from "@testing-library/react";
import { useActivationConfirmation } from "./useActivationConfirmation";

// NOTE (Litefuse): upstream used `vi.hoisted(...)` here. jest has no equivalent,
// and none is needed: every read of `mocks` below happens lazily, when `useUtils()`
// is called from inside the hook (i.e. after this module finished evaluating), so a
// plain module-scope object is safe.
const mocks = {
  estimate: jest.fn().mockResolvedValue([
    {
      evaluatorId: "evaluator-1",
      matchingObservations: 20,
      sampling: 1,
      testRunCostUsd: 0.01,
      estimatedCostUsd: 0.2,
    },
  ]),
};

// NOTE (Litefuse): jest.mock() specifiers must be relative here. The `@/` alias is
// only rewritten by the SWC transform inside import/export statements, so a bare
// `@/...` string argument reaches jest's resolver verbatim and fails with
// "Cannot find module" (jest.config.mjs has no `@/` moduleNameMapper entry).
jest.mock("../../../../utils/api", () => ({
  api: {
    useUtils: () => ({
      client: {
        evalsV2: {
          activationCostEstimates: { mutate: mocks.estimate },
        },
      },
    }),
  },
}));

jest.mock("../../../../utils/trpcErrorToast", () => ({
  trpcErrorToast: jest.fn(),
}));

describe("useActivationConfirmation", () => {
  it("owns estimate, sampling, and confirmation state with React state", async () => {
    const onConfirm = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useActivationConfirmation({ projectId: "project-1" }),
    );

    await act(() =>
      result.current.requestActivation({
        targets: [
          {
            evaluatorId: "evaluator-1",
            evaluatorName: "Quality judge",
            filter: [],
            sampling: 1,
          },
        ],
        title: "Activate evaluation rule?",
        description: "Estimate details",
        confirmLabel: "Activate rule",
        onConfirm,
      }),
    );

    expect(result.current.confirmation).toMatchObject({ open: true });
    expect(result.current.estimate).toMatchObject({
      status: "idle",
      sampling: 1,
      estimates: [{ evaluatorId: "evaluator-1", estimatedCostUsd: 0.2 }],
    });

    act(() => result.current.setSampling(0.5));
    await act(() => result.current.confirmActivation());

    expect(onConfirm).toHaveBeenCalledWith(0.5);
    expect(result.current.confirmation).toMatchObject({
      open: false,
      isConfirming: false,
    });
  });
});
