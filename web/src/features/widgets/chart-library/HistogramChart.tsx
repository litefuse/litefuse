import React from "react";
import { type DataPoint } from "@/src/features/widgets/chart-library/chart-props";
import { BarChart, Bar, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/src/components/ui/chart";
import { compactSmallNumberFormatter } from "@/src/utils/numbers";

interface HistogramDataPoint {
  binLabel: string;
  count: number;
  lower?: number;
  upper?: number;
  height?: number;
}

const HistogramChart = ({
  data,
  subtleFill = false,
}: {
  data: DataPoint[];
  subtleFill?: boolean;
}) => {
  const transformHistogramData = (data: DataPoint[]): HistogramDataPoint[] => {
    if (!data.length) return [];

    const firstDataPoint = data[0];

    // Find the histogram value - it could be in any field (e.g., histogram_latency, histogram_inputCost, etc.)
    let histogramValue: unknown = undefined;

    // Check all properties of the first data point for histogram data
    for (const key of Object.keys(firstDataPoint)) {
      const value = (firstDataPoint as unknown as Record<string, unknown>)[key];
      if (typeof value === "string" && value.includes("num_buckets")) {
        histogramValue = value;
        break;
      }
    }

    // Handle Doris histogram format: JSON string "{\"num_buckets\": N, \"buckets\": [...]}"
    if (
      typeof histogramValue === "string" &&
      histogramValue.includes("num_buckets")
    ) {
      try {
        histogramValue = JSON.parse(histogramValue);
      } catch {
        return [];
      }
    }

    // Check if this is Doris histogram format: {"num_buckets": N, "buckets": [{lower, upper, count, ...}]}
    if (
      histogramValue &&
      typeof histogramValue === "object" &&
      !Array.isArray(histogramValue) &&
      "buckets" in histogramValue
    ) {
      const metricObj = histogramValue as unknown as {
        num_buckets?: number;
        buckets?: Array<{ lower?: string; upper?: string; count?: number }>;
      };
      const buckets = metricObj.buckets;
      if (!buckets?.length) return [];
      return buckets.map((bucket) => ({
        binLabel: `[${compactSmallNumberFormatter(Number(bucket.lower))}, ${compactSmallNumberFormatter(Number(bucket.upper))}]`,
        count: bucket.count ?? 0,
        lower: Number(bucket.lower),
        upper: Number(bucket.upper),
      }));
    }

    // Fallback: try original metric field for ClickHouse format
    if (firstDataPoint?.metric && Array.isArray(firstDataPoint.metric)) {
      // ClickHouse histogram format: [(lower, upper, height), ...]
      return (firstDataPoint.metric as [number, number, number][]).map(
        ([lower, upper, height]) => ({
          binLabel: `[${compactSmallNumberFormatter(lower)}, ${compactSmallNumberFormatter(upper)}]`,
          count: height,
          lower,
          upper,
          height,
        }),
      );
    }

    // Fallback: treat as regular data points with binLabel
    return data.map((item) => ({
      binLabel: item.dimension || `Bin ${data.indexOf(item) + 1}`,
      count: (item.metric as number) || 0,
    }));
  };

  const histogramData = transformHistogramData(data);

  // Chart configuration
  const config = {
    count: {
      label: "Count",
      color: "hsl(var(--chart-1))",
    },
  };

  if (!histogramData.length) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        No data available
      </div>
    );
  }

  return (
    <ChartContainer
      config={config}
      className="[&_.recharts-bar-rectangle:hover]:opacity-30 dark:[&_.recharts-bar-rectangle:hover]:opacity-100 dark:[&_.recharts-bar-rectangle:hover]:brightness-[3]"
    >
      <BarChart
        data={histogramData}
        margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
      >
        <XAxis
          dataKey="binLabel"
          stroke="hsl(var(--chart-grid))"
          fontSize={12}
          tickLine={false}
          axisLine={false}
          angle={-45}
          textAnchor="end"
          height={90}
        />
        <YAxis
          stroke="hsl(var(--chart-grid))"
          fontSize={12}
          tickLine={false}
          axisLine={false}
        />
        <Bar
          dataKey="count"
          fill="hsl(var(--chart-1))"
          radius={[2, 2, 0, 0]}
          fillOpacity={subtleFill ? 0.3 : 1}
        />
        <ChartTooltip
          cursor={false}
          contentStyle={{ backgroundColor: "hsl(var(--background))" }}
          content={({ active, payload, label }) => (
            <ChartTooltipContent
              active={active}
              payload={payload}
              label={label}
              valueFormatter={(v) => compactSmallNumberFormatter(Number(v))}
              nameFormatter={(name) => (name === "count" ? "Count" : name)}
              labelFormatter={(label) => `Bin: ${label}`}
            />
          )}
        />
      </BarChart>
    </ChartContainer>
  );
};

export default HistogramChart;
