import { FILL_PREVIEW_VIEWPORT } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  keyboardNudgePreviewMiniPlayerPosition,
  keyboardResizePreviewMiniPlayerFromHandle,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
  PREVIEW_MINI_PLAYER_DEFAULT_TOP,
  PREVIEW_MINI_PLAYER_EDGE_GAP,
  resolvePreviewMiniPlayerDefaultPosition,
  resizePreviewMiniPlayerRect,
  resizePreviewMiniPlayer,
  resolvePreviewMiniPlayerFrame,
  resolvePreviewMiniPlayerSourceSize,
} from "./previewMiniPlayerLayout";

const container = { width: 1_000, height: 700 };
const source = { width: 1_600, height: 1_000 };

describe("resolvePreviewMiniPlayerSourceSize", () => {
  it("uses the device viewport scaled by zoom", () => {
    expect(
      resolvePreviewMiniPlayerSourceSize({ _tag: "freeform", width: 390, height: 844 }, null, 2),
    ).toEqual({ width: 780, height: 1_688 });
  });

  it("uses the size the fill viewport had when it was floated", () => {
    expect(
      resolvePreviewMiniPlayerSourceSize(
        FILL_PREVIEW_VIEWPORT,
        { x: 0, y: 0, width: 640, height: 400, scale: 0.5, scrollLeft: 0, scrollTop: 0 },
        1,
      ),
    ).toEqual({ width: 1_280, height: 800 });
  });
});

describe("resolvePreviewMiniPlayerFrame", () => {
  it("opens at the source aspect ratio in the top-right corner", () => {
    expect(
      resolvePreviewMiniPlayerFrame({ width: null, position: null, source, container }),
    ).toEqual({ x: 668, y: PREVIEW_MINI_PLAYER_EDGE_GAP, width: 320, height: 200 });
  });

  it("keeps a tall source at the minimum width instead of the default box", () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: null,
        position: null,
        source: { width: 390, height: 844 },
        container,
      }),
    ).toEqual({ x: 748, y: PREVIEW_MINI_PLAYER_EDGE_GAP, width: 240, height: 519 });
  });

  it("derives height from the stored width", () => {
    expect(
      resolvePreviewMiniPlayerFrame({ width: 480, position: { x: 100, y: 80 }, source, container }),
    ).toEqual({ x: 100, y: 80, width: 480, height: 300 });
  });

  it("shrinks to the space above the composer without losing the stored width", () => {
    const frame = resolvePreviewMiniPlayerFrame({
      width: 800,
      position: { x: 100, y: 80 },
      source,
      container,
      bottomInset: 300,
    });
    expect(frame).toEqual({ x: 100, y: PREVIEW_MINI_PLAYER_EDGE_GAP, width: 602, height: 376 });
  });

  it("never grows past the source's own rendered size", () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: 900,
        position: { x: 12, y: 12 },
        source: { width: 480, height: 320 },
        container,
      }),
    ).toMatchObject({ width: 480, height: 320 });
  });
});

describe("resizePreviewMiniPlayer", () => {
  const start = { x: 300, y: 200, width: 320, height: 200 };

  it("keeps the aspect ratio when dragging the right edge", () => {
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "east",
        delta: { x: 160, y: 0 },
        source,
        container,
      }),
    ).toEqual({ x: 300, y: 200, width: 480, height: 300 });
  });

  it("anchors the right edge when dragging from the left", () => {
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "west",
        delta: { x: -160, y: 0 },
        source,
        container,
      }),
    ).toEqual({ x: 140, y: 200, width: 480, height: 300 });
  });

  it("anchors the bottom edge when dragging the top up", () => {
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "north",
        delta: { x: 0, y: -100 },
        source,
        container,
      }),
    ).toEqual({ x: 300, y: 100, width: 480, height: 300 });
  });

  it("follows the dominant axis on a corner drag", () => {
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "southeast",
        delta: { x: 20, y: 100 },
        source,
        container,
      }),
    ).toEqual({ x: 300, y: 200, width: 480, height: 300 });
  });

  it("stops at the container edge in the drag direction", () => {
    expect(
      resizePreviewMiniPlayer({
        start: { x: 600, y: 12, width: 320, height: 200 },
        direction: "east",
        delta: { x: 500, y: 0 },
        source,
        container,
      }),
    ).toEqual({ x: 600, y: 12, width: 388, height: 243 });
  });

  it("shifts the player when the free axis would overflow", () => {
    expect(
      resizePreviewMiniPlayer({
        start: { x: 12, y: 400, width: 320, height: 200 },
        direction: "east",
        delta: { x: 300, y: 0 },
        source,
        container,
        bottomInset: 0,
      }),
    ).toEqual({ x: 12, y: 300, width: 620, height: 388 });
  });

  it("respects the minimum size", () => {
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "southeast",
        delta: { x: -300, y: -300 },
        source,
        container,
      }),
    ).toEqual({ x: 300, y: 200, width: 240, height: 150 });
  });
});

