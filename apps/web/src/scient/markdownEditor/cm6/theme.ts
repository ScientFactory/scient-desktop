import { EditorView } from "@codemirror/view";

/**
 * Live-preview theme. The critical property: hidden markup never changes line
 * geometry. Inline marks collapse via max-width (animatable), block marks via
 * font-size 0.01em; both keep the DOM text present and the line height fixed.
 */
export const livePreviewTheme = EditorView.theme({
  "&": {
    color: "inherit",
    backgroundColor: "transparent",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: 1.7,
    overflowY: "auto",
  },
  ".cm-content": {
    padding: "1.5rem 2rem 40vh 2rem",
    caretColor: "currentColor",
  },
  ".cm-line": {
    padding: "0",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, currentColor 14%, transparent) !important",
  },

  // Inline markup characters: collapsed but present, animating open near the caret.
  ".cm-md-mark": {
    display: "inline-block",
    overflow: "hidden",
    whiteSpace: "pre",
    verticalAlign: "baseline",
    maxWidth: "0",
    opacity: "0",
    transform: "scaleX(0.9)",
    pointerEvents: "none",
    transition:
      "max-width 160ms cubic-bezier(0.2, 0, 0.2, 1), opacity 120ms ease-out, transform 120ms ease-out",
  },
  ".cm-md-mark-on": {
    maxWidth: "6ch",
    opacity: "0.55",
    transform: "scaleX(1)",
    pointerEvents: "auto",
  },

  // Block markup characters: hidden by microscopic font size so line height holds.
  ".cm-md-blockmark": {
    display: "inline",
    overflow: "hidden",
    fontSize: "0.01em",
    lineHeight: "inherit",
    opacity: "0",
    transition: "font-size 160ms ease-out, opacity 120ms ease-out",
  },
  ".cm-md-blockmark-on": {
    fontSize: "1em",
    opacity: "0.5",
  },

  // Typography projections.
  ".cm-md-heading": {
    fontWeight: 650,
    lineHeight: 1.3,
  },
  ".cm-md-h1": { fontSize: "1.75em", padding: "0.9em 0 0.25em 0" },
  ".cm-md-h2": { fontSize: "1.5em", padding: "0.8em 0 0.2em 0" },
  ".cm-md-h3": { fontSize: "1.3em", padding: "0.7em 0 0.15em 0" },
  ".cm-md-h4": { fontSize: "1.15em", padding: "0.6em 0 0.1em 0" },
  ".cm-md-h5": { fontSize: "1em", padding: "0.5em 0 0.1em 0" },
  ".cm-md-h6": { fontSize: "0.95em", padding: "0.5em 0 0.1em 0", opacity: 0.85 },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strong": { fontWeight: 700 },
  ".cm-md-strike": { textDecoration: "line-through" },
  ".cm-md-link": {
    color: "#3b82f6",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
  ".cm-md-listmark": { opacity: 0 },
  ".cm-md-listmark-on": { opacity: 0.5 },
  ".cm-md-orderedmark": { opacity: 0.9 },
  ".cm-md-bullet": { opacity: 0.85 },
  ".cm-md-quote": {
    borderLeft: "3px solid color-mix(in srgb, currentColor 25%, transparent)",
    paddingLeft: "0.9em !important",
    opacity: 0.92,
  },
  ".cm-md-task": { marginRight: "0.45em" },
  ".cm-md-task input": { accentColor: "#3b82f6", verticalAlign: "middle" },

  // Code projections.
  ".cm-md-code": {
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.9em",
    backgroundColor: "color-mix(in srgb, currentColor 6%, transparent)",
  },
  ".cm-md-code-fence": { opacity: 0.6 },
  ".cm-md-codetext": {
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.92em",
    backgroundColor: "color-mix(in srgb, currentColor 8%, transparent)",
    borderRadius: "3px",
  },
  ".cm-md-raw": { opacity: 0.6 },

  // Widget projections.
  ".cm-md-math": { display: "inline-block" },
  ".cm-md-math-display": {
    display: "block",
    textAlign: "center",
    padding: "0.6em 0",
    overflowX: "auto",
  },
  ".cm-md-math .katex-display": { margin: "0" },
  ".cm-md-image": {
    margin: "0.4em 0",
    maxWidth: "100%",
  },
  ".cm-md-image img": {
    maxWidth: "100%",
    maxHeight: "24rem",
    borderRadius: "6px",
    display: "block",
  },
  ".cm-md-image figcaption": {
    fontSize: "0.85em",
    opacity: 0.6,
    padding: "0.25em 0 0 0",
  },
  ".cm-md-image-pending": {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: "0.85em",
    opacity: 0.5,
    backgroundColor: "color-mix(in srgb, currentColor 8%, transparent)",
    borderRadius: "4px",
    padding: "0.15em 0.5em",
  },
  ".cm-md-hr": {
    borderTop: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
    padding: "0.35em 0",
  },
  ".cm-md-placeholder": {
    opacity: 0.4,
    pointerEvents: "none",
    position: "absolute",
  },
});
