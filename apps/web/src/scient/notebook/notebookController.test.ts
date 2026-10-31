import type {
  NotebookCellView,
  NotebookEdit,
  NotebookEditResult,
  NotebookView,
} from "@t3tools/contracts";
import { notebookCodeHash } from "@t3tools/shared/notebookStaleness";
import { describe, expect, it, vi } from "vite-plus/test";

import { createNotebookController, type NotebookTransport } from "./notebookController";

const cell = (id: string, source = ""): NotebookCellView => ({
  id,
  cellType: "code",
  source,
  executionCount: null,
  run: null,
  pendingExecution: null,
  outputs: [],
});

const view = (cells: ReadonlyArray<NotebookCellView>): NotebookView => ({
  revision: "1.0",
  language: "python",
  cells,
});

function fakeTransport(initial: NotebookView) {
  const sent: Array<ReadonlyArray<NotebookEdit>> = [];
  const errors: string[] = [];
  let current = initial;
  let refused: ReadonlyArray<string> = [];
  let failEdits = false;
  let release: (() => void) | null = null;
  let hold = false;
  const transport: NotebookTransport = {
    read: async () => current,
    readOutput: async () => null,
    edit: async (edits): Promise<NotebookEditResult | null> => {
      sent.push(edits);
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      if (failEdits) return null;
      const answer = { revision: `1.${sent.length}`, refused };
      refused = [];
      return answer;
    },
    recordRun: async () => null,
    onError: (title) => errors.push(title),
    onNotice: (title) => errors.push(title),
  };
  return {
    transport,
    sent,
    errors,
    setFailing: (failing: boolean) => (failEdits = failing),
    otherWriter: (next: NotebookView, cells: ReadonlyArray<string>) => {
      current = next;
      refused = cells;
    },
    hold: () => (hold = true),
    release: () => {
      hold = false;
      release?.();
    },
  };
}

const opened = async (cells: ReadonlyArray<NotebookCellView>) => {
  const fake = fakeTransport(view(cells));
  const controller = createNotebookController(fake.transport);
  controller.fileChanged("first");
  await vi.waitFor(() => expect(controller.store.getState().status).toBe("ready"));
  return { fake, controller };
};

describe("notebookController", () => {
  it("says what each edit was made from, following its own edits", async () => {
    const { fake, controller } = await opened([cell("a", "old")]);
    controller.setSource("a", "new");
    await controller.flush();
    controller.setSource("a", "newer");
    await controller.flush();
    expect(fake.sent).toEqual([
      [{ _tag: "set-source", cellId: "a", source: "new", base: notebookCodeHash("old") }],
      [{ _tag: "set-source", cellId: "a", source: "newer", base: notebookCodeHash("new") }],
    ]);
  });

  it("shows the other writer's change and keeps what was typed in a new cell", async () => {
    const { fake, controller } = await opened([cell("a", "old"), cell("b", "other")]);
    fake.otherWriter(view([cell("a", "theirs"), cell("b", "other")]), ["a"]);
    controller.edit("a", "end");
    controller.setSource("a", "mine");
    await controller.flush();
    await vi.waitFor(() => expect(controller.store.getState().order).toHaveLength(3));
    const state = controller.store.getState();
    const [first, kept, last] = state.order;
    expect(first).toBe("a");
    expect(last).toBe("b");
    expect(state.cells.a?.source).toBe("theirs");
    expect(state.cells[kept!]?.source).toBe("mine");
    expect(state.editing).toBe(kept);
    expect(fake.errors).toHaveLength(1);
  });

  it("reads a file change that came during typing once the text has gone", async () => {
    const { fake, controller } = await opened([cell("a", "old"), cell("b", "theirs")]);
    controller.setSource("a", "mine");
    fake.otherWriter(view([cell("a", "mine"), cell("b", "changed")]), []);
    controller.fileChanged("second");
    expect(controller.store.getState().cells.b?.source).toBe("theirs");
    await controller.flush();
    await vi.waitFor(() => expect(controller.store.getState().cells.b?.source).toBe("changed"));
    expect(controller.store.getState().cells.a?.source).toBe("mine");
  });

  it("sends one edit for a burst of typing, with the last text", async () => {
    const { fake, controller } = await opened([cell("a")]);
    controller.setSource("a", "x");
    controller.setSource("a", "xy");
    controller.setSource("a", "xyz");
    await controller.flush();
    expect(fake.sent).toEqual([
      [{ _tag: "set-source", cellId: "a", source: "xyz", base: notebookCodeHash("") }],
    ]);
    expect(controller.store.getState().cells.a?.source).toBe("xyz");
  });

  it("keeps edits in order while one is on its way", async () => {
    const { fake, controller } = await opened([cell("a"), cell("b")]);
    fake.hold();
    controller.move("b", -1);
    controller.setSource("a", "later");
    fake.release();
    await controller.flush();
    expect(fake.sent.flat().map((edit) => edit._tag)).toEqual(["move", "set-source"]);
  });

  it("does not let a file change replace edits still on their way", async () => {
    const { fake, controller } = await opened([cell("a", "saved")]);
    controller.setSource("a", "typing");
    controller.fileChanged("second");
    fake.otherWriter(view([cell("a", "typing")]), []);
    await controller.flush();
    expect(controller.store.getState().cells.a?.source).toBe("typing");
    expect(fake.errors).toEqual([]);
  });

  it("keeps what was typed when a save fails, says so once, and sends it later", async () => {
    const { fake, controller } = await opened([cell("a", "saved")]);
    fake.setFailing(true);
    controller.setSource("a", "typed");
    await controller.flush();
    await controller.flush();
    expect(fake.errors).toEqual(["This notebook could not be saved. Trying again."]);
    expect(controller.store.getState().cells.a?.source).toBe("typed");
    fake.setFailing(false);
    await controller.flush();
    expect(fake.sent.at(-1)).toEqual([
      { _tag: "set-source", cellId: "a", source: "typed", base: notebookCodeHash("saved") },
    ]);
  });

  it("puts a deleted cell back where it was", async () => {
    const { controller } = await opened([cell("a"), cell("b"), cell("c")]);
    const removed = controller.remove("b");
    expect(controller.store.getState().order).toEqual(["a", "c"]);
    controller.restore("b", removed?.after ?? null);
    expect(controller.store.getState().order).toEqual(["a", "b", "c"]);
    await controller.flush();
  });

  it("marks a cell expecting a run straight away", async () => {
    const { fake, controller } = await opened([cell("a")]);
    controller.expectRuns([{ cellId: "a", execution: "run-1" }]);
    expect(controller.store.getState().cells.a?.pendingExecution).toBe("run-1");
    await controller.flush();
    expect(fake.sent.flat()).toEqual([{ _tag: "expect-run", cellId: "a", execution: "run-1" }]);
  });
});
