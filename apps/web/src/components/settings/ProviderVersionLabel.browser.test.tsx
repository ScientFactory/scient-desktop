import "../../index.css";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

import { ProviderVersionLabel } from "./ProviderVersionLabel";

const LONG_VERSION = "v2026.08.11-e8f3c2a1b4d5";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function renderLabel(width: string, version: string, className = "text-xs") {
  host = document.createElement("div");
  host.style.width = width;
  host.className = "flex";
  document.body.append(host);
  root = createRoot(host);
  root.render(<ProviderVersionLabel version={version} className={className} />);
}

/** The label, once its first measurement has been reported. */
async function measuredLabel(): Promise<HTMLElement> {
  await expect.poll(() => host?.querySelector("code")?.dataset.overflowing).toBeDefined();
  return host!.querySelector("code")!;
}

const tooltipText = () => document.querySelector('[data-slot="tooltip-popup"]')?.textContent;

afterEach(() => {
  vi.useRealTimers();
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

it("fades a clipped version's tail instead of drawing an ellipsis", async () => {
  renderLabel("90px", LONG_VERSION);
  const label = await measuredLabel();

  expect(label.dataset.overflowing).toBe("true");
  const style = getComputedStyle(label);
  expect(style.textOverflow).not.toBe("ellipsis");
  expect(style.whiteSpace).toBe("nowrap");
  expect(style.maskImage || style.webkitMaskImage).toContain("linear-gradient");
  expect(label.textContent).toBe(LONG_VERSION);

  // The full version is one hover away.
  await userEvent.hover(label);
  await expect.poll(tooltipText).toBe(LONG_VERSION);
});

it("lets the keyboard reach a clipped version's full text", async () => {
  renderLabel("90px", LONG_VERSION);
  const label = await measuredLabel();

  expect(label.tabIndex).toBe(0);
  await userEvent.tab();
  expect(document.activeElement).toBe(label);
  await expect.poll(tooltipText).toBe(LONG_VERSION);
});

it("leaves a version that fits untouched", async () => {
  renderLabel("400px", "v1.2.3");
  const label = await measuredLabel();

  expect(label.dataset.overflowing).toBe("false");
  expect(label.hasAttribute("tabindex")).toBe(false);
  const style = getComputedStyle(label);
  expect(style.maskImage || style.webkitMaskImage || "none").toBe("none");

  // Well past the tooltip's hover delay, on a controlled clock.
  vi.useFakeTimers();
  await userEvent.hover(label);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
});

it("starts fading when the row narrows and stops when it widens", async () => {
  renderLabel("400px", LONG_VERSION);
  const label = await measuredLabel();
  expect(label.dataset.overflowing).toBe("false");

  host!.style.width = "80px";
  await expect.poll(() => label.dataset.overflowing).toBe("true");

  host!.style.width = "400px";
  await expect.poll(() => label.dataset.overflowing).toBe("false");
});

it("measures a new version even when the label keeps its width", async () => {
  // A full-width label: a longer version changes what overflows, not its box.
  renderLabel("90px", "v1.2.3", "w-full text-xs");
  const label = await measuredLabel();
  expect(label.dataset.overflowing).toBe("false");

  root!.render(<ProviderVersionLabel version={LONG_VERSION} className="w-full text-xs" />);

  await expect.poll(() => label.dataset.overflowing).toBe("true");
});
