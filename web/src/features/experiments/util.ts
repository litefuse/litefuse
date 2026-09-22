import { type TFunction } from "i18next";

// Helper function to generate default experiment name
export function generateDefaultExperimentName(
  promptName: string,
  promptVersion: number,
  datasetName: string,
  t: TFunction,
): string {
  return t("Prompt {{prompt}}-v{{version}} on dataset {{dataset}}", {
    prompt: promptName,
    version: promptVersion,
    dataset: datasetName,
  });
}

// Helper function to generate default experiment description
export function generateDefaultExperimentDescription(
  promptName: string,
  promptVersion: number,
  datasetName: string,
  t: TFunction,
): string {
  return t(
    "Experiment run of prompt {{prompt}}-v{{version}} on dataset {{dataset}}",
    { prompt: promptName, version: promptVersion, dataset: datasetName },
  );
}

// Helper function to generate dataset run name with timestamp
export function generateDatasetRunName(experimentName: string): string {
  return `${experimentName} - ${new Date().toISOString()}`;
}
