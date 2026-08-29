// @effect-diagnostics globalTimers:off -- Async image resolution uses deferred promises, not polling.
import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { StateEffect, type EditorState, type Extension, type Range } from "@codemirror/state";
import { activeLineNumbers, pointerFreezeField, selectionTouches } from "./reveal";
import type { MarkdownImageResourceScope } from "./imageResources";
import {
  BulletWidget,
  HorizontalRuleWidget,
  MarkdownImageWidget,
  MathWidget,
  PlaceholderWidget,
  TaskCheckboxWidget,
} from "./widgets";

const HEADING_CLASSES: ReadonlyMap<string, string> = new Map([
  ["ATXHeading1", "cm-md-h1"],
  ["ATXHeading2", "cm-md-h2"],
  ["ATXHeading3", "cm-md-h3"],
  ["ATXHeading4", "cm-md-h4"],
  ["ATXHeading5", "cm-md-h5"],
  ["ATXHeading6", "cm-md-h6"],
]);

const FENCE_NODE = "FencedCode";

interface LivePreviewConfig {
  readonly imageResources?: MarkdownImageResourceScope;
  readonly placeholder: string;
}

/** Rebuild decorations after an async document resource changes. */
export const refreshLivePreview = StateEffect.define<null>();

/**
 * Obsidian-style live preview for Markdown source. The buffer always holds the
 * file's exact bytes; this plugin only projects decorations over it:
 *
 * - Inline and block markup characters are hidden with width/size-preserving
 *   CSS so lines never reflow when the cursor enters or leaves a range.
 * - Revealed state follows selection intersection (marks under the caret show
 *   raw), suppressed while a pointer press freeze is active.
 * - Math, images, task markers, bullets, and horizontal rules are replaced
 *   visually by widgets whose source text stays untouched in the buffer.
 */
export function livePreview(config: LivePreviewConfig): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, config);
      }

      update(update: ViewUpdate) {
        const resourceChanged = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(refreshLivePreview)),
        );
        if (update.docChanged || update.viewportChanged || update.selectionSet || resourceChanged) {
          this.decorations = buildDecorations(update.view, config);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

function buildDecorations(view: EditorView, config: LivePreviewConfig): DecorationSet {
  const { state } = view;
  const frozen = state.field(pointerFreezeField, false) ?? false;
  const activeLines = activeLineNumbers(state);
  const decorations: Range<Decoration>[] = [];
  const codeRanges: Array<readonly [number, number]> = [];

  const mark = (className: string, from: number, to: number): void => {
    if (to > from) decorations.push(Decoration.mark({ class: className }).range(from, to));
  };
  const hideMark = (from: number, to: number, revealed: boolean): void => {
    mark(revealed ? "cm-md-mark cm-md-mark-on" : "cm-md-mark", from, to);
  };

  for (const visible of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => {
        const { from, to, name } = node;
        const revealedInline = !frozen && selectionTouches(state, from, to);
        const lineActive = activeLines.has(state.doc.lineAt(from).number);

        switch (name) {
          case "EmphasisMark":
          case "StrikethroughMark":
          case "CodeMark": {
            hideMark(from, to, revealedInline);
            return;
          }
          case "Emphasis": {
            mark("cm-md-em", from, to);
            return;
          }
          case "StrongEmphasis": {
            mark("cm-md-strong", from, to);
            return;
          }
          case "Strikethrough": {
            mark("cm-md-strike", from, to);
            return;
          }
          case "HeaderMark": {
            const revealed = lineActive && !frozen;
            mark(revealed ? "cm-md-blockmark cm-md-blockmark-on" : "cm-md-blockmark", from, to);
            return;
          }
          case "ATXHeading1":
          case "ATXHeading2":
          case "ATXHeading3":
          case "ATXHeading4":
          case "ATXHeading5":
          case "ATXHeading6": {
            const headingClass = HEADING_CLASSES.get(name) ?? "cm-md-h1";
            const first = state.doc.lineAt(from).number;
            const last = state.doc.lineAt(to).number;
            for (let number = first; number <= last; number += 1) {
              const line = state.doc.line(number);
              decorations.push(
                Decoration.line({ class: `cm-md-heading ${headingClass}` }).range(line.from),
              );
            }
            return;
          }
          case "ListMark": {
            const markerText = state.sliceDoc(from, to);
            const ordered = /^\d+[.)]$/u.test(markerText.trim());
            if (ordered) {
              mark("cm-md-orderedmark", from, to);
              return;
            }
            if (lineActive || frozen) {
              mark("cm-md-listmark cm-md-listmark-on", from, to);
              return;
            }
            decorations.push(
              Decoration.replace({ widget: new BulletWidget(markerText) }).range(from, to),
            );
            return;
          }
          case "QuoteMark": {
            const revealed = lineActive && !frozen;
            mark(revealed ? "cm-md-blockmark cm-md-blockmark-on" : "cm-md-blockmark", from, to);
            return;
          }
          case "Blockquote": {
            const first = state.doc.lineAt(from).number;
            const last = state.doc.lineAt(to).number;
            for (let number = first; number <= last; number += 1) {
              const line = state.doc.line(number);
              decorations.push(Decoration.line({ class: "cm-md-quote" }).range(line.from));
            }
            return;
          }
          case "TaskMarker": {
            const markerText = state.sliceDoc(from, to);
            const checked = /\[[xX]\]/u.test(markerText);
            if (revealedInline) return;
            decorations.push(
              Decoration.replace({
                widget: new TaskCheckboxWidget(checked, () => {
                  view.dispatch({
                    changes: { from, to, insert: checked ? "[ ]" : "[x]" },
                  });
                }),
              }).range(from, to),
            );
            return;
          }
          case "Link": {
            mark("cm-md-link", from, to);
            let closeBracketEnd = -1;
            for (const linkMark of node.node.getChildren("LinkMark")) {
              if (state.sliceDoc(linkMark.from, linkMark.to) === "]") {
                closeBracketEnd = linkMark.to;
              }
            }
            if (closeBracketEnd > 0 && !revealedInline) {
              decorations.push(Decoration.replace({}).range(closeBracketEnd, to));
            }
            return;
          }
          case "Image": {
            if (revealedInline) return;
            const imageSyntax = state.sliceDoc(from, to);
            const match = /^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)$/u.exec(imageSyntax);
            if (!match?.[1] || !match[2]) return;
            const authoredSource = match[2];
            config.imageResources?.request(authoredSource);
            decorations.push(
              Decoration.replace({
                widget: new MarkdownImageWidget(
                  authoredSource,
                  config.imageResources?.lookup(authoredSource) ?? null,
                  match[1],
                ),
              }).range(from, to),
            );
            return;
          }
          case "HorizontalRule": {
            if (!revealedInline) {
              decorations.push(
                Decoration.replace({ widget: new HorizontalRuleWidget(), block: true }).range(
                  from,
                  to,
                ),
              );
            }
            return;
          }
          case FENCE_NODE:
          case "CodeBlock":
          case "HTMLBlock": {
            codeRanges.push([from, to]);
            const firstLine = state.doc.lineAt(from);
            const lastLine = state.doc.lineAt(to);
            for (let number = firstLine.number; number <= lastLine.number; number += 1) {
              const line = state.doc.line(number);
              decorations.push(
                Decoration.line({
                  class: name === FENCE_NODE ? "cm-md-code cm-md-code-fence" : "cm-md-code",
                }).range(line.from),
              );
            }
            return;
          }
          case "CodeText": {
            mark("cm-md-codetext", from, to);
            return;
          }
          case "Comment": {
            mark("cm-md-raw", from, to);
            return;
          }
          default:
            return;
        }
      },
    });
  }

  decorations.push(...buildMathDecorations(state, view.visibleRanges, codeRanges, frozen));
  if (state.doc.length === 0 && config.placeholder) {
    decorations.push(
      Decoration.widget({ widget: new PlaceholderWidget(config.placeholder) }).range(0),
    );
  }

  return Decoration.set(decorations, true);
}

