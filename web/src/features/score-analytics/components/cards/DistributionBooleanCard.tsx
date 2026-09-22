import { useState, useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/src/components/ui/tabs";
import { Loader2 } from "lucide-react";
import { useScoreAnalytics } from "../ScoreAnalyticsProvider";
import { ScoreDistributionBooleanChart } from "../charts/ScoreDistributionBooleanChart";
import { SamplingDetailsHoverCard } from "../SamplingDetailsHoverCard";

import { useTranslation } from "react-i18next";
type DistributionTab = "score1" | "score2" | "all" | "matched";

/**
 * DistributionBooleanCard - Distribution chart card for BOOLEAN scores
 *
 * Responsibilities:
 * - Manage tab state (score1/score2/all/matched)
 * - Select appropriate distribution data and categories based on tab
 * - Apply solid color mapping (similar to numeric, not per-category)
 * - Render ScoreDistributionBooleanChart directly
 *
 * Key Implementation Details:
 * - Boolean scores always have exactly 2 categories (True/False)
 * - Individual tabs use solid colors like numeric charts
 * - Comparison tabs use namespaced categories
 * - Color logic is simpler than categorical (only 2 shades needed)
 */
export function DistributionBooleanCard() {
  const { t } = useTranslation();
  const { data, isLoading, params, colorMappings, getColorForScore } =
    useScoreAnalytics();

  const [activeTab, setActiveTab] = useState<DistributionTab>("all");

  // Select distribution data and categories based on active tab
  const { distribution1Data, distribution2Data, categories, description } =
    useMemo(() => {
      if (!data) {
        return {
          distribution1Data: [],
          distribution2Data: undefined,
          categories: [],
          description: "",
        };
      }

      const { distribution, metadata, statistics } = data;
      const { mode } = metadata;
      const { score1, score2 } = params;

      if (mode === "single") {
        // Single score mode - only show individual distribution
        return {
          distribution1Data: distribution.score1,
          distribution2Data: undefined,
          categories: distribution.categories ?? [],
          description: `${t("{{total}} observations", {
            total: statistics.score1.total.toLocaleString(),
          })}${
            statistics.score1.mode
              ? ` | ${t("Most frequent: {{category}} ({{total}})", {
                  category: statistics.score1.mode.category,
                  total: statistics.score1.mode.count.toLocaleString(),
                })}`
              : ""
          }`,
        };
      }

      // Two score mode - handle tabs
      switch (activeTab) {
        case "score1":
          return {
            distribution1Data: distribution.score1Individual,
            distribution2Data: undefined,
            categories: distribution.categories ?? [],
            description: t("{{name}} - {{total}} observations", {
              name: score1.name,
              total: statistics.score1.total.toLocaleString(),
            }),
          };
        case "score2":
          return {
            distribution1Data: distribution.score2Individual,
            distribution2Data: undefined,
            categories: distribution.score2Categories ?? [],
            description: t("{{name}} - {{total}} observations", {
              name: score2?.name ?? t("Score 2"),
              total: (statistics.score2?.total ?? 0).toLocaleString(),
            }),
          };
        case "all":
          return {
            distribution1Data: distribution.score1Individual,
            distribution2Data: distribution.score2Individual,
            categories: distribution.categories ?? [],
            description: t("{{name1}} ({{total1}}) vs {{name2}} ({{total2}})", {
              name1: score1.name,
              total1: statistics.score1.total.toLocaleString(),
              name2: score2?.name,
              total2: statistics.score2?.total.toLocaleString(),
            }),
          };
        case "matched":
          return {
            distribution1Data: distribution.score1Matched,
            distribution2Data: distribution.score2Matched,
            categories: distribution.categories ?? [],
            description: t("{{name1}} vs {{name2}} - {{total}} matched", {
              name1: score1.name,
              name2: score2?.name,
              total: (
                statistics.comparison?.matchedCount ?? 0
              ).toLocaleString(),
            }),
          };
      }
    }, [data, activeTab, params]);

  // Build color mapping for boolean charts
  const chartColors = useMemo(() => {
    if (!data) return colorMappings;

    // For individual tabs, use solid colors like numeric charts
    if (activeTab === "score1") {
      return { score1: getColorForScore(1) };
    }

    if (activeTab === "score2") {
      // Visual slot 1, but score2's color
      return { score1: getColorForScore(2) };
    }

    // For "all" or "matched" tabs with boolean data, use solid colors
    return {
      score1: getColorForScore(1),
      score2: getColorForScore(2),
    };
  }, [activeTab, data, colorMappings, getColorForScore]);

  // Loading state
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("Distribution")}</CardTitle>
          <CardDescription>{t("Loading chart...")}</CardDescription>
        </CardHeader>
        <CardContent className="flex h-[340px] flex-col items-center justify-center pl-0">
          <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  // No data state
  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("Distribution")}</CardTitle>
          <CardDescription>{t("No data available")}</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground flex h-[340px] flex-col items-center justify-center pl-0 text-sm">
          {t("Select a score to view distribution")}
        </CardContent>
      </Card>
    );
  }

  const { metadata } = data;
  const { mode } = metadata;
  const { score1, score2 } = params;

  const hasData = distribution1Data.length > 0;
  const showTabs = mode === "two";

  // Helper function to truncate tab labels with max character limit
  const truncateLabel = (label: string): string => {
    if (label.length <= 20) return label;
    return label.substring(0, 17) + "...";
  };

  // Build full tab labels for title attribute (hover tooltip)
  const score1FullLabel =
    score1.name === score2?.name
      ? `${score1.source} · ${score1.name}`
      : score1.name;

  const score2FullLabel = score2
    ? score2.name === score1.name
      ? `${score2.source} · ${score2.name}`
      : score2.name
    : "Score 2";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <CardTitle className="flex items-center gap-2">
                {t("Distribution")}
                {data.samplingMetadata.isSampled && (
                  <SamplingDetailsHoverCard
                    samplingMetadata={data.samplingMetadata}
                    showLabel
                  />
                )}
              </CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>
          {showTabs && (
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as DistributionTab)}
            >
              <TabsList className="h-7">
                <TabsTrigger
                  value="score1"
                  title={score1FullLabel}
                  className="h-5 px-2 text-xs"
                >
                  {truncateLabel(score1FullLabel)}
                </TabsTrigger>
                <TabsTrigger
                  value="score2"
                  title={score2FullLabel}
                  className="h-5 px-2 text-xs"
                >
                  {truncateLabel(score2FullLabel)}
                </TabsTrigger>
                <TabsTrigger value="all" className="h-5 px-2 text-xs">
                  {t("all")}
                </TabsTrigger>
                <TabsTrigger value="matched" className="h-5 px-2 text-xs">
                  {t("matched")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex h-[340px] flex-col pl-0">
        {hasData ? (
          <ScoreDistributionBooleanChart
            distribution1={distribution1Data}
            distribution2={
              activeTab === "score1" || activeTab === "score2"
                ? undefined
                : distribution2Data
            }
            categories={categories}
            score1Name={
              activeTab === "score2" && score2
                ? `${score2.name} (${score2.source})`
                : `${score1.name} (${score1.source})`
            }
            score2Name={
              activeTab === "score1" || activeTab === "score2"
                ? undefined
                : mode === "two" && score2
                  ? `${score2.name} (${score2.source})`
                  : undefined
            }
            colors={chartColors}
          />
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {t("No distribution data available for the selected time range")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
