import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import NewEvaluatorPage from "./NewEvaluatorPage";

// NOTE (Litefuse): jest.mock() specifiers must be relative here. The `@/` alias is
// only rewritten by the SWC transform inside import/export statements, so a bare
// `@/...` string argument reaches jest's resolver verbatim and fails with
// "Cannot find module" (jest.config.mjs has no `@/` moduleNameMapper entry).
const useHasProjectAccessMock = jest.fn();

jest.mock("next/router", () => ({
  useRouter: () => ({
    isReady: true,
    query: { projectId: "project-1", type: "LLM_AS_JUDGE" },
  }),
}));

jest.mock("../../../rbac", () => ({
  useHasProjectAccess: (params: unknown) => useHasProjectAccessMock(params),
}));

jest.mock("../hooks/useEvalTemplate", () => ({
  useEvalTemplate: () => ({
    isPending: false,
    isNotFound: false,
    draft: null,
  }),
}));

jest.mock("../../../../components/SupportOrUpgradePage", () => ({
  SupportOrUpgradePage: () => <div>access restricted</div>,
}));

jest.mock("./EvaluatorSetupPage", () => ({
  EvaluatorSetupPage: () => <div>evaluator setup</div>,
}));

describe("NewEvaluatorPage", () => {
  beforeEach(() => {
    useHasProjectAccessMock.mockReset();
  });

  it("asks for evaluator:CUD and keeps read-only roles out of the editor", () => {
    useHasProjectAccessMock.mockReturnValue(false);

    render(<NewEvaluatorPage />);

    expect(useHasProjectAccessMock).toHaveBeenCalledWith({
      projectId: "project-1",
      scope: "evaluator:CUD",
    });
    expect(screen.getByText("access restricted")).toBeInTheDocument();
    expect(screen.queryByText("evaluator setup")).not.toBeInTheDocument();
  });

  it("renders the editor for roles that may create evaluators", () => {
    useHasProjectAccessMock.mockReturnValue(true);

    render(<NewEvaluatorPage />);

    expect(screen.getByText("evaluator setup")).toBeInTheDocument();
  });
});
