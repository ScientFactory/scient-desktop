// @vitest-environment happy-dom

import { TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { scientMarkdownParser } from "./schema";
import { resolveScientMarkdownDocumentDirection } from "./directionPresentation";
import { ScientMarkdownEditorView } from "./view";

describe("rich Markdown direction presentation", () => {
  const mounted: ScientMarkdownEditorView[] = [];

  afterEach(() => {
    mounted.splice(0).forEach((controller) => controller.destroy());
    document.body.replaceChildren();
  });

  function mount(source: string) {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Markdown document",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    return { controller, onUserSourceChange, view: controller.mount(host) };
  }

  function inheritedDirection(element: Element | null): string | null {
    return element?.closest("[dir]")?.getAttribute("dir") ?? null;
  }

  it("derives the document base from visible prose rather than technical source", () => {
    const document = scientMarkdownParser.parse(
      [
        "English prose remains the document language.",
        "",
        "```text",
        "שלום שלום שלום שלום שלום שלום",
        "```",
        "",
        "`עברית בתוך קוד`",
      ].join("\n"),
    );

    expect(resolveScientMarkdownDocumentDirection(document)).toBe("ltr");
    expect(
      resolveScientMarkdownDocumentDirection(
        scientMarkdownParser.parse("Methods\n\nשלום עולם, זהו מסמך עברי ארוך וברור מאוד.\n"),
      ),
    ).toBe("rtl");
  });

  it("matches ordinary Markdown direction for mixed prose and structural blocks", () => {
    const source = [
      "# Methods and Results",
      "",
      "English-only paragraph.",
      "",
      "שלום עולם, זהו מסמך עברי עם תוכן נוסף.",
      "",
      "> ציטוט עברי ברור.",
      "",
      "- RF — רגיש מאוד",
      "- Anti-CCP — ספציפי מאוד",
      "",
      "1. Standard deviation",
      "2. Confidence interval",
      "",
      "- [ ] משימה פתוחה",
      "",
      "| Name | ערך |",
      "| --- | --- |",
      "| OA | אוטואימונית |",
      "",
    ].join("\n");
    const { controller, onUserSourceChange, view } = mount(source);

    expect(view.dom.dir).toBe("ltr");
    expect(inheritedDirection(view.dom.querySelector("h1"))).toBe("ltr");
    const paragraphs = Array.from(view.dom.querySelectorAll("p"));
    expect(
      inheritedDirection(
        paragraphs.find((node) => node.textContent === "English-only paragraph.") ?? null,
      ),
    ).toBe("ltr");
    expect(
      inheritedDirection(
        paragraphs.find((node) => node.textContent?.startsWith("שלום עולם")) ?? null,
      ),
    ).toBe("rtl");
    expect(inheritedDirection(view.dom.querySelector("blockquote"))).toBe("rtl");
    expect(inheritedDirection(view.dom.querySelector("ul"))).toBe("rtl");
    expect(inheritedDirection(view.dom.querySelector("ol"))).toBe("ltr");
    const task = view.dom.querySelector("li[data-task-checked]");
    expect(inheritedDirection(task)).toBe("rtl");
    expect(inheritedDirection(view.dom.querySelector("table"))).toBe("rtl");
    expect(
      Array.from(view.dom.querySelectorAll("th, td")).map((cell) => [
        cell.textContent,
        inheritedDirection(cell),
      ]),
    ).toEqual([
      ["Name", "ltr"],
      ["ערך", "rtl"],
      ["OA", "ltr"],
      ["אוטואימונית", "rtl"],
    ]);
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("keeps cell text flow independent from manual table layout and restores Auto", () => {
    const source = [
      "| Label | Details |",
      "| --- | --- |",
      "| English | A sentence, with punctuation. |",
      "| Mixed RTL | English בתוך עברית נוספת. |",
      "| Mixed LTR | English sentence with עברית. |",
      "| Arabic | العربية فقط. |",
      "| Neutral | 123 — — |",
      "",
    ].join("\n");
    const { controller, onUserSourceChange, view } = mount(source);
    const table = view.dom.querySelector("table")!;
    const cells = Array.from(view.dom.querySelectorAll("th, td"));
    const directionFor = (text: string) =>
      inheritedDirection(cells.find((cell) => cell.textContent === text) ?? null);

    expect(inheritedDirection(table)).toBe("ltr");
    expect(directionFor("A sentence, with punctuation.")).toBe("ltr");
    expect(directionFor("English בתוך עברית נוספת.")).toBe("rtl");
    expect(directionFor("English sentence with עברית.")).toBe("ltr");
    expect(directionFor("العربية فقط.")).toBe("rtl");
    expect(directionFor("123 — —")).toBe("ltr");
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    let firstCellPosition: number | null = null;
    view.state.doc.descendants((node, position) => {
      if (firstCellPosition === null && node.type.spec.tableRole === "header_cell") {
        firstCellPosition = position;
        return false;
      }
      return true;
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, firstCellPosition! + 2)),
    );
    expect(controller.execute("direction-rtl")).toBe(true);

    expect(table.getAttribute("dir")).toBe("rtl");
    expect(inheritedDirection(table)).toBe("rtl");
    expect(directionFor("A sentence, with punctuation.")).toBe("ltr");
    expect(directionFor("English בתוך עברית נוספת.")).toBe("rtl");
    expect(directionFor("English sentence with עברית.")).toBe("ltr");
    expect(directionFor("العربية فقط.")).toBe("rtl");
    expect(directionFor("123 — —")).toBe("ltr");
    expect(controller.session.session.draftSource).toContain('<div dir="rtl">');

    expect(controller.execute("direction-auto")).toBe(true);
    expect(table.getAttribute("dir")).toBeNull();
    expect(inheritedDirection(table)).toBe("ltr");
    expect(directionFor("English בתוך עברית נוספת.")).toBe("rtl");
    expect(directionFor("English sentence with עברית.")).toBe("ltr");
    expect(directionFor("123 — —")).toBe("ltr");
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).toHaveBeenCalled();
  });

  it("keeps explicit direction authoritative and recomputes automatic direction after edits", () => {
    const source = '<div dir="ltr">\n\nשלום עולם.\n\n</div>\n';
    const { controller, view } = mount(source);
    const paragraph = view.dom.querySelector("p")!;

    expect(view.dom.dir).toBe("rtl");
    expect(paragraph.dir).toBe("ltr");
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1))
        .insertText("English replacement."),
    );

    expect(view.dom.dir).toBe("ltr");
    expect(view.dom.querySelector("p")?.dir).toBe("ltr");
    expect(controller.session.session.draftSource).toContain("English replacement.");
  });

  it("updates only a changed automatic block while the document base stays stable", () => {
    const { controller, view } = mount(
      "This English document has enough ordinary prose to keep its stable base direction.\n\nשלום עולם.\n",
    );
    let hebrewPosition: number | null = null;
    view.state.doc.descendants((node, position) => {
      if (node.type.name === "paragraph" && node.textContent === "שלום עולם.") {
        hebrewPosition = position;
        return false;
      }
      return true;
    });
    expect(hebrewPosition).not.toBeNull();
    const hebrewParagraph = Array.from(view.dom.querySelectorAll("p")).find(
      (node) => node.textContent === "שלום עולם.",
    );
    expect(view.dom.dir).toBe("ltr");
    expect(inheritedDirection(hebrewParagraph ?? null)).toBe("rtl");

    const node = view.state.doc.nodeAt(hebrewPosition!);
    view.dispatch(
      view.state.tr.insertText(
        "English replacement.",
        hebrewPosition! + 1,
        hebrewPosition! + 1 + (node?.content.size ?? 0),
      ),
    );

    const replacement = Array.from(view.dom.querySelectorAll("p")).find(
      (paragraph) => paragraph.textContent === "English replacement.",
    );
    expect(view.dom.dir).toBe("ltr");
    expect(inheritedDirection(replacement ?? null)).toBe("ltr");
    expect(controller.session.session.draftSource).toContain("English replacement.");
  });

  it("mirrors only eligible RTL prose arrows without changing source or copied text", () => {
    const source = [
      "שלב ראשון → שלב שני.",
      "",
      "[קישור → עברי](other.md)",
      "",
      "`קוד → עברי`",
      "",
      "עברית: H2O → CO2",
      "",
      "שלב ⟶ הבא",
      "",
    ].join("\n");
    const { controller, onUserSourceChange, view } = mount(source);
    const arrows = Array.from(
      view.dom.querySelectorAll<HTMLElement>(".scient-markdown-rtl-flow-arrow"),
    );

    expect(arrows).toHaveLength(2);
    expect(arrows.map((arrow) => arrow.textContent)).toEqual(["→", "⟶"]);
    expect(arrows[1]?.classList.contains("is-long")).toBe(true);
    expect(view.dom.querySelector("a")?.textContent).toBe("קישור → עברי");
    expect(view.dom.querySelector("code")?.textContent).toBe("קוד → עברי");
    expect(controller.session.session.draftSource).toBe(source);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });
});
