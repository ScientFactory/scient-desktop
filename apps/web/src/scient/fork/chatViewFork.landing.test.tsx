// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
let probed: Probed;
let root: Root;

function Probe(props: {
  routeThreadKey: string;
  detailLoaded: boolean;
  displayedThreadKey: string | null;
}) {
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
    probed = { landing, reveal };
  });
  return null;
}

async function render(props: Parameters<typeof Probe>[0]) {
  await act(() => root.render(<Probe {...props} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(() => root.unmount());
  settleForkLanding(fork);
  vi.unstubAllGlobals();
});

describe("fork landing in the chat view", () => {
  it("leaves every other thread switch untouched", async () => {
    await render({ routeThreadKey: origin, detailLoaded: false, displayedThreadKey: origin });
    expect(probed.landing).toMatchObject({ pending: false, landed: false });
    expect(probed.landing.heldTimeline).toBeUndefined();
    expect(probed.reveal.messagesClassName).toBeUndefined();
    expect(probed.reveal.onPositionedThreadKeyChange).toBeUndefined();
    expect(probed.reveal.syncStatusHidden).toBe(false);
  });

  it("hides the fork until its own rows are positioned, then shows it once", async () => {
    await render({ routeThreadKey: origin, detailLoaded: true, displayedThreadKey: origin });
    markForkLanding(fork);
    await render({ routeThreadKey: fork, detailLoaded: false, displayedThreadKey: fork });
    expect(probed.reveal.messagesClassName).toBe("opacity-0");
    expect(probed.reveal.syncStatusHidden).toBe(true);
    // Nothing from the origin is held under the fork's header.
    expect(probed.landing.heldTimeline).toEqual({ threadKey: null, entries: [] });

    await render({ routeThreadKey: fork, detailLoaded: true, displayedThreadKey: fork });
    // Loaded but not yet positioned.
    expect(isForkLandingPending(fork)).toBe(true);
    await act(() => probed.reveal.onPositionedThreadKeyChange?.(fork));
    expect(isForkLandingPending(fork)).toBe(false);
    expect(probed.reveal.messagesClassName).toContain("transition-opacity");
    expect(probed.reveal.messagesClassName).not.toContain("opacity-0");
    expect(probed.reveal.onPositionedThreadKeyChange).toBeUndefined();
    expect(probed.reveal.syncStatusHidden).toBe(false);

    // Leaving the fork ends its landing for good.
    await render({ routeThreadKey: origin, detailLoaded: true, displayedThreadKey: origin });
    expect(probed.landing).toMatchObject({ pending: false, landed: false });
    expect(probed.reveal.messagesClassName).toBeUndefined();
  });

  it("shows the fork when the landing times out, but still holds no origin rows", async () => {
    vi.useFakeTimers();
    try {
      markForkLanding(fork, 100);
      await render({ routeThreadKey: fork, detailLoaded: false, displayedThreadKey: fork });
      expect(probed.reveal.messagesClassName).toBe("opacity-0");
      await act(() => vi.advanceTimersByTime(100));
      expect(probed.landing.pending).toBe(false);
      expect(probed.reveal.messagesClassName).not.toContain("opacity-0");
      expect(probed.landing.heldTimeline).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
