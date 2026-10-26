import { prepareNameForSave } from "./prepareNameForSave";

describe("prepareNameForSave", () => {
  it("keeps an existing name without requesting an AI suggestion", async () => {
    const generateName = jest.fn();
    const setName = jest.fn();

    await expect(
      prepareNameForSave({
        currentName: "  Quality judge  ",
        generateName,
        setName,
      }),
    ).resolves.toBe("Quality judge");
    expect(generateName).not.toHaveBeenCalled();
    expect(setName).not.toHaveBeenCalled();
  });

  it("generates and stores a missing name before saving", async () => {
    const generateName = jest.fn().mockResolvedValue("  Generated name  ");
    const setName = jest.fn();

    await expect(
      prepareNameForSave({ currentName: "", generateName, setName }),
    ).resolves.toBe("Generated name");
    expect(setName).toHaveBeenCalledWith("Generated name");
  });

  it("cannot prepare a missing name when AI assistance is unavailable", async () => {
    await expect(
      prepareNameForSave({
        currentName: "",
        generateName: null,
        setName: jest.fn(),
      }),
    ).resolves.toBeNull();
  });
});
