import { Extension } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { observeResize } from "~/lib/observeResize";

interface ColumnBreakState {
  /** Positions of the inline `\columnbreak` commands in the document. */
  readonly commands: readonly number[];
  /** Where each break takes effect: the start of the line after its command. */
  readonly breaks: readonly number[];
  readonly decorations: DecorationSet;
}

const columnBreaksKey = new PluginKey<ColumnBreakState>("scientLatexColumnBreaks");

const isColumnBreak = (node: DocumentNode | null | undefined) =>
  node?.type.name === "latexInlineCommand" && node.attrs.name === "columnbreak";

function collect(doc: DocumentNode, from: number, to: number, into: Set<number>) {
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, position) => {
    if (isColumnBreak(node)) into.add(position);
  });
}

/**
 * The commands after a transaction: existing ones are mapped (and dropped when
 * removed), and only the changed ranges are searched for new ones, so typing
 * and loading never walk the whole document.
 */
function nextCommands(previous: readonly number[], transaction: Transaction): number[] {
  const { doc, mapping } = transaction;
  const found = new Set<number>();
  for (const position of previous) {
    const mapped = mapping.mapResult(position, 1);
    if (!mapped.deleted && isColumnBreak(doc.nodeAt(mapped.pos))) found.add(mapped.pos);
  }
  mapping.maps.forEach((map, index) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const rest = mapping.slice(index + 1);
      collect(doc, rest.map(newStart, -1), rest.map(newEnd, 1), found);
    });
  });
  return [...found].sort((a, b) => a - b);
}

function gapDecorations(doc: DocumentNode, breaks: readonly number[]) {
  return DecorationSet.create(
    doc,
    breaks.map((position) =>
      Decoration.widget(
        position,
        () => {
          const gap = document.createElement("span");
          gap.className = "scient-latex-column-break-gap";
          gap.contentEditable = "false";
          gap.setAttribute("aria-hidden", "true");
          return gap;
        },
        { side: -1, key: `column:${position}`, ignoreSelection: true },
      ),
    ),
  );
}

