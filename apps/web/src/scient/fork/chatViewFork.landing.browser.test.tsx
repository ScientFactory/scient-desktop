import { render as _fixtureRender, type Screen } from "../../../test/render";
import { useLayoutEffect } from "react";

import { userEvent } from "vitest/browser";
import { expect, it, vi } from "vite-plus/test";

import { markForkLanding, settleForkLanding } from "~/components/scient-fork/forkLanding";
import { useForkLanding, useForkLandingReveal } from "./chatViewFork";

const fork = "env:landing-browser-fork";
const origin = "env:landing-browser-origin";

// The actual landing hooks with the messages wrapper's inert/opacity binding.
// ChatView's full provider/composer shell is not mounted by this focused proof.
function Probe({
  _fixture,
  ...props
}: { threadKey: string; detailLoaded: boolean; onAction: () => void } & { _fixture: _Fixture }) {
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
    _fixture.publishReveal(currentReveal);
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

async function render(_fixture: _Fixture, props: Omit<Parameters<typeof Probe>[0], "_fixture">) {
  if (!_fixture.root0) {
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  await _fixture.root0.rerender(<Probe _fixture={_fixture} {...props} />);
  await expect.poll(() => _fixture.host?.querySelector("[data-action]")).not.toBeNull();
}

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  settleForkLanding(fork);
}

it("measures pending rows but blocks pointer/focus until their own landing settles", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const onAction = vi.fn();
  await render(_fixture, { threadKey: origin, detailLoaded: true, onAction });
  const button = _fixture.host!.querySelector<HTMLButtonElement>("[data-action]")!;
  const before = _fixture.host!.querySelector<HTMLButtonElement>("[data-before]")!;
  const after = _fixture.host!.querySelector<HTMLButtonElement>("[data-after]")!;
  const surface = _fixture.host!.querySelector<HTMLElement>("[data-landing-surface]")!;
  expect(surface.inert).toBe(false);
  await userEvent.click(button);
  expect(onAction).toHaveBeenCalledTimes(1);

  markForkLanding(fork, 60_000);
  await render(_fixture, { threadKey: fork, detailLoaded: false, onAction });
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

  await render(_fixture, { threadKey: fork, detailLoaded: true, onAction });
  await expect.poll(() => _fixture.reveal.onPositionedThreadKeyChange).toBeDefined();
  _fixture.reveal.onPositionedThreadKeyChange?.(fork);
  await expect.poll(() => surface.inert, { timeout: 3_000 }).toBe(false);
  expect(surface.getBoundingClientRect().height).toBe(pendingBounds.height);
  before.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(button);
  await userEvent.click(button);
  expect(onAction).toHaveBeenCalledTimes(2);
});

// regression: b75327a435 chore: merge main and preserve frozen fork history readers
it("releases inertness at expiry even when the fork never finishes loading", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const onAction = vi.fn();
  markForkLanding(fork, 1_000);
  await render(_fixture, { threadKey: fork, detailLoaded: false, onAction });
  const surface = _fixture.host!.querySelector<HTMLElement>("[data-landing-surface]")!;
  await expect.poll(() => surface.inert).toBe(true);
  await expect.poll(() => surface.inert, { timeout: 3_000 }).toBe(false);
  await userEvent.click(_fixture.host!.querySelector<HTMLButtonElement>("[data-action]")!);
  expect(onAction).toHaveBeenCalledTimes(1);
});

function _createFixture() {
  let _published_reveal = undefined! as ReturnType<typeof useForkLandingReveal>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get reveal() {
      return _published_reveal;
    },
    publishReveal(next: typeof _published_reveal) {
      _published_reveal = next;
    },

    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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
