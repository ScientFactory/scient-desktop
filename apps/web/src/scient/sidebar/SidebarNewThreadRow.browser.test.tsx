import "../../index.css";

import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

import { SidebarThreadHeader } from "../../components/sidebar/SidebarThreadHeader";
import { SidebarProvider } from "../../components/ui/sidebar";
import { SidebarNewThreadRow } from "./SidebarNewThreadRow";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 16)));

/** The sidebar's top: T3's header (search, toggles) and Scient's New thread row. */
async function mountSidebarTop(onNewThread: () => void) {
  host = document.createElement("div");
  host.style.width = "280px";
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <SidebarProvider>
      <div style={{ width: 280 }}>
        <SidebarThreadHeader
          hideNewThreadButton
          hasProjects={false}
          projectScope={null}
          onNewProject={() => {}}
          onNewThread={onNewThread}
          newThreadDisabled={false}
          newThreadShortcutLabel="⌘N"
          newThreadInProjectShortcutLabel={null}
          showNewThreadInProjectHint={false}
          searchInputRef={createRef<HTMLInputElement>()}
          searchQuery=""
          onSearchQueryChange={() => {}}
          onSearchKeyDown={() => {}}
          isSearching={false}
          searchResultCount={0}
          activeSearchResultIndex={0}
          onClearSearch={() => {}}
        />
        <SidebarNewThreadRow
          onNewThread={onNewThread}
          shortcutLabel="⌘N"
          inProjectShortcutLabel={null}
          showInProjectHint={false}
        />
      </div>
    </SidebarProvider>,
  );
  await nextFrame();
  return host;
}

it("replaces the header's New thread icon with a labelled row below search", async () => {
  const onNewThread = vi.fn();
  const host = await mountSidebarTop(onNewThread);

  // The header's icon stays in the DOM but takes no space and cannot be reached.
  const headerIcon = host.querySelector<HTMLElement>('button[aria-label="New thread"]')!;
  expect(headerIcon.hidden).toBe(true);
  expect(getComputedStyle(headerIcon).display).toBe("none");

  const row = host.querySelector<HTMLElement>('[data-testid="sidebar-new-thread-row"]')!;
  expect(row.textContent).toBe("New thread");
  const rect = row.getBoundingClientRect();
  expect(rect.height).toBe(32);
  expect(rect.width).toBeGreaterThan(200);
  // It sits a small gap below the search row, one size step below thread titles.
  const header = row.parentElement!.previousElementSibling!.getBoundingClientRect();
  expect(rect.top - header.bottom).toBe(6);
  const icon = row.querySelector("svg")!.getBoundingClientRect();
  expect([icon.width, icon.height]).toEqual([14, 14]);
  expect(getComputedStyle(row.querySelector("span")!).fontSize).toBe("13px");

  row.click();
  expect(onNewThread).toHaveBeenCalledTimes(1);
});

it("keeps the search icon and placeholder at the icon color until hovered", async () => {
  const host = await mountSidebarTop(() => {});
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search threads"]')!;
  const field = input.closest<HTMLElement>("div.rounded-md")!;
  await userEvent.unhover(field);
  const icon = field.querySelector("svg")!;
  const placeholderColor = () => getComputedStyle(input, "::placeholder").color;
  const iconColor = () => getComputedStyle(icon).color;
  const newThreadIconColor = getComputedStyle(
    host.querySelector('[data-testid="sidebar-new-thread-row"] svg')!,
  ).color;

  // At rest, and while focused without the pointer over it, both match the
  // sidebar's other icons.
  expect(iconColor()).toBe(newThreadIconColor);
  expect(placeholderColor()).toBe(newThreadIconColor);
  input.focus();
  expect(placeholderColor()).toBe(newThreadIconColor);

  // Hovering strengthens both to the typed text's color.
  await userEvent.hover(field);
  const strong = getComputedStyle(input).color;
  expect(strong).not.toBe(newThreadIconColor);
  expect(iconColor()).toBe(strong);
  expect(placeholderColor()).toBe(strong);

  await userEvent.unhover(field);
  expect(placeholderColor()).toBe(newThreadIconColor);
});
