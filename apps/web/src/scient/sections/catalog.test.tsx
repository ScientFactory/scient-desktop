import { EnvironmentId, ThreadSectionId, type ThreadSection } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("../../rpc/atomRegistry");
  return { useAtomValue: (atom: never) => appAtomRegistry.get(atom) };
});
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const environmentServerConfigsAtom = Atom.make(new Map<string, unknown>());
  return {
    environmentServerConfigsAtom,
    serverEnvironment: {
      updateSettings: {},
      settingsValueAtom: (environmentId: string) =>
        Atom.make(
          (get) =>
            (get(environmentServerConfigsAtom).get(environmentId) as ConfigLike | undefined)
              ?.settings ?? null,
        ),
    },
  };
});
vi.mock("../../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make<string | null>("primary") };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { environmentServerConfigsAtom } from "../../state/server";
import { sectionCatalogsAtom, useThreadSectionCatalogs } from "./catalog";

type Settings = { threadSections: ThreadSection[]; threadSectionsGeneralIndex: number };
type ConfigLike = {
  environment: { capabilities: { threadSections?: boolean } };
  settings: Settings;
};

const PRIMARY = EnvironmentId.make("primary");
const REMOTE = EnvironmentId.make("remote");

const research: ThreadSection = {
  id: ThreadSectionId.make("research"),
  name: "Research",
  order: 0,
};
const field: ThreadSection = { id: ThreadSectionId.make("field"), name: "Field", order: 0 };

function config(sections: ThreadSection[], threadSections = true): ConfigLike {
  return {
    environment: { capabilities: { threadSections } },
    settings: { threadSections: sections, threadSectionsGeneralIndex: 0 },
  };
}

function setConfigs(entries: ReadonlyArray<readonly [string, ConfigLike]>) {
  appAtomRegistry.set(environmentServerConfigsAtom as never, new Map(entries) as never);
}

let catalogs: ReturnType<typeof useThreadSectionCatalogs>;
let renderer: ReactTestRenderer;
function Probe() {
  const value = useThreadSectionCatalogs();
  useLayoutEffect(() => {
    catalogs = value;
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appAtomRegistry.set(primaryEnvironmentIdAtom as never, "primary" as never);
  setConfigs([
    ["primary", config([research])],
    ["remote", config([field])],
  ]);
  mocks.update.mockReset();
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

/** Resolves like the server: applies the patch to that environment's stored settings. */
function serverAcceptsWrites() {
  mocks.update.mockImplementation(
    async ({ environmentId, input }: { environmentId: string; input: { patch: Settings } }) => {
      const configs = appAtomRegistry.get(environmentServerConfigsAtom) as unknown as Map<
        string,
        ConfigLike
      >;
      const stored = configs.get(environmentId)!.settings;
      return AsyncResult.success({
        threadSections: input.patch.threadSections ?? stored.threadSections,
        threadSectionsGeneralIndex:
          input.patch.threadSectionsGeneralIndex ?? stored.threadSectionsGeneralIndex,
      });
    },
  );
}

it("lists each environment that stores sections, primary first", () => {
  setConfigs([
    ["remote", config([field])],
    ["old", config([], false)],
    ["primary", config([research])],
  ]);
  const listed = appAtomRegistry.get(sectionCatalogsAtom);
  expect(listed.map((catalog) => catalog.environmentId)).toEqual(["primary", "remote"]);
  expect(listed[1]!.sections).toEqual([field]);
});

it("keeps a catalog's identity while its stored sections are unchanged", () => {
  const sections = [research];
  setConfigs([["primary", config(sections)]]);
  const first = appAtomRegistry.get(sectionCatalogsAtom)[0];
  setConfigs([["primary", config(sections)]]);
  expect(appAtomRegistry.get(sectionCatalogsAtom)[0]).toBe(first);
});

it("lists catalogs without a primary environment, as the hosted app does", () => {
  appAtomRegistry.set(primaryEnvironmentIdAtom as never, null as never);
  setConfigs([["remote", config([field])]]);
  expect(appAtomRegistry.get(sectionCatalogsAtom).map((catalog) => catalog.environmentId)).toEqual([
    "remote",
  ]);
});

it("creates a section on its own environment and never writes the primary", async () => {
  serverAcceptsWrites();
  const created = await catalogs.create(REMOTE, "notes");
  expect(created?.name).toBe("Notes");
  expect(mocks.update).toHaveBeenCalledTimes(1);
  const request = mocks.update.mock.calls[0]![0];
  expect(request.environmentId).toBe(REMOTE);
  expect(request.input.patch.threadSections.map((section: ThreadSection) => section.name)).toEqual([
    "Field",
    "Notes",
  ]);
  expect(request.input.patch.threadSectionsExpected.threadSections).toEqual([field]);
});

it("renames and removes by environment and section id", async () => {
  serverAcceptsWrites();
  const renamed = await catalogs.rename({ environmentId: REMOTE, sectionId: "field" }, "Lab");
  expect(renamed?.kind).toBe("renamed");
  expect(mocks.update.mock.calls[0]![0].environmentId).toBe(REMOTE);
  const removed = await catalogs.remove({ environmentId: PRIMARY, sectionId: "research" });
  expect(removed?.section.id).toBe("research");
  expect(mocks.update.mock.calls[1]![0].environmentId).toBe(PRIMARY);
});

it("does not resolve a section id against another environment's catalog", async () => {
  // Research is on the primary; the remote has no section of that id.
  mocks.update.mockResolvedValue(
    AsyncResult.success({ threadSections: [field], threadSectionsGeneralIndex: 0 }),
  );
  const result = await catalogs.rename({ environmentId: REMOTE, sectionId: "research" }, "Lab");
  expect(result).toEqual({ kind: "missing" });
  // Only the confirming write, which changes nothing on the remote.
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(mocks.update.mock.calls[0]![0].environmentId).toBe(REMOTE);
  expect(mocks.update.mock.calls[0]![0].input.patch.threadSections).toEqual([field]);
});

it("marks a section occupied without a write once it is recorded", async () => {
  setConfigs([["remote", config([{ ...field, environmentIds: ["remote"] }])]]);
  expect(await catalogs.markOccupied({ environmentId: REMOTE, sectionId: "field" })).toBe(true);
  expect(mocks.update).not.toHaveBeenCalled();
});

it("clears an old empty stamp on the section's own environment when a thread is filed", async () => {
  setConfigs([
    ["primary", config([research])],
    ["remote", config([{ ...field, emptySince: "2020-01-01T00:00:00.000Z" }])],
  ]);
  serverAcceptsWrites();
  expect(await catalogs.markOccupied({ environmentId: REMOTE, sectionId: "field" })).toBe(true);
  const request = mocks.update.mock.calls[0]![0];
  expect(request.environmentId).toBe(REMOTE);
  expect(request.input.patch.threadSections).toEqual([{ ...field, environmentIds: ["remote"] }]);
});

it("marks a section created a moment ago, before this client's copy shows it", async () => {
  const fresh: ThreadSection = { id: ThreadSectionId.make("fresh"), name: "Fresh", order: 1 };
  const onServer = { threadSections: [field, fresh], threadSectionsGeneralIndex: 0 };
  mocks.update.mockImplementation(async ({ input }) => {
    if (input.patch.threadSectionsExpected.threadSections.length === 2) {
      onServer.threadSections = input.patch.threadSections;
    }
    return AsyncResult.success(onServer);
  });
  expect(await catalogs.markOccupied({ environmentId: REMOTE, sectionId: "fresh" })).toBe(true);
  expect(onServer.threadSections.find((entry) => entry.id === "fresh")?.environmentIds).toEqual([
    "remote",
  ]);
});

it("reports a section the server confirms is gone", async () => {
  mocks.update.mockResolvedValue(
    AsyncResult.success({ threadSections: [field], threadSectionsGeneralIndex: 0 }),
  );
  expect(await catalogs.markOccupied({ environmentId: REMOTE, sectionId: "deleted" })).toBe(false);
  expect(mocks.update).toHaveBeenCalledTimes(1);
});

it("refuses writes to an environment that stores no sections", async () => {
  setConfigs([
    ["primary", config([research])],
    ["old", config([], false)],
  ]);
  expect(await catalogs.create(EnvironmentId.make("old"), "Notes")).toBeNull();
  expect(mocks.update).not.toHaveBeenCalled();
});

it("runs each environment's writes independently", async () => {
  let resolvePrimary!: (value: unknown) => void;
  mocks.update.mockImplementation(({ environmentId }: { environmentId: string }) =>
    environmentId === "primary"
      ? new Promise((resolve) => {
          resolvePrimary = resolve;
        })
      : Promise.resolve(
          AsyncResult.success({
            threadSections: [{ ...field, name: "Lab" }],
            threadSectionsGeneralIndex: 0,
          }),
        ),
  );
  const primaryWrite = catalogs.rename({ environmentId: PRIMARY, sectionId: "research" }, "Papers");
  const remoteWrite = catalogs.rename({ environmentId: REMOTE, sectionId: "field" }, "Lab");
  expect((await remoteWrite)?.kind).toBe("renamed");
  resolvePrimary(
    AsyncResult.success({
      threadSections: [{ ...research, name: "Papers" }],
      threadSectionsGeneralIndex: 0,
    }),
  );
  expect((await primaryWrite)?.kind).toBe("renamed");
});

it("cancels a cleanup queued behind another catalog write when its snapshot becomes stale", async () => {
  setConfigs([["primary", config([{ ...research, emptySince: "2020-01-01T00:00:00.000Z" }])]]);
  let resolve!: (value: unknown) => void;
  mocks.update.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const rename = catalogs.rename({ environmentId: PRIMARY, sectionId: "research" }, "Renamed");
  let current = true;
  const sweep = catalogs.sweepEmpty(PRIMARY, {
    occupancy: new Map(),
    judge: true,
    afterDays: 1,
    isCurrent: () => current,
  });
  await Promise.resolve();
  current = false;
  resolve(
    AsyncResult.success({
      threadSections: [{ ...research, name: "Renamed", emptySince: "2020-01-01T00:00:00.000Z" }],
      threadSectionsGeneralIndex: 0,
    }),
  );
  await rename;
  expect(await sweep).toEqual([]);
  expect(mocks.update).toHaveBeenCalledTimes(1);
});