/** An inline TeX column break takes effect after its rendered line, not at its character. */
function inlineColumnBreakPositions(view: EditorView, commands: readonly number[]): number[] {
  const positions = new Set<number>();
  for (const position of commands) {
    const wrapper = view.nodeDOM(position);
    if (!(wrapper instanceof HTMLElement)) continue;
    const marker = wrapper.matches(".scient-latex-inline-column-break")
      ? wrapper
      : wrapper.querySelector<HTMLElement>(".scient-latex-inline-column-break");
    const paragraph = wrapper.closest("p");
    const columns = wrapper.closest('.scient-latex-page-layout[data-layout="columns"]');
    const content = columns?.querySelector<HTMLElement>(
      ":scope > .scient-latex-page-layout-body > [data-node-view-content-react]",
    );
    if (!marker || !paragraph || !content) continue;
    const box = marker.getBoundingClientRect();
    if (box.height === 0) continue;
    const bounds = content.getBoundingClientRect();
    const computed = getComputedStyle(content);
    const count = Math.max(1, Number.parseInt(computed.columnCount, 10) || 1);
    const scale = bounds.width / (Number.parseFloat(computed.width) || content.offsetWidth);
    if (!Number.isFinite(scale) || scale <= 0 || bounds.width <= 0) continue;
    const gap = (Number.parseFloat(computed.columnGap) || 0) * scale;
    const stride = (bounds.width + gap) / count;
    const column = (left: number) => Math.floor((left - bounds.left + 0.5 * scale) / stride);
    const sameLine = (rect: DOMRect) => {
      // A tall inline formula or a smaller text mark can share the baseline
      // without sharing the marker's vertical center. Compare their overlap.
      const overlap = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
      return (
        column(rect.left) === column(box.left) && overlap > Math.min(rect.height, box.height) * 0.5
      );
    };
    const resolved = view.state.doc.resolve(position);
    let next = resolved.end();
    const range = paragraph.ownerDocument.createRange();
    const walker = paragraph.ownerDocument.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, {
      acceptNode(text) {
        const excluded = text.parentElement?.closest('[contenteditable="false"]');
        return wrapper.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING &&
          !(excluded && paragraph.contains(excluded))
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let text: globalThis.Node | null;
    while ((text = walker.nextNode())) {
      const length = text.textContent?.length ?? 0;
      range.selectNodeContents(text);
      const following = [...range.getClientRects()].find(
        (rect) => rect.height > 0 && rect.width > 0 && !sameLine(rect),
      );
      if (!following) continue;
      // Find the first character on the following line within this text run.
      let low = 0,
        high = length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        range.setStart(text, middle);
        range.setEnd(text, Math.min(length, middle + 1));
        if (sameLine(range.getBoundingClientRect())) low = middle + 1;
        else high = middle;
      }
      // Leave a hanging wrap space on the preceding line instead of indenting
      // the continuation with that space after inserting the break widget.
      while (low < length && /[\t\r\n ]/u.test(text.textContent?.[low] ?? "")) low++;
      next = Math.min(next, view.posAtDOM(text, low));
      break;
    }
    // A formula or other inline atom can also begin the following line.
    resolved.parent.forEach((child, offset) => {
      const at = resolved.start() + offset;
      if (child.isText || at <= position || at >= next) return;
      const dom = view.nodeDOM(at);
      if (!(dom instanceof HTMLElement)) return;
      const rect = dom.getBoundingClientRect();
      if (rect.height > 0 && !sameLine(rect)) next = at;
    });
    if (next > position) positions.add(next);
  }
  return [...positions].sort((a, b) => a - b);
}

/**
 * Inline `\columnbreak` inside `multicols`: the column breaks after the line
 * the command ends, so where depends on how the paragraph wraps. The break
 * positions are measured with the breaks hidden, after changes and resizes,
 * only in documents that contain such a command.
 */
export const LatexColumnBreaks = Extension.create({
  name: "latexColumnBreaks",
  addProseMirrorPlugins() {
    return [
      new Plugin<ColumnBreakState>({
        key: columnBreaksKey,
        state: {
          init: (_config, state) => {
            const commands = new Set<number>();
            collect(state.doc, 0, state.doc.content.size, commands);
            return {
              commands: [...commands].sort((a, b) => a - b),
              breaks: [],
              decorations: DecorationSet.empty,
            };
          },
          apply(transaction, value) {
            const measured = transaction.getMeta(columnBreaksKey) as number[] | undefined;
            if (measured)
              return {
                ...value,
                breaks: measured,
                decorations: gapDecorations(transaction.doc, measured),
              };
            if (!transaction.docChanged) return value;
            const commands = nextCommands(value.commands, transaction);
            if (!commands.length) return { commands, breaks: [], decorations: DecorationSet.empty };
            // Until measured again, the breaks follow the text they precede.
            return {
              commands,
              breaks: value.breaks.map((position) => transaction.mapping.map(position, -1)),
              decorations: value.decorations.map(transaction.mapping, transaction.doc),
            };
          },
        },
        props: {
          decorations: (state) => columnBreaksKey.getState(state)?.decorations,
        },
        view(view) {
          let frame = 0;
          const measure = () => {
            frame = 0;
            if (view.isDestroyed) return;
            const state = columnBreaksKey.getState(view.state);
            if (!state?.commands.length) return;
            // Outside ProseMirror's DOM, so its observer does not redraw anything.
            const scope = view.dom.parentElement;
            if (!scope) return;
            scope.dataset.latexColumnMeasuring = "true";
            const breaks = inlineColumnBreakPositions(view, state.commands);
            delete scope.dataset.latexColumnMeasuring;
            if (JSON.stringify(breaks) === JSON.stringify(state.breaks)) return;
            view.dispatch(
              view.state.tr.setMeta(columnBreaksKey, breaks).setMeta("addToHistory", false),
            );
          };
          const schedule = () => {
            if (!frame && columnBreaksKey.getState(view.state)?.commands.length)
              frame = requestAnimationFrame(measure);
          };
          schedule();
          const stopObserving = observeResize(view.dom, schedule);
          return {
            update(updated, previous) {
              if (updated.state.doc !== previous.doc) schedule();
            },
            destroy() {
              cancelAnimationFrame(frame);
              stopObserving();
            },
          };
        },
      }),
    ];
  },
});
