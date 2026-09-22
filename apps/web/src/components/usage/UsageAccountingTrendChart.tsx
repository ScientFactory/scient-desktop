import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  formatCount,
  formatDayShort,
  formatTokens,
  formatUsdPrecise,
} from "@t3tools/shared/usageFormat";

import type { AccountingChartMetric, AccountingTrend } from "./usageAccountingPresentation";
import {
  nearestCurveIndex,
  nearestPeriodIndex,
  niceScale,
  placeChartTooltip,
  shapePreservingCurvePath,
  shapePreservingCurveYAtX,
  shapePreservingCurveYRangeBetweenX,
} from "./usageChartGeometry";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 244;
const PLOT_TOP = 10;
const CURVE_CLEARANCE = 10;
const CURVE_RELEASE_CLEARANCE = 16;
const MAX_CURVE_LIFT = 32;
const COLORS = [
  "var(--color-blue-500)",
  "var(--color-violet-500)",
  "var(--color-emerald-500)",
  "var(--color-amber-500)",
  "var(--color-rose-500)",
  "var(--color-zinc-400)",
] as const;

function formatMetric(value: number, metric: AccountingChartMetric): string {
  switch (metric) {
    case "spend":
      return formatUsdPrecise(value);
    case "tokens":
      return formatTokens(value);
    case "requests":
      return formatCount(value);
  }
}

