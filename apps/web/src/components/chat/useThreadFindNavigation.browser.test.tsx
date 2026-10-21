import type { LegendListRef } from "@legendapp/list/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
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
    match: { entryId: "message", runId: null, occurrence: 0 },
    navigationId: 0,
    rowIndex: 0,
    entries: [{ id: "message" }],
    listRef: {
      current: {
        scrollToIndex,
        scrollToOffset,
        getState: () => ({ scroll: 300 }),
      } as unknown as LegendListRef,
    },
    contentInsetEndAdjustment: 100,
    listReady: true,
  };
  return stack.move();
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("find result navigation", () => {
  it("retargets a pending first jump when progressive history moves the matching row", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    _fixture.container.replaceChildren();
    let first!: () => void;
    let second!: () => void;
    scrollToIndex
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            first = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            second = resolve;
          }),
      );
    await using screen = await render(<Probe {..._fixture.props} rowIndex={2} />);
    await screen.rerender(
      <Probe
        {..._fixture.props}
        rowIndex={6}
        entries={[{ id: "tool" }, ..._fixture.props.entries]}
      />,
    );
    expect(scrollToIndex.mock.calls.map(([request]) => request.index)).toEqual([2, 6]);
    await act(async () => first());
    expect(scrollToOffset).not.toHaveBeenCalled();
    await act(async () => {
      _fixture.container.innerHTML =
        '<div data-timeline-row-id="message"><p data-thread-find-text>COD4</p></div>';
      _fixture.moveText(450);
      second();
      await nextFrame();
    });
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({
      offset: 346 + _fixture.textHeight,
      animated: false,
    });
  });

  it("keeps the highlighted text at the same position when progressive activity arrives", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    const historyControls = {
      hasMoreHistory: true,
      loading: true,
      error: null,
      onLoadEarlier: vi.fn(),
    };
    await using screen = await render(
      <Probe {..._fixture.props} historyControls={historyControls} />,
    );
    _fixture.moveText(368);
    scrollToOffset.mockImplementationOnce(async () => {
      _fixture.moveText(200);
    });
    await screen.rerender(
      <Probe
        {..._fixture.props}
        entries={[{ id: "tool" }, { id: "message" }]}
        historyControls={{ ...historyControls, loading: false }}
      />,
    );
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 468, animated: false });
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("respects scrolling away from a partial match before activity arrives", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    const historyControls = {
      hasMoreHistory: true,
      loading: true,
      error: null,
      onLoadEarlier: vi.fn(),
    };
    await using screen = await render(
      <Probe {..._fixture.props} historyControls={historyControls} />,
    );
    _fixture.moveText(-600);
    _fixture.container.dispatchEvent(new Event("scroll"));
    await screen.rerender(
      <Probe
        {..._fixture.props}
        entries={[{ id: "tool" }, { id: "message" }]}
        historyControls={{ ...historyControls, loading: false }}
      />,
    );
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it("reveals settled virtual text without another timeline render", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    let complete!: () => void;
    scrollToIndex.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    _fixture.moveText(1800);
    await using _screen = await render(<Probe {..._fixture.props} />);
    expect(renders).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).not.toHaveBeenCalled();
    _fixture.moveText(450);
    await act(async () => {
      complete();
      await nextFrame();
    });
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({
      offset: 346 + _fixture.textHeight,
      animated: false,
    });
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("ignores an older scroll completion after navigation moves to another occurrence", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    let first!: () => void;
    let second!: () => void;
    scrollToIndex
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            first = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            second = resolve;
          }),
      );
    _fixture.moveText(1800);
    await using screen = await render(<Probe {..._fixture.props} />);
    await screen.rerender(
      <Probe
        {..._fixture.props}
        navigationId={1}
        match={{ entryId: "message", runId: null, occurrence: 1 }}
      />,
    );
    _fixture.moveText(450);
    await act(async () => first());
    expect(scrollToOffset).not.toHaveBeenCalled();
    await act(async () => {
      second();
      await nextFrame();
    });
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({
      offset: 346 + _fixture.textHeight,
      animated: false,
    });
  });

  it("loads history until a distant match can be revealed in the conversation", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    const onLoadEarlier = vi.fn();
    const historyControls = { hasMoreHistory: true, loading: false, error: null, onLoadEarlier };
    const pending = {
      ..._fixture.props,
      rowIndex: -1,
      entries: [{ id: "recent" }],
      historyControls,
    };
    await using screen = await render(<Probe {...pending} />);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).not.toHaveBeenCalled();
    await screen.rerender(
      <Probe {...pending} historyControls={{ ...historyControls, loading: true }} />,
    );
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    await screen.rerender(<Probe {...pending} entries={[{ id: "older" }, ...pending.entries]} />);
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
    _fixture.moveText(1800);
    scrollToIndex.mockImplementationOnce(async () => {
      _fixture.moveText(200);
    });
    await screen.rerender(<Probe {..._fixture.props} historyControls={historyControls} />);
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("waits for list bootstrap before positioning the first result", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    _fixture.moveText(1800);
    await using screen = await render(<Probe {..._fixture.props} listReady={false} />);
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).not.toHaveBeenCalled();
    scrollToIndex.mockImplementationOnce(async () => {
      _fixture.moveText(200);
    });
    await screen.rerender(<Probe {..._fixture.props} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).not.toHaveBeenCalled();
  });
  it("leaves the scroll position unchanged between already visible occurrences", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    await using screen = await render(<Probe {..._fixture.props} />);
    await screen.rerender(
      <Probe
        {..._fixture.props}
        navigationId={1}
        match={{ entryId: "message", runId: null, occurrence: 1 }}
      />,
    );
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).not.toHaveBeenCalled();
    const highlight = CSS.highlights.get("t3-thread-find-active");
    const ranges = [...(highlight as unknown as Set<Range>)];
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.startOffset).toBe(9);
    expect(ranges[0]?.toString()).toBe("COD4");
  });

  it("reveals the same match again when search restarts after scrolling away", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    await using screen = await render(<Probe {..._fixture.props} />);
    _fixture.moveText(-1800);
    _fixture.props.listRef.current = {
      scrollToIndex,
      scrollToOffset,
      getState: () => ({ scroll: 2400 }),
    } as unknown as LegendListRef;
    await screen.rerender(<Probe {..._fixture.props} navigationId={1} />);
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 504, animated: false });
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(
      Array.from(CSS.highlights.get("t3-thread-find-active") ?? [], (range) => range.toString()),
    ).toEqual(["COD4"]);
  });

  it("moves only far enough to reveal text below the composer", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    await using screen = await render(<Probe {..._fixture.props} />);
    _fixture.moveText(450);
    await screen.rerender(
      <Probe
        {..._fixture.props}
        navigationId={1}
        match={{ entryId: "message", runId: null, occurrence: 1 }}
      />,
    );
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({
      offset: 346 + _fixture.textHeight,
      animated: false,
    });
  });

  it("moves only far enough to reveal text above the viewport margin", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    await using screen = await render(<Probe {..._fixture.props} />);
    _fixture.moveText(40);
    await screen.rerender(
      <Probe
        {..._fixture.props}
        navigationId={1}
        match={{ entryId: "message", runId: null, occurrence: 1 }}
      />,
    );
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 244, animated: false });
  });

  it("keeps the selected text visible when newly measured rows shift during scrolling", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    let scroll = 300;
    _fixture.props.listRef.current = {
      scrollToIndex,
      scrollToOffset,
      getState: () => ({ scroll }),
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
        match={{ entryId: "message", runId: null, occurrence: 1 }}
      />,
    );
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    expect(_fixture.rect.top).toBe(200);
    expect(scrollToOffset.mock.calls).toEqual([
      [{ offset: 346 + _fixture.textHeight, animated: false }],
      [{ offset: 392 + 2 * _fixture.textHeight, animated: false }],
    ]);
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("waits for a new context window to settle before revealing an offscreen result", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    _fixture.moveText(1800);
    scrollToIndex.mockImplementationOnce(async () => {
      _fixture.moveText(450);
    });
    await using _screen = await render(<Probe {..._fixture.props} />);
    await act(nextFrame);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({
      offset: 346 + _fixture.textHeight,
      animated: false,
    });
  });

  it("materializes a virtualized message before revealing its occurrence", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    _fixture.container.replaceChildren();
    await using _screen = await render(<Probe {..._fixture.props} rowIndex={4} />);
    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith({
      index: 4,
      animated: false,
      viewOffset: 96,
    });
    expect(scrollToOffset).not.toHaveBeenCalled();
    _fixture.moveText(450);
    await act(async () => {
      _fixture.container.innerHTML =
        '<div data-timeline-row-id="message"><p data-thread-find-text>COD4</p></div>';
      await nextFrame();
    });
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({
      offset: 346 + _fixture.textHeight,
      animated: false,
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
