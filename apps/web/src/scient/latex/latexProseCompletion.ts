import { Extension } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import type { EditorView } from "@tiptap/pm/view";
import { latexTableInlineContent } from "./latexVisualDocument";
import { LATEX_INLINE_MARKS } from "./latexTextFormatting";
import { latexColorCss } from "./latexColorBoxes";
import { latexSourceArgument } from "./latexSourceSyntax";
import { installLatexTextCompletion } from "./latexTextCompletion";
import type { LatexCompletionContext, LatexSourceChoice } from "./latexCommandCompletion";

interface Snippet {
  from: number;
  to: number;
}
const headingLevels: Readonly<Record<string, number>> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
  chapter: 6,
};
const key = new PluginKey<Snippet | null>("latexProseCompletion");

function paragraphInput(view: EditorView) {
  const { selection } = view.state;
  if (
    !view.editable ||
    view.composing ||
    !view.hasFocus() ||
    !selection.empty ||
    !(selection instanceof TextSelection) ||
    !selection.$from.parent.isTextblock ||
    selection.$from.parent.type.spec.code
  )
    return null;
  const { $from } = selection;
  return {
    source: $from.parent.textBetween(0, $from.parent.content.size, "\n", "\ufffc"),
    from: $from.parentOffset,
    to: $from.parentOffset,
  };
}

