import type { Editor, JSONContent } from "@tiptap/core";
import { latexTitleDeclarations } from "./latexDocumentStructure";
import { latexSourceArgument, latexSourceCommands } from "./latexSourceSyntax";
import { latexTableInlineContent, latexVisualInlineSourceRange } from "./latexVisualDocument";
import type { LatexSelectionSnapshot } from "./latexSelectionSession";
import { latexLiteralBlock } from "./latexLiteral";
import { latexMathSourceRange } from "./latexMathSourceRange";
import { mathSelectionPoint, mathSelectionAtOffset } from "./mathLiveSelection";
import type { MathfieldElement } from "mathlive";

/** Map the selected field through its authored slot, including repeated cell text. */
export function latexVisualObjectSourceRange(
  node: JSONContent,
  source: string,
  sourceFrom: number,
  target: HTMLElement,
  reading: { element: HTMLElement; snapshot: LatexSelectionSnapshot } | null,
  documentSource: string,
  point?: { left: number; top: number },
) {
  let range: { from: number; to: number } | undefined;
  let from: number, to: number;
  let content: JSONContent[] | null;
  const field = target.closest<HTMLTextAreaElement | HTMLInputElement>("textarea,input");
  const cell = target.closest<HTMLElement>("[data-table-cell]");
  const inner = (cell as (HTMLElement & { editor?: Editor }) | null)?.editor;
  if (cell && reading?.snapshot.content?.kind === "math" && cell.contains(reading.element)) {
    const coordinates = /^(\d+)-(\d+)$/u.exec(cell.dataset.tableCell ?? "");
    const slot =
      coordinates && node.attrs?.kind === "table"
        ? node.attrs.cellRanges?.[Number(coordinates[1])]?.[Number(coordinates[2])]
        : null;
    if (!slot) return null;
    const raw = source.slice(slot.from, slot.to);
    const math = reading.element as MathfieldElement;
    const path = point
      ? (reading.snapshot.content.selected
          ? mathSelectionAtOffset(math, reading.snapshot.content.to).path
          : mathSelectionPoint(math, point.left, point.top).path
        ).map((cell) => ({
          environment: cell.array.environmentName ?? "",
          row: cell.row,
          rows: cell.array.rowCount ?? 0,
          column: cell.column,
          columns: cell.array.colCount ?? 0,
        }))
      : [];
    const selected = latexMathSourceRange(raw, path, reading.snapshot.content.text);
    return {
      from: sourceFrom + slot.from + (selected?.from ?? 0),
      to: sourceFrom + slot.from + (selected?.to ?? raw.length),
    };
  }
  if (
    cell &&
    (inner || (reading?.element === cell && reading.snapshot.content?.kind === "prose"))
  ) {
    const selected = inner?.state.selection ?? reading!.snapshot.content!;
    from = Math.max(0, selected.from - 1);
    to = Math.max(from, selected.to - 1);
    const native = cell.ownerDocument.getSelection();
    if (inner && native?.rangeCount && !native.isCollapsed) {
      const range = native.getRangeAt(0);
      if (cell.contains(range.commonAncestorContainer)) {
        try {
          const start = inner.view.posAtDOM(range.startContainer, range.startOffset);
          const end = inner.view.posAtDOM(range.endContainer, range.endOffset);
          const $start = inner.state.doc.resolve(start),
            $end = inner.state.doc.resolve(end);
          if (
            $start.sameParent($end) &&
            $start.parent.isTextblock &&
            inner.state.doc.textBetween(start, end) === native.toString()
          ) {
            from = start - 1;
            to = end - 1;
          }
        } catch {
          return null;
        }
      }
    }
    const coordinates = /^(\d+)-(\d+)$/u.exec(cell.dataset.tableCell ?? "");
    if (coordinates && node.attrs?.kind === "table")
      range = node.attrs.cellRanges?.[Number(coordinates[1])]?.[Number(coordinates[2])];
    else if (cell.dataset.tableCell === "footnote" && node.attrs?.name === "footnote") {
      const command = latexSourceCommands(source).find((item) => item.name === "footnote");
      const argument = command && latexSourceArgument(source, command.to);
      if (argument) range = { from: argument.from, to: argument.to };
    }
    if (!range) return null;
    content = inner
      ? (inner.getJSON().content?.[0]?.content ?? [])
      : latexTableInlineContent(source.slice(range.from, range.to));
  } else if (field) {
    from = field.selectionStart ?? 0;
    to = field.selectionEnd ?? from;
    content = field.value ? [{ type: "text", text: field.value }] : [];
    if (node.attrs?.sourceMeta?.literal === true) {
      const literal = latexLiteralBlock(source);
      if (literal && source.slice(literal.bodyFrom, literal.bodyTo) === field.value)
        return {
          from: sourceFrom + literal.bodyFrom + from,
          to: sourceFrom + literal.bodyFrom + to,
        };
    }
    const label = field.getAttribute("aria-label");
    const title =
      label === "Document title"
        ? "title"
        : label === "Document author"
          ? "author"
          : label === "Document date"
            ? "date"
            : null;
    if (title && node.attrs?.kind === "title") {
      const declaration = latexTitleDeclarations(documentSource).get(title);
      if (!declaration) return null;
      source = documentSource;
      sourceFrom = 0;
      range = declaration;
    } else if (field.closest("figcaption")) {
      const command = latexSourceCommands(source).find((item) => item.name === "caption");
      const option = command && latexSourceArgument(source, command.to, "[", "]");
      const argument = command && latexSourceArgument(source, option?.end ?? command.to);
      if (argument) range = { from: argument.from, to: argument.to };
    } else {
      const description = /^Description item (\d+) (label|body)$/u.exec(label ?? "");
      const items = node.attrs?.sourceMeta?.originalItems;
      const index = description ? Number(description[1]) - 1 : -1;
      const item = items?.[index];
      const start = item
        ? String(node.attrs?.sourceMeta?.head ?? "").length +
          items
            .slice(0, index)
            .reduce((at: number, item: { raw: string }) => at + item.raw.length, 0)
        : 0;
      if (item)
        range =
          description![2] === "label"
            ? { from: start + item.labelFrom, to: start + item.labelTo }
            : { from: start + item.bodyFrom, to: start + item.bodyTo };
      else if (field.value === source) range = { from: 0, to: source.length };
    }
    if (!range) return null;
  } else return null;
  if (!content || range.from < 0 || range.to > source.length) return null;
  const raw = source.slice(range.from, range.to);
  return latexVisualInlineSourceRange(
    {
      id: "object-field",
      node: { type: "paragraph", content },
      source: raw,
      from: sourceFrom + range.from,
      to: sourceFrom + range.to,
      editable: true,
    },
    from,
    to,
  );
}
