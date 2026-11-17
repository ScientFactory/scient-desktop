import { describe, expect, it } from "vite-plus/test";

import type { TimelineNavigation } from "./timelineViewport";
import { readingNavigationReleasesFollow } from "./useReadingFollow";

const viewport = (contentScrollsUp: boolean, awayFromEnd: boolean) => ({
  contentScrollsUp: () => contentScrollsUp,
  awayFromEnd: () => awayFromEnd,
});

describe("readingNavigationReleasesFollow", () => {
  it("lets go of a followed response only for movement toward older content", () => {
    const releases = (navigation: TimelineNavigation, contentScrollsUp = true) =>
      readingNavigationReleasesFollow(navigation, viewport(contentScrollsUp, true), true);
    expect(releases({ source: "wheel", direction: "up" })).toBe(true);
    expect(releases({ source: "wheel", direction: "up" }, false)).toBe(false);
    expect(releases({ source: "key", key: "PageUp", direction: "up" })).toBe(true);
    // Moving toward the end, a touch or a press only pauses the follow, away from the end too.
    expect(releases({ source: "wheel", direction: "down" })).toBe(false);
    expect(releases({ source: "key", key: "PageDown", direction: "down" })).toBe(false);
    expect(releases({ source: "touch" })).toBe(false);
    expect(releases({ source: "pointer", onScrollbar: true })).toBe(false);
    expect(releases({ source: "pointer", onScrollbar: false })).toBe(false);
    expect(releases({ source: "scroll" })).toBe(true);
    expect(releases({ source: "command", releasesFollow: true })).toBe(true);
    expect(releases({ source: "command", releasesFollow: false })).toBe(false);
  });

  it("keeps the timeline's own rule while no response is followed", () => {
    const awayFromEnd = viewport(true, true);
    const down = { source: "key", key: "PageDown", direction: "down" } as const;
    expect(readingNavigationReleasesFollow(down, awayFromEnd, false)).toBe(true);
    expect(readingNavigationReleasesFollow({ source: "touch" }, awayFromEnd, false)).toBe(true);
    expect(
      readingNavigationReleasesFollow({ source: "pointer", onScrollbar: true }, awayFromEnd, false),
    ).toBe(true);
  });
});
