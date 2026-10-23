import { describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeMode } from "@t3tools/contracts";

const testState = vi.hoisted(() => {
  let beforeNavigate: () => void = () => undefined;
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let projectRemoved = false;
  let connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree" | null,
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null,
    defaultRuntimeMode: "full-access" as RuntimeMode,
  };
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  const router = {
    state: {
      location: { href: "/", state: {} },
      matches: [{ params: {} }],
    },
    subscribe: (_event: string, listener: () => void) => {
      beforeNavigate = listener;
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => null),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
  };

  return {
    navigateAway: () => {
      beforeNavigate();
      router.state.location.href = "/usage";
    },
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get projectRemoved() {
      return projectRemoved;
    },
    get connectedEnvironmentIds() {
      return connectedEnvironmentIds;
    },
    disconnect(environmentId: string) {
      connectedEnvironmentIds = connectedEnvironmentIds.filter((id) => id !== environmentId);
    },
    removeProject() {
      projectRemoved = true;
    },
    get targetSettings() {
      return targetSettings;
    },
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree" | null,
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
      projectRemoved = false;
      connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
      targetSettings = {
        defaultThreadEnvMode: workspaceDefaults.envMode,
        newWorktreesStartFromOrigin: workspaceDefaults.startFromOrigin,
        defaultModelSelection: null,
        defaultRuntimeMode: "full-access",
      };
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

const testServerConfigs = () =>
  new Map([
    [
      "environment-primary",
      {
        settings: {
          ...testState.targetSettings,
          newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
        },
      },
    ],
    ["environment-ssh", { settings: testState.targetSettings }],
  ]);

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "connected-environment-ids"
        ? testState.connectedEnvironmentIds
        : testServerConfigs(),
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : testServerConfigs(),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({
  DEFAULT_RUNTIME_MODE: "default",
  DEFAULT_SERVER_SETTINGS: {},
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
  resolveProjectSettings: (
    settings: Record<string, unknown>,
    _projectId: unknown,
    _project: unknown,
    projectFile?: { defaultThreadEnvMode?: "local" | "worktree" } | null,
  ) => ({
    settings:
      projectFile === undefined
        ? settings
        : {
            ...settings,
            defaultThreadEnvMode:
              settings.defaultThreadEnvMode ?? projectFile?.defaultThreadEnvMode ?? "local",
          },
    sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
    overrides: {},
  }),
  resolveNewThreadEnvMode: (input: {
    projectSettings: { settings: { defaultThreadEnvMode: "local" | "worktree" } };
  }) => input.projectSettings.settings.defaultThreadEnvMode,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: () => false,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
  hasExplicitComposerModelSelection: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => {
  const project = {
    id: "project-remote",
    environmentId: "environment-ssh",
    workspaceRoot: "/remote/project",
    defaultThreadEnvMode: null,
    defaultModelSelection: null,
  };
  return {
    readProject: () => (testState.projectRemoved ? null : project),
    readProjects: () => (testState.projectRemoved ? [] : [project]),
    readThreadShell: () => null,
    readThreadShells: () => [],
    useProjects: () => [],
    useThreadShell: () => null,
  };
});
vi.mock("../state/presentation", () => ({
  environmentSummaries: { connectedEnvironmentIdsAtom: "connected-environment-ids" },
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { readProject } from "../state/entities";
import { useNewThreadHandler } from "./useHandleNewThread";

describe("useNewThreadHandler", () => {
  it.each([
    null,
    {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    },
  ])("hands off after preparation but before deferred navigation (%s)", async (draft) => {
    testState.reset(draft);
    let completeNavigation!: () => void;
    const navigation = new Promise<void>((resolve) => {
      completeNavigation = resolve;
    });
    let markNavigationStarted!: () => void;
    const navigationStarted = new Promise<void>((resolve) => {
      markNavigationStarted = resolve;
    });
    const ready = vi.fn();
    testState.router.navigate.mockImplementationOnce(async () => {
      expect(ready).toHaveBeenCalledOnce();
      markNavigationStarted();
      await navigation;
    });
    const pending = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { onNavigationReady: ready },
    );
    expect(ready).not.toHaveBeenCalled();
    testState.completeProjectFileRead(null);
    await navigationStarted;
    expect(testState.router.navigate).toHaveBeenCalledOnce();
    completeNavigation();
    expect(await pending).not.toBeNull();
  });

  describe.each([
    ["new", null],
    [
      "reusable",
      {
        draftId: "draft-existing",
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-existing",
      },
    ],
  ])("useNewThreadHandler with a %s draft", (_, draft) => {
    it.each(["approval-required", "auto-accept-edits", "auto", "full-access"] as const)(
      "uses the target environment's %s permissions for new threads",
      async (runtimeMode) => {
        testState.reset(draft);
        testState.targetSettings.defaultRuntimeMode = runtimeMode;
        const projectRef = {
          environmentId: "environment-ssh",
          projectId: "project-remote",
        } as never;
        const pendingOpen = useNewThreadHandler()(projectRef);
        testState.completeProjectFileRead(null);
        const opened = await pendingOpen;

        expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
          "remote-project",
          projectRef,
          opened!.draftId,
          expect.objectContaining({ runtimeMode }),
        );
      },
    );

    it("abandons a delayed draft open when the user navigates elsewhere", async () => {
      testState.reset(draft);
      const openThread = useNewThreadHandler();
      const pendingOpen = openThread(
        { environmentId: "environment-ssh", projectId: "project-remote" } as never,
        { replace: true },
      );

      testState.navigateAway();
      testState.completeProjectFileRead(null);
      await pendingOpen;

      expect(testState.router.state.location.href).toBe("/usage");
      expect(testState.router.navigate).not.toHaveBeenCalled();
      expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
    });

    it("abandons a delayed draft open when the project is removed meanwhile", async () => {
      testState.reset(draft);
      const pendingOpen = useNewThreadHandler()(
        { environmentId: "environment-ssh", projectId: "project-remote" } as never,
        { replace: true },
      );

      testState.removeProject();
      testState.completeProjectFileRead(null);

      await expect(pendingOpen).resolves.toBeNull();
      expect(testState.router.navigate).not.toHaveBeenCalled();
      expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
    });

    // SCIENT-FORK:START — the index landing retries a null open only for a removed project.
    it("yields a superseded automatic open while its project still exists", async () => {
      testState.reset(draft);
      // A fresh route visit, so no earlier explicit claim on "/" refuses the automatic one.
      testState.navigateAway();
      testState.router.state.location.href = "/";
      const openThread = useNewThreadHandler();
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;
      const automatic = openThread(projectRef, { replace: true, navigationKind: "automatic" });
      const explicit = openThread(projectRef, { replace: true });

      testState.completeProjectFileRead(null);

      await expect(automatic).resolves.toBeNull();
      await expect(explicit).resolves.not.toBeNull();
      expect(testState.router.navigate).toHaveBeenCalledOnce();
      // A null here is not a removal, so the landing must not retry it into a loop.
      expect(readProject(projectRef)).not.toBeNull();
    });
    // SCIENT-FORK:END

    it.each([true, false])(
      "uses the target environment's start-from-origin default of %s",
      async (startFromOrigin) => {
        testState.reset(draft, { envMode: "worktree", startFromOrigin });
        const openThread = useNewThreadHandler();
        const projectRef = {
          environmentId: "environment-ssh",
          projectId: "project-remote",
        } as never;
        const pendingOpen = openThread(projectRef);

        testState.completeProjectFileRead(null);
        const opened = await pendingOpen;

        expect(opened).toEqual({
          draftId: draft?.draftId ?? "draft-delayed",
          threadId: draft?.threadId ?? "thread-delayed",
        });
        expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
          "remote-project",
          projectRef,
          opened!.draftId,
          expect.objectContaining({ envMode: "worktree", startFromOrigin }),
        );
        if (draft) {
          expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
            draft.draftId,
            expect.objectContaining({ envMode: "worktree", startFromOrigin }),
          );
        }
      },
    );

    it.each([true, false])(
      "preserves an explicit start-from-origin choice of %s",
      async (startFromOrigin) => {
        testState.reset(draft, { envMode: "worktree", startFromOrigin: !startFromOrigin });
        const openThread = useNewThreadHandler();
        const projectRef = {
          environmentId: "environment-ssh",
          projectId: "project-remote",
        } as never;

        const opened = await openThread(projectRef, { envMode: "worktree", startFromOrigin });

        expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
          "remote-project",
          projectRef,
          opened!.draftId,
          expect.objectContaining({ envMode: "worktree", startFromOrigin }),
        );
      },
    );
  });
});

describe("useNewThreadHandler", () => {
  it("opens the draft without waiting on a project file from an offline machine", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: false });
    testState.disconnect("environment-ssh");

    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.router.navigate).toHaveBeenCalledOnce();
  });
});
