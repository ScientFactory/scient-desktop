import { describe, expect, it } from "vite-plus/test";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";
const lane = {
  padding: 20,
  minChatWidth: 640,
};
const resolve = (width: number, height: number, previewY: number | null = null) =>
  resolveThreadDetailsCardLayout({
    container: {
      width,
      height,
    },
    lane,
    frame:
      previewY === null
        ? null
        : {
            x: width - 332,
            y: previewY,
            width: 320,
            height: 240,
          },
  });
describe("workspace card", () => {
  it("hides when a readable chat lane cannot fit beside it", () => {
    expect(resolve(984, 900)).toMatchObject({
      x: 692,
    });
    expect(resolve(983, 900)).toBeNull();
  });
  it("keeps the workspace controls available across the compact desktop boundary", () => {
    for (let width = 984; width <= 1011; width++) {
      expect(resolve(width, 900)).toMatchObject({
        x: width - 292,
        width: 280,
      });
    }
  });
});
