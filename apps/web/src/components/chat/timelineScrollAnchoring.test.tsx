import { describe, expect, it } from "vite-plus/test";
import {
  getRowBottom,
  readTimelinePosition,
  rememberTimelinePosition,
  timelineContentOverflowsViewport,
} from "./timelineScrollAnchoring";

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timelineContentOverflowsViewport", () => {
  const inset = { composerInset: 100, anchorOffset: 24 };

  it("reports overflow from the last row, not the inset spacer", () => {
    const fits = buildState({ positions: [0, 200], sizes: [200, 300], scrollLength: 700 });
    expect(timelineContentOverflowsViewport(fits, inset)).toBe(false);

    const overflows = buildState({ positions: [0, 200], sizes: [200, 400], scrollLength: 700 });
    expect(timelineContentOverflowsViewport(overflows, inset)).toBe(true);
  });

  it("treats an empty or unmeasured list as fitting", () => {
    expect(timelineContentOverflowsViewport(undefined, inset)).toBe(false);
    expect(
      timelineContentOverflowsViewport(
        buildState({ positions: [0, 200], sizes: [200, 400], scrollLength: 0 }),
        inset,
      ),
    ).toBe(false);
    expect(timelineContentOverflowsViewport(buildState({ positions: [], sizes: [] }), inset)).toBe(
      false,
    );
    expect(
      timelineContentOverflowsViewport(
        buildState({ positions: [0, 200], sizes: [200, Number.NaN] }),
        inset,
      ),
    ).toBe(false);
  });
});

describe("timeline scroll anchoring", () => {
  it("measures row bottoms from LegendList row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });
});

describe("remembered timeline positions", () => {
  it("keeps reading positions and end-follow independent across threads and environments", () => {
    const reading = { rowId: "message-4", offsetWithinRow: 32, scrollOffset: 932, atEnd: false };
    const following = { rowId: "message-9", offsetWithinRow: 10, scrollOffset: 2010, atEnd: true };
    rememberTimelinePosition("scroll-test-a:thread-1", reading);
    rememberTimelinePosition("scroll-test-a:thread-2", following);
    rememberTimelinePosition("scroll-test-b:thread-1", following);
    expect(readTimelinePosition("scroll-test-a:thread-1")).toEqual(reading);
    expect(readTimelinePosition("scroll-test-a:thread-2")).toEqual(following);
    expect(readTimelinePosition("scroll-test-b:thread-1")).toEqual(following);
    expect(readTimelinePosition("scroll-test-a:unvisited")).toBeUndefined();
    rememberTimelinePosition("scroll-test-a:thread-1", following);
    expect(readTimelinePosition("scroll-test-a:thread-1")).toEqual(following);
  });
});
