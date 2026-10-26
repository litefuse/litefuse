// Evaluators (the migrated upstream UI). This is now the canonical route, as in
// upstream (`routes.tsx`: href `/project/[projectId]/evals`). The legacy
// evaluators pages moved to /evals/legacy/**; the old /evals/v2/* routes are
// redirect stubs.
export { default } from "@/src/features/evals/v2/pages/EvaluatorsPage";
