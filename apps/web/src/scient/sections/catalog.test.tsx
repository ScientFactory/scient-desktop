import { ThreadSectionId, type ThreadSection } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { threadSections: [] as ThreadSection[], threadSectionsGeneralIndex: 0 },
  update: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    new Map([["primary", { environment: { capabilities: { threadSections: true } } }]]),
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: typeof mocks.settings) => unknown) =>
    select(mocks.settings),
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => mocks.settings } }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: {},
  serverEnvironment: { updateSettings: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));

import { useThreadSectionCatalog } from "./catalog";

const research: ThreadSection = {
  id: ThreadSectionId.make("research"),
  name: "Research",
  order: 0,
  environmentIds: ["primary"],
};
let catalog: ReturnType<typeof useThreadSectionCatalog>;
let renderer: ReactTestRenderer;
function Probe() {
  const value = useThreadSectionCatalog();
  useLayoutEffect(() => {
    catalog = value;
  });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.settings = { threadSections: [research], threadSectionsGeneralIndex: 0 };
  mocks.update.mockReset();
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("only acknowledges registration for an existing section, even when no write is needed", async () => {
  expect(await catalog.recordEnvironments(research.id, ["primary"])).toBe(true);
  expect(await catalog.recordEnvironments("deleted", ["remote"])).toBe(false);
  expect(mocks.update).not.toHaveBeenCalled();
});

it("rejects registration if the section disappears during a catalog conflict", async () => {
  mocks.update.mockResolvedValue(
    AsyncResult.success({ threadSections: [], threadSectionsGeneralIndex: 0 }),
  );
  expect(await catalog.recordEnvironments(research.id, ["remote"])).toBe(false);
  expect(mocks.update).toHaveBeenCalledTimes(1);
});

it("rejects registration after repeated catalog conflicts", async () => {
  mocks.update.mockResolvedValue(AsyncResult.success(mocks.settings));
  expect(await catalog.recordEnvironments(research.id, ["remote"])).toBe(false);
  expect(mocks.update).toHaveBeenCalledTimes(3);
});

it("cancels a cleanup queued behind another catalog write when its snapshot becomes stale", async () => {
  mocks.settings.threadSections = [{ ...research, emptySince: "2020-01-01T00:00:00.000Z" }];
  let resolve!: (value: AsyncResult.Success<typeof mocks.settings>) => void;
  const pending = new Promise<AsyncResult.Success<typeof mocks.settings>>((done) => {
    resolve = done;
  });
  mocks.update.mockReturnValue(pending);
  const rename = catalog.rename(research.id, "Renamed");
  let current = true;
  const sweep = catalog.sweepEmpty({
    occupancy: new Map(),
    visibleEnvironmentIds: new Set(["primary"]),
    afterDays: 1,
    isCurrent: () => current,
  });
  await Promise.resolve();
  current = false;
  resolve(
    AsyncResult.success({
      threadSections: [{ ...mocks.settings.threadSections[0]!, name: "Renamed" }],
      threadSectionsGeneralIndex: 0,
    }),
  );
  await rename;
  expect(await sweep).toEqual([]);
  expect(mocks.update).toHaveBeenCalledTimes(1);
});
