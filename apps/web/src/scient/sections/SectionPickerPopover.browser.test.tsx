import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { EnvironmentId, ThreadId, ThreadSectionId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

const LAB = EnvironmentId.make("lab");
const section = (name: string, order: number) => ({
  id: ThreadSectionId.make(name.toLowerCase()),
  name,
  order,
});
const thread = (id: string, projectId: string, sectionId: string | null) => ({
  id: ThreadId.make(id),
  environmentId: LAB,
  projectId,
  sectionId,
  archivedAt: null,
  updatedAt: "2026-11-09T10:00:00.000Z",
});
const mocks = vi.hoisted(() => ({
  threads: [] as Array<ReturnType<typeof thread>>,
}));
vi.mock("./catalog", () => ({
  useThreadSectionCatalogs: () => ({
    catalogFor: (environmentId: string) => ({
      environmentId,
      generalIndex: 0,
      sections: [section("Voice", 0), section("Compute", 1), section("Overleaf", 2)],
    }),
  }),
}));
vi.mock("./loadedEnvironments", async () => {
  const { Atom } = await import("effect/reactivity");
  return { loadedThreadEnvironmentsKeyAtom: Atom.make(() => "lab") };
});
vi.mock("../../state/entities", () => ({
  readThreadShell: (ref: { threadId: string }) =>
    mocks.threads.find((candidate) => candidate.id === ref.threadId) ?? null,
  useQuietThreadShells: () => mocks.threads,
}));

import { SectionPickerPopover } from "./SectionPickerPopover";
import { setSidebarSectionScope } from "./sidebarScope";

const moved = { environmentId: LAB, threadId: ThreadId.make("moved") };

async function renderPicker(
  _fixture: _Fixture,
  props: { onMove?: (section: unknown) => void; onCreate?: (name: string) => Promise<boolean> },
) {
  // Voice holds the moved thread in this project; Compute only another project's thread.
  mocks.threads = [thread("moved", "app", "voice"), thread("other", "site", "compute")];
  setSidebarSectionScope([{ environmentId: "lab", projectId: "app" }]);
  _fixture.cleanup.defer(() => setSidebarSectionScope(null));
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(
    <SectionPickerPopover
      open
      requestKey={1}
      threadRefs={[moved]}
      anchor={{ x: 120, y: 80 }}
      onOpenChange={() => {}}
      onMove={props.onMove ?? (() => {})}
      onCreate={props.onCreate ?? (async () => true)}
    />,
  );
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      document.querySelector('input[aria-label="Search sections"]'),
    ),
  );
}

const rowNames = () =>
  [...document.querySelectorAll('[data-slot="autocomplete-item"]')].map((row) => row.textContent);

it("lists the selected project's sections and finds others by search", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));
  const onMove = vi.fn();
  await renderPicker(_fixture, { onMove });

  expect(rowNames()).toEqual(["General", "Voice"]);
  expect(
    document.querySelector('[aria-label="Current section"]')?.closest("[role=option]"),
  ).toHaveTextContent("Voice");

  await userEvent.keyboard("comp");
  await vi.waitFor(() => expect(rowNames()).toEqual(["Compute", "Create “Comp”"]));
  expect(
    [...document.querySelectorAll('[data-slot="autocomplete-group-label"]')].map(
      (label) => label.textContent,
    ),
  ).toEqual(["Other projects"]);
  await userEvent.keyboard("{Enter}");
  expect(onMove).toHaveBeenCalledExactlyOnceWith({ environmentId: LAB, sectionId: "compute" });
});

it("creates a section from the typed name with Enter", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));
  const onCreate = vi.fn(async () => true);
  await renderPicker(_fixture, { onCreate });

  await userEvent.keyboard("field notes");
  await vi.waitFor(() => expect(rowNames()).toEqual(["Create “Field notes”"]));
  await userEvent.keyboard("{Enter}");
  expect(onCreate).toHaveBeenCalledExactlyOnceWith("Field notes");
});

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
}

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
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
