import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fakes = vi.hoisted(() => ({
  inspect: vi.fn(),
  initialize: vi.fn(),
  runAtomCommand: vi.fn(),
  readProjects: vi.fn(),
  waitForProjectProjection: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("~/lib/scientProjectInitialization", () => ({
  inspectScientProjectForOpening: fakes.inspect,
  initializeScientProjectForOpening: fakes.initialize,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: fakes.runAtomCommand,
}));
vi.mock("~/state/entities", () => ({ readProjects: fakes.readProjects }));
vi.mock("~/lib/projectProjection", () => ({
  waitForProjectProjection: fakes.waitForProjectProjection,
}));
vi.mock("~/state/session", () => ({
  readPreparedConnection: () => ({ prepared: true }),
  readEnvironmentScope: () => true,
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { create: "create-command" } }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: "registry" }));
vi.mock("~/lib/utils", () => ({ newProjectId: () => "new-project" }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: fakes.toast } }));

const { createProjectForOverleaf } = await import("./createProjectForOverleaf");

const environmentId = EnvironmentId.make("local");
const ROOT = "/home/me/Projects/Thesis";

describe("createProjectForOverleaf", () => {
  beforeEach(() => {
    for (const fake of Object.values(fakes)) fake.mockReset();
    fakes.inspect.mockResolvedValue({
      root: ROOT,
      state: "ordinary",
      canInitialize: true,
      issues: [],
      existingFiles: [],
    });
    fakes.initialize.mockResolvedValue({ state: "initialized" });
    fakes.readProjects.mockReturnValue([]);
    fakes.runAtomCommand.mockResolvedValue(AsyncResult.success({}));
    fakes.waitForProjectProjection.mockResolvedValue(true);
  });

  it("registers the folder as Add project does, then sets Scient up before any link", async () => {
    const made = await createProjectForOverleaf({ environmentId, root: "~/Projects/Thesis" });

    // The server's resolved root is used from here on, not the typed `~` path.
    expect(fakes.inspect).toHaveBeenCalledWith({ prepared: true }, "~/Projects/Thesis");
    expect(fakes.runAtomCommand).toHaveBeenCalledExactlyOnceWith(
      "registry",
      "create-command",
      {
        environmentId,
        input: {
          projectId: "new-project",
          title: "Thesis",
          workspaceRoot: ROOT,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: null,
        },
      },
      expect.objectContaining({ reportFailure: false }),
    );
    expect(fakes.initialize).toHaveBeenCalledExactlyOnceWith({
      prepared: { prepared: true },
      root: ROOT,
      title: "Thesis",
    });
    expect(made).toEqual({
      projectRef: { environmentId, projectId: "new-project" },
      cwd: ROOT,
      created: true,
      ready: true,
    });
  });

  it("uses a folder that already is a project as it is", async () => {
    fakes.readProjects.mockReturnValue([
      { environmentId, id: ProjectId.make("p1"), workspaceRoot: ROOT },
    ]);
    const made = await createProjectForOverleaf({ environmentId, root: ROOT });
    expect(made).toMatchObject({ cwd: ROOT, created: false, ready: true });
    expect(fakes.runAtomCommand).not.toHaveBeenCalled();
    expect(fakes.initialize).not.toHaveBeenCalled();
  });

  it("throws the server's reason when nothing was made, and sets nothing up", async () => {
    fakes.runAtomCommand.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Folder is not writable"))),
    );
    await expect(createProjectForOverleaf({ environmentId, root: ROOT })).rejects.toThrow(
      "Folder is not writable",
    );
    expect(fakes.initialize).not.toHaveBeenCalled();
  });

  it("leaves a folder Scient can't set up safely as it is", async () => {
    fakes.inspect.mockResolvedValue({
      root: ROOT,
      state: "conflicting",
      canInitialize: false,
      issues: [],
      existingFiles: ["PROJECT.md"],
    });
    await createProjectForOverleaf({ environmentId, root: ROOT });
    expect(fakes.runAtomCommand).toHaveBeenCalledOnce();
    expect(fakes.initialize).not.toHaveBeenCalled();
  });
});
