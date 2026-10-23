import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  isForkLandingPending,
  markForkLanding,
  settleForkLanding,
} from "~/components/scient-fork/forkLanding";
import { useForkLanding, useForkLandingReveal } from "./chatViewFork";

const fork = "env:fork";
const origin = "env:origin";

type Probed = {
  landing: ReturnType<typeof useForkLanding>;
  reveal: ReturnType<typeof useForkLandingReveal>;
};

function Probe({
  _fixture,
  ...props
}: {
  routeThreadKey: string;
  detailLoaded: boolean;
  displayedThreadKey: string | null;
} & { _fixture: _Fixture }) {
  const landing = useForkLanding(props.routeThreadKey);
  const reveal = useForkLandingReveal({
    landing,
    threadKey: props.routeThreadKey,
    threadExists: true,
    threadDeleted: false,
    detailLoaded: props.detailLoaded,
    displayedThreadKey: props.displayedThreadKey,
    timelineEmpty: false,
  });
  useLayoutEffect(() => {
    _fixture.publishProbed({ landing, reveal });
  });
  return <div data-landing-surface inert={landing.pending} className={reveal.messagesClassName} />;
}

async function render(_fixture: _Fixture, props: Omit<Parameters<typeof Probe>[0], "_fixture">) {
  await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} {...props} />));
}

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.container = document.createElement("div");
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  settleForkLanding(fork);
  vi.unstubAllGlobals();
}

describe("fork landing in the chat view", () => {
  it("leaves every other thread switch untouched", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, {
      routeThreadKey: origin,
      detailLoaded: false,
      displayedThreadKey: origin,
    });
    expect(_fixture.probed.landing).toMatchObject({ pending: false, landed: false });
    expect(_fixture.probed.landing.heldTimeline).toBeUndefined();
    expect(_fixture.probed.reveal.messagesClassName).toBeUndefined();
    expect(_fixture.probed.reveal.onPositionedThreadKeyChange).toBeUndefined();
    expect(_fixture.probed.reveal.syncStatusHidden).toBe(false);
    expect(_fixture.container.querySelector("[data-landing-surface]")?.hasAttribute("inert")).toBe(
      false,
    );
  });

  it("hides the fork until its own rows are positioned, then shows it once", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, {
      routeThreadKey: origin,
      detailLoaded: true,
      displayedThreadKey: origin,
    });
    markForkLanding(fork);
    await render(_fixture, { routeThreadKey: fork, detailLoaded: false, displayedThreadKey: fork });
    expect(_fixture.probed.reveal.messagesClassName).toBe("opacity-0");
    expect(_fixture.probed.reveal.syncStatusHidden).toBe(true);
    expect(_fixture.container.querySelector("[data-landing-surface]")?.hasAttribute("inert")).toBe(
      true,
    );
    // Nothing from the origin is held under the fork's header.
    expect(_fixture.probed.landing.heldTimeline).toEqual({ threadKey: null, entries: [] });

    await render(_fixture, { routeThreadKey: fork, detailLoaded: true, displayedThreadKey: fork });
    // Loaded but not yet positioned.
    expect(isForkLandingPending(fork)).toBe(true);
    await act(() => _fixture.probed.reveal.onPositionedThreadKeyChange?.(fork));
    expect(isForkLandingPending(fork)).toBe(false);
    expect(_fixture.probed.reveal.messagesClassName).toContain("transition-opacity");
    expect(_fixture.probed.reveal.messagesClassName).not.toContain("opacity-0");
    expect(_fixture.probed.reveal.onPositionedThreadKeyChange).toBeUndefined();
    expect(_fixture.probed.reveal.syncStatusHidden).toBe(false);
    expect(_fixture.container.querySelector("[data-landing-surface]")?.hasAttribute("inert")).toBe(
      false,
    );

    // Leaving the fork ends its landing for good.
    await render(_fixture, {
      routeThreadKey: origin,
      detailLoaded: true,
      displayedThreadKey: origin,
    });
    expect(_fixture.probed.landing).toMatchObject({ pending: false, landed: false });
    expect(_fixture.probed.reveal.messagesClassName).toBeUndefined();
  });

  it("shows the fork when the landing times out, but still holds no origin rows", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.stack.use(_fixtureFakeTimers());
    try {
      markForkLanding(fork, 100);
      await render(_fixture, {
        routeThreadKey: fork,
        detailLoaded: false,
        displayedThreadKey: fork,
      });
      expect(_fixture.probed.reveal.messagesClassName).toBe("opacity-0");
      expect(
        _fixture.container.querySelector("[data-landing-surface]")?.hasAttribute("inert"),
      ).toBe(true);
      await act(() => vi.advanceTimersByTime(100));
      expect(_fixture.probed.landing.pending).toBe(false);
      expect(
        _fixture.container.querySelector("[data-landing-surface]")?.hasAttribute("inert"),
      ).toBe(false);
      expect(_fixture.probed.reveal.messagesClassName).not.toContain("opacity-0");
      expect(_fixture.probed.landing.heldTimeline).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

function _createFixture() {
  let _published_probed = undefined! as Probed;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get probed() {
      return _published_probed;
    },
    publishProbed(next: typeof _published_probed) {
      _published_probed = next;
      return next;
    },

    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
