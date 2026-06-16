import { BatchExportFileFormat, exportOptions } from "@langfuse/shared";

const sanitizeFileName = (fileName: string) => {
  const sanitized = fileName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return sanitized.length > 0 ? sanitized : "batch-export";
};

export const buildBatchExportFileName = (
  fileBaseName: string,
  format: BatchExportFileFormat,
) => {
  const extension = exportOptions[format].extension;
  const sanitized = sanitizeFileName(fileBaseName);

  return sanitized.toLowerCase().endsWith(`.${extension}`)
    ? sanitized
    : `${sanitized}.${extension}`;
};
