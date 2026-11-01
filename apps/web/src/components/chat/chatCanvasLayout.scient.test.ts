import { describe, expect, it } from "vite-plus/test";
import { resolveChatCanvasLayout, type ChatCanvasPreview } from "./chatCanvasLayout";
import { resizePreviewMiniPlayer } from "../preview/previewMiniPlayerLayout";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";
const preview: ChatCanvasPreview = {
  key: "browser:one",
  width: 320,
  position: null,
  source: {
    width: 1600,
    height: 1000,
  },
};
const resolve = (width: number, player: ChatCanvasPreview | null = preview, height = 900) =>
  resolveChatCanvasLayout({
    container: {
      width,
      height,
    },
    preview: player,
    composerHeight: 180,
  });
const expectClear = (result: ReturnType<typeof resolve>) => {
  const frame = result.frame!;
  const chat = result.chat;
  expect(frame.x + frame.width <= chat.left - 12 || frame.x >= chat.left + chat.width + 12).toBe(
    true,
  );
};
// Scient's compact chat lane (padding 20 instead of upstream's 48) moves these boundaries;
// the upstream cases they replace are marked in chatCanvasLayout.test.ts.
describe("chat canvas layout", () => {
  // regression: 511bc318c4 fix(alignment): preserve Scient presentation and guarded reload
  it("preserves the comfortable and full-width lanes in an 800px desktop canvas", () => {
    const container = {
      width: 800,
      height: 900,
    };
    expect(
      resolveChatCanvasLayout({
        container,
        preview: null,
        maxChatWidth: 736,
      }).chat,
    ).toEqual({
      left: 32,
      width: 736,
      insetStart: 0,
      insetEnd: 0,
    });
    expect(
      resolveChatCanvasLayout({
        container,
        preview: null,
        maxChatWidth: 10_000,
      }).chat,
    ).toEqual({
      left: 20,
      width: 760,
      insetStart: 0,
      insetEnd: 0,
    });
  });
  it("stops leftward dragging before the player can push chat to the right", () => {
    const centered = resolve(1344, null).chat;
    for (const x of [1100, 800, 672, 600, 400, 12, -100]) {
      const result = resolve(1344, {
        ...preview,
        position: {
          x,
          y: 500,
        },
      });
      expect(result.frame!.x).toBeGreaterThanOrEqual(672);
      expect(result.chat.left).toBeLessThanOrEqual(centered.left);
      expect(result.chat.insetStart).toBe(0);
      expect(result.chat.width).toBeGreaterThanOrEqual(640);
      expectClear(result);
    }
    expect(
      resolve(1344, {
        ...preview,
        position: {
          x: 12,
          y: 500,
        },
      }).frame!.x,
    ).toBe(672);
  });
  it("keeps a large player when clearing the full card would leave no readable chat", () => {
    const container = {
      width: 1584,
      height: 988,
    };
    const source = {
      width: 1000,
      height: 1523,
    };
    const layout = (width: number) => {
      const resized = resizePreviewMiniPlayer({
        start: {
          x: 1332,
          y: 610,
          width: 240,
          height: 366,
        },
        direction: "northwest",
        delta: {
          x: 240 - width,
          y: ((240 - width) * source.height) / source.width,
        },
        container,
        source,
      });
      return resolveChatCanvasLayout({
        container,
        maxChatWidth: 736,
        composerHeight: 206,
        detailsCard: {
          left: 1260,
          right: 1572,
          bottom: 339,
        },
        preview: {
          ...preview,
          width: resized.width,
          position: resized,
          source,
        },
      });
    };
    const shifted = layout(460);
    expect(shifted.frame!.width).toBe(460);
    expect(shifted.chat.left).toBeLessThan(424);
    expect(shifted.overlapsDetailsCard).toBe(false);
    expectClear(shifted);
    const narrowed = layout(560);
    expect(narrowed.frame!.width).toBe(560);
    expect(narrowed.chat.width).toBe(656);
    expect(narrowed.overlapsDetailsCard).toBe(false);
    expectClear(narrowed);
    const grown = layout(600);
    expect(grown.frame!.width).toBe(600);
    expect(grown.overlapsDetailsCard).toBe(true);
    expect(grown.overlapsChat).toBe(false);
    expectClear(grown);
    expect(layout(560)).toEqual(narrowed);
  });
});
describe("workspace card beside chat", () => {
  const withCard = (width: number, player: ChatCanvasPreview | null = null, maxChatWidth = 736) =>
    resolveChatCanvasLayout({
      container: {
        width,
        height: 900,
      },
      maxChatWidth,
      composerHeight: 180,
      detailsCard: {
        left: width - 292,
        right: width - 12,
        bottom: 400,
      },
      preview: player,
    });
  it("narrows chat only after it reaches the left padding", () => {
    expect(withCard(1080).chat).toMatchObject({
      left: 20,
      width: 736,
    });
    expect(withCard(1000).chat).toEqual({
      left: 20,
      width: 656,
      insetStart: 0,
      insetEnd: 304,
    });
    expect(withCard(984).chat).toMatchObject({
      left: 20,
      width: 640,
    });
  });
  // regression: 511bc318c4 fix(alignment): preserve Scient presentation and guarded reload
  it("preserves readable chat and card clearance across compact desktop widths", () => {
    for (let width = 984; width <= 1440; width++) {
      const container = {
        width,
        height: 900,
      };
      const card = resolveThreadDetailsCardLayout({
        container,
        lane: {
          padding: 20,
          minChatWidth: 640,
        },
        frame: null,
      })!;
      const chat = withCard(width).chat;
      expect(chat.left).toBeGreaterThanOrEqual(20);
      expect(chat.width).toBeGreaterThanOrEqual(640);
      expect(card.x - chat.left - chat.width).toBeGreaterThanOrEqual(32);
    }
  });
  // regression: 429c625a85 fix(web): workspace card docks beside chat when the window is narrow (#14992)
  it("keeps a full-width chat clear of the card", () => {
    expect(withCard(1147, null, 10_000).chat).toEqual({
      left: 20,
      width: 803,
      insetStart: 0,
      insetEnd: 304,
    });
  });
});
