import "../../../index.css";
import { render as _fixtureRender, type Screen, act } from "../../../../test/render";
import { type ComponentProps } from "react";

import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { makeThreadFixture } from "../../../test-fixtures";

const discovery = vi.hoisted(() => ({
  active: [] as readonly OrchestrationV2ThreadShell[],
  archived: [] as readonly {
    environmentId: EnvironmentId;
    snapshot: OrchestrationV2ArchivedShellSnapshot;
  }[],
  activeReads: vi.fn(),
  archiveReads: vi.fn(),
}));
vi.mock("../../../state/entities", () => ({
  useEnvironmentThreadShells: (environmentId: EnvironmentId | null) => {
    discovery.activeReads(environmentId);
    return environmentId === null ? [] : discovery.active;
  },
}));
vi.mock("../../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: (environmentIds: readonly EnvironmentId[]) => {
    discovery.archiveReads(environmentIds);
    return { snapshots: discovery.archived, error: null, isLoading: false, refresh: vi.fn() };
  },
}));
vi.mock("../../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { ScientForkDialog } from "./ScientForkWorkspaceModeDialog";

const environmentId = EnvironmentId.make("fork-title-environment");
const otherEnvironment = EnvironmentId.make("other-fork-title-environment");
const originId = ThreadId.make("fork-title-origin");
const projectId = ProjectId.make("fork-title-project");

const confirm = vi.fn();
const baseShell = makeThreadFixture().source;

function shell(id: string, title: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) {
  return {
    ...baseShell,
    id: ThreadId.make(id),
    projectId,
    title,
    ...overrides,
  } satisfies OrchestrationV2ThreadShell;
}
const original = shell(originId, "Study");
function child(title = "Study (2)") {
  return shell("fork-title-child", title, {
    lineage: { rootThreadId: originId, parentThreadId: originId, relationshipToParent: "fork" },
    forkLineage: { originThreadId: originId, baselineAssistantMessageId: null },
  });
}
function archive(threads: readonly OrchestrationV2ThreadShell[], env = environmentId) {
  return {
    environmentId: env,
    snapshot: { schemaVersion: 2, snapshotSequence: 1, projects: [], threads },
  };
}
function titleInput() {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Thread title"]');
  if (input === null) throw new Error("Mounted title input is missing");
  return input;
}
async function render(
  _fixture: _Fixture,
  origin = original,
  props: Partial<ComponentProps<typeof ScientForkDialog>> = {},
) {
  await act(
    async () =>
      await _fixture.root0.rerender(
        <ScientForkDialog
          origin={presentThreadShell(environmentId, origin)}
          open
          disabled={false}
          source="this-response"
          titleOverrideSupported
          worktreeAvailability={{ available: true }}
          onOpenChange={vi.fn()}
          onConfirm={confirm}
          {...props}
        />,
      ),
  );
}
async function editTitle(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Native input value setter is missing");
  await act(() => {
    setter.call(titleInput(), value);
    titleInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  const form = document.querySelector("form");
  if (form === null) throw new Error("Mounted fork form is missing");
  await act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

async function _setupFixture0(_fixture: _Fixture) {
  discovery.active = [original];
  discovery.archived = [];
  discovery.activeReads.mockClear();
  discovery.archiveReads.mockClear();
  confirm.mockReset();
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.host.remove();
}

it("uses the real presented caller's source lineage to number a fork of a fork", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const fork = child();
  discovery.active = [original, fork];
  const presented = presentThreadShell(environmentId, fork);
  expect("forkLineage" in presented).toBe(false);
  expect(presented.source.forkLineage?.originThreadId).toBe(originId);
  await render(_fixture, fork);
  expect(titleInput().value).toBe("Study (3)");
  await submit();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    { workspaceMode: "local", displayTitle: "Study (3)" },
    expect.any(Function),
    expect.any(Function),
  );
});

it("reserves archived sibling titles from the same origin project and environment", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  discovery.active = [original, child()];
  discovery.archived = [
    archive([shell("archived-grandchild", "Study (3)", { archivedAt: baseShell.createdAt })]),
  ];
  await render(_fixture);
  expect(titleInput().value).toBe("Study (4)");
  expect(discovery.archiveReads).toHaveBeenLastCalledWith([environmentId]);
});

it.each([null, undefined])(
  "does not revive stale wrapper lineage when source lineage is %s",
  async (forkLineage) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const fork = child();
    discovery.active = [original, fork];
    const presented = presentThreadShell(environmentId, { ...fork, forkLineage });
    await render(_fixture, fork, { origin: { ...presented, forkLineage: fork.forkLineage } });
    expect(titleInput().value).toBe("Study (2) (2)");
  },
);

it("retains explicit lineage for compatible callers without a captured source shell", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const fork = child();
  discovery.active = [original, fork];
  await render(_fixture, fork, {
    origin: {
      id: fork.id,
      title: fork.title,
      projectId,
      environmentId,
      forkLineage: fork.forkLineage,
    },
  });
  expect(titleInput().value).toBe("Study (3)");
});

it("uses an archived unsuffixed witness but excludes other projects and environments", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const fork = child();
  discovery.active = [fork];
  discovery.archived = [
    archive([
      original,
      shell("foreign-project", "Study (3)", { projectId: ProjectId.make("foreign-project") }),
    ]),
    archive([shell("foreign-environment", "Study (3)")], otherEnvironment),
  ];
  await render(_fixture, fork);
  expect(titleInput().value).toBe("Study (3)");
});

it.each(["Renamed research (2024)", "Renamed research (2)"])(
  "preserves authored numeric titles without a matching base witness: %s",
  async (title) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const fork = child(title);
    discovery.active = [original, fork];
    await render(_fixture, fork);
    expect(titleInput().value).toBe(`${title} (2)`);
  },
);

it("updates an untouched proposal after archived data arrives without submitting an override", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  discovery.active = [original, child()];
  await render(_fixture);
  expect(titleInput().value).toBe("Study (3)");
  discovery.archived = [archive([shell("archived-grandchild", "Study (3)")])];
  await render(_fixture);
  expect(titleInput().value).toBe("Study (4)");
  await submit();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    { workspaceMode: "local", displayTitle: "Study (4)" },
    expect.any(Function),
    expect.any(Function),
  );
});

it("retains an authored title when archived siblings arrive and submits the explicit override", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture);
  await editTitle("My chosen research (2024)");
  expect(titleInput().value).toBe("My chosen research (2024)");
  discovery.archived = [archive([shell("new-sibling", "Study (2)")])];
  await render(_fixture);
  expect(titleInput().value).toBe("My chosen research (2024)");
  await submit();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    {
      workspaceMode: "local",
      titleOverride: "My chosen research (2024)",
      displayTitle: "My chosen research (2024)",
    },
    expect.any(Function),
    expect.any(Function),
  );
});

it("keeps the accepted retry title locked through late sibling updates", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const props = {
    locked: true,
    retryTitle: "Accepted custom fork",
    retryWorkspaceMode: "local" as const,
  };
  await render(_fixture, original, props);
  discovery.archived = [archive([shell("new-sibling", "Study (2)")])];
  await render(_fixture, original, props);
  expect(titleInput().value).toBe("Accepted custom fork");
  expect(titleInput().disabled).toBe(true);
});

it("does not subscribe to sibling discovery while the dialog is closed", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, original, { open: false });
  expect(discovery.activeReads).toHaveBeenLastCalledWith(null);
  expect(discovery.archiveReads).toHaveBeenLastCalledWith([]);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
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
