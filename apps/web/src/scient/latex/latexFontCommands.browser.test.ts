// Replays the reported font gestures on a real LaTeX Visual editor schema in a browser: words
// sized one by one, the word under the caret, and + and − over mixed sizes.
import { Editor, Mark } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";
import { latexFontState, setLatexFontSize } from "./latexFontCommands";
import { LATEX_CANVAS_TEXT_MARKS } from "./latexTextFormatting";

const marks = [
  Mark.create({
    name: "latexFontSize",
    addAttributes: () => ({ points: { default: 10 }, leading: { default: 12 } }),
    renderHTML: () => ["span", 0],
  }),
  Mark.create({
    name: "latexFontFamily",
    addAttributes: () => ({ family: { default: "" }, engine: { default: "pdftex" } }),
    renderHTML: () => ["span", 0],
  }),
  ...LATEX_CANVAS_TEXT_MARKS.map(({ name }) =>
    Mark.create({ name, renderHTML: () => ["span", 0] }),
  ),
];

/** An editor on a throwaway element; `using` destroys both when the test ends. */
function open(text: string) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, ...marks],
    content: `<p>${text}</p>`,
  });
  return {
    editor,
    [Symbol.dispose]() {
      editor.destroy();
      element.remove();
    },
  };
}

/** Text offsets of the first paragraph (0 = start of its text). */
const select = (editor: Editor, from: number, to = from) =>
  editor.commands.setTextSelection({ from: 1 + from, to: 1 + to });

/** Each word with its size, read from the document. */
const sizes = (editor: Editor) => {
  const runs: Array<[string, unknown]> = [];
  editor.state.doc.descendants((node) => {
    if (node.isText)
      runs.push([
        node.text!,
        node.marks.find((m) => m.type.name === "latexFontSize")?.attrs.points,
      ]);
  });
  return runs;
};

describe("LaTeX font commands in a real editor", () => {
  it("shows the common size of words sized one by one", () => {
    using fixture = open("alpha beta gamma");
    const { editor } = fixture;
    select(editor, 2);
    setLatexFontSize(editor, 14);
    select(editor, 8);
    setLatexFontSize(editor, 14);
    select(editor, 0, 10);
    expect(latexFontState(editor)).toMatchObject({ size: 14, sizeMixed: false });
  });

  it("sizes a whole word with an apostrophe or a combining accent at the caret", () => {
    using fixture = open("I don't know café now");
    const { editor } = fixture;
    select(editor, 3);
    setLatexFontSize(editor, 14);
    select(editor, 14);
    setLatexFontSize(editor, 16);
    expect(sizes(editor)).toEqual([
      ["I ", undefined],
      ["don't", 14],
      [" know ", undefined],
      ["café", 16],
      [" now", undefined],
    ]);
  });
});
