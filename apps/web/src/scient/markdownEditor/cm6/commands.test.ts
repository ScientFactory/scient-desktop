// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  insertBlockTemplate,
  insertImageTemplate,
  insertLineBreak,
  insertLink,
  setLineBlockStyle,
  setParagraph,
  toggleDirection,
  toggleLinePrefix,
  toggleNumberedList,
  toggleWrap,
} from "./commands";

const views: EditorView[] = [];

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  document.body.replaceChildren();
});

function makeView(doc: string, anchor = 0, head = anchor): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor, head } }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

describe("CM6 markdown commands", () => {
  it("toggles an inline wrap on and off from the same selection", () => {
    const view = makeView("alpha", 0, 5);
    toggleWrap(view, "**");
    expect(view.state.doc.toString()).toBe("**alpha**");

    toggleWrap(view, "**");
    expect(view.state.doc.toString()).toBe("alpha");
  });

  it("unwraps when the selection includes the markers", () => {
    const view = makeView("**alpha**", 0, 9);
    toggleWrap(view, "**");
    expect(view.state.doc.toString()).toBe("alpha");
  });

  it("toggles a heading prefix on every selected line", () => {
    const view = makeView("one\ntwo", 0, 7);
    toggleLinePrefix(view, "## ");
    expect(view.state.doc.toString()).toBe("## one\n## two");

    toggleLinePrefix(view, "## ");
    expect(view.state.doc.toString()).toBe("one\ntwo");
  });

  it("numbers selected lines with increasing ordinals and removes them again", () => {
    const view = makeView("one\ntwo\nthree", 0, 13);
    toggleNumberedList(view);
    expect(view.state.doc.toString()).toBe("1. one\n2. two\n3. three");

    const numbered = makeView("1. one\n2. two", 0, 13);
    toggleNumberedList(numbered);
    expect(numbered.state.doc.toString()).toBe("one\ntwo");
  });

  it("resets headings and quotes to plain paragraphs", () => {
    const view = makeView("## one\n> two", 0, 12);
    expect(setParagraph(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("one\ntwo");

    expect(setParagraph(view)).toBe(false);
  });

  it("sets one block style across every selected line instead of toggling markers", () => {
    const view = makeView("# one\n> two", 2, 11);
    expect(setLineBlockStyle(view, "## ")).toBe(true);
    expect(view.state.doc.toString()).toBe("## one\n## two");

    expect(setLineBlockStyle(view, "## ")).toBe(false);
    expect(view.state.doc.toString()).toBe("## one\n## two");
  });

  it("places the caret after a style marker on an empty line", () => {
    const view = makeView("");
    expect(setLineBlockStyle(view, "> ")).toBe(true);
    expect(view.state.doc.toString()).toBe("> ");
    expect(view.state.selection.main.head).toBe(2);
  });

  it("wraps the selection in a link with the url selected", () => {
    const view = makeView("alpha", 0, 5);
    insertLink(view);
    expect(view.state.doc.toString()).toBe("[alpha](url)");
    const selection = view.state.selection.main;
    expect(view.state.sliceDoc(selection.from, selection.to)).toBe("url");
  });

  it("inserts an image template with the alt text selected", () => {
    const view = makeView("");
    insertImageTemplate(view);
    expect(view.state.doc.toString()).toBe("![alt](url)");
    const selection = view.state.selection.main;
    expect(view.state.sliceDoc(selection.from, selection.to)).toBe("alt");
  });

  it("inserts a hard line break at the cursor", () => {
    const view = makeView("one two", 3);
    insertLineBreak(view);
    expect(view.state.doc.toString()).toBe("one\\\n two");
    expect(view.state.selection.main.head).toBe(5);
  });

  it("places the cursor inside an inserted block template", () => {
    const view = makeView("before\n\nafter", 7);
    insertBlockTemplate(view, "```\n\n```");
    expect(view.state.doc.toString()).toBe("before\n```\n\n```\nafter");
    expect(view.state.selection.main.head).toBe(11);
  });

  it("wraps and unwraps a text-direction region", () => {
    const view = makeView("alpha", 0);
    toggleDirection(view, "rtl");
    expect(view.state.doc.toString()).toBe('<div dir="rtl">\nalpha\n</div>');

    toggleDirection(view, "rtl");
    expect(view.state.doc.toString()).toBe("alpha");
  });
});
