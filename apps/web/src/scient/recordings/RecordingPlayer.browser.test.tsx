import { expect, it } from "vite-plus/test";
import { page } from "vitest/browser";
import { render } from "../../../test/render";
import lectureVideoUrl from "../../../test/fixtures/recording-lecture.mp4?url";
import "../../index.css";
import { RecordingPlayer } from "./RecordingPlayer";

it("covers the viewport and removes the desktop resize inset for recording fullscreen", async () => {
  await page.viewport(1280, 800);
  await using screen = await render(
    <div className="electron-windows h-screen bg-background">
      <div id="root">
        <RecordingPlayer
          onReady={() => {}}
          onMedia={() => {}}
          src={lectureVideoUrl}
          video
          time={0}
          onTime={() => {}}
          onStale={() => {}}
          theater={false}
          onTheater={() => {}}
          caption=""
        />
      </div>
    </div>,
  );
  const root = screen.container.querySelector<HTMLElement>("#root")!;
  expect(getComputedStyle(root).paddingRight).toBe("6px");
  const fullscreen = screen.getByRole("button", { name: "Full screen (F)" });
  await fullscreen.click();
  await expect.element(fullscreen).toHaveAttribute("aria-pressed", "true");
  try {
    const stage = document.fullscreenElement as HTMLElement;
    await expect
      .poll(() => stage.style.getPropertyValue("--recording-fullscreen-width"))
      .toBe(`${window.innerWidth}px`);
    stage.style.setProperty("--recording-fullscreen-width", "1px");
    stage.style.setProperty("--recording-fullscreen-height", "1px");
    window.dispatchEvent(new Event("resize"));
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests, t3code/no-frame-waits-in-browser-tests -- the regression appears after the native fullscreen transition settles, not on the first frame.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(stage.style.getPropertyValue("--recording-fullscreen-width")).toBe(
      `${window.innerWidth}px`,
    );
    expect(stage.style.getPropertyValue("--recording-fullscreen-height")).toBe(
      `${window.innerHeight}px`,
    );
    const bounds = stage.getBoundingClientRect();
    expect([bounds.left, bounds.top, bounds.width, bounds.height]).toEqual([
      0,
      0,
      window.innerWidth,
      window.innerHeight,
    ]);
    for (const element of [document.documentElement, document.body, root, stage]) {
      const style = getComputedStyle(element);
      expect(style.backgroundColor).toBe("rgb(0, 0, 0)");
      expect(style.paddingRight).toBe("0px");
      expect(style.borderRightWidth).toBe("0px");
    }
    const directory = import.meta.env.VITE_SCIENT_RECORDINGS_SCREENSHOTS;
    if (directory) {
      await page.screenshot({ path: `${directory}/recording-fullscreen-edge.png` });
      document.documentElement.classList.add("dark");
      try {
        await page.screenshot({ path: `${directory}/recording-fullscreen-edge-dark.png` });
      } finally {
        document.documentElement.classList.remove("dark");
      }
    }
  } finally {
    await document.exitFullscreen();
  }
  // The root mark clears on the fullscreenchange event that follows the exit.
  await expect.poll(() => getComputedStyle(root).paddingRight).toBe("6px");
  expect(document.documentElement.hasAttribute("data-recording-fullscreen")).toBe(false);
});
