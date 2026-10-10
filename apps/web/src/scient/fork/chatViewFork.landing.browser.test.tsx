import { useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { markForkLanding, settleForkLanding } from "~/components/scient-fork/forkLanding";
import { useForkLanding, useForkLandingReveal } from "./chatViewFork";

const fork = "env:landing-browser-fork";
const origin = "env:landing-browser-origin";
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let reveal: ReturnType<typeof useForkLandingReveal>;

// The actual landing hooks with the messages wrapper's inert/opacity binding.
// ChatView's full provider/composer shell is not mounted by this focused proof.
function Probe(props: { threadKey: string; detailLoaded: boolean; onAction: () => void }) {
  const landing = useForkLanding(props.threadKey);
  const currentReveal = useForkLandingReveal({
    landing,
    threadKey: props.threadKey,
    threadExists: true,
    threadDeleted: false,
    detailLoaded: props.detailLoaded,
    displayedThreadKey: props.threadKey,
    timelineEmpty: false,
  });
  useLayoutEffect(() => {
    reveal = currentReveal;
  });
  return (
    <>
      <button data-before type="button">
        Before timeline
      </button>
      <div
        data-landing-surface
        inert={landing.pending}
        className={currentReveal.messagesClassName}
        style={{ width: 240, height: 80, opacity: landing.pending ? 0 : 1 }}
      >
        <button data-action type="button" onClick={props.onAction}>
          Landing row action
        </button>
      </div>
      <button data-after type="button">
        After timeline
      </button>
    </>
  );
}

async function render(props: Parameters<typeof Probe>[0]) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  root.render(<Probe {...props} />);
  await expect.poll(() => host?.querySelector("[data-action]")).not.toBeNull();
}

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  settleForkLanding(fork);
});

it("measures pending rows but blocks pointer/focus until their own landing settles", async () => {
  const onAction = vi.fn();
  await render({ threadKey: origin, detailLoaded: true, onAction });
  const button = host!.querySelector<HTMLButtonElement>("[data-action]")!;
  const before = host!.querySelector<HTMLButtonElement>("[data-before]")!;
  const after = host!.querySelector<HTMLButtonElement>("[data-after]")!;
  const surface = host!.querySelector<HTMLElement>("[data-landing-surface]")!;
  expect(surface.inert).toBe(false);
  await userEvent.click(button);
  expect(onAction).toHaveBeenCalledTimes(1);

  markForkLanding(fork, 60_000);
  await render({ threadKey: fork, detailLoaded: false, onAction });
  await expect.poll(() => surface.inert).toBe(true);
  const pendingBounds = surface.getBoundingClientRect();
  expect(pendingBounds.width).toBeGreaterThan(0);
  expect(pendingBounds.height).toBeGreaterThan(0);
  before.focus();
  button.focus();
  expect(document.activeElement).toBe(before);
  // Force bypasses Playwright actionability; Chromium must still reject the
  // actual pointer hit on the inert descendant, rather than a synthetic click.
  await userEvent.click(button, { force: true });
  expect(onAction).toHaveBeenCalledTimes(1);
  before.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(after);

  await render({ threadKey: fork, detailLoaded: true, onAction });
  await expect.poll(() => reveal.onPositionedThreadKeyChange).toBeDefined();
  reveal.onPositionedThreadKeyChange?.(fork);
  await expect.poll(() => surface.inert, { timeout: 3_000 }).toBe(false);
  expect(surface.getBoundingClientRect().height).toBe(pendingBounds.height);
  before.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(button);
  await userEvent.click(button);
  expect(onAction).toHaveBeenCalledTimes(2);
});

it("releases inertness at expiry even when the fork never finishes loading", async () => {
  const onAction = vi.fn();
  markForkLanding(fork, 1_000);
  await render({ threadKey: fork, detailLoaded: false, onAction });
  const surface = host!.querySelector<HTMLElement>("[data-landing-surface]")!;
  await expect.poll(() => surface.inert).toBe(true);
  await expect.poll(() => surface.inert, { timeout: 3_000 }).toBe(false);
  await userEvent.click(host!.querySelector<HTMLButtonElement>("[data-action]")!);
  expect(onAction).toHaveBeenCalledTimes(1);
});
