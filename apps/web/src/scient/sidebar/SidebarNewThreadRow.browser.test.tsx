import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { createRef } from "react";

import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

import { SidebarThreadHeader } from "../../components/sidebar/SidebarThreadHeader";
import { SidebarProvider } from "../../components/ui/sidebar";
import { SidebarNewThreadRow } from "./SidebarNewThreadRow";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

/** The sidebar's top: T3's header (search, toggles) and Scient's New thread row. */
async function mountSidebarTop(_fixture: _Fixture, onNewThread: () => void) {
  _fixture.host = document.createElement("div");
  _fixture.host.style.width = "280px";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(
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
  await vi.waitFor(() =>
    expect(_fixture.host!.querySelector('[data-testid="sidebar-new-thread-row"]')).not.toBeNull(),
  );
  return _fixture.host;
}

it("replaces the header's New thread icon with a labelled row below search", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const onNewThread = vi.fn();
  const host = await mountSidebarTop(_fixture, onNewThread);

  // The header's icon stays in the DOM but takes no space and cannot be reached.
  const headerIcon = host.querySelector<HTMLElement>('button[aria-label="New thread"]')!;
  expect(headerIcon.hidden).toBe(true);
  expect(getComputedStyle(headerIcon).display).toBe("none");

  const row = host.querySelector<HTMLElement>('[data-testid="sidebar-new-thread-row"]')!;
  expect(row.textContent).toBe("New thread");
  row.click();
  expect(onNewThread).toHaveBeenCalledTimes(1);
});

// regression: 2e4057fdda fix(sidebar): rest the search icon and placeholder at the icon color
it("keeps the search icon and placeholder at the icon color until hovered", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const host = await mountSidebarTop(_fixture, () => {});
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
