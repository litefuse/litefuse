import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScoreDataTypeEnum } from "@langfuse/shared";
import { TooltipProvider } from "@/src/components/ui/tooltip";
import { createEvaluatorSetupStore } from "@/src/features/evals/v2/store/evaluatorSetupStore/evaluatorSetupStore";
import { EvaluatorSetupFooter } from "./EvaluatorSetupFooter";

describe("EvaluatorSetupFooter", () => {
  it("does not allow saving a code evaluator with client validation errors", () => {
    const store = createEvaluatorSetupStore({
      initialEvaluator: null,
      initialType: "CODE",
      mode: "create",
    });
    store.getState().actions.setName("Invalid code evaluator");

    render(
      <TooltipProvider>
        <EvaluatorSetupFooter
          store={store}
          initialSnapshot=""
          isEditing={false}
          isSaving={false}
          canWrite
          nameAIAssistanceAvailable={false}
          codeValidation={{ isValid: false, isPending: false }}
          onClose={jest.fn()}
          onSave={jest.fn()}
        />
      </TooltipProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Create evaluator" }),
    ).toBeDisabled();
  });

  it("explains that empty prompt messages block evaluator creation", async () => {
    const store = createEvaluatorSetupStore({
      initialEvaluator: null,
      initialType: "LLM_AS_JUDGE",
      mode: "create",
    });
    store.getState().actions.setName("LLM evaluator");
    store.getState().actions.setPromptMessage(0, { role: "user", content: "" });

    render(
      <TooltipProvider delayDuration={0}>
        <EvaluatorSetupFooter
          store={store}
          initialSnapshot=""
          isEditing={false}
          isSaving={false}
          canWrite
          nameAIAssistanceAvailable={false}
          codeValidation={null}
          onClose={jest.fn()}
          onSave={jest.fn()}
        />
      </TooltipProvider>,
    );

    const createButton = screen.getByRole("button", {
      name: "Create evaluator",
    });
    expect(createButton).toBeDisabled();

    fireEvent.focus(createButton.parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Add content to every prompt message before saving.",
    );
  });

  it("explains that empty category names block evaluator creation", async () => {
    const store = createEvaluatorSetupStore({
      initialEvaluator: null,
      initialType: "LLM_AS_JUDGE",
      mode: "create",
    });
    store.getState().actions.setName("Categorical evaluator");
    store.getState().actions.setScoreOutput({
      dataType: ScoreDataTypeEnum.CATEGORICAL,
      scoreDescription: "Classify the response",
      reasoningDescription: "Explain the classification",
      choices: [{ label: "" }, { label: "" }],
      shouldAllowMultipleMatches: false,
      minValue: "",
      maxValue: "",
    });

    render(
      <TooltipProvider delayDuration={0}>
        <EvaluatorSetupFooter
          store={store}
          initialSnapshot=""
          isEditing={false}
          isSaving={false}
          canWrite
          nameAIAssistanceAvailable={false}
          codeValidation={null}
          onClose={jest.fn()}
          onSave={jest.fn()}
        />
      </TooltipProvider>,
    );

    const createButton = screen.getByRole("button", {
      name: "Create evaluator",
    });
    expect(createButton).toBeDisabled();

    fireEvent.focus(createButton.parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Category names cannot be empty.",
    );
  });

  it("keeps a read-only viewer from saving, and says why", async () => {
    const store = createEvaluatorSetupStore({
      initialEvaluator: null,
      initialType: "LLM_AS_JUDGE",
      mode: "create",
    });
    store.getState().actions.setName("Read-only viewer's try");

    render(
      <TooltipProvider delayDuration={0}>
        <EvaluatorSetupFooter
          store={store}
          initialSnapshot=""
          isEditing={false}
          isSaving={false}
          canWrite={false}
          nameAIAssistanceAvailable={false}
          codeValidation={null}
          onClose={jest.fn()}
          onSave={jest.fn()}
        />
      </TooltipProvider>,
    );

    const createButton = screen.getByRole("button", {
      name: "Create evaluator",
    });
    expect(createButton).toBeDisabled();

    fireEvent.focus(createButton.parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "You do not have permission to create or change evaluators in this project.",
    );
  });
});

