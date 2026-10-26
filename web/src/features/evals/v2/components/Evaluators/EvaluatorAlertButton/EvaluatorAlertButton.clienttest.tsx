import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { EvaluatorAlertButton } from "./EvaluatorAlertButton";

// NOTE (Litefuse): upstream used `vi.hoisted(() => vi.fn())`. jest has no equivalent,
// and none is needed: `routerPush` is only read lazily, inside the `useRouter()` arrow
// the module factory exposes, so a plain module-scope mock is safe.
const routerPush = jest.fn();

jest.mock("next/router", () => ({
  useRouter: () => ({ push: routerPush }),
}));

// NOTE (Litefuse): jest.mock() specifiers must be relative here. The `@/` alias is
// only rewritten by the SWC transform inside import/export statements, so a bare
// `@/...` string argument reaches jest's resolver verbatim and fails with
// "Cannot find module" (jest.config.mjs has no `@/` moduleNameMapper entry).
jest.mock("../../../../../posthog-analytics", () => ({
  usePostHogClientCapture: () => jest.fn(),
}));

describe("EvaluatorAlertButton", () => {
  // NOTE (Litefuse): `vi.stubGlobal` / `vi.unstubAllGlobals` have no jest equivalent
  // (jest only ships `jest.replaceProperty`), so the global is (un)set directly.
  beforeAll(() => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  afterAll(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });

  beforeEach(() => {
    routerPush.mockReset().mockResolvedValue(true);
  });

  it("offers to add an alert when none are configured", () => {
    const { container } = render(
      <EvaluatorAlertButton
        scope="allEvaluators"
        projectId="project-1"
        connectedAlerts={[]}
        canRead
        canCreate
      />,
    );

    expect(
      screen.getByRole("button", { name: "Add evaluator alert" }),
    ).toHaveTextContent("Add alert");
    expect(container.querySelector(".lucide-plus")).toBeInTheDocument();
    expect(container.querySelector(".lucide-chevron-down")).toHaveClass("ml-1");
    expect(container.querySelector(".lucide-bell")).not.toBeInTheDocument();
  });

  it("keeps the alert label and shows a spinner while loading", () => {
    const { container } = render(
      <EvaluatorAlertButton
        scope="allEvaluators"
        projectId="project-1"
        connectedAlerts={[]}
        isLoading
        canRead
        canCreate
      />,
    );

    expect(
      screen.getByRole("button", { name: "Loading evaluator alerts" }),
    ).toHaveTextContent("Add alert");
    expect(container.querySelector(".lucide-loader-circle")).toHaveClass(
      "animate-spin",
    );
    expect(container.querySelector(".lucide-plus")).not.toBeInTheDocument();
  });

  it("uses the evaluator score style for code evaluators", () => {
    render(
      <EvaluatorAlertButton
        scope="evaluator"
        projectId="project-1"
        evaluatorId="evaluator-1"
        evaluatorType="CODE"
        scoreDataType="BOOLEAN"
        connectedAlerts={[]}
        canRead
        canCreate
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Add evaluator alert" }),
    );

    const scoreAlert = screen
      .getByText("Score threshold")
      .closest("[cmdk-item]");
    expect(scoreAlert).not.toBeNull();
    expect(
      scoreAlert?.querySelector(".lucide-arrow-up-right"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Numeric score")).not.toBeInTheDocument();
    expect(screen.queryByText("Boolean score")).not.toBeInTheDocument();
    expect(screen.queryByText("Categorical score")).not.toBeInTheDocument();
    expect(screen.queryByText("Cost threshold")).not.toBeInTheDocument();
  });

  it("does not offer another cost alert for connected code evaluators", () => {
    render(
      <EvaluatorAlertButton
        scope="evaluator"
        projectId="project-1"
        evaluatorId="evaluator-1"
        evaluatorType="CODE"
        scoreDataType="BOOLEAN"
        connectedAlerts={[
          {
            id: "alert-1",
            name: "Evaluator alert",
            severity: "UNKNOWN",
            metric: { measure: "count", aggregation: "count" },
            thresholdOperator: "GT",
            alertThreshold: 1,
            alertedAt: null,
          },
        ]}
        canRead
        canCreate
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "1 connected evaluator alert" }),
    );

    expect(screen.getByRole("button", { name: "Score" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cost" }),
    ).not.toBeInTheDocument();
  });

  it("shows a table link after 20 connected alerts and keeps bottom actions icon-free", () => {
    render(
      <EvaluatorAlertButton
        scope="evaluator"
        projectId="project-1"
        evaluatorId="evaluator-1"
        evaluatorType="LLM_AS_JUDGE"
        scoreDataType="NUMERIC"
        connectedAlerts={[
          {
            id: "alert-1",
            name: "Evaluator alert",
            severity: "UNKNOWN",
            metric: { measure: "count", aggregation: "count" },
            thresholdOperator: "GT",
            alertThreshold: 1,
            alertedAt: null,
          },
        ]}
        hasMore
        canRead
        canCreate
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "1 connected evaluator alert" }),
    );

    const connectedAlert = screen
      .getByText("Evaluator alert")
      .closest("[cmdk-item]");
    expect(
      connectedAlert?.querySelector(".lucide-arrow-up-right"),
    ).toBeInTheDocument();

    const scoreAction = screen.getByRole("button", { name: "Score" });
    const costAction = screen.getByRole("button", { name: "Cost" });
    expect(
      scoreAction.querySelector(".lucide-arrow-up-right"),
    ).not.toBeInTheDocument();
    expect(
      costAction.querySelector(".lucide-arrow-up-right"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("See all alerts"));
    expect(routerPush).toHaveBeenCalledWith(
      "/project/project-1/alerts?filter=evaluatorId%3BstringOptions%3B%3Bany+of%3Bevaluator-1",
    );
  });

  // LITEFUSE (decision M1): the evaluator surfaces opt in to hiding the
  // creation entry point while there is nothing connected, so no "Add alert"
  // affordance is offered. Connected alerts still render the full picker, which
  // the cases above pin down.
  it("hides the create entry when the surface opts in and no alerts are connected", () => {
    const { container } = render(
      <EvaluatorAlertButton
        scope="evaluator"
        projectId="project-1"
        evaluatorId="evaluator-1"
        evaluatorType="LLM_AS_JUDGE"
        scoreDataType="NUMERIC"
        connectedAlerts={[]}
        canRead
        canCreate
        hideCreateEntryWhenEmpty
      />,
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Add alert")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the connected-alert picker when the surface opts in and alerts are connected", () => {
    render(
      <EvaluatorAlertButton
        scope="evaluator"
        projectId="project-1"
        evaluatorId="evaluator-1"
        evaluatorType="LLM_AS_JUDGE"
        scoreDataType="NUMERIC"
        connectedAlerts={[
          {
            id: "alert-1",
            name: "Evaluator alert",
            severity: "UNKNOWN",
            metric: { measure: "count", aggregation: "count" },
            thresholdOperator: "GT",
            alertThreshold: 1,
            alertedAt: null,
          },
        ]}
        canRead
        canCreate
        hideCreateEntryWhenEmpty
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "1 connected evaluator alert",
    });
    expect(trigger).toHaveTextContent("Alerts");

    fireEvent.click(trigger);

    expect(screen.getByText("Evaluator alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Score" })).toBeInTheDocument();
  });
});
