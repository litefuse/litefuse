/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodeView } from "./CodeJsonViewer";

jest.mock("../../utils/clipboard", () => ({
  copyTextToClipboard: jest.fn(),
}));

jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

jest.mock("../../features/posthog-analytics/usePostHogClientCapture", () => ({
  usePostHogClientCapture: () => jest.fn(),
}));

jest.mock("../../features/theming/useMarkdownContext", () => ({
  useMarkdownContext: () => ({ setIsMarkdownEnabled: jest.fn() }),
}));

jest.mock("./LangfuseMediaView", () => ({
  LangfuseMediaView: () => null,
}));

jest.mock("./MarkdownJsonView", () => ({
  MarkdownJsonViewHeader: () => null,
}));

jest.mock("./PromptReferences", () => ({
  renderRichPromptContent: (content: string) => content,
  usePromptReferenceProjectId: () => null,
}));

describe("CodeView", () => {
  it("does not throw after async copy resolves and keeps focus on the copy button", async () => {
    const { copyTextToClipboard } = jest.requireMock(
      "../../utils/clipboard",
    ) as {
      copyTextToClipboard: jest.Mock;
    };
    copyTextToClipboard.mockResolvedValue(undefined);

    render(<CodeView content="sk-lf-test" />);

    const button = screen.getByRole("button");
    const focusSpy = jest.spyOn(button, "focus");

    fireEvent.click(button);

    await waitFor(() => {
      expect(copyTextToClipboard).toHaveBeenCalledWith("sk-lf-test");
    });
    expect(focusSpy).toHaveBeenCalled();
  });
});
