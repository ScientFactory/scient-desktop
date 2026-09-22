// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Editor } from "@pierre/diffs/editor";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo, redo } from "prosemirror-history";
import {
  scientMarkdownParser,
  scientMarkdownSchema,
  scientMarkdownSerializer,
} from "~/scient/markdownEditor/prosemirror/schema";
import { markdownMathController } from "./markdownAdapter";
import {
  sourceMathController,
  sourceMathOwnsEvent,
  sourceOffset,
  sourcePosition,
} from "./sourceAdapter";

afterEach(() => document.body.replaceChildren());

describe("host editor integration", () => {
  it("inserts a schema equation with native undo/redo and a faithful Markdown round trip", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const doc = scientMarkdownParser.parse("Before x+1 after\n");
    const view = new EditorView(host, {
      state: EditorState.create({
        doc,
        schema: scientMarkdownSchema,
        selection: TextSelection.create(doc, 8, 11),
        plugins: [history()],
      }),
    });
    const controller = markdownMathController(() => view);
    expect(controller.execute("math.fraction")).toBe(true);
    expect(scientMarkdownSerializer.serialize(view.state.doc)).toBe(
      "Before \\(\\frac{x+1}{}\\) after",
    );
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(scientMarkdownSerializer.serialize(view.state.doc)).toBe("Before x+1 after");
    expect(redo(view.state, view.dispatch)).toBe(true);
    const saved = scientMarkdownSerializer.serialize(view.state.doc);
    expect(scientMarkdownParser.parse(saved).eq(view.state.doc)).toBe(true);
    view.destroy();
  });
  it("creates display math without dropping either half of a paragraph", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const doc = scientMarkdownParser.parse("Before after");
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 8) }),
    });
    expect(markdownMathController(() => view).matrix("pmatrix", 2, 2)).toBe(true);
    const saved = scientMarkdownSerializer.serialize(view.state.doc);
    expect(saved).toContain("Before");
    expect(saved).toContain("after");
    expect(saved).toContain("\\begin{pmatrix}");
    expect(view.state.doc.childCount).toBe(3);
    view.destroy();
  });
  it("round trips an inserted Greek command including its terminating space", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const doc = scientMarkdownParser.parse("Before after");
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 8) }),
    });
    expect(markdownMathController(() => view).execute("math.symbol.alpha")).toBe(true);
    const saved = scientMarkdownSerializer.serialize(view.state.doc);
    expect(saved).toContain("\\(\\alpha \\)");
    expect(scientMarkdownParser.parse(saved).eq(view.state.doc)).toBe(true);
    view.destroy();
  });
  it("round trips a new blank inline equation", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const doc = scientMarkdownParser.parse("Before after");
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 8) }),
    });
    expect(markdownMathController(() => view).execute("math.inline")).toBe(true);
    expect(
      scientMarkdownParser
        .parse(scientMarkdownSerializer.serialize(view.state.doc))
        .eq(view.state.doc),
    ).toBe(true);
    view.destroy();
  });
  it("does not insert math into code or a read-only document", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const doc = scientMarkdownParser.parse("```tex\nx\n```\n");
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 1) }),
    });
    expect(markdownMathController(() => view).execute("math.symbol.alpha")).toBe(false);
    view.setProps({ editable: () => false });
    expect(markdownMathController(() => view).execute("math.inline")).toBe(false);
    view.destroy();
  });
  it("does not retarget an open palette to identical text at another position", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const doc = scientMarkdownParser.parse("x and x");
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 1, 2) }),
    });
    const controller = markdownMathController(() => view);
    controller.open();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7, 8)));
    expect(controller.execute("math.fraction")).toBe(false);
    expect(view.state.doc.eq(doc)).toBe(true);
    view.destroy();
  });
  it("maps source selections in UTF-16 across Windows and Unicode lines", () => {
    const source = "Hello\r\nα 😀\r\nlast";
    for (const offset of [0, 4, 7, 8, 11, 13, source.length])
      expect(sourceOffset(source, sourcePosition(source, offset))).toBe(offset);
    const legacy = "first\rα 😀\rlast";
    for (const offset of [0, 6, 8, 11, legacy.length])
      expect(sourceOffset(legacy, sourcePosition(legacy, offset))).toBe(offset);
  });
  it("claims source keystrokes through a shadow root but not search or annotation controls", () => {
    const host = document.createElement("div"),
      shadow = host.attachShadow({ mode: "open" });
    const content = document.createElement("div");
    content.setAttribute("data-content", "");
    content.setAttribute("contenteditable", "true");
    const input = document.createElement("input");
    shadow.append(content, input);
    document.body.append(host);
    let owned = false;
    host.addEventListener("keydown", (event) => {
      owned = sourceMathOwnsEvent(event);
    });
    const event = () =>
      new KeyboardEvent("keydown", { key: "m", altKey: true, bubbles: true, composed: true });
    content.dispatchEvent(event());
    expect(owned).toBe(true);
    input.dispatchEvent(event());
    expect(owned).toBe(false);
    const comment = document.createElement("textarea");
    content.append(comment);
    comment.dispatchEvent(event());
    expect(owned).toBe(false);
  });
  it("uses one source-editor edit and places the caret in the new fraction slot", () => {
    let source = "Value $x+1$.";
    let selections = [
      {
        start: sourcePosition(source, 7),
        end: sourcePosition(source, 10),
        direction: "forward" as const,
      },
    ];
    const applyEdits = vi.fn(
      (
        edits: Array<{
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
          newText: string;
        }>,
      ) => {
        for (const edit of edits)
          source =
            source.slice(0, sourceOffset(source, edit.range.start)) +
            edit.newText +
            source.slice(sourceOffset(source, edit.range.end));
      },
    );
    const editor = {
      isComposing: false,
      getState: () => ({ selections }),
      getFile: () => ({ name: "main.tex", contents: source }),
      getText: () => source,
      applyEdits,
      setSelections: (next: typeof selections) => {
        selections = next;
      },
      focus: vi.fn(),
    };
    const controller = sourceMathController(
      editor as unknown as Editor<never>,
      "latex",
      () => true,
    );
    expect(controller.execute("math.fraction")).toBe(true);
    expect(applyEdits).toHaveBeenCalledOnce();
    expect(source).toBe("Value $\\frac{x+1}{}$.");
    expect(source[sourceOffset(source, selections[0]!.start)]).toBe("}");
    editor.isComposing = true;
    expect(controller.execute("math.symbol.alpha")).toBe(false);
    expect(applyEdits).toHaveBeenCalledOnce();
  });
});