describe("clampPreviewMiniPlayerPosition", () => {
  it("opens at a useful default size", () => {
    expect(PREVIEW_MINI_PLAYER_DEFAULT_SIZE).toEqual({ width: 400, height: 260 });
  });

  it("opens centered across the upper portion of the app window", () => {
    expect(
      resolvePreviewMiniPlayerDefaultPosition(
        { width: 1_200, height: 800 },
        PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
      ),
    ).toEqual({ x: 400, y: PREVIEW_MINI_PLAYER_DEFAULT_TOP });
  });

  it("keeps a dragged player within the app viewport", () => {
    expect(
      clampPreviewMiniPlayerPosition({ x: 900, y: -40 }, container, { width: 360, height: 240 }),
    ).toEqual({ x: 628, y: PREVIEW_MINI_PLAYER_EDGE_GAP });
  });

  it("can keep the player above a reserved bottom inset", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 500, y: 448 },
        container,
        { width: 360, height: 240 },
        160,
      ),
    ).toEqual({
      x: 500,
      y: 288,
    });
  });
});

describe("clampPreviewMiniPlayerSize", () => {
  it("allows resizing within the available viewport", () => {
    expect(
      clampPreviewMiniPlayerSize({ width: 520, height: 360 }, { width: 1_000, height: 700 }, 120),
    ).toEqual({ width: 520, height: 360 });
  });

  it("bounds oversized players above a reserved bottom inset", () => {
    expect(
      clampPreviewMiniPlayerSize(
        { width: 2_000, height: 2_000 },
        { width: 1_000, height: 700 },
        120,
      ),
    ).toEqual({ width: 976, height: 556 });
  });

  it("lets a tiny container win over the preferred minimum", () => {
    expect(
      clampPreviewMiniPlayerSize({ width: 360, height: 239 }, { width: 250, height: 180 }, 20),
    ).toEqual({ width: 226, height: 136 });
  });
});

describe("keyboardNudgePreviewMiniPlayerPosition", () => {
  const container = { width: 1_000, height: 700 };
  const player = { width: 360, height: 240 };

  it("moves by the requested step", () => {
    expect(
      keyboardNudgePreviewMiniPlayerPosition({ x: 500, y: 300 }, "left", 8, container, player),
    ).toEqual({ x: 492, y: 300 });
    expect(
      keyboardNudgePreviewMiniPlayerPosition({ x: 500, y: 300 }, "down", 80, container, player),
    ).toEqual({ x: 500, y: 380 });
  });

  it("uses the same viewport bounds as pointer movement", () => {
    expect(
      keyboardNudgePreviewMiniPlayerPosition(
        { x: 20, y: PREVIEW_MINI_PLAYER_EDGE_GAP },
        "left",
        80,
        container,
        player,
      ),
    ).toEqual({ x: PREVIEW_MINI_PLAYER_EDGE_GAP, y: PREVIEW_MINI_PLAYER_EDGE_GAP });
    expect(
      keyboardNudgePreviewMiniPlayerPosition({ x: 628, y: 448 }, "right", 80, container, player),
    ).toEqual({ x: 628, y: 448 });
  });
});

