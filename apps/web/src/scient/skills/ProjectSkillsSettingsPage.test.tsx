import { EnvironmentId, ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
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

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProjectSkillsSettings } from "./ProjectSkillsSettings";
import { ProjectSkillsSettingsPage } from "./ProjectSkillsSettingsPage";
import { SkillSourceStripItem } from "./SkillSourceStrip";

function render() {
  hooks.beginRender();
  return ProjectSkillsSettingsPage() as ReactElement<Record<string, unknown>>;
}

function collectElements(
  node: unknown,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReadonlyArray<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap((child) => collectElements(child, predicate));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  const nested = Object.values(node.props).flatMap((value) => collectElements(value, predicate));
  return predicate(node) ? [node, ...nested] : nested;
}

describe("ProjectSkillsSettingsPage project selector", () => {
  beforeEach(() => hooks.reset());

  it("opens, switches, and closes projects from the shared source selector", () => {
    let page = render();
    let projectItems = collectElements(page, (element) => element.type === SkillSourceStripItem);
    const favicons = collectElements(page, (element) => element.type === ProjectFavicon);
    let settings = visitElements(page, (element) => element.type === ProjectSkillsSettings);

    expect(projectItems).toHaveLength(2);
    expect(projectItems.map((item) => item.props.expanded)).toEqual([false, false]);
    expect(favicons.map((favicon) => favicon.props.cwd)).toEqual([
      "/workspace/first",
      "/workspace/second",
    ]);
    expect(settings).toBeNull();

    (projectItems[1]?.props.onToggle as (() => void) | undefined)?.();
    page = render();
    projectItems = collectElements(page, (element) => element.type === SkillSourceStripItem);
    settings = visitElements(page, (element) => element.type === ProjectSkillsSettings);

    expect(projectItems.map((item) => item.props.expanded)).toEqual([false, true]);
    expect(settings?.props.projectId).toBe(projects[1].id);

    (projectItems[0]?.props.onToggle as (() => void) | undefined)?.();
    page = render();
    projectItems = collectElements(page, (element) => element.type === SkillSourceStripItem);
    settings = visitElements(page, (element) => element.type === ProjectSkillsSettings);

    expect(projectItems.map((item) => item.props.expanded)).toEqual([true, false]);
    expect(settings?.props.projectId).toBe(projects[0].id);

    (projectItems[0]?.props.onToggle as (() => void) | undefined)?.();
    page = render();
    projectItems = collectElements(page, (element) => element.type === SkillSourceStripItem);
    settings = visitElements(page, (element) => element.type === ProjectSkillsSettings);

    expect(projectItems.map((item) => item.props.expanded)).toEqual([false, false]);
    expect(settings).toBeNull();
  });
});
