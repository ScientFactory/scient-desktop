import { Schema, Slice } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { describe, expect, it } from "vite-plus/test";
import {
  applyLatexVisualDocumentChange,
  latexVisualTableSource,
  projectLatexVisualDocument,
} from "./latexVisualDocument";
import {
  parseTypingDraft,
  rebindVisualTypingContent,
  reconcileVisualPendingContent,
  isOrdinaryTyping,
  isSourceOwnedTyping,
} from "./visualTyping";
import { serializedVisualDocument } from "./visualDocumentJson";
import { LatexSourceStep } from "./LatexSourceStep";

const syntaxAttrs = { sourceId: { default: null }, sourceMeta: { default: null } };
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", attrs: syntaxAttrs },
    bulletList: { group: "block", content: "listItem+", attrs: syntaxAttrs },
    orderedList: { group: "block", content: "listItem+", attrs: syntaxAttrs },
    listItem: { content: "block+", attrs: syntaxAttrs },
    text: {},
  },
  marks: { bold: {} },
});

describe("source-tracked typing classification", () => {
  const state = () =>
    EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(null, [
        schema.nodes.paragraph!.create(null, schema.text("First")),
        schema.nodes.paragraph!.create(null, schema.text("Second")),
      ]),
    });
  const annotation = () => new LatexSourceStep(0, 0, Slice.empty, { edit: null, inverse: null });

  it.each(["insert", "delete"] as const)(
    "classifies a tracked text %s and its undo without checking ownership at the history marker",
    (operation) => {
      const original = state();
      const position = original.doc.firstChild!.nodeSize + 2;
      const transaction =
        operation === "insert"
          ? original.tr.insertText("added", position)
          : original.tr.delete(position, position + 1);
      transaction.step(annotation());
      expect(isOrdinaryTyping(transaction)).toBe(true);
      expect(isSourceOwnedTyping(transaction, (index) => index === 1)).toBe(true);
      expect(isSourceOwnedTyping(transaction, () => false)).toBe(false);
      const undo = EditorState.create({ schema, doc: transaction.doc }).tr;
      for (let index = transaction.steps.length - 1; index >= 0; index--)
        undo.step(transaction.steps[index]!.invert(transaction.docs[index]!));
      expect(isOrdinaryTyping(undo)).toBe(true);
      expect(isSourceOwnedTyping(undo, (index) => index === 1)).toBe(true);
      expect(undo.doc.eq(original.doc)).toBe(true);
    },
  );

  it("does not classify history-only, arbitrary empty replacements or structural edits as typing", () => {
    const original = state();
    expect(isOrdinaryTyping(original.tr)).toBe(false);
    expect(isOrdinaryTyping(original.tr.step(annotation()))).toBe(false);
    expect(
      isOrdinaryTyping(original.tr.insertText("added", 2).step(new ReplaceStep(0, 0, Slice.empty))),
    ).toBe(false);
    expect(
      isOrdinaryTyping(
        original.tr.step(
          new LatexSourceStep(0, original.doc.firstChild!.nodeSize, Slice.empty, {
            edit: null,
            inverse: null,
          }),
        ),
      ),
    ).toBe(false);
  });
});

