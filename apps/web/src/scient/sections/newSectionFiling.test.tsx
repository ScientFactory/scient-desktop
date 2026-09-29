import { EnvironmentId, ThreadId, type ThreadSection } from "@t3tools/contracts";
import { threadSectionCatalogsEqual } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// DF-042 end to end: the real catalog and membership actions, with only the
// server boundary faked. The local settings copy never catches up during the
// test, like a settings stream that lands after the write resolves.
const mocks = vi.hoisted(() => {
  const serverSettingsAtom = { atom: "primary-settings" };
  const serverConfigsAtom = { atom: "server-configs" };
  const updateSettingsCommand = { command: "update-settings" };
  const setSectionCommand = { command: "set-section" };
  return {
    serverSettingsAtom,
    serverConfigsAtom,
    updateSettingsCommand,
    setSectionCommand,
    localCopy: { threadSections: [] as ThreadSection[], threadSectionsGeneralIndex: 0 },
    server: { threadSections: [] as ThreadSection[], threadSectionsGeneralIndex: 0 },
    membership: new Map<string, string | null>(),
    configs: new Map([
      ["primary", { environment: { capabilities: { threadSections: true } } }],
      ["remote", { environment: { capabilities: { threadSections: true } } }],
    ]),
  };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.configs }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: typeof mocks.localCopy) => unknown) =>
    select(mocks.localCopy),
}));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => (atom === mocks.serverSettingsAtom ? mocks.localCopy : mocks.configs),
  },
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: mocks.serverConfigsAtom,
  primaryServerSettingsAtom: mocks.serverSettingsAtom,
  serverEnvironment: { updateSettings: mocks.updateSettingsCommand },
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { setSection: mocks.setSectionCommand },
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: (ref: { threadId: string }) => ({
    projectId: "project-a",
    sectionId: mocks.membership.get(ref.threadId) ?? null,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.updateSettingsCommand
      ? async ({ input }: { input: { patch: Record<string, never> } }) => {
          const patch = input.patch as unknown as {
            threadSections: ThreadSection[];
            threadSectionsGeneralIndex: number;
            threadSectionsExpected: typeof mocks.server;
          };
          const expected = patch.threadSectionsExpected;
          if (
            expected.threadSectionsGeneralIndex === mocks.server.threadSectionsGeneralIndex &&
            threadSectionCatalogsEqual(expected.threadSections, mocks.server.threadSections)
          ) {
            mocks.server = {
              threadSections: patch.threadSections,
              threadSectionsGeneralIndex: patch.threadSectionsGeneralIndex,
            };
          }
          return AsyncResult.success(mocks.server);
        }
      : async ({ input }: { input: { threadId: string; sectionId: string | null } }) => {
          mocks.membership.set(input.threadId, input.sectionId);
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
import { useThreadSectionCatalog } from "./catalog";
import { createSectionAndFile } from "./useNewSectionForThreads";

let hooks: {
  readonly catalog: ReturnType<typeof useThreadSectionCatalog>;
  readonly actions: ReturnType<typeof useThreadSectionActions>;
};
let renderer: ReactTestRenderer;
function Probe() {
  const catalog = useThreadSectionCatalog();
  const actions = useThreadSectionActions();
  useLayoutEffect(() => {
    hooks = { catalog, actions };
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.localCopy = { threadSections: [], threadSectionsGeneralIndex: 0 };
  mocks.server = { threadSections: [], threadSectionsGeneralIndex: 0 };
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

it.each([
  ["one thread", [ref("primary", "t1")]],
  ["threads on two environments", [ref("primary", "t1"), ref("remote", "t2")]],
])("files %s into a section created a moment earlier", async (_label, threadRefs) => {
  const section = await createSectionAndFile({
    name: "Design",
    threadRefs,
    scopeProjectRefs: [{ environmentId: "primary", projectId: "project-a" }],
    create: hooks.catalog.create,
    moveThreadsToSection: hooks.actions.moveThreadsToSection,
  });
  expect(section).not.toBeNull();
  // The local copy still lacks the section; filing must not depend on it.
  expect(mocks.localCopy.threadSections).toEqual([]);
  for (const threadRef of threadRefs) {
    expect(mocks.membership.get(threadRef.threadId)).toBe(section!.id);
  }
  expect(mocks.server.threadSections).toEqual([
    expect.objectContaining({
      id: section!.id,
      environmentIds: [...new Set(threadRefs.map((threadRef) => threadRef.environmentId))],
      // The selected project, then each filed thread's own project.
      createdInProjects: [
        ...new Set(["primary", ...threadRefs.map((threadRef) => threadRef.environmentId)]),
      ].map((environmentId) => ({ environmentId, projectId: "project-a" })),
    }),
  ]);
  expect(toastManager.add).not.toHaveBeenCalled();
});
