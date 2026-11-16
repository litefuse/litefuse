export type BlobStorageExportOptions = {
  parquet?: boolean;
  signal?: AbortSignal;
};

export function blobStorageMetadata(column: string, parquet?: boolean) {
  const flattened = `json_object_flatten(${column})`;
  // JSON-to-STRING casts unwrap scalar strings and collapse JSON null into SQL NULL.
  return parquet
    ? `IF(${column} IS NULL, NULL, CAST(JSON_ARRAY(${flattened}) AS STRING)) AS metadata`
    : `${flattened} AS metadata`;
}

export function blobStorageJson(
  column: string,
  alias: string,
  parquet?: boolean,
) {
  return parquet ? `CAST(TO_JSON(${column}) AS STRING) AS ${alias}` : column;
}
