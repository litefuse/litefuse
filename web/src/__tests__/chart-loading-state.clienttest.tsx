import React from "react";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  RESOURCE_LIMIT_ERROR_MESSAGE,
  SLOW_QUERY_HINT_TEXT,
} from "@langfuse/shared";
import { ChartLoadingState } from "@/src/features/widgets/chart-library/ChartLoadingState";
import { I18nextProvider } from "react-i18next";
import { createI18nInstance } from "@/src/features/i18n/instance";

describe("ChartLoadingState", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("renders spinner immediately and delayed hint after configured delay", () => {
    const hintDelayMs = 1375;

    render(<ChartLoadingState isLoading={true} hintDelayMs={hintDelayMs} />);

    expect(
      screen.getByRole("status", { name: "Loading chart data" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(SLOW_QUERY_HINT_TEXT)).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(hintDelayMs - 1);
    });
    expect(screen.queryByText(SLOW_QUERY_HINT_TEXT)).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByText(SLOW_QUERY_HINT_TEXT)).toBeInTheDocument();
  });

  test("resets delayed hint when loading toggles off and on again", () => {
    const hintDelayMs = 825;

    const { rerender } = render(
      <ChartLoadingState isLoading={true} hintDelayMs={hintDelayMs} />,
    );

    act(() => {
      jest.advanceTimersByTime(hintDelayMs);
    });
    expect(screen.getByText(SLOW_QUERY_HINT_TEXT)).toBeInTheDocument();

    rerender(<ChartLoadingState isLoading={false} hintDelayMs={hintDelayMs} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(SLOW_QUERY_HINT_TEXT)).not.toBeInTheDocument();

    rerender(<ChartLoadingState isLoading={true} hintDelayMs={hintDelayMs} />);
    expect(screen.queryByText(SLOW_QUERY_HINT_TEXT)).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(hintDelayMs);
    });
    expect(screen.getByText(SLOW_QUERY_HINT_TEXT)).toBeInTheDocument();
  });

  test("shows hint immediately without spinner for overload state", () => {
    const { container } = render(
      <ChartLoadingState
        isLoading={true}
        showSpinner={false}
        showHintImmediately={true}
      />,
    );

    expect(screen.getByText(SLOW_QUERY_HINT_TEXT)).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeInTheDocument();
  });

  test("renders a provided hint text for error states", () => {
    const customHint = "Custom resource limit hint";

    render(
      <ChartLoadingState
        isLoading={true}
        showHintImmediately={true}
        showSpinner={false}
        hintText={customHint}
      />,
    );

    expect(screen.getByText(customHint)).toBeInTheDocument();
    expect(screen.queryByText(SLOW_QUERY_HINT_TEXT)).not.toBeInTheDocument();
  });

  test("localizes the default loading label and slow-query hint in Chinese", () => {
    render(
      <I18nextProvider i18n={createI18nInstance("zh-CN")}>
        <ChartLoadingState isLoading showHintImmediately />
      </I18nextProvider>,
    );

    expect(
      screen.getByRole("status", { name: "图表数据加载中" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("此查询耗时较长。请缩短时间范围或添加更多筛选条件。"),
    ).toBeInTheDocument();
  });

  test("localizes the standard query failure hint and preserves custom errors", () => {
    const i18n = createI18nInstance("zh-CN");
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <ChartLoadingState
          isLoading
          showHintImmediately
          hintText={RESOURCE_LIMIT_ERROR_MESSAGE}
        />
      </I18nextProvider>,
    );

    expect(
      screen.getByText(
        "无法完成查询。请添加更具体的筛选条件（例如缩短日期范围）以缩小查询范围。",
      ),
    ).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={i18n}>
        <ChartLoadingState
          isLoading
          showHintImmediately
          hintText="Raw server error"
        />
      </I18nextProvider>,
    );
    expect(screen.getByText("Raw server error")).toBeInTheDocument();
  });
});