export function UsageAccountingTrendChart({
  trend,
  metric,
}: {
  readonly trend: AccountingTrend;
  readonly metric: AccountingChartMetric;
}) {
  const [activePeriod, setActivePeriod] = useState<number | null>(null);
  const [activeSeriesIndex, setActiveSeriesIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);
  const activeSeriesIndexRef = useRef<number | null>(null);
  const tooltipCurveAdjustedRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const { paths, points, ticks, toY } = useMemo(() => {
    const peak = trend.series.reduce((current, series) => Math.max(current, ...series.values), 0);
    const scale = niceScale(peak, 4);
    const toY = (value: number) =>
      scale.max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / scale.max) * (VIEW_HEIGHT - PLOT_TOP);
    const stepX = trend.periods.length <= 1 ? 0 : VIEW_WIDTH / (trend.periods.length - 1);
    const toX = (index: number) => (trend.periods.length === 1 ? VIEW_WIDTH / 2 : index * stepX);
    const points = trend.series.map((series) =>
      series.values.map((value, index) => ({ x: toX(index), y: toY(value) })),
    );
    return {
      paths: points.map(shapePreservingCurvePath),
      points,
      ticks: scale.ticks,
      toY,
    };
  }, [trend]);

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;
    if (plot.clientWidth === 0 || plot.clientHeight === 0) return;
    const dimensions = {
      anchorX: hoverPosition.x,
      anchorY: hoverPosition.y,
      tooltipWidth: tooltip.offsetWidth,
      tooltipHeight: tooltip.offsetHeight,
      plotWidth: plot.clientWidth,
    };
    const basePosition = placeChartTooltip(dimensions);
    const curveStartX = (basePosition.left / plot.clientWidth) * VIEW_WIDTH;
    const curveEndX = ((basePosition.left + tooltip.offsetWidth) / plot.clientWidth) * VIEW_WIDTH;
    const curveYRanges = points.flatMap((seriesPoints) => {
      const range = shapePreservingCurveYRangeBetweenX(seriesPoints, curveStartX, curveEndX);
      return range === null
        ? []
        : [
            {
              min: (range.min / VIEW_HEIGHT) * plot.clientHeight,
              max: (range.max / VIEW_HEIGHT) * plot.clientHeight,
            },
          ];
    });
    const position = placeChartTooltip({
      ...dimensions,
      curveYRanges,
      curveClearance: tooltipCurveAdjustedRef.current ? CURVE_RELEASE_CLEARANCE : CURVE_CLEARANCE,
      maxCurveLift: MAX_CURVE_LIFT,
    });
    tooltipCurveAdjustedRef.current = position.top < basePosition.top;
    plot.style.setProperty("--usage-accounting-tooltip-left", `${position.left}px`);
    plot.style.setProperty("--usage-accounting-tooltip-top", `${position.top}px`);
  }, [points]);

  const scheduleTooltipPosition = useCallback(() => {
    if (typeof requestAnimationFrame === "undefined") {
      positionTooltip();
      return;
    }
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      positionTooltip();
    });
  }, [positionTooltip]);

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(animationFrameRef.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (activePeriod === null) return;
    positionTooltip();
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(positionTooltip);
    observer.observe(plot);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [activePeriod, positionTooltip]);

  const selectPeriod = useCallback(
    (index: number) => {
      const plot = plotRef.current;
      if (plot === null || trend.periods.length === 0) return;
      const boundedIndex = Math.min(trend.periods.length - 1, Math.max(0, index));
      const x =
        trend.periods.length === 1
          ? plot.clientWidth / 2
          : (boundedIndex / (trend.periods.length - 1)) * plot.clientWidth;
      let highestSeriesIndex = 0;
      let highestPoint = VIEW_HEIGHT;
      points.forEach((seriesPoints, seriesIndex) => {
        const pointY = seriesPoints[boundedIndex]?.y ?? VIEW_HEIGHT;
        if (pointY < highestPoint) {
          highestPoint = pointY;
          highestSeriesIndex = seriesIndex;
        }
      });
      const y = (highestPoint / VIEW_HEIGHT) * plot.clientHeight;
      hoverPositionRef.current = { x, y };
      activeSeriesIndexRef.current = highestSeriesIndex;
      plot.style.setProperty("--usage-accounting-hover-x", `${x}px`);
      plot.style.setProperty("--usage-accounting-hover-y", `${y}px`);
      setActivePeriod(boundedIndex);
      setActiveSeriesIndex(highestSeriesIndex);
      scheduleTooltipPosition();
    },
    [points, scheduleTooltipPosition, trend.periods.length],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || trend.periods.length === 0) return;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) return;
      const x = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
      const pointerY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
      const curveX = (x / bounds.width) * VIEW_WIDTH;
      const curveYs = points.map(
        (seriesPoints) =>
          (shapePreservingCurveYAtX(seriesPoints, curveX) / VIEW_HEIGHT) * bounds.height,
      );
      const nearestSeries = nearestCurveIndex({
        curveYs,
        pointerY,
        previousIndex: activeSeriesIndexRef.current,
        switchMargin: 5,
      });
      if (nearestSeries === null) return;
      const y = curveYs[nearestSeries] ?? pointerY;
      hoverPositionRef.current = { x, y };
      activeSeriesIndexRef.current = nearestSeries;
      plot.style.setProperty("--usage-accounting-hover-x", `${x}px`);
      plot.style.setProperty("--usage-accounting-hover-y", `${y}px`);
      setActivePeriod(nearestPeriodIndex(x, bounds.width, trend.periods.length));
      setActiveSeriesIndex(nearestSeries);
      scheduleTooltipPosition();
    },
    [points, scheduleTooltipPosition, trend.periods.length],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const current = activePeriod ?? trend.periods.length - 1;
      const next =
        event.key === "ArrowLeft"
          ? current - 1
          : event.key === "ArrowRight"
            ? current + 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? trend.periods.length - 1
                : null;
      if (next === null) return;
      event.preventDefault();
      selectPeriod(next);
    },
    [activePeriod, selectPeriod, trend.periods.length],
  );

  if (trend.periods.length === 0 || trend.series.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
        No provider-billed activity in this period.
      </div>
    );
  }

  const firstPeriod = trend.periods[0]!;
  const lastPeriod = trend.periods.at(-1)!;
  const middlePeriod = trend.periods[Math.floor((trend.periods.length - 1) / 2)]!;
  const activeDescription =
    activePeriod === null
      ? "No billing day selected"
      : `${formatDayShort(trend.periods[activePeriod]!)}: ${trend.series
          .map(
            (series) => `${series.label} ${formatMetric(series.values[activePeriod] ?? 0, metric)}`,
          )
          .join(", ")}`;

  return (
    <div className="min-w-0">
      <div className="relative h-72 ps-12">
        <div className="pointer-events-none absolute inset-y-0 start-0 w-11 text-[10px] text-muted-foreground tabular-nums">
          {ticks.toReversed().map((tick) => (
            <span
              key={tick}
              className="absolute end-2 -translate-y-1/2"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {formatMetric(tick, metric)}
            </span>
          ))}
        </div>
        <div
          ref={plotRef}
          aria-label={`${metric} over time by billing day. Use the left and right arrow keys to inspect exact daily values.`}
          aria-orientation="horizontal"
          aria-valuemax={trend.periods.length - 1}
          aria-valuemin={0}
          aria-valuenow={activePeriod ?? trend.periods.length - 1}
          aria-valuetext={activeDescription}
          className="relative h-[calc(100%-1.5rem)] w-full touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="slider"
          tabIndex={0}
          onBlur={() => {
            hoverPositionRef.current = null;
            activeSeriesIndexRef.current = null;
            tooltipCurveAdjustedRef.current = false;
            setActivePeriod(null);
            setActiveSeriesIndex(null);
          }}
          onFocus={() => {
            if (activePeriod === null) selectPeriod(trend.periods.length - 1);
          }}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerMove}
          onPointerLeave={() => {
            hoverPositionRef.current = null;
            activeSeriesIndexRef.current = null;
            tooltipCurveAdjustedRef.current = false;
            setActivePeriod(null);
            setActiveSeriesIndex(null);
          }}
          onPointerMove={handlePointerMove}
        >
          <svg
            aria-hidden
            className="h-full w-full overflow-visible"
            preserveAspectRatio="none"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="var(--border)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {trend.series.map((series, index) => (
              <path
                key={series.id}
                d={paths[index]}
                fill="none"
                stroke={COLORS[series.colorIndex % COLORS.length]}
                strokeWidth={index === 0 ? 2.4 : 1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {activePeriod === null || activeSeriesIndex === null ? null : (
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-0 z-[1] border-s border-dashed border-muted-foreground"
              style={{
                left: "var(--usage-accounting-hover-x, 0px)",
                top: "var(--usage-accounting-hover-y, 0px)",
              }}
            >
              <span
                className="absolute -start-[4.5px] -top-[4.5px] size-[9px] rounded-full border-2 border-background shadow-sm"
                style={{
                  background:
                    COLORS[(trend.series[activeSeriesIndex]?.colorIndex ?? 0) % COLORS.length],
                }}
              />
            </div>
          )}
          {activePeriod === null ? null : (
            <div
              ref={tooltipRef}
              className="surface-glass pointer-events-none absolute z-10 min-w-40 max-w-full rounded-xl border border-border/50 p-2.5 text-xs shadow-lg transition-[top] duration-100 ease-out motion-reduce:transition-none"
              role="tooltip"
              style={{
                left: "var(--usage-accounting-tooltip-left, 0px)",
                top: "var(--usage-accounting-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1.5 font-medium">
                {formatDayShort(trend.periods[activePeriod]!)}
              </div>
              <div className="flex flex-col gap-1">
                {trend.series.map((series, seriesIndex) => (
                  <div key={series.id} className="flex items-center justify-between gap-4">
                    <span
                      className={`flex min-w-0 items-center gap-1.5 ${
                        seriesIndex === activeSeriesIndex
                          ? "text-foreground"
                          : "text-muted-foreground"
                      }`}
                    >
                      <span
                        className="size-2 shrink-0 rounded-sm"
                        style={{ background: COLORS[series.colorIndex % COLORS.length] }}
                      />
                      <span className="truncate">{series.label}</span>
                    </span>
                    <span
                      className={`tabular-nums ${
                        seriesIndex === activeSeriesIndex ? "font-semibold" : "font-medium"
                      }`}
                    >
                      {formatMetric(series.values[activePeriod] ?? 0, metric)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="absolute end-0 bottom-0 start-12 flex justify-between text-[10px] text-muted-foreground">
          <span>{formatDayShort(firstPeriod)}</span>
          {trend.periods.length > 2 ? <span>{formatDayShort(middlePeriod)}</span> : null}
          <span>{formatDayShort(lastPeriod)}</span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2" aria-label="Chart legend">
        {trend.series.map((series) => (
          <div
            key={series.id}
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              className="size-2 shrink-0 rounded-sm"
              style={{ background: COLORS[series.colorIndex % COLORS.length] }}
            />
            <span className="max-w-48 truncate">{series.label}</span>
            <span className="text-foreground tabular-nums">
              {formatMetric(series.total, metric)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
