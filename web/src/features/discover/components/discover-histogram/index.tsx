// @ts-nocheck
import ReactECharts from "echarts-for-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useEffect, useRef, useState } from "react";
import dayjs from "dayjs";
import { Select } from "components/ui/select";
import { useTheme } from "next-themes";
import { IntervalEnum } from "types/type";
import { TIME_INTERVALS } from "utils/data";
import {
  getAutoInterval,
  FORMAT_DATE,
  translationDateIntervalType,
} from "../../constants";
import {
  currentDateAtom,
  discoverCurrentAtom,
  activeShortcutAtom,
  tableDataChartsAtom,
  intervalAtom,
  tableTotalCountAtom,
  pageSizeAtom,
  pageAtom,
  timeRangeAtom,
} from "store/discover";

export function DiscoverHistogram() {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const [currentDate, setCurrentDate] = useAtom(currentDateAtom);
  const ReactEChartsInstance = useRef<ReactECharts>(null);
  const [discoverCurrent, setDiscoverCurrent] = useAtom(discoverCurrentAtom);
  const setActiveItem = useSetAtom(activeShortcutAtom);

  const tableDataCharts = useAtomValue(tableDataChartsAtom);
  if (process.env.NODE_ENV !== "production") {
    tableDataChartsAtom.debugLabel = "tableDataCharts";
  }
  const [interval_value, setInterval_value] = useState(1);
  const [interval, setInterval] = useAtom(intervalAtom);
  if (process.env.NODE_ENV !== "production") {
    intervalAtom.debugLabel = "interval";
  }
  const tableTotalCount = useAtomValue(tableTotalCountAtom);
  const [_timeRange, setTimeRange] = useAtom(timeRangeAtom);
  const [_pageSize, setPageSize] = useAtom(pageSizeAtom);
  const setPage = useSetAtom(pageAtom);

  useEffect(() => {
    const v = getAutoInterval(currentDate as any).interval_value;
    setInterval_value(v);
  }, [currentDate]);

  const timeInterval =
    interval === IntervalEnum.Auto
      ? translationDateIntervalType(interval)
      : `${interval_value} ${translationDateIntervalType(interval)}`;

  let base = +new Date(1988, 9, 3);
  let oneDay = 24 * 3600 * 1000;
  let data = [[base, Math.random() * 300]];
  for (let i = 1; i < 20000; i++) {
    let now = new Date((base += oneDay));
    data.push([+now, Math.round((Math.random() - 0.5) * 20 + data[i - 1][1])]);
  }

  const options: any = {
    title: {
      subtext: `${`Time Interval`}: ${timeInterval}`,
      left: "right",
      top: 12,
    },
    grid: {
      left: "32px",
      right: "32px",
      bottom: "0px",
      containLabel: true,
    },
    color: theme === "light" ? ["#608DFF"] : ["#608DFF"],
    xAxis: {
      type: "category",
      data: tableDataCharts.map((e) => e["TT"]),
      axisLabel: {
        fontSize: "12px",
        fontStyle: "normal",
        fontWeight: 400,
        color: theme === "light" ? "#9F9FA2" : "#5F5F64",
      },
      axisLine: {
        lineStyle: {
          width: 0.5,
          color: theme === "light" ? "#BFBFC1" : "#3F3F45",
        },
      },
      axisTick: {
        show: false,
      },
    },
    toolbox: {
      show: false,
    },
    brush: {
      xAxisIndex: 0,
    },
    yAxis: {
      name: `Count`,
      nameTextStyle: {
        align: "right",
        padding: [5, 0],
      },
      type: "value",
      splitLine: {
        show: true,
        lineStyle: {
          width: 0.5,
          color: theme === "light" ? "#BFBFC1" : "#3F3F45",
        },
      },
      axisLabel: {
        fontSize: "12px",
        fontStyle: "normal",
        fontWeight: 400,
      },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "line",
      },
      padding: 0,
      borderWidth: 0,
      backgroundColor: theme === "light" ? "#ffffff" : "rgba(63, 63, 69, 0.64)",
      formatter: function (params: any) {
        const html = `<div className="text-n2"
                                       style="
                                          padding: 8px;
                                          min-width: 120px;
                                          border-radius: 6px;
                                          backdrop-filter: blur(12px);
                                          color: ${theme === "light" ? "#1F1F26" : "#EFEFF0"};
                                        ">
                                      <div style="padding-bottom: 4px; border-bottom: 1px solid ${theme === "light" ? "#DFDFE0" : "#3F3F45"};">${[params[0].name]}</div>
                                      <div style="padding-top:4px;display: flex;justify-content: space-between;"><span>Count: </span><span style="font-family:DIN Alternate;font-size:14;font-weight:500;">${[
                                        params[0].value || 0,
                                      ]}</span></div>
                                  </div>`;
        return html;
      },
    },

    series: [
      {
        data: tableDataCharts.map((e) => e["sum(cnt)"]),
        type: "bar",
        barWidth: "99.3%",
      },
    ],

    animation: false,
  };

  useEffect(() => {
    const chart = ReactEChartsInstance.current;
    if (chart && tableDataCharts.length > 0) {
      const handler = ({ areas }: any) => {
        if (!areas.length) {
          return;
        }
        setPage(1);
        setPageSize(50);
        setActiveItem(undefined);
        const [startIndex, endIndex] = (areas[0] as any).coordRange as [
          startIndex: number,
          endIndex: number,
        ];
        const timeInterval =
          interval === IntervalEnum.Auto
            ? getAutoInterval(currentDate as any).interval_unit
            : interval;
        const chartsEndDate = dayjs(
          new Date(tableDataCharts[endIndex]["TT"]),
        ).add(interval_value, timeInterval);
        setDiscoverCurrent({
          ...discoverCurrent,
          date: [dayjs(tableDataCharts[startIndex]["TT"]), chartsEndDate],
        });

        setCurrentDate([
          dayjs(tableDataCharts[startIndex]["TT"]),
          chartsEndDate,
        ]);
        const timeRange = {
          from: dayjs(tableDataCharts[startIndex]["TT"]).format(FORMAT_DATE),
          to: chartsEndDate.format(FORMAT_DATE),
          raw: {
            from: dayjs(tableDataCharts[startIndex]["TT"]).format(FORMAT_DATE),
            to: chartsEndDate.format(FORMAT_DATE),
          },
        };
        setTimeRange(timeRange);
        chart.getEchartsInstance().dispatchAction({
          type: "brush",
          command: "clear",
          areas: [],
        });
      };

      if (chart.ele) {
        chart.getEchartsInstance().dispatchAction({
          type: "takeGlobalCursor",
          key: "brush",
          brushOption: {
            brushType: "lineX",
          },
        });
        chart.getEchartsInstance().on("brushEnd", handler);

        return () => {
          if (chart.ele) {
            chart.getEchartsInstance().off("brushEnd", handler);
          }
        };
      }
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableDataCharts]);
  return (
    <div className="px-4">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-2xl font-semibold">
            {tableTotalCount
              ? tableTotalCount
                  .toString()
                  .replace(/(\d)(?=(?:\d{3})+$)/g, "$1,")
              : "0"}
          </span>{" "}
          <span className="text-xs">{`hits`}</span>
        </div>
        <div className="text-muted-foreground text-sm">
          {currentDate &&
            `${currentDate[0]?.format(FORMAT_DATE)} ~ ${currentDate[1]?.format(FORMAT_DATE)} `}
        </div>
        <div className="w-40">
          <Select
            value={interval}
            onChange={(selectdbInterval) => {
              setInterval(selectdbInterval.value as any);
            }}
            options={TIME_INTERVALS}
          />
        </div>
      </div>
      <div className="h-[300px]">
        <ReactECharts
          option={options}
          ref={ReactEChartsInstance}
        ></ReactECharts>
      </div>
    </div>
  );
}
