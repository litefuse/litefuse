// @ts-nocheck
export function encodeSpecialTokens(query: string): string {
  return query
    .replace(/\\\\/g, "HDX_BACKSLASH_LITERAL")
    .replace("http://", "http_COLON_//")
    .replace("https://", "https_COLON_//")
    .replace(/localhost:(\d{1,5})/, "localhost_COLON_$1")
    .replace(/\\:/g, "HDX_COLON");
}

export function decodeSpecialTokens(query: string): string {
  return query
    .replace(/\\"/g, '"')
    .replace(/HDX_BACKSLASH_LITERAL/g, "\\")
    .replace("http_COLON_//", "http://")
    .replace("https_COLON_//", "https://")
    .replace(/localhost_COLON_(\d{1,5})/, "localhost:$1")
    .replace(/HDX_COLON/g, ":");
}
