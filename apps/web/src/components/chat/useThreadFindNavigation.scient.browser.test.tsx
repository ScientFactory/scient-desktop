import type { LegendListRef } from "@legendapp/list/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { useThreadFindNavigation } from "./useThreadFindNavigation";
const renders = vi.fn();
function Probe(props: Parameters<typeof useThreadFindNavigation>[0]) {
  renders();
  useThreadFindNavigation(props);
  return null;
}
const scrollToIndex = vi.fn<LegendListRef["scrollToIndex"]>();
const scrollToOffset = vi.fn<LegendListRef["scrollToOffset"]>();
function setup(_fixture: _Fixture) {
  vi.clearAllMocks();
  using stack = new DisposableStack();
  const highlights = ["t3-thread-find", "t3-thread-find-active"].map(
    (name) => [name, CSS.highlights.get(name)] as const,
  );
  stack.defer(() => {
    for (const [name, highlight] of highlights) {
      if (highlight) CSS.highlights.set(name, highlight);
      else CSS.highlights.delete(name);
    }
  });
  _fixture.container = document.createElement("div");
  _fixture.container.innerHTML =
    '<div data-timeline-row-id="message"><p data-thread-find-text>COD4 and COD4</p></div>';
  _fixture.container.dataset.nativeFindFixture = "true";
  _fixture.container.style.cssText =
    "position:fixed;left:0;top:0;width:800px;height:600px;overflow:hidden";
  const style = document.createElement("style");
  style.textContent =
    "[data-native-find-fixture] [data-thread-find-text]{position:absolute;top:var(--find-text-top,0px);margin:0;font:16px/20px Arial}";
  document.body.append(style);
  stack.defer(() => style.remove());
  document.body.append(_fixture.container);
  _fixture.initializeGeometry();
  const ownContainer = _fixture.container;
  stack.defer(() => ownContainer.remove());
  scrollToIndex.mockResolvedValue();
  _fixture.props = {
    container: _fixture.container,
    query: "COD4",
    match: {
      entryId: "message",
      runId: null,
      occurrence: 0,
    },
    navigationId: 0,
    rowIndex: 0,
    entries: [
      {
        id: "message",
      },
    ],
    listRef: {
      current: {
        scrollToIndex,
        scrollToOffset,
        getState: () => ({
          scroll: 300,
        }),
      } as unknown as LegendListRef,
    },
    contentInsetEndAdjustment: 100,
    listReady: true,
  };
  return stack.move();
}

describe("find result navigation", () => {
  // regression: 12069eefd7 feat(web): find messages and plans in the current thread (#10439)
  it("moves only far enough to reveal text below the composer", async () => {
    await using _fixture = _createFixture();
    using _environment = setup(_fixture);
    await using screen = await render(<Probe {..._fixture.props} />);
    _fixture.moveText(450);
    await screen.rerender(
      <Probe
        {..._fixture.props}
        navigationId={1}
        match={{
          entryId: "message",
          runId: null,
          occurrence: 1,
        }}
      />,
    );
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({
      offset: 346 + _fixture.textHeight,
      animated: false,
    });
  });
  // regression: 12069eefd7 feat(web): find messages and plans in the current thread (#10439)
  it("keeps the selected text visible when newly measured rows shift during scrolling", async () => {
    await using _fixture = _createFixture();
    using _environment = setup(_fixture);
    let scroll = 300;
    _fixture.props.listRef.current = {
      scrollToIndex,
      scrollToOffset,
      getState: () => ({
        scroll,
      }),
    } as unknown as LegendListRef;
    scrollToOffset
      .mockImplementationOnce(async ({ offset }) => {
        scroll = offset;
      })
      .mockImplementationOnce(async ({ offset }) => {
        scroll = offset;
        _fixture.moveText(200);
      });
    await using screen = await render(<Probe {..._fixture.props} />);
    _fixture.moveText(450);
    await screen.rerender(
      <Probe
        {..._fixture.props}
        navigationId={1}
        match={{
          entryId: "message",
          runId: null,
          occurrence: 1,
        }}
      />,
    );
    await vi.waitFor(() => {
      expect(_fixture.rect.top).toBe(200);
      expect(scrollToOffset.mock.calls).toEqual([
        [
          {
            offset: 346 + _fixture.textHeight,
            animated: false,
          },
        ],
        [
          {
            offset: 392 + 2 * _fixture.textHeight,
            animated: false,
          },
        ],
      ]);
      expect(renders).toHaveBeenCalledTimes(2);
    });
  });
});
function _createFixture() {
  const stack = new AsyncDisposableStack();
  let baseline = 0;
  let textHeight = 0;
  const fixture = {
    get rect() {
      const range = document.createRange();
      range.selectNodeContents(fixture.container.querySelector("[data-thread-find-text]")!);
      return range.getBoundingClientRect();
    },
    get textHeight() {
      return textHeight;
    },
    initializeGeometry() {
      const rect = fixture.rect;
      expect(rect.height).toBeGreaterThan(0);
      baseline = rect.top;
      textHeight = rect.height;
      fixture.moveText(200);
    },
    moveText(top: number) {
      fixture.container.style.setProperty("--find-text-top", `${top - baseline}px`);
    },
    props: undefined! as ComponentProps<typeof Probe>,
    container: undefined! as HTMLDivElement,
    stack,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
  return fixture;
}
type _Fixture = ReturnType<typeof _createFixture>;
