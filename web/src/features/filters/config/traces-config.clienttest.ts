/**
 * LITEFUSE ADDITION.
 *
 * The traces sidebar has to survive the filter ids our own deep links emit: the
 * evaluators v2 "last 5 runs" marker navigates to `/project/<id>/traces?filter=…`
 * with a column set the traces table does not list verbatim. `traceName` is a
 * real traces filter (the shared Doris mapping aliases it onto `trace_name`), so
 * it is rewritten onto this surface's own `name` column; `isRootObservation`
 * cannot be applied by the traces query at all and is declared as such, so it is
 * dropped with a readable message instead of the generic "unknown filter column"
 * warning.
 *
 * The rules table no longer emits `ruleId` (it forwards the rule's own filter,
 * narrowed to what this surface can apply — see `ruleLinkUrls`), and that
 * narrowing is what the last case here pins down: nothing the rule link encodes
 * is ever dropped by the page.
 */
import {
  LangfuseInternalTraceEnvironment,
  type FilterState,
} from "@langfuse/shared";

import { evaluatorExecutionsUrl } from "@/src/features/evals/v2/fns/evaluators/evaluatorScoresUrl";
import {
  ruleFilterToTraceFilter,
  ruleTracesUrl,
} from "@/src/features/evals/v2/fns/rules/ruleLinkUrls";
import { traceFilterConfig } from "./traces-config";
import {
  decodeAndNormalizeFilters,
  type FilterColumnHandling,
} from "../hooks/useSidebarFilterState";

const handling: FilterColumnHandling = {
  columnAliases: traceFilterConfig.columnAliases,
  unappliedFilterColumns: traceFilterConfig.unappliedFilterColumns,
};

/** Extracts and decodes the `filter` query param of a deep link, like the page does. */
const filtersOf = (href: string): FilterState =>
  decodeAndNormalizeFilters(
    new URL(href, "http://localhost:3000").searchParams.get("filter") ?? "",
    traceFilterConfig.columnDefinitions,
    handling,
  );

describe("traceFilterConfig column handling for deep-link filters", () => {
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("keeps the evaluator executions link filter by aliasing traceName onto the traces name column", () => {
    const href = evaluatorExecutionsUrl("project-1", "Judge", "LLM_AS_JUDGE");

    expect(filtersOf(href)).toEqual([
      {
        column: "name",
        type: "stringOptions",
        operator: "any of",
        value: ["Execute evaluator: Judge"],
      },
      {
        column: "environment",
        type: "stringOptions",
        operator: "any of",
        value: [LangfuseInternalTraceEnvironment.LLMJudge],
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reports that isRootObservation cannot be applied instead of warning about it", () => {
    const href = evaluatorExecutionsUrl("project-1", "Judge", "LLM_AS_JUDGE");

    filtersOf(href);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Filter on "isRootObservation" is not applied on this view',
      ),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("carries a rule's own filter onto the traces surface", () => {
    const href = ruleTracesUrl({
      projectId: "project-1",
      filter: [
        {
          column: "environment",
          type: "stringOptions",
          operator: "any of",
          value: ["zm_demo"],
        },
      ],
    });

    expect(filtersOf(href)).toEqual([
      {
        column: "environment",
        type: "stringOptions",
        operator: "any of",
        value: ["zm_demo"],
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("drops rule conditions this surface cannot apply before they reach the page", () => {
    // `type` / `isRootObservation` describe a single observation; `/traces`
    // filters whole traces, so the link must not claim them.
    const ruleFilter: FilterState = [
      {
        column: "environment",
        type: "stringOptions",
        operator: "any of",
        value: ["zm_demo"],
      },
      {
        column: "type",
        type: "stringOptions",
        operator: "any of",
        value: ["GENERATION"],
      },
      {
        column: "isRootObservation",
        type: "boolean",
        operator: "=",
        value: true,
      },
    ];

    expect(ruleFilterToTraceFilter(ruleFilter)).toEqual([
      {
        column: "environment",
        type: "stringOptions",
        operator: "any of",
        value: ["zm_demo"],
      },
    ]);

    const href = ruleTracesUrl({ projectId: "project-1", filter: ruleFilter });

    expect(filtersOf(href)).toEqual([
      {
        column: "environment",
        type: "stringOptions",
        operator: "any of",
        value: ["zm_demo"],
      },
    ]);
    // Nothing was dropped by the page: the builder already removed what the
    // surface cannot apply, so there is no warning to hide.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("still warns about columns this surface has never heard of", () => {
    const filters = filtersOf(
      "/project/project-1/traces?filter=not_a_column%3Bstring%3B%3Bcontains%3Bx",
    );

    expect(filters).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unknown filter column skipped: not_a_column",
    );
  });
});
