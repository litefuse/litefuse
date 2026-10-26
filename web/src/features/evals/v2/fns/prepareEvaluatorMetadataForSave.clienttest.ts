import { prepareEvaluatorMetadataForSave } from "./prepareEvaluatorMetadataForSave";

describe("prepareEvaluatorMetadataForSave", () => {
  it("generates both missing fields concurrently", async () => {
    const generateName = jest.fn().mockResolvedValue("  Quality judge  ");
    const generateDescription = jest
      .fn()
      .mockResolvedValue("  Scores response quality.  ");
    const setName = jest.fn();
    const setDescription = jest.fn();

    await expect(
      prepareEvaluatorMetadataForSave({
        currentName: "",
        currentDescription: "",
        generateName,
        generateDescription,
        setName,
        setDescription,
      }),
    ).resolves.toEqual({
      name: "Quality judge",
      description: "Scores response quality.",
    });
    expect(generateName).toHaveBeenCalledTimes(1);
    expect(generateDescription).toHaveBeenCalledTimes(1);
    expect(setName).toHaveBeenCalledWith("Quality judge");
    expect(setDescription).toHaveBeenCalledWith("Scores response quality.");
  });

  it("continues with a generated name when no description is returned", async () => {
    const generateName = jest.fn().mockResolvedValue("Quality judge");
    const generateDescription = jest.fn().mockResolvedValue(null);
    const setName = jest.fn();
    const setDescription = jest.fn();

    await expect(
      prepareEvaluatorMetadataForSave({
        currentName: "",
        currentDescription: "",
        generateName,
        generateDescription,
        setName,
        setDescription,
      }),
    ).resolves.toEqual({
      name: "Quality judge",
      description: null,
    });
    expect(generateName).toHaveBeenCalledTimes(1);
    expect(generateDescription).toHaveBeenCalledTimes(1);
    expect(setName).toHaveBeenCalledWith("Quality judge");
    expect(setDescription).not.toHaveBeenCalled();
  });

  it("requires a name when generation returns nothing", async () => {
    const generateName = jest.fn().mockResolvedValue(null);
    const setName = jest.fn();
    const setDescription = jest.fn();

    await expect(
      prepareEvaluatorMetadataForSave({
        currentName: "",
        currentDescription: "",
        generateName,
        generateDescription: null,
        setName,
        setDescription,
      }),
    ).resolves.toBeNull();
    expect(generateName).toHaveBeenCalledTimes(1);
    expect(setName).not.toHaveBeenCalled();
    expect(setDescription).not.toHaveBeenCalled();
  });

  it("fills only missing metadata without overwriting existing text", async () => {
    const generateName = jest.fn().mockResolvedValue("Generated name");
    const generateDescription = jest
      .fn()
      .mockResolvedValue("Generated description.");
    const setName = jest.fn();
    const setDescription = jest.fn();

    await expect(
      prepareEvaluatorMetadataForSave({
        currentName: "Existing name",
        currentDescription: "",
        generateName,
        generateDescription,
        setName,
        setDescription,
      }),
    ).resolves.toEqual({
      name: "Existing name",
      description: "Generated description.",
    });
    expect(generateName).not.toHaveBeenCalled();
    expect(generateDescription).toHaveBeenCalledTimes(1);
    expect(setName).not.toHaveBeenCalled();
    expect(setDescription).toHaveBeenCalledWith("Generated description.");
  });
});
