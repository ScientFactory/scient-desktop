import { createRoot, type Root } from "react-dom/client";
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
import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { useSettingsIntentPreload } from "./useSettingsIntentPreload";
import { SettingsRoutePending, SettingsRouteError } from "./SettingsRouteLoading";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
});

async function mount(failLoad = false) {
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
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(<RouterProvider router={router} />);
  await expect.element(page.getByText("General controls")).toBeVisible();
  return { release, router, requests: () => requests };
}

it.each(["pointer", "keyboard"])(
  "preloads on %s intent without changing the current page",
  async (intent) => {
    const fixture = await mount();
    const button = host!.querySelectorAll("button")[1]!;
    if (intent === "pointer")
      await userEvent.hover(page.getByRole("button", { name: "Providers", exact: true }));
    else button.focus();
    await expect.poll(fixture.requests).toBe(1);
    expect(host!.querySelector("main")!.textContent).toBe("General controls");
    fixture.release();
    await userEvent.click(page.getByRole("button", { name: "Providers", exact: true }));
    await expect.element(page.getByText("Provider controls")).toBeVisible();
  },
);

it("acknowledges direct keyboard navigation and ignores a late superseded destination", async () => {
  const fixture = await mount();
  // No hover or preload: the component stays unresolved until its receipt is released.
  const loading = fixture.router.navigate({ to: "/settings/providers", replace: true });
  await expect.element(page.getByRole("status")).toHaveTextContent("Loading settings…");
  expect(host!.querySelector("[data-destination]")!.textContent).toBe("/settings/providers");
  expect(host!.querySelector("main")!.textContent).not.toContain("General controls");
  await fixture.router.navigate({ to: "/settings/general", replace: true });
  fixture.release();
  await loading;
  await expect.element(page.getByText("General controls")).toBeVisible();
  expect(host!.querySelector("main")!.textContent).not.toContain("Provider controls");
});

it("keeps a preload failure on the current page and provides recovery after navigation", async () => {
  const fixture = await mount(true);
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
