import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProjectId, type ScientSkillInventory } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProjectSkillsSettings } from "./ProjectSkillsSettings";

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

const query = vi.hoisted(() => ({
  refresh: vi.fn(),
  inventories: new Map<string, { refresh: () => void }>(),
  data: {
    skills: [],
    diagnostics: [],
    supportedProviders: [],
  } satisfies ScientSkillInventory,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { refresh: () => void }) => ({
    data: query.data,
    error: null,
    isPending: false,
    refresh: atom.refresh,
  }),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

vi.mock("./scientSkillsState", () => ({
  scientSkillsInventory: vi.fn(({ input }: { input: { projectId: string } }) => {
    let atom = query.inventories.get(input.projectId);
    if (!atom) {
      atom = { refresh: () => query.refresh() };
      query.inventories.set(input.projectId, atom);
    }
    return atom;
  }),
  setScientSkillProjectPreference: Symbol("set-project-preference"),
}));

vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsRow: ({ title, description }: { title: string; description?: string }) => (
    <div>
      {title}
      {description}
    </div>
  ),
}));

const environmentId = EnvironmentId.make("local-environment");
const firstProjectId = ProjectId.make("first-project");
const secondProjectId = ProjectId.make("second-project");

function render(projectId: ProjectId) {
  return mount(<ProjectSkillsSettings environmentId={environmentId} projectId={projectId} />);
}

describe("ProjectSkillsSettings inventory freshness", () => {
  beforeEach(() => {
    query.refresh.mockReset();
    query.inventories.clear();
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
