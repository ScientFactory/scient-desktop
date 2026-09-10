import { EditorView as CodeMirrorView } from "@codemirror/view";
import type { FileCitation } from "@t3tools/contracts";
import { toastManager } from "~/components/ui/toast";
import { isMarkdownCitationTextRange, resolveMarkdownCitation } from "./markdownCitation";
import type { ScientMarkdownEditorView } from "./prosemirror/view";

/** Paint a transient range, without selecting text, entering edit mode or writing the file. */
export function revealMarkdownCitation(
  controller: ScientMarkdownEditorView,
  citation: FileCitation,
): () => void {
  const view = controller.view;
  const match = resolveMarkdownCitation(controller.session, citation);
  if (!view || !match || !isMarkdownCitationTextRange(controller, match)) {
    toastManager.add({
      type: "warning",
      title: "The quoted text has changed",
      description:
        "Showing the file. The saved quote is unchanged; its exact location could not be verified.",
    });
    return () => {};
  }
  const doc = view.state.doc;
  const start = doc.resolve(match.from);
  const codePosition = start.parent.type.name === "code_block" ? start.before() : null;
  const block = codePosition === null ? null : view.nodeDOM(codePosition);
  const codeDom =
    block instanceof HTMLElement ? block.querySelector<HTMLElement>(".cm-editor") : null;
  const code = codeDom ? CodeMirrorView.findFromDOM(codeDom) : null;
  if (code && codePosition !== null) {
    (block as HTMLElement).scrollIntoView({ block: "nearest" });
    code.dispatch({
      effects: CodeMirrorView.scrollIntoView(match.from - codePosition - 1, { y: "center" }),
    });
  } else {
    const anchor = view.domAtPos(match.from).node;
    (anchor instanceof HTMLElement ? anchor : anchor.parentElement)?.scrollIntoView({
      block: "center",
    });
  }
  const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  let highlight: Highlight | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const frame = requestAnimationFrame(() => {
    if (disposed || view.state.doc !== doc || !view.dom.isConnected) return;
    const ranges: Range[] = [];
    const add = (first: { node: Node; offset: number }, last: { node: Node; offset: number }) => {
      const range = view.dom.ownerDocument.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset);
      ranges.push(range);
    };
    if (code && codePosition !== null) {
      for (const visible of code.visibleRanges) {
        const from = Math.max(visible.from, match.from - codePosition - 1);
        const to = Math.min(visible.to, match.to - codePosition - 1);
        if (from < to) add(code.domAtPos(from), code.domAtPos(to));
      }
    } else add(view.domAtPos(match.from), view.domAtPos(match.to));
    if (registry && typeof Highlight !== "undefined") {
      highlight = new Highlight(...ranges);
      registry.set("scient-file-citation", highlight);
    }
    timer = setTimeout(dispose, 3_000);
  });
  const stop = controller.subscribe(() => {
    if (view.state.doc !== doc) dispose();
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    stop();
    if (highlight && registry?.get("scient-file-citation") === highlight)
      registry.delete("scient-file-citation");
  };
  return dispose;
}
