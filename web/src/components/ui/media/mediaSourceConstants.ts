// LITEFUSE NOTE: this constant is new; upstream declares it in
// `packages/shared/src/domain/media.ts` and imports it from `@langfuse/shared`.
//
// Our shared package does not export it, and adding it there would mean editing
// a file outside the evaluator module. Declaring it here keeps the change inside
// newly added files. The value is copied from upstream, so anything that
// compares against it behaves identically.
export const OBSERVATION_FIELD_SIZE_LIMIT_MEDIA_SOURCE = "field_size_limit";
