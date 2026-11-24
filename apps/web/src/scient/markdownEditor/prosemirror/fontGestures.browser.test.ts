// Replays font size and bold gestures in a real browser with real keystrokes on a throwaway
// document, and checks that no edit is refused and the file text stays as expected.
import { TextSelection } from "prosemirror-state";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { isMacKeyboard } from "../../keyboard/keys";
import { drawnPointsAt } from "../../writing/fontChoices";
import { selectionMarkValue } from "./selectionMarkValue";
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

/** Mod+Shift on a physical key, as the browser reports it: on a Mac, `key` stays unshifted. */
function pressSizeShortcut(target: HTMLElement, code: string, key: string) {
  const mac = isMacKeyboard();
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code,
      metaKey: mac,
      ctrlKey: !mac,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
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
    expect(draft(controller)).toBe("**alpha more**\n");
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

  describe("with the selection made by real keys, in the conditions that failed before", () => {
    /** Put the caret at `from`, then extend the selection to `to` with Shift+ArrowRight. */
    async function selectByKeys(view: ReturnType<typeof open>["view"], from: number, to: number) {
      select(view, from);
      // The editor reads the browser selection asynchronously, and on a slow machine it can
      // restore its last selection over a key press it hasn't read yet. Press one key at a
      // time and press again only if the selection did not move.
      const selected = () => [view.state.selection.from, view.state.selection.to];
      for (let end = from + 1; end <= to; end += 1) {
        for (let attempt = 1; ; attempt += 1) {
          await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
          try {
            await vi.waitFor(() => expect(selected()).toEqual([1 + from, 1 + end]), {
              timeout: 1_000,
            });
            break;
          } catch (error) {
            if (attempt === 3 || selected()[1] !== end) throw error;
          }
        }
      }
    }

    it("a space typed between a sized word and the next word is accepted", async () => {
      using editor = open("un bien mot\n");
      const { controller, view } = editor;
      await selectByKeys(view, 3, 7);
      controller.execute("font-size-14");
      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => expect(view.state.selection.empty).toBe(true));
      await userEvent.keyboard(" ");
      expect(refused(controller)).toBe(false);
      // Chromium types a non-breaking space before an existing space; it is a space for this rule.
      expect(draft(controller).replaceAll("\u00a0", " ")).toBe(
        `un <span style="font-size:14pt">bien</span>  mot\n`,
      );
    });

    it("italic over two differently sized words is accepted", async () => {
      using editor = open("aa bb cc\n");
      const { controller, view } = editor;
      await selectByKeys(view, 0, 2);
      controller.execute("font-size-14");
      await selectByKeys(view, 3, 5);
      controller.execute("font-size-20");
      await selectByKeys(view, 1, 4);
      controller.execute("italic");
      expect(refused(controller)).toBe(false);
    });

    it("removing bold from the last word of a bold phrase is accepted", async () => {
      using editor = open("**one two**\n");
      const { controller, view } = editor;
      await selectByKeys(view, 4, 7);
      controller.execute("bold");
      expect(refused(controller)).toBe(false);
      expect(draft(controller)).toBe("**one** two\n");
    });

    it("a size on the text after a sized line break is accepted", async () => {
      using editor = open("one  \ntwo three\n");
      const { controller, view } = editor;
      await selectByKeys(view, 0, 13);
      controller.execute("font-size-14");
      await selectByKeys(view, 4, 9);
      controller.execute("font-size-20");
      expect(refused(controller)).toBe(false);
    });
  });

  it("+ and − move each word of a mixed selection by one point and keep the field empty", () => {
    using editor = open(
      `<span style="font-size:11pt">alpha</span> <span style="font-size:20pt">beta</span> gamma\n`,
    );
    const { controller, view } = editor;
    const drawn = drawnPointsAt(view, 14)!;
    select(view, 0, 16);
    controller.stepFontSize(1);
    expect(refused(controller)).toBe(false);
    expect(draft(controller)).toBe(
      `<span style="font-size:12pt">alpha</span> <span style="font-size:21pt">beta</span> <span style="font-size:${drawn + 1}pt">gamma</span>\n`,
    );
    expect(selectionMarkValue(view.state, "font_size", "size", "number")).toEqual({
      value: null,
      mixed: true,
    });
    controller.stepFontSize(-1);
    expect(draft(controller)).toContain(`<span style="font-size:11pt">alpha</span>`);
  });

  it("+ on a heading word starts from the heading's drawn size", () => {
    using editor = open("# Title\n");
    const { controller, view } = editor;
    const drawn = drawnPointsAt(view, 2)!;
    select(view, 2);
    controller.stepFontSize(1);
    expect(draft(controller)).toBe(`# <span style="font-size:${drawn + 1}pt">Title</span>\n`);
  });

  it("Mod+Shift+. and Mod+Shift+, step the size of the selection, by key position", () => {
    using editor = open("alpha beta\n");
    const { controller, view } = editor;
    select(view, 0, 5);
    controller.execute("font-size-14");
    // macOS reports the unshifted character while Cmd and Shift are held; a French keyboard
    // has ":" and ";" on those two keys.
    pressSizeShortcut(view.dom, "Period", ".");
    pressSizeShortcut(view.dom, "Period", ":");
    expect(draft(controller)).toBe(`<span style="font-size:16pt">alpha</span> beta\n`);
    pressSizeShortcut(view.dom, "Comma", ",");
    expect(draft(controller)).toBe(`<span style="font-size:15pt">alpha</span> beta\n`);
  });
});