function finishSnippet(
  view: EditorView,
  snippet: Snippet,
  context: LatexCompletionContext,
): boolean {
  const source = view.state.doc.textBetween(snippet.from, snippet.to, "\n", "\ufffc");
  const color =
    /^\\(color|textcolor|colorbox|fcolorbox)\{([^{}]+)\}(?:\{([^{}]*)\})?(?:\{([^{}]*)\})?$/u.exec(
      source,
    );
  if (color && latexColorCss(color[2]!, context.colors ? { ...context.colors } : undefined)) {
    const command = color[1] === "color" ? "textcolor" : color[1]!;
    const body = command === "fcolorbox" ? color[4] : color[3];
    const background = command === "fcolorbox" ? color[3] : "";
    const mark =
      view.state.schema.marks[command === "textcolor" ? "latexColor" : "latexBackground"];
    if (mark && !body && (command !== "fcolorbox" || (background && latexColorCss(background)))) {
      const tr = view.state.tr.delete(snippet.from, snippet.to).setMeta(key, null);
      tr.setSelection(TextSelection.create(tr.doc, snippet.from));
      tr.setStoredMarks([
        ...(view.state.storedMarks ?? view.state.selection.$from.marks()).filter(
          (existing) => existing.type !== mark,
        ),
        mark.create({ command, color: color[2], background: background ?? "" }),
      ]);
      view.dispatch(tr);
      return true;
    }
  }
  const content = latexTableInlineContent(source);
  if (!content?.length) return false;
  try {
    const fragment = Fragment.fromArray(
      content.map((node) => view.state.schema.nodeFromJSON(node)),
    );
    const tr = view.state.tr.replaceWith(snippet.from, snippet.to, fragment).setMeta(key, null);
    tr.setSelection(TextSelection.create(tr.doc, snippet.from + fragment.size));
    view.dispatch(tr.scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

/** Prose and object text accept the same visible command templates as equations. */
export const LatexProseCompletion = Extension.create<{ context: () => LatexCompletionContext }>({
  name: "latexProseCompletion",
  addOptions: () => ({ context: () => ({}) }),
  addProseMirrorPlugins() {
    const context = this.options.context;
    let completion: ReturnType<typeof installLatexTextCompletion> | null = null;
    const snippetKey = (view: EditorView, event: KeyboardEvent) => {
      const snippet = key.getState(view.state);
      if (
        !snippet ||
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return false;
      const selection = view.state.selection;
      if (!selection.empty || selection.from < snippet.from || selection.from > snippet.to)
        return false;
      if (event.key === "Tab") {
        const source = view.state.doc.textBetween(snippet.from, snippet.to, "\n", "\ufffc");
        const slots = [...source.matchAll(/[{[](?=[}\]])/gu)].map(
          (match) => snippet.from + match.index + 1,
        );
        const next = event.shiftKey
          ? slots.findLast((position) => position < selection.from)
          : slots.find((position) => position > selection.from);
        if (next !== undefined) {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, next)));
          return true;
        }
        return !event.shiftKey && finishSnippet(view, snippet, context());
      }
      if (event.key === "Enter" && !event.shiftKey) return finishSnippet(view, snippet, context());
      if (
        event.key === "}" &&
        view.state.doc.textBetween(selection.from, selection.from + 1) === "}"
      ) {
        if (selection.from + 1 === snippet.to && finishSnippet(view, snippet, context()))
          return true;
        view.dispatch(
          view.state.tr.setSelection(TextSelection.create(view.state.doc, selection.from + 1)),
        );
        return true;
      }
      return false;
    };
    return [
      new Plugin<Snippet | null>({
        key,
        state: {
          init: () => null,
          apply(tr, previous) {
            const next: Snippet | null | undefined = tr.getMeta(key);
            if (next !== undefined) return next;
            if (!previous) return null;
            const from = tr.mapping.mapResult(previous.from, -1);
            const to = tr.mapping.mapResult(previous.to, 1);
            return from.deletedAcross || to.deletedAcross || to.pos < from.pos
              ? null
              : { from: from.pos, to: to.pos };
          },
        },
        props: {
          handleKeyDown(view, event) {
            return Boolean(completion?.key(event) || snippetKey(view, event));
          },
          handleDOMEvents: {
            blur: () => {
              completion?.hide();
              return false;
            },
          },
        },
        view(view) {
          const apply = (choice: LatexSourceChoice): boolean => {
            const input = paragraphInput(view);
            if (!input) return false;
            const base = view.state.selection.$from.start();
            const from = base + choice.from,
              to = base + choice.to;
            const name = choice.label.slice(1);
            const custom = Object.hasOwn(context().macros ?? {}, name);
            const level = custom ? undefined : headingLevels[name];
            if (level && view.state.schema.nodes.heading) {
              const parent = view.state.selection.$from.parent;
              const heading = view.state.schema.nodes.heading.create({
                level,
                latexCommand: name,
                unnumbered: false,
              });
              const tr = closeHistory(view.state.tr)
                .replaceWith(base - 1, base + parent.content.size + 1, heading)
                .setMeta(key, null);
              tr.setSelection(TextSelection.create(tr.doc, base));
              view.dispatch(tr.scrollIntoView());
              view.focus();
              return true;
            }
            const markName = custom ? undefined : LATEX_INLINE_MARKS[name];
            // Empty formatting becomes a writing style; no example text or hidden source characters.
            if (markName && view.state.schema.marks[markName]) {
              const argument = latexSourceArgument(input.source, choice.to);
              const content =
                argument &&
                latexTableInlineContent(
                  choice.label + input.source.slice(argument.from - 1, argument.end),
                );
              if (argument && content?.length) {
                const fragment = Fragment.fromArray(
                  content.map((node) => view.state.schema.nodeFromJSON(node)),
                );
                const tr = closeHistory(view.state.tr)
                  .replaceWith(from, base + argument.end, fragment)
                  .setMeta(key, null);
                tr.setSelection(TextSelection.create(tr.doc, from));
                tr.setStoredMarks([
                  ...(view.state.storedMarks ?? view.state.selection.$from.marks()).filter(
                    (mark) => mark.type.name !== markName,
                  ),
                  view.state.schema.marks[markName]!.create(),
                ]);
                view.dispatch(tr.scrollIntoView());
                view.focus();
                return true;
              }
              if (argument && content === null) return false;
              const tr = closeHistory(view.state.tr)
                .delete(from, argument ? base + argument.end : to)
                .setMeta(key, null);
              tr.setStoredMarks([
                ...(view.state.storedMarks ?? view.state.selection.$from.marks()).filter(
                  (mark) => mark.type.name !== markName,
                ),
                view.state.schema.marks[markName]!.create(),
              ]);
              view.dispatch(tr);
              view.focus();
              return true;
            }
            const snippet = key.getState(view.state);
            const source =
              input.source.slice(0, choice.from) +
              choice.replacement +
              input.source.slice(choice.to);
            if (snippet && !choice.label.startsWith("\\")) {
              const start = snippet.from - base;
              const end = snippet.to - base + choice.replacement.length - (choice.to - choice.from);
              const raw = source.slice(start, end);
              const color =
                /^\\(color|textcolor|colorbox|fcolorbox)\{([^{}]+)\}(?:\{([^{}]*)\})?(?:\{([^{}]*)\})?$/u.exec(
                  raw,
                );
              if (
                color &&
                latexColorCss(color[2]!, context().colors ? { ...context().colors } : undefined)
              ) {
                const command = color[1] === "color" ? "textcolor" : color[1]!;
                const background = command === "fcolorbox" ? color[3] : "";
                const body = command === "fcolorbox" ? color[4] : color[3];
                const mark =
                  view.state.schema.marks[
                    command === "textcolor" ? "latexColor" : "latexBackground"
                  ];
                if (
                  mark &&
                  !body &&
                  (command !== "fcolorbox" || (background && latexColorCss(background)))
                ) {
                  const tr = closeHistory(view.state.tr)
                    .delete(snippet.from, snippet.to)
                    .setMeta(key, null);
                  tr.setStoredMarks([
                    ...(view.state.storedMarks ?? view.state.selection.$from.marks()).filter(
                      (existing) => existing.type !== mark,
                    ),
                    mark.create({ command, color: color[2], background: background ?? "" }),
                  ]);
                  view.dispatch(tr);
                  view.focus();
                  return true;
                }
              }
            }
            // Math commands can be started from a prose caret without opening a menu first.
            if (
              choice.math &&
              !choice.argument &&
              choice.label.startsWith("\\") &&
              view.state.schema.nodes.latexInlineMath
            ) {
              const node = view.state.schema.nodes.latexInlineMath.create({
                tex: choice.replacement,
                wrapper: "paren",
              });
              const tr = closeHistory(view.state.tr).replaceWith(from, to, node).setMeta(key, null);
              tr.setSelection(NodeSelection.create(tr.doc, from));
              view.dispatch(tr.scrollIntoView());
              view.focus();
              return true;
            }
            const tr = closeHistory(view.state.tr).insertText(choice.replacement, from, to);
            const rest = source.slice(choice.from + choice.replacement.length);
            const nextArgument = !choice.label.startsWith("\\") && rest.startsWith("}{");
            const caret = nextArgument ? from + choice.replacement.length + 2 : from + choice.caret;
            tr.setSelection(TextSelection.create(tr.doc, caret));
            if (choice.label.startsWith("\\"))
              tr.setMeta(key, { from, to: from + choice.replacement.length });
            view.dispatch(tr.scrollIntoView());
            view.focus();
            return true;
          };
          completion = installLatexTextCompletion(
            view.dom,
            {
              read: () => paragraphInput(view),
              allows: (choice) => {
                if (Object.hasOwn(context().macros ?? {}, choice.label.slice(1))) return true;
                const level = headingLevels[choice.label.slice(1)];
                if (!level) return true;
                const input = paragraphInput(view);
                return Boolean(
                  input &&
                  view.state.schema.nodes.heading &&
                  view.state.selection.$from.depth === 1 &&
                  view.state.selection.$from.parent.type.name === "paragraph" &&
                  choice.from === 0 &&
                  choice.to === input.source.length &&
                  (level !== 6 ||
                    /\\documentclass(?:\[[^\]]*\])?\{(?:book|report|memoir)\}/u.test(
                      context().source ?? "",
                    )),
                );
              },
              apply,
              bounds: () => view.coordsAtPos(view.state.selection.from),
            },
            "prose",
            context,
          );
          // Cell editors normally reserve Tab/Enter for navigation. Completion
          // gets those keys first while its argument list is open.
          const capture = (event: KeyboardEvent) => {
            if (completion?.key(event) || snippetKey(view, event)) {
              event.preventDefault();
              event.stopImmediatePropagation();
            }
          };
          view.dom.addEventListener("keydown", capture, true);
          return {
            update() {
              completion?.refresh();
            },
            destroy() {
              view.dom.removeEventListener("keydown", capture, true);
              completion?.dispose();
              completion = null;
            },
          };
        },
      }),
    ];
  },
});
