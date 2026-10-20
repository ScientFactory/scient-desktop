import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { ProjectFilePickerForTarget } from "./ProjectFilePicker";

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

beforeEach(() => {
  vi.clearAllMocks();
});

it.each([false, true])(
  "preserves ordinary opening and permits an explicit scoped action: %s",
  async (custom) => {
    const onSelectFile = vi.fn();
    const setOpen = vi.fn();

    mount(
      <ProjectFilePickerForTarget
        target={target}
        setOpen={setOpen}
        {...(custom ? { onSelectFile, actionLabel: "Run saved file" } : {})}
      />,
    );
    act(() => host.querySelector("button")!.click());
    if (custom) {
      expect(onSelectFile).toHaveBeenCalledWith("run.py");
      expect(mocks.openFile).not.toHaveBeenCalled();
    } else {
      expect(mocks.openFile).toHaveBeenCalledWith(target.threadRef, "run.py");
      expect(onSelectFile).not.toHaveBeenCalled();
    }
  },
);
