import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

import { SidebarProvider } from "../../components/ui/sidebar";
import { SidebarSectionsToggle } from "./SidebarSectionsToggle";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

/** The computed color of a sidebar token, read off a probe element. */
function tokenColor(_fixture: _Fixture, className: string): string {
  const probe = document.createElement("div");
  probe.className = className;
  _fixture.host!.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

it("marks the on state with a small gray inset that the white hover surrounds", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(
    <SidebarProvider>
      <SidebarSectionsToggle active onActiveChange={() => {}} />
    </SidebarProvider>,
  );
  await vi.waitFor(() =>
    expect(_fixture.host!.querySelector('[data-testid="sidebar-sections-toggle"]')).not.toBeNull(),
  );

  const button = _fixture.host.querySelector<HTMLElement>(
    '[data-testid="sidebar-sections-toggle"]',
  )!;
  await userEvent.unhover(button);
  const mark = button.querySelector<HTMLElement>("span.absolute")!;
  const gray = tokenColor(_fixture, "bg-sidebar-foreground/6");
  expect(gray).not.toBe(tokenColor(_fixture, "bg-sidebar-row-selected"));

  // At rest: the gray mark, inset inside the button.
  expect(getComputedStyle(mark).backgroundColor).toBe(gray);
  expect(mark.getBoundingClientRect().width).toBe(button.getBoundingClientRect().width - 6);
  expect(getComputedStyle(button).backgroundColor).toBe("rgba(0, 0, 0, 0)");

  // On hover: the full-size white fill around the gray mark, which stays.
  await userEvent.hover(button);
  expect(getComputedStyle(mark).display).not.toBe("none");
  expect(getComputedStyle(mark).backgroundColor).toBe(gray);
  expect(getComputedStyle(button).backgroundColor).toBe(
    tokenColor(_fixture, "bg-sidebar-row-hover"),
  );
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
