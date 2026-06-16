/**
 * @jest-environment jsdom
 */

import { copyTextToClipboard } from "./clipboard";

describe("copyTextToClipboard", () => {
  const originalClipboard = navigator.clipboard;
  const originalExecCommand = document.execCommand;

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    document.execCommand = originalExecCommand;
    document.body.innerHTML = "";
    jest.restoreAllMocks();
  });

  it("uses navigator.clipboard.writeText when it succeeds", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    const execCommand = jest.fn();

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    document.execCommand = execCommand;

    await copyTextToClipboard("pk-lf-test");

    expect(writeText).toHaveBeenCalledWith("pk-lf-test");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when navigator.clipboard.writeText rejects", async () => {
    const writeText = jest
      .fn()
      .mockRejectedValue(new Error("clipboard unavailable"));
    const execCommand = jest.fn().mockReturnValue(true);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    document.execCommand = execCommand;

    await copyTextToClipboard("sk-lf-test");

    expect(writeText).toHaveBeenCalledWith("sk-lf-test");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });
});
