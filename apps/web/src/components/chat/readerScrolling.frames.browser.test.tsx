import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { watchFocusedFrameResizes } from "./readerScrolling";

// Upstream tests this on attachTimelineViewport (timelineViewport.browser.test.tsx), which Scient
// replaced; here the same frame-resize rule is checked on Scient's reader input owner.
it("reports a content resize only from the focused frame in the timeline", async () => {
  await using screen = await render(
    <div data-testid="timeline" style={{ height: 300, overflowY: "auto" }}>
      <div style={{ height: 1200 }} />
      <iframe
        title="render"
        sandbox=""
        srcDoc="<p>frame</p>"
        style={{ display: "block", height: 200 }}
      />
    </div>,
    { router: false },
  );
  const timeline = screen.getByTestId("timeline").element() as HTMLElement;
  const frame = screen.getByTitle("render").element() as HTMLIFrameElement;
  const resized: HTMLIFrameElement[] = [];
  const stop = watchFocusedFrameResizes(timeline, (target) => resized.push(target));
  const resize = (height: number, source: Window | null = frame.contentWindow) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } },
      }),
    );

  // A preview that sizes itself while the reader is elsewhere is not their toggle.
  resize(200);
  resize(400);
  expect(resized).toEqual([]);
  frame.focus();
  // Another window's message, and a report of the same height, change nothing.
  resize(400, window);
  resize(400);
  expect(resized).toEqual([]);
  resize(600);
  resize(200);
  expect(resized).toEqual([frame, frame]);
  stop();
  resize(800);
  expect(resized).toEqual([frame, frame]);
});
