import "../../index.css";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vitest/browser";
import { AuthoringKeybindingsSettings } from "./AuthoringKeybindingsSettings";
import { reloadKeyboardPreferences } from "./preferences";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function renderSettings(scope: "math" | "pdf") {
  localStorage.clear();
  reloadKeyboardPreferences();
  host = document.createElement("div");
  host.className = "mx-auto w-full max-w-[900px]";
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <AuthoringKeybindingsSettings
      scope={scope}
      query={scope === "math" ? "math.symbol.alpha" : ""}
    />,
  );
}

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  localStorage.clear();
  reloadKeyboardPreferences();
});

function bounds(element: Element): DOMRect {
  const rect = element.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  return rect;
}

function expectInsideViewport(rect: DOMRect) {
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
}

function expectHorizontallyInside(child: DOMRect, parent: DOMRect) {
  expect(child.left).toBeGreaterThanOrEqual(parent.left - 2);
  expect(child.right).toBeLessThanOrEqual(parent.right + 2);
}

it.each([1280, 700, 390])("keeps Math menus inside their card at %ipx", async (width) => {
  await page.viewport(width, 800);
  renderSettings("math");
  await page.getByRole("button", { name: "Math input behavior and preset" }).click();
  await document.fonts.ready;
  expect(document.querySelector("#math-input-behavior")).not.toBeNull();

  const card = document
    .querySelector("#math-input-behavior")!
    .closest("[data-slot=popover-popup]")!;
  const cardRect = bounds(card);
  expectInsideViewport(cardRect);
  for (const control of card.querySelectorAll("button")) {
    expectHorizontallyInside(bounds(control), cardRect);
  }

  for (const name of [
    "Math shortcut preset",
    "Math command completion",
    "Shortcut sequence timeout",
  ]) {
    await page.getByRole("combobox", { name }).click();
    await expect.element(page.getByRole("listbox")).toBeVisible();
    const menu = [...document.querySelectorAll("[data-slot=select-popup]")].find(
      (candidate) => candidate.getBoundingClientRect().width > 0,
    );
    expect(menu).toBeTruthy();
    const menuRect = bounds(menu!);
    expectInsideViewport(menuRect);
    // These menus are intentionally wider than their triggers, but must not
    // spill out of the surrounding Math card as they did before.
    expectHorizontallyInside(menuRect, cardRect);
    await page.getByRole("option").first().click();
  }
});

it.each([1280, 700, 390])("anchors Restore confirmation to its button at %ipx", async (width) => {
  await page.viewport(width, 800);
  renderSettings("pdf");
  const trigger = page.getByRole("button", { name: "Restore defaults" });
  await trigger.click();
  await document.fonts.ready;
  expect(
    document.querySelector(
      '[data-slot="popover-popup"][aria-label="Restore document shortcut defaults"]',
    ),
  ).not.toBeNull();

  const triggerRect = bounds(
    document.querySelector('[data-slot="popover-trigger"][aria-expanded="true"]')!,
  );
  const popupRect = bounds(
    document.querySelector(
      '[data-slot="popover-popup"][aria-label="Restore document shortcut defaults"]',
    )!,
  );
  expectInsideViewport(popupRect);
  for (const control of document.querySelectorAll(
    '[data-slot="popover-popup"][aria-label="Restore document shortcut defaults"] button',
  )) {
    expectHorizontallyInside(bounds(control), popupRect);
  }
  expect(Math.abs(popupRect.right - triggerRect.right)).toBeLessThanOrEqual(16);
  expect(popupRect.top).toBeGreaterThanOrEqual(triggerRect.bottom - 2);
});