/**
 * KaTeX projection for `$...$` and single-line `$$...$$` ranges outside code.
 * Heuristic (Typora-style): opening `$` not followed by whitespace, closing
 * `$` not preceded by whitespace, non-empty content.
 */
function buildMathDecorations(
  state: EditorState,
  visibleRanges: ReadonlyArray<{ readonly from: number; readonly to: number }>,
  codeRanges: ReadonlyArray<readonly [number, number]>,
  frozen: boolean,
): Range<Decoration>[] {
  const math: Range<Decoration>[] = [];
  const inCode = (pos: number): boolean =>
    codeRanges.some(([from, to]) => pos >= from && pos <= to);
  const isFrozenAt = (pos: number): boolean => frozen || selectionTouches(state, pos, pos);

  for (const visible of visibleRanges) {
    const first = state.doc.lineAt(visible.from).number;
    const last = state.doc.lineAt(visible.to).number;
    for (let number = first; number <= last; number += 1) {
      const line = state.doc.line(number);
      const text = line.text;
      const display = /^\s*\$\$([^$]+)\$\$\s*$/u.exec(text);
      if (display?.[1] && !isFrozenAt(line.from)) {
        math.push(
          Decoration.replace({
            widget: new MathWidget(display[1], true),
            block: true,
          }).range(line.from, line.to),
        );
        continue;
      }
      const inline = /\$([^$\n]+)\$/gu;
      let match: RegExpExecArray | null;
      while ((match = inline.exec(text)) !== null) {
        const content = match[1];
        if (!content?.trim()) continue;
        if (/^\s|\s$/u.test(content)) continue;
        const from = line.from + match.index;
        const to = from + match[0].length;
        if (inCode(from) || isFrozenAt(from)) continue;
        math.push(Decoration.replace({ widget: new MathWidget(content, false) }).range(from, to));
      }
    }
  }
  return math;
}
