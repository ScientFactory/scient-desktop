import { describe, expect, it } from "vite-plus/test";

import { notebookCommand } from "./notebookCommands";

const press = (key: string, modifiers = {}) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...modifiers,
});

describe("notebookCommand", () => {
  it("maps Jupyter's single keys", () => {
    expect(notebookCommand(press("a"), null, 0)).toBe("insert-above");
    expect(notebookCommand(press("Enter"), null, 0)).toBe("edit");
    expect(notebookCommand(press("Enter", { shiftKey: true }), null, 0)).toBe("run-and-next");
    expect(notebookCommand(press("Enter", { metaKey: true }), null, 0)).toBe("run");
  });

  it("needs a quick second press to delete or interrupt", () => {
    expect(notebookCommand(press("d"), null, 1000)).toBeNull();
    expect(notebookCommand(press("d"), { key: "d", at: 900 }, 1000)).toBe("delete");
    expect(notebookCommand(press("d"), { key: "d", at: 100 }, 1000)).toBeNull();
    expect(notebookCommand(press("i"), { key: "i", at: 900 }, 1000)).toBe("interrupt");
  });

  it("leaves other chords to the app", () => {
    expect(notebookCommand(press("a", { metaKey: true }), null, 0)).toBeNull();
    expect(notebookCommand(press("x"), null, 0)).toBeNull();
  });
});
