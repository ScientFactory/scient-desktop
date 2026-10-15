import {
  EnvironmentId,
  ThreadId,
  type ThreadSection,
  threadSectionCatalogsEqual,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// DF-042 end to end: the real catalogs and membership actions, with only the
// server boundary faked. The local settings copy never catches up during the
// test, like a settings stream that lands after the write resolves.
type Stored = { threadSections: ThreadSection[]; threadSectionsGeneralIndex: number };
const mocks = vi.hoisted(() => ({
  updateSettingsCommand: { command: "update-settings" },
  setSectionCommand: { command: "set-section" },
  servers: new Map<string, Stored>(),
  membership: new Map<string, { environmentId: string; sectionId: string | null }>(),
}));
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
  const empty = { threadSections: [], threadSectionsGeneralIndex: 0 };
  const config = { environment: { capabilities: { threadSections: true } }, settings: empty };
  const environmentServerConfigsAtom = Atom.make(
    new Map([
      ["primary", config],
      ["remote", config],
    ]),
  );
  return {
    environmentServerConfigsAtom,
    serverEnvironment: {
      updateSettings: mocks.updateSettingsCommand,
      settingsValueAtom: () => Atom.make(() => empty),
    },
  };
});
vi.mock("../../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(() => "primary") };
});
vi.mock("../../state/threads", () => ({
  threadEnvironment: { setSection: mocks.setSectionCommand },
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: (ref: { threadId: string }) => ({
    projectId: "project-a",
    sectionId: mocks.membership.get(ref.threadId)?.sectionId ?? null,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.updateSettingsCommand
      ? async ({ environmentId, input }: { environmentId: string; input: { patch: never } }) => {
          const patch = input.patch as Stored & { threadSectionsExpected: Stored };
          const stored = mocks.servers.get(environmentId)!;
          const expected = patch.threadSectionsExpected;
          if (
            expected.threadSectionsGeneralIndex === stored.threadSectionsGeneralIndex &&
            threadSectionCatalogsEqual(expected.threadSections, stored.threadSections)
          ) {
            mocks.servers.set(environmentId, {
              threadSections: patch.threadSections,
              threadSectionsGeneralIndex: patch.threadSectionsGeneralIndex,
            });
          }
          return AsyncResult.success(mocks.servers.get(environmentId)!);
        }
      : async ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: { threadId: string; sectionId: string | null };
        }) => {
          mocks.membership.set(input.threadId, { environmentId, sectionId: input.sectionId });
          return AsyncResult.success(undefined);
        },
}));
vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("../../hooks/showThreadUndoNotice", () => ({ showThreadUndoNotice: vi.fn() }));

import { toastManager } from "../../components/ui/toast";
import { useThreadSectionActions } from "./actions";
import { useThreadSectionCatalogs } from "./catalog";
import { createSectionAndFile } from "./useNewSectionForThreads";

let hooks: {
  readonly catalogs: ReturnType<typeof useThreadSectionCatalogs>;
  readonly actions: ReturnType<typeof useThreadSectionActions>;
};
let renderer: ReactTestRenderer;
function Probe() {
  const catalogs = useThreadSectionCatalogs();
  const actions = useThreadSectionActions();
  useLayoutEffect(() => {
    hooks = { catalogs, actions };
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.servers.set("primary", { threadSections: [], threadSectionsGeneralIndex: 0 });
  mocks.servers.set("remote", { threadSections: [], threadSectionsGeneralIndex: 0 });
  mocks.membership.clear();
  vi.mocked(toastManager.add).mockClear();
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

const ref = (environmentId: string, threadId: string) => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});

it("files a thread into a section created a moment earlier on its own environment", async () => {
  const thread = ref("remote", "t1");
  const result = await createSectionAndFile({
    name: "Design",
    threadRefs: [thread],
    scopeProjectRefs: [{ environmentId: "primary", projectId: "project-a" }],
    environmentId: null,
    create: hooks.catalogs.create,
    moveThreadsToSection: hooks.actions.moveThreadsToSection,
  });
  expect(result.failedEnvironmentIds).toEqual([]);
  const [created] = result.created;
  expect(created?.environmentId).toBe("remote");
  expect(mocks.membership.get("t1")).toEqual({
    environmentId: "remote",
    sectionId: created!.section.id,
  });
  // The section lives on the thread's environment; the primary is untouched.
  expect(mocks.servers.get("primary")!.threadSections).toEqual([]);
  expect(mocks.servers.get("remote")!.threadSections).toEqual([
    expect.objectContaining({
      id: created!.section.id,
      environmentIds: ["remote"],
      // Only this environment's projects: the selected project is on the primary.
      createdInProjects: [{ environmentId: "remote", projectId: "project-a" }],
    }),
  ]);
  expect(toastManager.add).not.toHaveBeenCalled();
});

it("gives threads on two environments a section of that name on each", async () => {
  const result = await createSectionAndFile({
    name: "Design",
    threadRefs: [ref("primary", "t1"), ref("remote", "t2")],
    scopeProjectRefs: null,
    environmentId: null,
    create: hooks.catalogs.create,
    moveThreadsToSection: hooks.actions.moveThreadsToSection,
  });
  expect(result.created.map((entry) => entry.environmentId).toSorted()).toEqual([
    "primary",
    "remote",
  ]);
  for (const [threadId, environmentId] of [
    ["t1", "primary"],
    ["t2", "remote"],
  ] as const) {
    const stored = mocks.servers.get(environmentId)!.threadSections;
    expect(stored.map((section) => section.name)).toEqual(["Design"]);
    expect(mocks.membership.get(threadId)).toEqual({ environmentId, sectionId: stored[0]!.id });
  }
});

it("creates an empty section on the chosen environment", async () => {
  const result = await createSectionAndFile({
    name: "Later",
    threadRefs: [],
    scopeProjectRefs: null,
    environmentId: EnvironmentId.make("remote"),
    create: hooks.catalogs.create,
    moveThreadsToSection: hooks.actions.moveThreadsToSection,
  });
  expect(result.created.map((entry) => entry.environmentId)).toEqual(["remote"]);
  const [later] = mocks.servers.get("remote")!.threadSections;
  expect(later?.name).toBe("Later");
  // Nothing holds it yet, so no environment is recorded.
  expect(later?.environmentIds).toBeUndefined();
  expect(mocks.servers.get("primary")!.threadSections).toEqual([]);
});
