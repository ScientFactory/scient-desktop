import { EnvironmentId, ProjectId, type ScientSkillInventory } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const query = vi.hoisted(() => ({
  refresh: vi.fn(),
  data: {
    skills: [],
    diagnostics: [],
    supportedProviders: [],
  } satisfies ScientSkillInventory,
}));

const effects = vi.hoisted(() => ({
  dependencies: undefined as ReadonlyArray<unknown> | undefined,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: (effect: () => void, dependencies: ReadonlyArray<unknown>) => {
      const changed =
        effects.dependencies === undefined ||
        dependencies.some(
          (dependency, index) => !Object.is(dependency, effects.dependencies?.[index]),
        );
      effects.dependencies = dependencies;
      if (changed) effect();
    },
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: query.data,
    error: null,
    isPending: false,
    refresh: query.refresh,
  }),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

vi.mock("./scientSkillsState", () => ({
  scientSkillsInventory: vi.fn(() => Symbol("inventory")),
  setScientSkillProjectPreference: Symbol("set-project-preference"),
}));

import { ProjectSkillsSettings } from "./ProjectSkillsSettings";

const environmentId = EnvironmentId.make("local-environment");
const firstProjectId = ProjectId.make("first-project");
const secondProjectId = ProjectId.make("second-project");

function render(projectId: ProjectId) {
  hooks.beginRender();
  return ProjectSkillsSettings({ environmentId, projectId });
}

describe("ProjectSkillsSettings inventory freshness", () => {
  beforeEach(() => {
    hooks.reset();
    effects.dependencies = undefined;
    query.refresh.mockReset();
  });

  it("refreshes when opened and when the selected project changes", () => {
    render(firstProjectId);
    expect(query.refresh).toHaveBeenCalledTimes(1);

    render(firstProjectId);
    expect(query.refresh).toHaveBeenCalledTimes(1);

    render(secondProjectId);
    expect(query.refresh).toHaveBeenCalledTimes(2);
  });
});
