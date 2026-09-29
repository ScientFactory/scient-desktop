import "../../index.css";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { userEvent } from "vitest/browser";

import { SidebarProvider } from "../../components/ui/sidebar";
import { SidebarSectionsToggle } from "./SidebarSectionsToggle";

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

/** The computed color of a sidebar token, read off a probe element. */
function tokenColor(className: string): string {
  const probe = document.createElement("div");
  probe.className = className;
  host!.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

it("marks the on state with a small gray inset that the white hover surrounds", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <SidebarProvider>
      <SidebarSectionsToggle active onActiveChange={() => {}} />
    </SidebarProvider>,
  );
  await nextFrame();

  const button = host.querySelector<HTMLElement>('[data-testid="sidebar-sections-toggle"]')!;
  await userEvent.unhover(button);
  const mark = button.querySelector<HTMLElement>("span.absolute")!;
  const gray = tokenColor("bg-sidebar-foreground/6");
  expect(gray).not.toBe(tokenColor("bg-sidebar-row-selected"));

  // At rest: the gray mark, inset inside the button.
  expect(getComputedStyle(mark).backgroundColor).toBe(gray);
  expect(mark.getBoundingClientRect().width).toBe(button.getBoundingClientRect().width - 6);
  expect(getComputedStyle(button).backgroundColor).toBe("rgba(0, 0, 0, 0)");

  // On hover: the full-size white fill around the gray mark, which stays.
  await userEvent.hover(button);
  expect(getComputedStyle(mark).display).not.toBe("none");
  expect(getComputedStyle(mark).backgroundColor).toBe(gray);
  expect(getComputedStyle(button).backgroundColor).toBe(tokenColor("bg-sidebar-row-hover"));
});
