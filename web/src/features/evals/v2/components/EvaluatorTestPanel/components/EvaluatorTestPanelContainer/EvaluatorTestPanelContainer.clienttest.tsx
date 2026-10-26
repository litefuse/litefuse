import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";

import { createEvaluatorSetupStore } from "@/src/features/evals/v2/store/evaluatorSetupStore/evaluatorSetupStore";
import { EvaluatorTestPanelContainer } from "./EvaluatorTestPanelContainer";

// NOTE (Litefuse): jest.mock() specifiers must be relative here. The `@/` alias is
// only rewritten by the SWC transform inside import/export statements, so a bare
// `@/...` string argument reaches jest's resolver verbatim and fails with
// "Cannot find module" (jest.config.mjs has no `@/` moduleNameMapper entry).
jest.mock("../../EvaluatorTestPanel", () => ({
  EvaluatorTestPanel: ({ testSection }: { testSection: ReactNode }) =>
    testSection,
}));

jest.mock(
  "../TestSection/components/TestSectionContainer/TestSectionContainer",
  () => ({
    TestSectionContainer: ({ hasValidModel }: { hasValidModel: boolean }) => (
      <div>{hasValidModel ? "Model available" : "Model missing"}</div>
    ),
  }),
);

describe("EvaluatorTestPanelContainer", () => {
  it("subscribes to model validity without requiring it from the page", () => {
    const store = createEvaluatorSetupStore({
      initialEvaluator: null,
      mode: "create",
    });

    render(
      <EvaluatorTestPanelContainer
        projectId="project-1"
        store={store}
        sampleSelector={null}
        testResult={null}
        testPending={false}
        canRunTest
        rawResultOpen={false}
        onRawResultOpenChange={jest.fn()}
        onRunTest={jest.fn()}
        onOpenExecutionTrace={jest.fn()}
      />,
    );

    expect(screen.getByText("Model missing")).toBeInTheDocument();

    act(() => {
      store
        .getState()
        .actions.selectModel({ provider: "OpenAI", model: "gpt-4.1-mini" });
    });

    expect(screen.getByText("Model available")).toBeInTheDocument();
  });
});
