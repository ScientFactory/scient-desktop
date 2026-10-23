import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ReactNode } from "react";

import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { ProjectFilePickerForTarget } from "./ProjectFilePicker";

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

vi.mock("../chat/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
const mocks = vi.hoisted(() => ({ openFile: vi.fn() }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: mocks.openFile }) },
}));
vi.mock("~/hooks/useActiveProjectTarget", () => ({ useActiveProjectTarget: () => null }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: Symbol("bindings") }));
vi.mock("./projectFilesQueryState", () => ({
  useProjectFilePickerQuery: () => ({
    entries: [{ kind: "file", path: "run.py" }],
    matchedQuery: "",
    error: null,
    isPending: false,
  }),
}));

vi.mock("../CommandPaletteContent", () => ({
  CommandPaletteContent: ({
    children,
    footerActionLabel,
  }: {
    children: ReactNode;
    footerActionLabel: string;
  }) => <section aria-label={footerActionLabel}>{children}</section>,
}));
vi.mock("../CommandPaletteResults", () => ({
  CommandPaletteResults: ({
    groups,
    onExecuteItem,
  }: {
    groups: { items: CommandPaletteActionItem[] }[];
    onExecuteItem: (item: CommandPaletteActionItem) => void;
  }) => (
    <>
      {groups
        .flatMap((group) => group.items)
        .map((item) => (
          <button key={item.value} onClick={() => onExecuteItem(item)}>
            {item.title}
          </button>
        ))}
    </>
  ),
}));
const target = {
  environmentId: EnvironmentId.make("env"),
  cwd: "/synthetic",
  projectName: "Synthetic",
  threadRef: {} as ScopedThreadRef,
};

async function _setupFixture2(_fixture: _Fixture) {
  vi.clearAllMocks();
}

it.each([false, true])(
  "preserves ordinary opening and permits an explicit scoped action: %s",
  async (custom) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const onSelectFile = vi.fn();
    const setOpen = vi.fn();

    await mount(
      _fixture,
      <ProjectFilePickerForTarget
        target={target}
        setOpen={setOpen}
        {...(custom ? { onSelectFile, actionLabel: "Run saved file" } : {})}
      />,
    );
    await act(() => _fixture.host.querySelector("button")!.click());
    if (custom) {
      expect(onSelectFile).toHaveBeenCalledWith("run.py");
      expect(mocks.openFile).not.toHaveBeenCalled();
    } else {
      expect(mocks.openFile).toHaveBeenCalledWith(target.threadRef, "run.py");
      expect(onSelectFile).not.toHaveBeenCalled();
    }
  },
);

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
