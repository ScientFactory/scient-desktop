// @vitest-environment happy-dom
import { EnvironmentId, ProjectId, type AgentSessionProjectCandidate } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
let root: Root;
let container: HTMLDivElement;
const done = vi.fn(async () => true);
const back = vi.fn();
const busy = vi.fn();
const candidate = (path: string): AgentSessionProjectCandidate => ({
  title: path.split("/").at(-1)!,
  path,
  sources: ["codex"],
  threadCount: 1,
  lastActiveAt: new Date(Date.now() - 1_000).toISOString(),
  alreadyImported: false,
});
async function render(environmentId = local) {
  await act(() =>
    root.render(
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
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(() => button!.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("shared project import", () => {
  it("does not mutate while browsing or skipping and reports truncated scans", async () => {
    state.truncated = true;
    await render();
    expect(container.textContent).toContain("Scan limit reached");
    await click("Skip");
    expect(done).toHaveBeenCalledWith();
    expect(state.create).not.toHaveBeenCalled();
    expect(state.importThreads).not.toHaveBeenCalled();
  });

  it("waits for the imported project in the shell before opening it", async () => {
    state.candidates = [{ ...candidate("/fixtures/project"), projectId }];
    await render();
    await click("Import 1 project");
    expect(state.create).not.toHaveBeenCalled();
    expect(state.importThreads).toHaveBeenCalledWith({
      environmentId: local,
      input: { projectId, expectedWorkspaceRoot: "/fixtures/project" },
    });
    expect(done).not.toHaveBeenCalled();
    // Writes are complete; a slow shell must not prevent dismissal.
    expect(busy).toHaveBeenLastCalledWith(false);
    state.projects = [{ id: projectId, environmentId: local, workspaceRoot: "/fixtures/project" }];
    await render();
    expect(done).toHaveBeenCalledWith({ environmentId: local, projectId });
  });

  it("disables navigation and selection while importing and retries history without duplicating a project", async () => {
    let settle!: (value: unknown) => void;
    state.importThreads.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    state.create.mockImplementation(
      async ({ input }: { input: { projectId: ProjectId; workspaceRoot: string } }) => {
        state.projects = [
          { id: input.projectId, environmentId: local, workspaceRoot: input.workspaceRoot },
        ];
        return { _tag: "Success" };
      },
    );
    await render();
    await click("Choose");
    await click("Import 1");
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
    expect(container.querySelector('[role="checkbox"]')?.getAttribute("aria-disabled")).toBe(
      "true",
    );
    await act(() => settle({ _tag: "Success", value: { importedCount: 0, skippedCount: 1 } }));
    expect(container.textContent).toContain("could not be imported");
    expect(busy).toHaveBeenLastCalledWith(false);
    await click("Import 1");
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.importThreads).toHaveBeenCalledTimes(2);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("does not continue an old machine's import after switching environments", async () => {
    let settle!: (value: unknown) => void;
    state.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    state.candidates = [candidate("/fixtures/one"), candidate("/fixtures/two")];
    await render();
    await click("Import 2 projects");
    await render(remote);
    await act(() => settle({ _tag: "Success" }));
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.importThreads).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(busy).toHaveBeenLastCalledWith(false);
  });

  it("offers retry for scan errors without creating projects", async () => {
    state.error = new Error("offline");
    await render();
    await click("Retry");
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.create).not.toHaveBeenCalled();
  });
});
