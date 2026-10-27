import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ReactNode } from "react";

import { EnvironmentId, ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { ProjectSkills } from "./ProjectSkills";

async function _setupFixture0(_fixture: _Fixture) {
  await undefined;
}

async function mount(_fixture: _Fixture, node: ReactNode) {
  if (!_fixture.root0) {
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  await act(async () => await _fixture.root0!.rerender(node));
  return _fixture.host;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  if (_fixture.root0) await act(async () => await _fixture.root0!.unmount());
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  vi.unstubAllGlobals();
}

const environmentId = EnvironmentId.make("local-environment");
const projects = [
  {
    id: ProjectId.make("first-project"),
    environmentId,
    title: "First project",
    workspaceRoot: "/workspace/first",
    faviconPath: null,
  },
  {
    id: ProjectId.make("second-project"),
    environmentId,
    title: "Second project",
    workspaceRoot: "/workspace/second",
    faviconPath: "icon.png",
  },
] as const satisfies ReadonlyArray<
  Pick<OrchestrationProjectShell, "faviconPath" | "id" | "title" | "workspaceRoot"> & {
    readonly environmentId: EnvironmentId;
  }
>;

vi.mock("../../state/entities", () => ({
  useProjects: () => projects,
}));

vi.mock("../../components/ProjectFavicon", () => ({
  ProjectFavicon: ({ project }: { project: (typeof projects)[number] }) => (
    <span data-testid="favicon" data-project={JSON.stringify(project)} />
  ),
}));
vi.mock("./ProjectSkillsSettings", () => ({
  ProjectSkillsSettings: ({
    projectId,
    environmentId,
  }: {
    projectId: string;
    environmentId: string;
  }) => (
    <div data-testid="settings" data-project-id={projectId} data-environment-id={environmentId} />
  ),
}));
vi.mock("@tanstack/react-router", async (_actualRouter) => ({
  ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsRow: () => null,
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

it("opens, switches, and closes projects from the shared source selector", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await mount(_fixture, <ProjectSkills environmentId={environmentId} />);
  const items = () => [
    ..._fixture.host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
  ];
  const expanded = () => items().map((item) => item.getAttribute("aria-expanded") === "true");
  const settings = () => _fixture.host.querySelector<HTMLElement>('[data-testid="settings"]');
  expect(items()).toHaveLength(2);
  expect(expanded()).toEqual([false, false]);
  expect(
    [..._fixture.host.querySelectorAll<HTMLElement>('[data-testid="favicon"]')].map((item) =>
      JSON.parse(item.dataset.project!),
    ),
  ).toEqual(projects);
  expect(settings()).toBeNull();
  await act(() => items()[1]!.click());
  expect(expanded()).toEqual([false, true]);
  expect(settings()?.dataset.projectId).toBe(projects[1].id);
  expect(settings()?.dataset.environmentId).toBe(environmentId);
  await act(() => items()[0]!.click());
  expect(expanded()).toEqual([true, false]);
  expect(settings()?.dataset.projectId).toBe(projects[0].id);
  await act(() => items()[0]!.click());
  expect(expanded()).toEqual([false, false]);
  expect(settings()).toBeNull();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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
