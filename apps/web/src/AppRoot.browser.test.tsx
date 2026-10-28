import { createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../test/render";
import { appAtomRegistry } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { AppRoot } from "./AppRoot";

const { state, makeProbe } = vi.hoisted(() => {
  const state = {
    atom: undefined as Atom.Writable<string> | undefined,
    registries: new Map<string, unknown>(),
    values: new Map<string, string>(),
    mounted: [] as string[],
    unmounted: [] as string[],
  };
  return {
    state,
    makeProbe: async (name: string) => {
      const { RegistryContext, useAtomValue } = await import("@effect/atom-react");
      const { use, useEffect } = await import("react");
      return function RegistryProbe() {
        state.registries.set(name, use(RegistryContext));
        state.values.set(name, useAtomValue(state.atom!));
        useEffect(() => {
          state.mounted.push(name);
          return () => {
            state.unmounted.push(name);
          };
        }, []);
        return null;
      };
    },
  };
});

// Native hosts are controlled boundaries; the root, router, registry and React
// subscriptions remain real.
vi.mock(import("./browser/ElectronBrowserHost"), async () => ({
  ElectronBrowserHost: await makeProbe("electron-browser"),
}));
vi.mock(import("./components/QuitHoldOverlay"), async () => ({
  QuitHoldOverlay: await makeProbe("quit-hold"),
}));
vi.mock(import("./scient/documentExport/HtmlPdfLifecycleHost"), async () => {
  const Probe = await makeProbe("html-pdf");
  return { HtmlPdfLifecycleHost: () => <Probe /> };
});
// SCIENT-FORK:START — the editor flush hosts, like the other hosts, are probes here.
vi.mock(import("./scient/editorFlush/EditorFlushHosts"), async () => {
  const Probe = await makeProbe("editor-flush");
  return { EditorFlushHosts: () => <Probe /> };
});
// SCIENT-FORK:END

function setup() {
  state.atom = Atom.make("initial");
  state.registries.clear();
  state.values.clear();
  state.mounted.length = 0;
  state.unmounted.length = 0;
  return state.atom;
}

describe("AppRoot", () => {
  it("shares the application atom registry with routed UI and renderer-wide desktop hosts", async () => {
    const atom = setup();
    const router = createRouter({
      routeTree: createRootRoute({ component: await makeProbe("route") }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      disableGlobalCatchBoundary: true,
    });
    await router.load();
    await using screen = await render(<AppRoot router={router as unknown as AppRouter} />, {
      router: false,
    });
    const hosts = ["route", "html-pdf", "electron-browser", "quit-hold"];
    // SCIENT-FORK:START — the editor flush hosts share the app registry too.
    hosts.push("editor-flush");
    // SCIENT-FORK:END
    expect([...state.registries.keys()].sort()).toEqual([...hosts].sort());
    for (const registry of state.registries.values()) expect(registry).toBe(appAtomRegistry);
    expect([...state.values.values()]).toEqual(hosts.map(() => "initial"));

    await act(async () => {
      router.history.push("/?view=second");
      await router.load();
      appAtomRegistry.set(atom, "updated");
    });
    expect([...state.values.values()]).toEqual(hosts.map(() => "updated"));
    expect([...state.mounted].sort()).toEqual([...hosts].sort());

    await screen.unmount();
    expect([...state.unmounted].sort()).toEqual([...hosts].sort());
  });
});
