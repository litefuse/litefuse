import { act, renderHook } from "@testing-library/react";
import { createEvaluatorSetupStore } from "@/src/features/evals/v2/store/evaluatorSetupStore/evaluatorSetupStore";

import { useEvaluatorTestAvailability } from "./useEvaluatorTestAvailability";

// NOTE (Litefuse): jest.mock() specifiers must be relative here. The `@/` alias is
// only rewritten by the SWC transform inside import/export statements, so a bare
// `@/...` string argument reaches jest's resolver verbatim and fails with
// "Cannot find module" (jest.config.mjs has no `@/` moduleNameMapper entry).
jest.mock("./useEvaluatorSetupSample", () => ({
  useEvaluatorSetupSample: () => ({ id: "sample" }),
}));

describe("useEvaluatorTestAvailability", () => {
  const store = createEvaluatorSetupStore({
    initialEvaluator: null,
    mode: "create",
  });

  beforeEach(() => {
    act(() => {
      store.getState().actions.setType("LLM_AS_JUDGE");
      store.getState().actions.setModelMode("default");
      store
        .getState()
        .actions.setSelectedObservation({ id: "sample" } as never);
    });
  });

  it("blocks LLM evaluator tests when no model is configured", () => {
    const { result, rerender } = renderHook(
      ({ hasValidModel }) =>
        useEvaluatorTestAvailability({
          projectId: "project-1",
          store,
          hasValidModel,
          canRunTest: true,
        }),
      { initialProps: { hasValidModel: false } },
    );

    expect(result.current).toBe("Select a model before running a test.");

    rerender({ hasValidModel: true });
    expect(result.current).toBeNull();

    act(() => store.getState().actions.setType("CODE"));
    rerender({ hasValidModel: false });
    expect(result.current).toBeNull();
  });

  // Test runs bill the configured model, so a read-only role must be stopped
  // before any "select a model"/"pick a sample" hint is offered.
  it("blocks every test run for roles without evaluator:CUD", () => {
    const { result } = renderHook(() =>
      useEvaluatorTestAvailability({
        projectId: "project-1",
        store,
        hasValidModel: true,
        canRunTest: false,
      }),
    );

    expect(result.current).toBe(
      "You do not have permission to run evaluator tests in this project.",
    );
  });
});