describe("keyboardResizePreviewMiniPlayerFromHandle", () => {
  const rect = { position: { x: 200, y: 160 }, size: { width: 320, height: 200 } };
  const container = { width: 1_000, height: 700 };

  it("moves the focused edge in the arrow's screen direction", () => {
    expect(keyboardResizePreviewMiniPlayerFromHandle(rect, "w", "left", 12, container)).toEqual({
      position: { x: 188, y: 160 },
      size: { width: 332, height: 200 },
    });
    expect(keyboardResizePreviewMiniPlayerFromHandle(rect, "e", "left", 12, container)).toEqual({
      position: { x: 200, y: 160 },
      size: { width: 308, height: 200 },
    });
    expect(keyboardResizePreviewMiniPlayerFromHandle(rect, "n", "up", 12, container)).toEqual({
      position: { x: 200, y: 148 },
      size: { width: 320, height: 212 },
    });
    expect(keyboardResizePreviewMiniPlayerFromHandle(rect, "s", "down", 12, container)).toEqual({
      position: { x: 200, y: 160 },
      size: { width: 320, height: 212 },
    });
  });

  it("ignores arrows on an axis the focused handle does not control", () => {
    expect(keyboardResizePreviewMiniPlayerFromHandle(rect, "e", "up", 12, container)).toBeNull();
    expect(keyboardResizePreviewMiniPlayerFromHandle(rect, "s", "left", 12, container)).toBeNull();
  });

  it("lets corner handles control both axes and preserves pointer bounds", () => {
    expect(keyboardResizePreviewMiniPlayerFromHandle(rect, "se", "right", 12, container)).toEqual({
      position: { x: 200, y: 160 },
      size: { width: 332, height: 200 },
    });
    expect(keyboardResizePreviewMiniPlayerFromHandle(rect, "se", "up", 1_000, container)).toEqual({
      position: { x: 200, y: 160 },
      size: { width: 320, height: 150 },
    });
    expect(
      keyboardResizePreviewMiniPlayerFromHandle(
        { position: { x: 20, y: 20 }, size: { width: 940, height: 660 } },
        "nw",
        "left",
        1_000,
        container,
      ),
    ).toEqual({ position: { x: 12, y: 20 }, size: { width: 948, height: 660 } });
  });
});

describe("resizePreviewMiniPlayerRect", () => {
  const rect = { position: { x: 200, y: 160 }, size: { width: 320, height: 200 } };
  const container = { width: 1_000, height: 700 };

  it("anchors the opposite corner when resizing from the top left", () => {
    expect(
      resizePreviewMiniPlayerRect({
        rect,
        direction: "nw",
        delta: { x: -80, y: -40 },
        container,
      }),
    ).toEqual({ position: { x: 120, y: 120 }, size: { width: 400, height: 240 } });
  });

  it("resizes from individual edges without moving unrelated edges", () => {
    expect(
      resizePreviewMiniPlayerRect({
        rect,
        direction: "w",
        delta: { x: 40, y: 90 },
        container,
      }),
    ).toEqual({ position: { x: 240, y: 160 }, size: { width: 280, height: 200 } });
    expect(
      resizePreviewMiniPlayerRect({
        rect,
        direction: "s",
        delta: { x: 90, y: 60 },
        container,
      }),
    ).toEqual({ position: { x: 200, y: 160 }, size: { width: 320, height: 260 } });
  });

  it("honors viewport, reserved-inset, and minimum-size bounds from every direction", () => {
    expect(
      resizePreviewMiniPlayerRect({
        rect,
        direction: "nw",
        delta: { x: -1_000, y: -1_000 },
        container,
      }),
    ).toEqual({ position: { x: 12, y: 12 }, size: { width: 508, height: 348 } });
    expect(
      resizePreviewMiniPlayerRect({
        rect,
        direction: "se",
        delta: { x: 1_000, y: 1_000 },
        container,
        bottomInset: 120,
      }),
    ).toEqual({ position: { x: 200, y: 160 }, size: { width: 788, height: 408 } });
    expect(
      resizePreviewMiniPlayerRect({
        rect,
        direction: "nw",
        delta: { x: 1_000, y: 1_000 },
        container,
      }),
    ).toEqual({ position: { x: 280, y: 210 }, size: { width: 240, height: 150 } });
  });
});
