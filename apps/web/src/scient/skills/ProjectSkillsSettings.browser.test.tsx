import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ReactNode } from "react";

import { EnvironmentId, ProjectId, type ScientSkillInventory } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectSkillsSettings } from "./ProjectSkillsSettings";

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

async function render(_fixture: _Fixture, projectId: ProjectId) {
  return await mount(
    _fixture,
    <ProjectSkillsSettings environmentId={environmentId} projectId={projectId} />,
  );
}

describe("ProjectSkillsSettings inventory freshness", () => {
  async function _setupFixture2(_fixture: _Fixture) {
    query.refresh.mockReset();
    query.inventories.clear();
  }

  it("refreshes when opened and when the selected project changes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    await render(_fixture, firstProjectId);
    expect(query.refresh).toHaveBeenCalledTimes(1);

    await render(_fixture, firstProjectId);
    expect(query.refresh).toHaveBeenCalledTimes(1);

    await render(_fixture, secondProjectId);
    expect(query.refresh).toHaveBeenCalledTimes(2);
  });
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
