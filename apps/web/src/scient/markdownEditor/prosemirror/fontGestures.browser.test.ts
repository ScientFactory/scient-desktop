// Replays font size and bold gestures in a real browser with real keystrokes on a throwaway
// document, and checks that no edit is refused and the file text stays as expected.
import { TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { ScientMarkdownEditorView } from "./view";

/** Mounts an editor on a throwaway host; `using` destroys both when the test ends. */
function open(source: string) {
  const controller = new ScientMarkdownEditorView({
    source,
    revision: "gesture-fixture",
    mode: "write",
    ariaLabel: "Gesture fixture",
  });
  const host = document.createElement("div");
  document.body.append(host);
  const view = controller.mount(host);
  view.focus();
  return {
    controller,
    view,
    [Symbol.dispose]() {
      controller.destroy();
      host.remove();
    },
  };
}

/** Select text offsets of the first paragraph (0 = start of its text). */
function select(view: ReturnType<typeof open>["view"], from: number, to = from) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + from, 1 + to)));
  view.focus();
}

const draft = (controller: ScientMarkdownEditorView) => controller.session.session.draftSource;
const refused = (controller: ScientMarkdownEditorView) =>
  controller.session.pendingWriteback !== null;

describe("font gestures in a real browser", () => {
  it("typing a space then a word at the end of a sized word is accepted and continues the size", async () => {
    using editor = open("alpha beta\n");
    const { controller, view } = editor;
    select(view, 0, 5);
    controller.execute("font-size-14");
    select(view, 5);
    await userEvent.keyboard(" gamma");
    expect(refused(controller)).toBe(false);
    expect(draft(controller)).toBe(`<span style="font-size:14pt">alpha gamma</span> beta\n`);
  });

  it("applying a size to a selection that ends with a space does not size the space", async () => {
    using editor = open("alpha beta\n");
    const { controller, view } = editor;
    select(view, 0, 6);
    controller.execute("font-size-14");
    expect(refused(controller)).toBe(false);
    expect(draft(controller)).toBe(`<span style="font-size:14pt">alpha</span> beta\n`);
  });

  it("typing a space after a bold word is accepted", async () => {
    using editor = open("**alpha**\n");
    const { controller, view } = editor;
    select(view, 5);
    await userEvent.keyboard(" more");
    expect(refused(controller)).toBe(false);
    expect(draft(controller)).toContain("more");
  });

  it("holding Enter after a sized word never refuses and keeps the size on the first line only", async () => {
    using editor = open("alpha\n");
    const { controller, view } = editor;
    select(view, 0, 5);
    controller.execute("font-size-14");
    select(view, 5);
    await userEvent.keyboard("{Enter}".repeat(8));
    expect(refused(controller)).toBe(false);
    expect(draft(controller).startsWith(`<span style="font-size:14pt">alpha</span>`)).toBe(true);
    expect(draft(controller).match(/font-size/gu)).toHaveLength(1);
  });

  it("removing the size from a sized word restores plain text", async () => {
    using editor = open(`<span style="font-size:14pt">alpha</span> beta\n`);
    const { controller, view } = editor;
    select(view, 0, 5);
    controller.execute("font-size-default");
    expect(refused(controller)).toBe(false);
    expect(draft(controller)).toBe("alpha beta\n");
  });

  it("a lone space typed after a bold word is accepted", async () => {
    using editor = open("alpha **beta**\n");
    const { controller, view } = editor;
    select(view, 10);
    await userEvent.keyboard(" ");
    expect(refused(controller)).toBe(false);
  });

  it("a lone space typed after a sized word is accepted", async () => {
    using editor = open(`alpha <span style="font-size:14pt">beta</span>\n`);
    const { controller, view } = editor;
    select(view, 10);
    await userEvent.keyboard(" ");
    expect(refused(controller)).toBe(false);
  });

  it("removing bold from the last word of a paragraph is accepted", async () => {
    using editor = open("alpha **beta**\n");
    const { controller, view } = editor;
    select(view, 6, 10);
    controller.execute("bold");
    expect(refused(controller)).toBe(false);
    expect(draft(controller)).toBe("alpha beta\n");
  });

  it("a size applied across a selection ending after a bold word is accepted", async () => {
    using editor = open("alpha **beta** gamma\n");
    const { controller, view } = editor;
    select(view, 0, 11);
    controller.execute("font-size-18");
    expect(refused(controller)).toBe(false);
  });
});
