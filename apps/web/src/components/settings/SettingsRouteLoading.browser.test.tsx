import { render as _fixtureRender, type Screen } from "../../../test/render";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { useSettingsIntentPreload } from "./useSettingsIntentPreload";
import { SettingsRoutePending, SettingsRouteError } from "./SettingsRouteLoading";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
}

async function mount(_fixture: _Fixture, failLoad = false) {
  let release!: () => void;
  let requests = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const providerComponent = lazyRouteComponent(async () => {
    requests++;
    await gate;
    if (failLoad) throw new Error("Synthetic chunk load failure");
    return { default: () => <p>Provider controls</p> };
  });
  function Shell() {
    const navigate = useNavigate();
    const preload = useSettingsIntentPreload();
    const pathname = useLocation({ select: (location) => location.pathname });
    return (
      <>
        <nav aria-label="Probe Settings">
          <button onClick={() => void navigate({ to: "/settings/general" })}>General</button>
          <button
            onMouseEnter={() => preload("/settings/providers")}
            onFocus={() => preload("/settings/providers")}
            onClick={() => void navigate({ to: "/settings/providers", replace: true })}
          >
            Providers
          </button>
          <span data-destination>{pathname}</span>
        </nav>
        <main>
          <Outlet />
        </main>
      </>
    );
  }
  const rootRoute = createRootRoute({ component: Shell });
  const general = createRoute({
    getParentRoute: () => rootRoute,
    path: "settings/general",
    component: () => <p>General controls</p>,
  });
  const providers = createRoute({
    getParentRoute: () => rootRoute,
    path: "settings/providers",
    component: providerComponent,
    pendingComponent: SettingsRoutePending,
    pendingMs: 80,
    pendingMinMs: 0,
    errorComponent: SettingsRouteError,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([general, providers]),
    history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
  });
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(<RouterProvider router={router} />);
  await expect.element(page.getByText("General controls")).toBeVisible();
  return { release, router, requests: () => requests };
}

// regression: 6a52b09f3a fix(settings): acknowledge navigation and avoid repeated setup
// (every case in this file).
it("preloads on pointer intent without changing the current page", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const fixture = await mount(_fixture);
  await userEvent.hover(page.getByRole("button", { name: "Providers", exact: true }));
  await expect.poll(fixture.requests).toBe(1);
  expect(_fixture.host!.querySelector("main")!.textContent).toBe("General controls");
  fixture.release();
  await userEvent.click(page.getByRole("button", { name: "Providers", exact: true }));
  await expect.element(page.getByText("Provider controls")).toBeVisible();
});

it("acknowledges direct keyboard navigation and ignores a late superseded destination", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const fixture = await mount(_fixture);
  // No hover or preload: the component stays unresolved until its receipt is released.
  const loading = fixture.router.navigate({ to: "/settings/providers", replace: true });
  await expect.element(page.getByRole("status")).toHaveTextContent("Loading settings…");
  expect(_fixture.host!.querySelector("[data-destination]")!.textContent).toBe(
    "/settings/providers",
  );
  expect(_fixture.host!.querySelector("main")!.textContent).not.toContain("General controls");
  await fixture.router.navigate({ to: "/settings/general", replace: true });
  fixture.release();
  await loading;
  await expect.element(page.getByText("General controls")).toBeVisible();
  expect(_fixture.host!.querySelector("main")!.textContent).not.toContain("Provider controls");
});

it("keeps a preload failure on the current page and provides recovery after navigation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const fixture = await mount(_fixture, true);
  await userEvent.hover(page.getByRole("button", { name: "Providers", exact: true }));
  await expect.poll(fixture.requests).toBe(1);
  fixture.release();
  await expect.element(page.getByText("General controls")).toBeVisible();
  await fixture.router.navigate({ to: "/settings/providers" });
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect
    .element(page.getByText("Couldn’t open this Settings page.", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Reload app", exact: true })).toBeVisible();
  await fixture.router.navigate({ to: "/settings/general" });
  await expect.element(page.getByText("General controls")).toBeVisible();
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
