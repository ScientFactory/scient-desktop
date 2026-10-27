import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ReactNode } from "react";

import {
  EnvironmentId,
  ProjectId,
  type ScientSkillCatalogItem,
  type ScientSkillInventory,
} from "@t3tools/contracts";
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

vi.mock("../extensions/ExtensionRow", () => ({ ExtensionIcon: () => null }));
vi.mock("./composerSkills", () => ({ useTryComposerSkill: () => undefined }));
vi.mock("../../components/ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

const query = vi.hoisted(() => ({
  refresh: vi.fn(),
  inventories: new Map<string, { refresh: () => void }>(),
  data: {
    skills: [] as ScientSkillCatalogItem[],
    diagnostics: [],
    supportedProviders: [],
  } satisfies ScientSkillInventory,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { refresh: () => void }) => ({
    data:
      "document" in atom
        ? atom.document
          ? { instructions: "# Project instructions" }
          : null
        : query.data,
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
  scientSkillDocument: ({ input }: { input: { projectId?: string } }) => ({
    document: input.projectId === firstProjectId,
  }),
  setScientSkillProjectPreference: Symbol("set-project-preference"),
}));

vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: string;
    control?: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
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
    query.data.skills = [];
  }

  it("opens project instructions in the shared card without changing availability", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);
    query.data.skills = [
      {
        releaseKey: "project-review",
        id: "review",
        version: "1",
        name: "review",
        description: "Review the project",
        category: "Project",
        categoryDescription: "Project skills",
        origin: "project",
        scope: "project",
        supportedScopes: ["project"],
        defaultInvocationPolicy: "automatic",
        defaultActive: true,
        active: true,
        invocationPolicy: "automatic",
      },
    ];
    await render(_fixture, firstProjectId);
    await act(() => {
      _fixture.host.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
    });
    await expect.element(document.querySelector<HTMLElement>('[role="dialog"]')!).toBeVisible();
    expect(document.body.textContent).toContain("Project instructions");
    expect(_fixture.host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe(
      "true",
    );
  });

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
