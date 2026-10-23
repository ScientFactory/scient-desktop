import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
} from "../../../test/render";
import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

import { ProviderVersionLabel } from "./ProviderVersionLabel";

const LONG_VERSION = "v2026.08.11-e8f3c2a1b4d5";

async function renderLabel(
  _fixture: _Fixture,
  width: string,
  version: string,
  className = "text-xs",
) {
  _fixture.host = document.createElement("div");
  _fixture.host.style.width = width;
  _fixture.host.style.margin = "80px";
  _fixture.host.className = "flex";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(<ProviderVersionLabel version={version} className={className} />);
}

/** The label, once its first measurement has been reported. */
async function measuredLabel(_fixture: _Fixture): Promise<HTMLElement> {
  await expect.poll(() => _fixture.host?.querySelector("code")?.dataset.overflowing).toBeDefined();
  return _fixture.host!.querySelector("code")!;
}

const tooltipText = () => document.querySelector('[data-slot="tooltip-popup"]')?.textContent;

async function _cleanupFixture0(_fixture: _Fixture) {
  vi.useRealTimers();
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

it("fades a clipped version's tail instead of drawing an ellipsis", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderLabel(_fixture, "90px", LONG_VERSION);
  const label = await measuredLabel(_fixture);

  expect(label.dataset.overflowing).toBe("true");
  const style = getComputedStyle(label);
  expect(style.textOverflow).not.toBe("ellipsis");
  expect(style.whiteSpace).toBe("nowrap");
  expect(style.maskImage || style.webkitMaskImage).toContain("linear-gradient");
  expect(label.textContent).toBe(LONG_VERSION);

  // The full version is one hover away.
  const rect = label.getBoundingClientRect();
  expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)).toBe(
    label,
  );
  await userEvent.hover(label);
  await expect.poll(tooltipText).toBe(LONG_VERSION);
});

it("lets the keyboard reach a clipped version's full text", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderLabel(_fixture, "90px", LONG_VERSION);
  const label = await measuredLabel(_fixture);

  expect(label.tabIndex).toBe(0);
  await userEvent.tab();
  expect(document.activeElement).toBe(label);
  await expect.poll(tooltipText).toBe(LONG_VERSION);
});

it("leaves a version that fits untouched", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderLabel(_fixture, "400px", "v1.2.3");
  const label = await measuredLabel(_fixture);

  expect(label.dataset.overflowing).toBe("false");
  expect(label.hasAttribute("tabindex")).toBe(false);
  const style = getComputedStyle(label);
  expect(style.maskImage || style.webkitMaskImage || "none").toBe("none");

  // Well past the tooltip's hover delay, on a controlled clock.
  _fixture.stack.use(_fixtureFakeTimers());
  await userEvent.hover(label);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
});

it("starts fading when the row narrows and stops when it widens", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderLabel(_fixture, "400px", LONG_VERSION);
  const label = await measuredLabel(_fixture);
  expect(label.dataset.overflowing).toBe("false");

  _fixture.host!.style.width = "80px";
  await expect.poll(() => label.dataset.overflowing).toBe("true");

  _fixture.host!.style.width = "400px";
  await expect.poll(() => label.dataset.overflowing).toBe("false");
});

it("measures a new version even when the label keeps its width", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  // A full-width label: a longer version changes what overflows, not its box.
  await renderLabel(_fixture, "90px", "v1.2.3", "w-full text-xs");
  const label = await measuredLabel(_fixture);
  expect(label.dataset.overflowing).toBe("false");

  await _fixture.root0!.rerender(
    <ProviderVersionLabel version={LONG_VERSION} className="w-full text-xs" />,
  );

  await expect.poll(() => label.dataset.overflowing).toBe("true");
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
