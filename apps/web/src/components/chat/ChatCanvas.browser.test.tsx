import { useLayoutEffect } from "react";
import { expect, it } from "vite-plus/test";
import "../../index.css";

import { act, render } from "../../../test/render";
import { ChatCanvas } from "./ChatCanvas";
import { useChatCanvas } from "./ChatCanvasContext";

function Preview({ _fixture, x }: { x: number } & { _fixture: _Fixture }) {
  const current = useChatCanvas();
  useLayoutEffect(() => {
    _fixture.publishCanvas(current);
  }, [_fixture, current]);
  const reportPreview = current?.reportPreview;
  useLayoutEffect(() => {
    reportPreview?.({
      key: "browser:one",
      width: 240,
      source: { width: 240, height: 365 },
      position: { x, y: 12 },
      lastInteraction: "drag",
    });
  }, [reportPreview, x]);
  return null;
}

function layoutFont(size = 16) {
  const stack = new DisposableStack();
  const previous = document.documentElement.style.fontSize;
  document.documentElement.style.fontSize = `${size}px`;
  stack.defer(() => {
    document.documentElement.style.fontSize = previous;
  });
  return stack;
}

function find(_fixture: _Fixture, open: boolean, previewX = 1548) {
  return (
    <div
      style={{ display: "flex", position: "fixed", left: 200, top: 100, width: 1800, height: 1000 }}
    >
      <ChatCanvas composerOverlayElement={null} detailsCardTopInset={open ? 48 : 0}>
        {open ? (
          <div
            data-thread-find-bar
            style={{
              position: "absolute",
              top: ".75rem",
              right: ".75rem",
              width: "17.5rem",
              height: "2.25rem",
            }}
          />
        ) : null}
        <Preview _fixture={_fixture} x={previewX} />
      </ChatCanvas>
    </div>
  );
}

it.each([16, 24])(
  "keeps a preview below Find and releases its space on close at a %spx root font",
  async (size) => {
    await using _fixture = _createFixture();

    using _layout = layoutFont(size);
    await using screen = await render(find(_fixture, false));
    expect(_fixture.canvas?.layout.frame?.y).toBe(12);

    await screen.rerender(find(_fixture, true));
    expect(_fixture.canvas?.detailsCardTopInset).toBe(3 * size);
    expect(_fixture.canvas?.layout.frame?.y).toBe(3 * size + 12);

    await screen.rerender(find(_fixture, false));
    expect(_fixture.canvas?.detailsCardTopInset).toBe(0);
    expect(_fixture.canvas?.layout.frame?.y).toBe(12);

    await screen.rerender(find(_fixture, true));
    expect(_fixture.canvas?.layout.frame?.y).toBe(3 * size + 12);
  },
);

it("remeasures the open bar when its font size changes without resizing the canvas", async () => {
  await using _fixture = _createFixture();

  using _layout = layoutFont();
  await using _screen = await render(find(_fixture, true, 1200));
  expect(_fixture.canvas?.layout.frame?.y).toBe(12);

  await act(() => {
    document.documentElement.style.fontSize = "24px";
  });
  await expect.poll(() => _fixture.canvas?.detailsCardTopInset).toBe(72);
  expect(_fixture.canvas?.layout.frame?.y).toBe(84);
});

function _createFixture() {
  let _published_canvas = undefined! as ReturnType<typeof useChatCanvas>;

  const stack = new AsyncDisposableStack();
  return {
    get canvas() {
      return _published_canvas;
    },
    publishCanvas(next: typeof _published_canvas) {
      _published_canvas = next;
    },
    stack,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
