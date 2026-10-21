import { useLayoutEffect } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { shouldUseRestingComposerLayout } from "../composerFooterLayout";
import { useComposerFocusState } from "./useComposerFocusState";

function ComposerProbe({ _fixture }: { _fixture: _Fixture }) {
  const state = useComposerFocusState();
  useLayoutEffect(() => {
    _fixture.publishComposer(state);
    _fixture.publishIsResting(
      shouldUseRestingComposerLayout({
        isExistingThread: true,
        isMobileViewport: false,
        isScrollCollapsed: state.isComposerScrollCollapsed,
        hasExpandedChrome: false,
        hasMultilinePrompt: false,
        timelineOverflows: true,
      }),
    );
  });
  return null;
}

describe("composer focus state", () => {
  it("stays expanded when the composer loses focus", async () => {
    await using _fixture = _createFixture();

    await using _screen = await render(<ComposerProbe _fixture={_fixture} />);
    await act(() => _fixture.composer.setIsComposerFocused(true));
    expect(_fixture.isResting).toBe(false);

    await act(() => _fixture.composer.setIsComposerFocused(false));
    expect(_fixture.isResting).toBe(false);
  });

  it("can collapse again on the next scroll after returning to the end", async () => {
    await using _fixture = _createFixture();

    await using _screen = await render(<ComposerProbe _fixture={_fixture} />);
    await act(() => _fixture.composer.setIsComposerScrollCollapsed(true));
    expect(_fixture.isResting).toBe(true);

    await act(() => _fixture.composer.restoreAfterTimelineReachedEnd());
    expect(_fixture.isResting).toBe(false);

    await act(() => _fixture.composer.setIsComposerScrollCollapsed(true));
    expect(_fixture.isResting).toBe(true);
  });

  it("does not move focus into the composer when the timeline reaches the end", async () => {
    await using _fixture = _createFixture();

    await using _screen = await render(<ComposerProbe _fixture={_fixture} />);
    await act(() => _fixture.composer.setIsComposerScrollCollapsed(true));
    await act(() => _fixture.composer.restoreAfterTimelineReachedEnd());
    expect(_fixture.isResting).toBe(false);
    expect(_fixture.composer.isComposerFocused).toBe(false);
  });
});

function _createFixture() {
  let isResting = false;
  let _published_composer = undefined! as ReturnType<typeof useComposerFocusState>;

  const stack = new AsyncDisposableStack();
  return {
    get isResting() {
      return isResting;
    },
    publishIsResting(next: boolean) {
      isResting = next;
    },
    get composer() {
      return _published_composer;
    },
    publishComposer(next: typeof _published_composer) {
      _published_composer = next;
    },
    stack,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
