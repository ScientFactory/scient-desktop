import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProjectSkillsSettingsPage } from "./ProjectSkillsSettingsPage";

let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));

function mount(node: ReactNode) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root!.render(node));
  return host;
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

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
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsRow: () => null,
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

it("opens, switches, and closes projects from the shared source selector", () => {
  mount(<ProjectSkillsSettingsPage />);
  const items = () => [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")];
  const expanded = () => items().map((item) => item.getAttribute("aria-expanded") === "true");
  const settings = () => host.querySelector<HTMLElement>('[data-testid="settings"]');
  expect(items()).toHaveLength(2);
  expect(expanded()).toEqual([false, false]);
  expect(
    [...host.querySelectorAll<HTMLElement>('[data-testid="favicon"]')].map((item) =>
      JSON.parse(item.dataset.project!),
    ),
  ).toEqual(projects);
  expect(settings()).toBeNull();
  act(() => items()[1]!.click());
  expect(expanded()).toEqual([false, true]);
  expect(settings()?.dataset.projectId).toBe(projects[1].id);
  expect(settings()?.dataset.environmentId).toBe(environmentId);
  act(() => items()[0]!.click());
  expect(expanded()).toEqual([true, false]);
  expect(settings()?.dataset.projectId).toBe(projects[0].id);
  act(() => items()[0]!.click());
  expect(expanded()).toEqual([false, false]);
  expect(settings()).toBeNull();
});
