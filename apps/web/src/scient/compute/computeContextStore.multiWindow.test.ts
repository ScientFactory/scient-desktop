import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  openAppWindow,
  sharedLocalStorage,
  type SharedLocalStorage,
} from "../../../test/scientAppWindows";

const STORAGE_KEY = "scient:compute-context-bindings:v1";
const environmentId = EnvironmentId.make("environment-1");

async function openComputeWindow(storage: SharedLocalStorage) {
  const appWindow = await openAppWindow(storage, () => import("./computeContextStore"));
  const { module } = appWindow;
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
    receiveStorageEvent: () => appWindow.receiveStorageEvent(STORAGE_KEY),
    [Symbol.dispose]: appWindow[Symbol.dispose],
  };
}

function storedContextIds(storage: SharedLocalStorage): string[] {
  const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as {
    state?: { bindings?: Record<string, unknown> };
  };
  return Object.keys(persisted.state?.bindings ?? {}).toSorted();
}

describe("compute context bindings across app windows", () => {
  it("keeps bindings another window saved and adopts its additions and removals", async () => {
    const storage = sharedLocalStorage();
    using first = await openComputeWindow(storage);
    using second = await openComputeWindow(storage);

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
