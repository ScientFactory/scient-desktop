import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

const STORAGE_KEY = "scient:compute-context-bindings:v1";
const environmentId = EnvironmentId.make("environment-1");

function sharedLocalStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

async function openAppWindow(storage: ReturnType<typeof sharedLocalStorage>) {
  const appWindow = Object.assign(new EventTarget(), { localStorage: storage });
  vi.resetModules();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", appWindow);
  const module = await import("./computeContextStore");
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return {
    ensure: (id: string) =>
      module.ensureComputeContext({
        contextId: module.ComputeContextId.make(id),
        environmentId,
        cwd: "/project",
      }),
    remove: (id: string) =>
      module.useComputeContextStore.getState().removeContext(module.ComputeContextId.make(id)),
    contextIds: () => Object.keys(module.useComputeContextStore.getState().bindings).toSorted(),
    receiveStorageEvent: () =>
      appWindow.dispatchEvent(Object.assign(new Event("storage"), { key: STORAGE_KEY })),
  };
}

function storedContextIds(storage: ReturnType<typeof sharedLocalStorage>): string[] {
  const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as {
    state?: { bindings?: Record<string, unknown> };
  };
  return Object.keys(persisted.state?.bindings ?? {}).toSorted();
}

describe("compute context bindings across app windows", () => {
  it("keeps bindings another window saved and adopts its additions and removals", async () => {
    const storage = sharedLocalStorage();
    const first = await openAppWindow(storage);
    const second = await openAppWindow(storage);

    first.ensure("from-first");
    second.ensure("from-second");
    expect(storedContextIds(storage)).toEqual(["from-first", "from-second"]);

    second.receiveStorageEvent();
    expect(second.contextIds()).toEqual(["from-first", "from-second"]);

    first.receiveStorageEvent();
    first.remove("from-first");
    second.receiveStorageEvent();
    expect(second.contextIds()).toEqual(["from-second"]);
    expect(storedContextIds(storage)).toEqual(["from-second"]);
  });
});