describe("reopened typing ownership", () => {
  it("recovers an inserted table and its edited cell from a journal without parser metadata", () => {
    const source = "Before";
    const baseline = projectLatexVisualDocument(source);
    const seed = latexVisualTableSource(2, 2, "grid");
    const table = structuredClone(projectLatexVisualDocument(seed).content.content![0]!);
    table.attrs!.sourceId = null;
    table.attrs!.rows[0][0] = "\\textbf{Recovered \\& safe}";
    const tableSchema = new Schema({
      nodes: schema.spec.nodes.addToEnd("latexRichPreview", {
        group: "block",
        atom: true,
        attrs: Object.fromEntries(
          Object.keys(table.attrs!).map((name) => [name, { default: null }]),
        ),
      }),
      marks: schema.spec.marks,
    });
    const input = { ...baseline.content, content: [...baseline.content.content!, table] };
    const journal = serializedVisualDocument(tableSchema.nodeFromJSON(input));
    const recovered = JSON.parse(journal);
    expect(recovered.content[1].attrs.sourceMeta).toBeUndefined();
    const rebound = rebindVisualTypingContent(recovered, baseline.content)!;
    const changed = applyLatexVisualDocumentChange(source, baseline, rebound)!;
    expect(changed.source).toBe(
      "Before\n\n" + seed.replace("\\textbf{}", "\\textbf{Recovered \\& safe}"),
    );
    const nativeTable = projectLatexVisualDocument(changed.source).content.content![1]!;
    expect(nativeTable.attrs!.rows).toEqual([
      ["\\textbf{Recovered \\& safe}", "\\textbf{}"],
      ["", ""],
    ]);
  });

  it("rebinds stored parser ranges while preserving the writer's input and untouched native bytes", () => {
    const source =
      "\\begin{itemize}\r\n  \\item First words\r\n  \\item Keep these bytes\r\n\\end{itemize}";
    const baseline = projectLatexVisualDocument(source);
    const recovered = structuredClone(baseline.content);
    const list = recovered.content![0]!;
    list.attrs = {
      ...list.attrs,
      sourceId: "retired-parser-block",
      sourceMeta: { from: 10000, to: 10001 },
    };
    const item = list.content![0]!;
    item.attrs = { ...item.attrs, sourceMeta: { from: 9999 } };
    item.content![0]!.content![0]!.text = "Recovered words";
    const content = rebindVisualTypingContent(recovered, baseline.content)!;
    const change = applyLatexVisualDocumentChange(source, baseline, content)!;
    expect(change.source).toBe(source.replace("First words", "Recovered words"));
    expect(
      change.edit.patches.every(
        (patch) =>
          patch.start >= source.indexOf("First words") &&
          patch.end <= source.indexOf("First words") + "First words".length,
      ),
    ).toBe(true);
    expect(recovered.content![0]!.attrs!.sourceId).toBe("retired-parser-block");
  });
  it("stores authored list input without native raw text or maps and rebuilds lossless syntax from its base", () => {
    const source =
      "\\begin{itemize}\r\n  \\item   First words\r\n  \\item Keep these bytes\r\n\\end{itemize}";
    const baseline = projectLatexVisualDocument(source);
    const input = structuredClone(baseline.content);
    input.content![0]!.content![0]!.content![0]!.content![0]!.text = "Recovered words";
    const encoded = serializedVisualDocument(schema.nodeFromJSON(input));
    const draft = parseTypingDraft(
      `{"baseSource":${JSON.stringify(source)},"content":${encoded}}`,
    )!;
    const list = draft.content.content![0]!;
    expect(encoded).not.toContain("First words");
    expect(list.attrs?.sourceId).toBeUndefined();
    expect(list.attrs?.sourceMeta).toBeUndefined();
    expect(list.content![0]!.attrs?.sourceMeta).toEqual({
      from: baseline.content.content![0]!.content![0]!.attrs!.sourceMeta.from,
    });
    const native = projectLatexVisualDocument(draft.baseSource);
    const rebound = rebindVisualTypingContent(draft.content, native.content)!;
    expect(applyLatexVisualDocumentChange(source, native, rebound)!.source).toBe(
      source.replace("First words", "Recovered words"),
    );
  });

  it("retains split-item intent without persisting the original list source map", () => {
    const source =
      "\\begin{itemize}\r\n  \\item   First words\r\n  \\item Keep these bytes\r\n\\end{itemize}";
    const baseline = projectLatexVisualDocument(source);
    const input = structuredClone(baseline.content);
    const list = input.content![0]!;
    const continuation = structuredClone(list.content![0]!);
    list.content![0]!.content![0]!.content![0]!.text = "First";
    continuation.content![0]!.content![0]!.text = "words";
    list.content!.splice(1, 0, continuation);
    const encoded = serializedVisualDocument(schema.nodeFromJSON(input));
    const recovered = JSON.parse(encoded);
    expect(recovered.content[0].attrs.sourceMeta).toBeUndefined();
    const rebound = rebindVisualTypingContent(recovered, baseline.content)!;
    const changed = applyLatexVisualDocumentChange(source, baseline, rebound)!;
    const nativeList = projectLatexVisualDocument(changed.source).content.content![0]!;
    expect(
      nativeList.content!.map((item) =>
        item.content![0]!.content!.map((node) => node.text ?? "").join(""),
      ),
    ).toEqual(["First", "words", "Keep these bytes"]);
    expect(changed.source).toBe(
      "\\begin{itemize}\r\n  \\item   First\r\n  \\item words\r\n  \\item Keep these bytes\r\n\\end{itemize}",
    );
  });

  it("refuses a recovered split whose hint points to another real item's valid offset", () => {
    const source =
      "\\begin{itemize}\r\n  \\item   First words\r\n\r\n    \\item Keep these bytes\r\n\\end{itemize}";
    const baseline = projectLatexVisualDocument(source);
    const input = structuredClone(baseline.content);
    const list = input.content![0]!;
    const continuation = structuredClone(list.content![0]!);
    list.content![0]!.content![0]!.content![0]!.text = "First";
    continuation.content![0]!.content![0]!.text = "words";
    // The number is valid native metadata, but it belongs to the other item.
    continuation.attrs!.sourceMeta = { from: list.content![1]!.attrs!.sourceMeta.from };
    list.content!.splice(1, 0, continuation);
    const draft = parseTypingDraft(
      `{"baseSource":${JSON.stringify(source)},"content":${serializedVisualDocument(schema.nodeFromJSON(input))}}`,
    )!;
    const retained = structuredClone(draft.content);
    expect(
      rebindVisualTypingContent(
        draft.content,
        projectLatexVisualDocument(draft.baseSource).content,
      ),
    ).toBeNull();
    expect(draft.content).toEqual(retained);
    expect(draft.baseSource).toBe(source);
    expect(
      draft.content.content![0]!.content!.map((item) => item.content![0]!.content![0]!.text),
    ).toEqual(["First", "words", "Keep these bytes"]);
  });

  it("recovers an exact split with CRLF, item spacing, and surviving native inline wrappers", () => {
    const source =
      "\\begin{itemize}\r\n  \\item   \\textbf{First words}\r\n    \\item Keep these bytes\r\n\\end{itemize}";
    const baseline = projectLatexVisualDocument(source);
    const input = structuredClone(baseline.content);
    const list = input.content![0]!;
    const continuation = structuredClone(list.content![0]!);
    list.content![0]!.content![0]!.content![0]!.text = "First";
    continuation.content![0]!.content![0]!.text = "words";
    list.content!.splice(1, 0, continuation);
    const recovered = JSON.parse(serializedVisualDocument(schema.nodeFromJSON(input)));
    const rebound = rebindVisualTypingContent(recovered, baseline.content)!;
    expect(applyLatexVisualDocumentChange(source, baseline, rebound)!.source).toBe(
      "\\begin{itemize}\r\n  \\item   \\textbf{First}\r\n    \\item \\textbf{words}\r\n    \\item Keep these bytes\r\n\\end{itemize}",
    );
  });

  it("retains split input when indistinguishable native items make its origin ambiguous", () => {
    const source = "\\begin{itemize}\n\\item Same words\n  \\item Same words\n\\end{itemize}";
    const baseline = projectLatexVisualDocument(source);
    const input = structuredClone(baseline.content);
    const list = input.content![0]!;
    const continuation = structuredClone(list.content![0]!);
    list.content![0]!.content![0]!.content![0]!.text = "Same";
    continuation.content![0]!.content![0]!.text = "words";
    list.content!.splice(1, 0, continuation);
    const recovered = JSON.parse(serializedVisualDocument(schema.nodeFromJSON(input)));
    const retained = structuredClone(recovered);
    expect(rebindVisualTypingContent(recovered, baseline.content)).toBeNull();
    expect(recovered).toEqual(retained);
  });

  it("maps a split item's stale canvas origin to fresh native offsets after earlier typing", () => {
    const source =
      "\\begin{itemize}\r\n  \\item First words\r\n  \\item Keep these bytes\r\n\\end{itemize}";
    const baseline = projectLatexVisualDocument(source);
    const before = structuredClone(baseline.content);
    before.content![0]!.content![0]!.content![0]!.content![0]!.text = "Long first words";
    const first = applyLatexVisualDocumentChange(source, baseline, before)!;
    const next = structuredClone(before);
    const list = next.content![0]!;
    const continuation = structuredClone(list.content![1]!);
    list.content![1]!.content![0]!.content![0]!.text = "Keep";
    continuation.content![0]!.content![0]!.text = "these bytes";
    list.content!.push(continuation);
    const rebound = rebindVisualTypingContent(next, first.projection.content, before)!;
    const second = applyLatexVisualDocumentChange(first.source, first.projection, rebound)!;
    const nativeList = projectLatexVisualDocument(second.source).content.content![0]!;
    expect(
      nativeList.content!.map((item) =>
        item.content![0]!.content!.map((node) => node.text ?? "").join(""),
      ),
    ).toEqual(["Long first words", "Keep", "these bytes"]);
    expect(second.source.startsWith("\\begin{itemize}\r\n  \\item Long first words\r\n")).toBe(
      true,
    );
  });

  it("splits the item whose text was already edited without treating its stale range as authority", () => {
    const source =
      "\\begin{itemize}\r\n  \\item First words\r\n  \\item Keep these bytes\r\n\\end{itemize}";
    const baseline = projectLatexVisualDocument(source);
    const before = structuredClone(baseline.content);
    before.content![0]!.content![0]!.content![0]!.content![0]!.text = "Long first words";
    const first = applyLatexVisualDocumentChange(source, baseline, before)!;
    const next = structuredClone(before);
    const list = next.content![0]!;
    const continuation = structuredClone(list.content![0]!);
    list.content![0]!.content![0]!.content![0]!.text = "Long first";
    continuation.content![0]!.content![0]!.text = "words";
    list.content!.splice(1, 0, continuation);
    const rebound = rebindVisualTypingContent(next, first.projection.content, before)!;
    expect(applyLatexVisualDocumentChange(first.source, first.projection, rebound)!.source).toBe(
      "\\begin{itemize}\r\n  \\item Long first\r\n  \\item words\r\n  \\item Keep these bytes\r\n\\end{itemize}",
    );
  });
  it("does not turn untouched stale appearances into requests to revert earlier native edits", () => {
    const source = "First words\n\nSecond words\n\nFirst words\n\nSecond words";
    const baseline = projectLatexVisualDocument(source);
    const before = structuredClone(baseline.content);
    before.content![0]!.content![0]!.text = "A First words";
    const nativeSource = source.replaceAll("First words", "A First words");
    const native = projectLatexVisualDocument(nativeSource);
    const next = structuredClone(before);
    next.content![1]!.content![0]!.text = "Changed second words";
    const reconciled = reconcileVisualPendingContent(next, before, native.content)!;
    const content = rebindVisualTypingContent(reconciled, native.content, before)!;
    expect(applyLatexVisualDocumentChange(nativeSource, native, content)!.source).toBe(
      nativeSource.replace("Second words", "Changed second words"),
    );
    expect(next.content![2]!.content![0]!.text).toBe("First words");
  });

  it("refuses a changed appearance whose canvas baseline no longer matches native content", () => {
    const source = "First words\n\nFirst words";
    const before = projectLatexVisualDocument(source).content;
    const native = projectLatexVisualDocument(source.replaceAll("First words", "A First words"));
    const next = structuredClone(before);
    next.content![1]!.content![0]!.text = "B First words";
    expect(reconcileVisualPendingContent(next, before, native.content)).toBeNull();
    expect(next.content![1]!.content![0]!.text).toBe("B First words");
  });
});
