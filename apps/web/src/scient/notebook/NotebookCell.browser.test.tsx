import "../../index.css";

import type { EnvironmentId, NotebookCellView, ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

import { NotebookCell, type NotebookCellHandlers } from "./NotebookCell";
import { createNotebookController } from "./notebookController";

const cell: NotebookCellView = {
  id: "cell",
  cellType: "code",
  source:
    "first_line_of_code_long_enough_to_reach_the_right_edge_of_a_narrow_side_panel = 1\nsecond = 2",
  executionCount: 3,
  run: null,
  pendingExecution: null,
  outputs: [],
};

const handlers: NotebookCellHandlers = {
  run: () => undefined,
  stop: () => undefined,
  escape: () => undefined,
  leave: () => undefined,
  insert: () => undefined,
  ask: () => undefined,
  delete: () => undefined,
  edit: () => undefined,
  observeNear: () => () => undefined,
};

const place = {
  environmentId: "environment" as EnvironmentId,
  cwd: "/project",
  threadRef: { environmentId: "environment", threadId: "thread" } as unknown as ScopedThreadRef,
};

async function mountCell(
  width: number,
  options: {
    readonly cells?: ReadonlyArray<NotebookCellView>;
    readonly handlers?: NotebookCellHandlers;
  } = {},
) {
  const cells = options.cells ?? [cell];
  const controller = createNotebookController({
    read: async () => ({ revision: "1.0", language: "python", cells: [...cells] }),
    readOutput: async () => null,
    edit: async () => ({ revision: "1.1" }),
    recordRun: async () => null,
    onError: () => undefined,
  });
  controller.fileChanged("open");
  await vi.waitFor(() => expect(controller.store.getState().status).toBe("ready"));
  const screen = await render(
    <div style={{ width }}>
      <NotebookCell
        controller={controller}
        place={place}
        cellId={cells[0]!.id}
        language="python"
        handlers={options.handlers ?? handlers}
      />
    </div>,
  );
  return { controller, screen };
}

const box = () => {
  const element = document.querySelector<HTMLElement>("[data-notebook-cell-box]");
  if (element === null) throw new Error("The cell has no box.");
  return element.getBoundingClientRect();
};

describe("Ask in chat from a cell", () => {
  const action = (container: ParentNode) =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Ask in chat"]');

  it("offers a whole cell's quote on any cell with something in it", async () => {
    const ask = vi.fn();
    const { screen } = await mountCell(420, { handlers: { ...handlers, ask } });
    await using _screen = screen;
    await act(async () => action(screen.container)!.click());
    expect(ask).toHaveBeenCalledWith(cell.id);
  });

  it("has nothing to quote in an empty cell", async () => {
    const { screen } = await mountCell(420, { cells: [{ ...cell, source: "  \n" }] });
    await using _screen = screen;
    expect(action(screen.container)).toBeNull();
  });

  it("has no action where there is no chat", async () => {
    const { screen } = await mountCell(420, { handlers: { ...handlers, ask: null } });
    await using _screen = screen;
    expect(action(screen.container)).toBeNull();
  });

  it("keeps a selection dragged across code, and a plain click still edits", async () => {
    const edit = vi.fn();
    const { screen } = await mountCell(420, { handlers: { ...handlers, edit } });
    await using _screen = screen;
    const code = screen.container.querySelector<HTMLElement>("[data-notebook-cell-box] pre")!;
    const selection = window.getSelection()!;
    selection.selectAllChildren(code);
    await act(async () => code.click());
    expect(edit).not.toHaveBeenCalled();
    selection.removeAllRanges();
    await act(async () => code.click());
    expect(edit).toHaveBeenCalledOnce();
  });
});

describe.each([260, 420, 900])("NotebookCell layout at %ipx", (width) => {
  it("keeps every action off the code", async () => {
    await mountCell(width);
    const code = document.querySelector("[data-notebook-cell-box] pre")!.getBoundingClientRect();
    const actions = [...document.querySelectorAll<HTMLElement>("[data-notebook-cell] button")]
      .filter((button) => button.getAttribute("aria-label") !== null)
      .map((button) => button.getBoundingClientRect());
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      const overlaps =
        action.left < code.right &&
        action.right > code.left &&
        action.top < code.bottom &&
        action.bottom > code.top;
      expect(overlaps).toBe(false);
    }
  });

  it("opens the editor without moving anything", async () => {
    const { controller } = await mountCell(width);
    const before = box();
    await act(async () => controller.edit(cell.id, 5));
    await vi.waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    await vi.waitFor(() => expect(box().height).toBeCloseTo(before.height, 0));
    expect(box().top).toBeCloseTo(before.top, 0);
  });
});
