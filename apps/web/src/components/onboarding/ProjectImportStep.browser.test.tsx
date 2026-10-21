import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, ProjectId, type AgentSessionProjectCandidate } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectImportStep } from "./ProjectImportStep";

const state = vi.hoisted(() => ({
  candidates: [] as AgentSessionProjectCandidate[],
  projects: [] as { id: ProjectId; environmentId: EnvironmentId; workspaceRoot: string }[],
  error: null as Error | null,
  pending: false,
  truncated: false,
  refresh: vi.fn(),
  create: vi.fn(),
  importThreads: vi.fn(),
}));
vi.mock("../../state/agentSessions", () => ({
  agentSessionScan: (input: unknown) => input,
  agentSessionImport: "import",
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.projects,
  readProjects: () => state.projects,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.pending ? null : { candidates: state.candidates, truncated: state.truncated },
    error: state.error,
    isPending: state.pending,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "create" ? state.create : state.importThreads),
}));

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectId = ProjectId.make("imported-project");

const done = vi.fn(async () => true);
const back = vi.fn();
const busy = vi.fn();
const candidate = (path: string): AgentSessionProjectCandidate => ({
  title: path.split("/").at(-1)!,
  path,
  sources: ["codex"],
  threadCount: 3,
  git: { remoteKey: null, repository: null },
  lastActiveAt: new Date(Date.now() - 1_000).toISOString(),
  alreadyImported: false,
});
async function render(_fixture: _Fixture, environmentId = local) {
  await act(
    async () =>
      await _fixture.root0.rerender(
        <ProjectImportStep
          environmentId={environmentId}
          machineLabel="Test machine"
          onBack={back}
          onDone={done}
          onImportingChange={busy}
        />,
      ),
  );
}
async function click(_fixture: _Fixture, label: string) {
  const button = [..._fixture.container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(() => button!.click());
}

async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
  state.candidates = [candidate("/fixtures/project")];
  state.projects = [];
  state.error = null;
  state.pending = false;
  state.truncated = false;
  state.create.mockResolvedValue({ _tag: "Success" });
  state.importThreads.mockResolvedValue({
    _tag: "Success",
    value: { importedCount: 1, skippedCount: 0 },
  });
  done.mockResolvedValue(true);
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.unstubAllGlobals();
}

describe("shared project import", () => {
  it("does not mutate while browsing or skipping and reports truncated scans", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    state.truncated = true;
    await render(_fixture);
    expect(_fixture.container.textContent).toContain("Scan limit reached");
    await click(_fixture, "Skip");
    expect(done).toHaveBeenCalledWith(undefined, "", 0);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.importThreads).not.toHaveBeenCalled();
  });

  it("waits for the imported project in the shell before opening it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    state.candidates = [{ ...candidate("/fixtures/project"), projectId }];
    await render(_fixture);
    await click(_fixture, "Import 1 project");
    expect(state.create).not.toHaveBeenCalled();
    expect(state.importThreads).toHaveBeenCalledWith({
      environmentId: local,
      input: { projectId, expectedWorkspaceRoot: "/fixtures/project" },
    });
    expect(done).not.toHaveBeenCalled();
    // Writes are complete; a slow shell must not prevent dismissal.
    expect(busy).toHaveBeenLastCalledWith(false);
    state.projects = [{ id: projectId, environmentId: local, workspaceRoot: "/fixtures/project" }];
    await render(_fixture);
    expect(done).toHaveBeenCalledWith({ environmentId: local, projectId }, "", 1);
  });

  it("disables navigation while importing and completes after a partial import", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let settle!: (value: unknown) => void;
    let createdProjectId: ProjectId | undefined;
    state.importThreads.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    state.create.mockImplementation(
      async ({ input }: { input: { projectId: ProjectId; workspaceRoot: string } }) => {
        createdProjectId = input.projectId;
        state.projects = [
          { id: input.projectId, environmentId: local, workspaceRoot: input.workspaceRoot },
        ];
        return { _tag: "Success" };
      },
    );
    await render(_fixture);
    await click(_fixture, "Choose");
    await click(_fixture, "Import 1");
    expect(
      [..._fixture.container.querySelectorAll("button")].every((button) => button.disabled),
    ).toBe(true);
    expect(
      _fixture.container.querySelector('[role="checkbox"]')?.getAttribute("aria-disabled"),
    ).toBe("true");
    await act(() => settle({ _tag: "Success", value: { importedCount: 28, skippedCount: 1 } }));
    expect(_fixture.container.textContent).not.toContain("could not be imported");
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.importThreads).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(
      { environmentId: local, projectId: createdProjectId },
      "Imported 28 threads. 1 thread could not be imported.",
      28,
    );
  });

  it("does not continue an old machine's import after switching environments", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let settle!: (value: unknown) => void;
    state.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    state.candidates = [candidate("/fixtures/one"), candidate("/fixtures/two")];
    await render(_fixture);
    await click(_fixture, "Import 2 projects");
    await render(_fixture, remote);
    await act(() => settle({ _tag: "Success" }));
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.importThreads).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(busy).toHaveBeenLastCalledWith(false);
  });

  it("offers retry for scan errors without creating projects", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    state.error = new Error("offline");
    await render(_fixture);
    await click(_fixture, "Retry");
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.create).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
