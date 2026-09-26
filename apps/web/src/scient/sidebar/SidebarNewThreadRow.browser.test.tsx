import "../../index.css";

import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

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

it("replaces the header's New thread icon with a labelled row below search", async () => {
  const onNewThread = vi.fn();
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
          disabled={false}
          shortcutLabel="⌘N"
          inProjectShortcutLabel={null}
          showInProjectHint={false}
        />
      </div>
    </SidebarProvider>,
  );
  await nextFrame();

  // The header's icon stays in the DOM but takes no space and cannot be reached.
  const headerIcon = host.querySelector<HTMLElement>('button[aria-label="New thread"]')!;
  expect(headerIcon.hidden).toBe(true);
  expect(getComputedStyle(headerIcon).display).toBe("none");

  const row = host.querySelector<HTMLElement>('[data-testid="sidebar-new-thread-row"]')!;
  expect(row.textContent).toBe("New thread");
  const rect = row.getBoundingClientRect();
  expect(rect.height).toBe(32);
  expect(rect.width).toBeGreaterThan(200);
  // Its icon takes the sidebar's shared icon size.
  const icon = row.querySelector("svg")!.getBoundingClientRect();
  expect([icon.width, icon.height]).toEqual([16, 16]);

  row.click();
  expect(onNewThread).toHaveBeenCalledTimes(1);
});
