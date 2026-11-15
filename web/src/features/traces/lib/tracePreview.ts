/** The compact byId contract scopes a trace ID to its UTC day. */
export const tracePreviewKey = ({ id, day }: { id: string; day: string }) =>
  JSON.stringify([id, day]);
