import {
  commandKeys,
  getKeyboardPreferences,
  subscribeKeyboardPreferences,
} from "../keyboard/preferences";
import { labelKeys } from "../keyboard/keys";
import { attachShortcutHost } from "../keyboard/host";
import { WritingShortcutsDialog } from "../keyboard/WritingShortcutsDialog";
import {
  useEffect,
  useSyncExternalStore,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { EnvironmentId, ScientLatexDiagnostic } from "@t3tools/contracts";
import { Annotation, Compartment, EditorState, StateEffect, Transaction } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentSelection,
  toggleComment,
  undo,
  redo,
} from "@codemirror/commands";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldAll,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  unfoldAll,
  unfoldEffect,
  foldedRanges,
} from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import {
  autocompletion,
  acceptCompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  nextSnippetField,
  prevSnippetField,
  startCompletion,
  snippet,
  completionStatus,
  hasNextSnippetField,
} from "@codemirror/autocomplete";
import {
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import {
  Bold,
  Italic,
  ListTree,
  Search,
  Code,
  Plus,
  Settings2,
  Locate,
  Undo2,
  Redo2,
  RefreshCw,
  Keyboard,
  X,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
  MenuCheckboxItem,
} from "~/components/ui/menu";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { MathInputController } from "~/scient/math/input/controller";
import { MathInputTools } from "~/scient/math/input/MathInputTools";
import {
  completeLatexEnvironment,
  latexSourceCompletion,
  latexSourceFolding,
  latexSourceIndent,
  latexSourceIndex,
  sourceReferenceAt,
  wrapLatexSelection,
} from "./latexSourceExtensions";
import { resolveLatexPath, latexSourcePathBase, type SourceSection } from "./latexSourceModel";
import { useLatexSourceProject } from "./useLatexSourceProject";
import "./latex-source.css";

const externalSource = Annotation.define<boolean>();
const preferencesKey = "scient.latex.source-editor.preferences.v1";
interface Preferences {
  fontSize: number;
  wrap: boolean;
  numbers: boolean;
  complete: boolean;
  spellcheck: boolean;
  autoBuild: boolean;
}
function preferences(wordWrap: boolean): Preferences {
  const defaults = {
    fontSize: 14,
    wrap: wordWrap,
    numbers: true,
    complete: true,
    spellcheck: false,
    autoBuild: false,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey) ?? "null");
    if (!saved || typeof saved !== "object") return defaults;
    return {
      fontSize:
        typeof saved.fontSize === "number" ? Math.min(24, Math.max(10, saved.fontSize)) : 14,
      wrap: typeof saved.wrap === "boolean" ? saved.wrap : wordWrap,
      numbers: saved.numbers !== false,
      complete: saved.complete !== false,
      spellcheck: saved.spellcheck === true,
      autoBuild: saved.autoBuild === true,
    };
  } catch {
    return defaults;
  }
}

export interface LatexSourceSession {
  key: string;
  state: EditorState;
  scrollTop: number;
  scrollLeft: number;
}
interface Props {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  rootPath: string;
  contents: string;
  resolvedTheme: "light" | "dark";
  wordWrap: boolean;
  disabled: boolean;
  revealLine: number | null;
  revealRequestId: number;
  diagnostics: readonly ScientLatexDiagnostic[];
  diagnosticsCurrent: boolean;
  session: MutableRefObject<LatexSourceSession | null>;
  onContentsChange: (source: string) => void;
  onBuild: () => void;
  canBuild: boolean;
  onForwardSync: (position: { line: number; column: number }) => void;
  onOpenFile: (path: string, line?: number) => void;
  onShowDiagnostics: () => void;
  saveStatus: string;
}

const highlight = HighlightStyle.define([
  { tag: tags.comment, color: "var(--source-comment)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.macroName, tags.tagName], color: "var(--source-command)" },
  { tag: [tags.string, tags.attributeValue, tags.link], color: "var(--source-string)" },
  { tag: [tags.number, tags.atom, tags.bool], color: "var(--source-number)" },
  { tag: [tags.bracket, tags.punctuation], color: "var(--source-punctuation)" },
  { tag: tags.heading, color: "var(--source-command)", fontWeight: "600" },
  { tag: tags.invalid, textDecoration: "underline wavy var(--destructive)" },
]);
const sourceTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--background)", color: "var(--foreground)" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
    overflow: "auto",
    overscrollBehavior: "contain",
  },
  ".cm-content": { padding: "12px 0 80px", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 14px" },
  ".cm-gutters": {
    backgroundColor: "var(--background)",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "3em", padding: "0 6px 0 10px" },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--accent) 50%, transparent)",
  },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--ring) 25%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--ring) 20%, transparent)",
    outline: "1px solid var(--ring)",
  },
  ".cm-panels": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    borderColor: "var(--border)",
  },
  ".cm-tooltip": {
    border: "1px solid var(--border)",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    borderRadius: "5px",
    font: "12px/1.5 var(--font-sans)",
    boxShadow: "0 4px 18px #0003",
  },
  ".cm-tooltip-autocomplete > ul": {
    maxHeight: "210px",
    maxWidth: "420px",
    fontFamily: "var(--font-mono)",
  },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 6px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-completionDetail": {
    color: "var(--muted-foreground)",
    fontFamily: "var(--font-sans)",
    marginLeft: "12px",
  },
  ".cm-foldPlaceholder": {
    color: "var(--muted-foreground)",
    backgroundColor: "var(--muted)",
    borderColor: "var(--border)",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--ring) 20%, transparent)" },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--ring) 35%, transparent)",
  },
});

function Action(props: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <ScientTooltip content={props.label}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={props.label}
        aria-pressed={props.active}
        disabled={props.disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onClick}
      >
        {props.children}
      </Button>
    </ScientTooltip>
  );
}

export function LatexSourceEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [math] = useState(
    () =>
      new MathInputController({
        read() {
          const editor = view.current;
          if (!editor || editor.composing || editor.state.selection.ranges.length !== 1)
            return null;
          const { from, to } = editor.state.selection.main;
          return {
            source: editor.state.doc.toString(),
            selection: { from, to },
            format: "latex",
            editable: !editor.state.readOnly,
            identity: editor,
          };
        },
        apply(expected, edit) {
          const editor = view.current;
          if (
            !editor ||
            editor.composing ||
            editor.state.readOnly ||
            editor.state.doc.toString() !== expected.source
          )
            return false;
          editor.dispatch({
            changes: { from: edit.from, to: edit.to, insert: edit.insert },
            selection: { anchor: edit.selection.from, head: edit.selection.to },
            scrollIntoView: true,
            userEvent: "input",
          });
          return true;
        },
        focus: () => view.current?.focus(),
      }),
  );
  const autoBuildSource = useRef<string | null>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const project = useLatexSourceProject({ ...props, source: props.contents });
  const projectRef = useRef(project);
  useLayoutEffect(() => {
    projectRef.current = project;
  }, [project]);
  const [options, setOptions] = useState(() => preferences(props.wordWrap));
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineQuery, setOutlineQuery] = useState("");
  const [shortcuts, setShortcuts] = useState(false);
  useSyncExternalStore(
    subscribeKeyboardPreferences,
    getKeyboardPreferences,
    getKeyboardPreferences,
  );
  const shortcutLabel = (id: string, label: string) => {
    const keys = commandKeys(id)
      .map((keys) => labelKeys(keys))
      .join(" / ");
    return label + (keys ? " (" + keys + ")" : "");
  };

  const [sections, setSections] = useState<SourceSection[]>([]);
  const [cursor, setCursor] = useState({ line: 1, column: 1, selected: 0 });
  const [configuration] = useState(() => new Compartment());
  const [diagnosticConfig] = useState(() => new Compartment());
  const [historyConfig] = useState(() => new Compartment());
  const identity = JSON.stringify([props.environmentId, props.cwd, props.relativePath]);
  const reveal = useCallback((lineNumber: number) => {
    const editor = view.current;
    if (!editor) return;
    const line = editor.state.doc.line(Math.max(1, Math.min(editor.state.doc.lines, lineNumber)));
    const effects: StateEffect<unknown>[] = [EditorView.scrollIntoView(line.from, { y: "center" })];
    foldedRanges(editor.state).between(0, editor.state.doc.length, (from, to) => {
      if (from <= line.from && to >= line.from) effects.push(unfoldEffect.of({ from, to }));
    });
    editor.dispatch({ selection: { anchor: line.from }, effects });
    editor.focus();
  }, []);
  const goToDefinition = useCallback(
    (editor: EditorView, position = editor.state.selection.main.head) => {
      const reference = sourceReferenceAt(editor.state, position);
      if (!reference) return false;
      if (/^(input|include|subfile)$/u.test(reference.command)) {
        const path = resolveLatexPath(
          latexSourcePathBase(
            editor.state.doc.toString(),
            latest.current.relativePath,
            latest.current.rootPath,
          ),
          reference.argument,
          ".tex",
        );
        if (path) latest.current.onOpenFile(path, 1);
        return Boolean(path);
      }
      const label = editor.state
        .field(latexSourceIndex)
        .labels.find((entry) => entry.key === reference.argument);
      if (label) {
        reveal(editor.state.doc.lineAt(label.from).number);
        return true;
      }
      const external = projectRef.current.labels.find((entry) => entry.key === reference.argument);
      if (external) {
        latest.current.onOpenFile(external.file, external.line);
        return true;
      }
      return false;
    },
    [reveal],
  );
  const showInPdf = useCallback((editor: EditorView) => {
    const position = editor.state.selection.main.head;
    const line = editor.state.doc.lineAt(position);
    latest.current.onForwardSync({ line: line.number, column: position - line.from + 1 });
    return true;
  }, []);
  useLayoutEffect(() => {
    if (!host.current) return;
    const report = (editor: EditorView) => {
      const selection = editor.state.selection;
      const line = editor.state.doc.lineAt(selection.main.head);
      setCursor({
        line: line.number,
        column: selection.main.head - line.from + 1,
        selected: selection.ranges.reduce((count, range) => count + range.to - range.from, 0),
      });
      setSections(editor.state.field(latexSourceIndex).sections);
    };
    const saved = latest.current.session.current;
    const initial = latest.current.contents;
    const extensions = [
      ...(initial.includes("\r\n") ? [EditorState.lineSeparator.of("\r\n")] : []),
      configuration.of([]),
      diagnosticConfig.of([]),
      sourceTheme,
      latexSourceIndex,
      latexSourceFolding,
      latexSourceIndent,
      StreamLanguage.define(stex),
      syntaxHighlighting(highlight),
      historyConfig.of(history()),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      indentUnit.of("  "),
      foldGutter(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorState.allowMultipleSelections.of(true),
      EditorState.tabSize.of(2),
      EditorState.languageData.of(() => [
        { closeBrackets: { brackets: ["(", "[", "{"] }, commentTokens: { line: "%" } },
      ]),
      EditorView.contentAttributes.of({
        "aria-label": "LaTeX source editor",
        "aria-multiline": "true",
        autocapitalize: "off",
        autocorrect: "off",
      }),
      keymap.of([
        ...completionKeymap,
        ...closeBracketsKeymap,
        {
          key: "Tab",
          run: (editor) =>
            acceptCompletion(editor) || nextSnippetField(editor) || indentMore(editor),
          shift: (editor) => prevSnippetField(editor) || indentLess(editor),
        },
        { key: "Enter", run: completeLatexEnvironment },
        { key: "Mod-s", run: () => true },
        ...defaultKeymap.filter(
          (binding) => binding.run !== toggleComment && binding.run !== gotoLine,
        ),
        ...historyKeymap,
        ...searchKeymap.filter(
          (binding) => binding.run !== openSearchPanel && binding.run !== gotoLine,
        ),
        ...foldKeymap.filter((binding) => binding.run !== foldAll && binding.run !== unfoldAll),
      ]),
      EditorView.domEventHandlers({
        click: (event, editor) => {
          if (!(event.ctrlKey || event.metaKey)) return false;
          const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
          if (position === null || !goToDefinition(editor, position)) return false;
          event.preventDefault();
          return true;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (
          update.docChanged &&
          !update.transactions.some((transaction) => transaction.annotation(externalSource))
        ) {
          autoBuildSource.current = update.state.sliceDoc();
          latest.current.onContentsChange(update.state.sliceDoc());
        }
        if (update.docChanged || update.selectionSet) report(update.view);
      }),
    ];
    const state =
      saved?.key === identity && saved.state.sliceDoc() === initial
        ? saved.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state
        : EditorState.create({ doc: initial, extensions });
    const editor = new EditorView({ parent: host.current, state });
    view.current = editor;
    const detachWriting = attachShortcutHost(editor.dom, ["latex", "source"], {
      capture: true,
      accepts: (event) =>
        event.target instanceof Element &&
        editor.contentDOM.contains(event.target) &&
        !editor.composing,
      execute: (id) => {
        if (id === "latex.shortcuts") {
          setShortcuts(true);
          return true;
        }
        if (id === "latex.outline") {
          setOutlineOpen((open) => !open);
          return true;
        }
        if (id === "source.find") return openSearchPanel(editor);
        if (id === "source.gotoLine") return gotoLine(editor);
        if (id === "source.definition") return goToDefinition(editor);
        if (id === "source.pdf") return showInPdf(editor);
        if (id === "source.fold") return foldAll(editor);
        if (id === "source.unfold") return unfoldAll(editor);
        if (id === "source.build") {
          if (!latest.current.canBuild) return false;
          autoBuildSource.current = null;
          latest.current.onBuild();
          return true;
        }
        if (latest.current.disabled) return false;
        if (id === "latex.bold") return wrapLatexSelection(editor, "\\textbf{", "}");
        if (id === "latex.italic") return wrapLatexSelection(editor, "\\textit{", "}");
        if (id === "source.comment") return toggleComment(editor);
        if (id === "source.indent") return indentSelection(editor);
        const templates: Record<string, string> = {
          "latex.paragraph": "\n\n${}",
          "latex.section": "\\section{${}}",
          "latex.subsection": "\\subsection{${}}",
          "latex.subsubsection": "\\subsubsection{${}}",
          "latex.bulletList": "\\begin{itemize}\n  \\item ${}\n\\end{itemize}",
          "latex.orderedList": "\\begin{enumerate}\n  \\item ${}\n\\end{enumerate}",
          "latex.footnote": "\\footnote{${}}",
          "latex.reference": "\\ref{${}}",
          "latex.figure":
            "\\begin{figure}\n  \\centering\n  \\includegraphics[width=\\linewidth]{${}}\n  \\caption{${}}\n\\end{figure}",
          "latex.table": "\\begin{tabular}{ll}\n  ${} & ${} \\\\\n  ${} & ${}\n\\end{tabular}",
          "latex.pagebreak": "\\newpage\n${}",
        };
        const template = templates[id];
        if (!template) return false;
        const selection = editor.state.selection.main;
        snippet(template)(editor, null, selection.from, selection.to);
        return true;
      },
    });
    const detachMath = math.attach(editor.dom, (event) => {
      if (!(event.target instanceof Element) || !editor.contentDOM.contains(event.target))
        return false;
      if ((event.ctrlKey || event.metaKey) && event.code === "Space") return false;
      return completionStatus(editor.state) !== "active" && !hasNextSnippetField(editor.state);
    });
    if (saved?.key === identity) {
      editor.scrollDOM.scrollTop = saved.scrollTop;
      editor.scrollDOM.scrollLeft = saved.scrollLeft;
    }
    report(editor);
    return () => {
      detachWriting();
      detachMath();
      math.close(false);
      latest.current.session.current = {
        key: identity,
        state: editor.state,
        scrollTop: editor.scrollDOM.scrollTop,
        scrollLeft: editor.scrollDOM.scrollLeft,
      };
      editor.destroy();
      view.current = null;
    };
  }, [identity, configuration, diagnosticConfig, historyConfig, goToDefinition, showInPdf, math]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.sliceDoc() === props.contents) return;
    // Only actual external changes replace the model. Save acknowledgements keep selection and undo.
    const text = editor.state.toText(props.contents);
    const old = editor.state.doc;
    let from = 0,
      endOld = old.length,
      endNew = text.length;
    const oldText = old.toString(),
      nextText = text.toString();
    while (from < endOld && from < endNew && oldText[from] === nextText[from]) from++;
    while (endOld > from && endNew > from && oldText[endOld - 1] === nextText[endNew - 1]) {
      endOld--;
      endNew--;
    }
    editor.dispatch({
      changes: { from, to: endOld, insert: text.slice(from, endNew) },
      annotations: [externalSource.of(true), Transaction.addToHistory.of(false)],
      effects: historyConfig.reconfigure([]),
    });
    editor.dispatch({ effects: historyConfig.reconfigure(history()) });
  }, [props.contents, historyConfig]);
  useEffect(() => {
    if (
      !options.autoBuild ||
      !props.canBuild ||
      props.saveStatus !== "Saved" ||
      autoBuildSource.current !== props.contents
    )
      return;
    const timer = setTimeout(() => {
      autoBuildSource.current = null;
      latest.current.onBuild();
    }, 1500);
    return () => clearTimeout(timer);
  }, [options.autoBuild, props.contents, props.saveStatus, props.canBuild]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({
      effects: configuration.reconfigure([
        EditorView.theme(
          { ".cm-scroller": { fontSize: `${options.fontSize}px` } },
          { dark: props.resolvedTheme === "dark" },
        ),
        options.wrap ? EditorView.lineWrapping : [],
        options.numbers ? lineNumbers() : [],
        EditorState.readOnly.of(props.disabled),
        EditorView.editable.of(!props.disabled),
        EditorView.contentAttributes.of({ spellcheck: String(options.spellcheck) }),
        autocompletion({
          override: [
            latexSourceCompletion(() => projectRef.current, props.relativePath, props.rootPath),
          ],
          activateOnTyping: options.complete,
          maxRenderedOptions: 40,
          icons: false,
          defaultKeymap: false,
          closeOnBlur: true,
        }),
      ]),
    });
    try {
      localStorage.setItem(preferencesKey, JSON.stringify(options));
    } catch {
      /* Editing does not depend on preference storage. */
    }
  }, [
    options,
    props.disabled,
    props.resolvedTheme,
    props.relativePath,
    props.rootPath,
    configuration,
    identity,
  ]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const file = props.relativePath.replaceAll("\\", "/");
    const root = props.cwd.replaceAll("\\", "/").replace(/\/$/u, "");
    const diagnostics = props.diagnosticsCurrent
      ? props.diagnostics
          .filter(
            (entry) =>
              entry.line !== null &&
              entry.file !== null &&
              [file, `${root}/${file}`].includes(
                entry.file.replaceAll("\\", "/").replace(/^\.\//u, ""),
              ),
          )
          .map((entry) => {
            const line = editor.state.doc.line(
              Math.max(1, Math.min(editor.state.doc.lines, entry.line!)),
            );
            return {
              from: line.from,
              to: line.to,
              severity: entry.severity,
              message: entry.message,
              source: "LaTeX build",
            };
          })
      : [];
    editor.dispatch({
      effects: diagnosticConfig.reconfigure(diagnostics.length ? lintGutter() : []),
    });
    editor.dispatch(setDiagnostics(editor.state, diagnostics));
  }, [
    props.diagnostics,
    props.diagnosticsCurrent,
    props.cwd,
    props.relativePath,
    diagnosticConfig,
    identity,
  ]);
  useEffect(() => {
    if (props.revealLine === null) return;
    reveal(props.revealLine);
  }, [props.revealRequestId, props.revealLine, identity, reveal]);
  const run = (command: (editor: EditorView) => unknown) => {
    if (view.current) {
      command(view.current);
      view.current.focus();
    }
  };
  const insert = (source: string) =>
    run((editor) => {
      if (!editor.state.readOnly)
        snippet(source)(
          editor,
          null,
          editor.state.selection.main.from,
          editor.state.selection.main.to,
        );
    });
  return (
    <div
      className="scient-latex-source"
      data-keybinding-capture=""
      data-theme={props.resolvedTheme}
    >
      <div className="scient-latex-source-toolbar" role="toolbar" aria-label="LaTeX source tools">
        <Action
          label="Document outline"
          active={outlineOpen}
          onClick={() => setOutlineOpen((value) => !value)}
        >
          <ListTree />
        </Action>
        <Action
          label={shortcutLabel("source.find", "Find and replace")}
          onClick={() => run(openSearchPanel)}
        >
          <Search />
        </Action>
        <span className="scient-source-separator" />
        <Action
          label={shortcutLabel("latex.bold", "Bold")}
          disabled={props.disabled}
          onClick={() => run((editor) => wrapLatexSelection(editor, "\\textbf{", "}"))}
        >
          <Bold />
        </Action>
        <Action
          label={shortcutLabel("latex.italic", "Italic")}
          disabled={props.disabled}
          onClick={() => run((editor) => wrapLatexSelection(editor, "\\textit{", "}"))}
        >
          <Italic />
        </Action>
        <Action
          label={shortcutLabel("source.comment", "Comment / uncomment")}
          disabled={props.disabled}
          onClick={() => run(toggleComment)}
        >
          <Code />
        </Action>
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost" size="toolbar" disabled={props.disabled}>
                <Plus /> Insert
              </Button>
            }
          />
          <MenuPopup
            align="start"
            finalFocus={() => {
              view.current?.focus();
              return false;
            }}
          >
            {[
              ["Inline math", "\\(${}\\)"],
              ["Display math", "\\[\n${}\n\\]"],
              ["Equation", "\\begin{equation}\n${}\n\\end{equation}"],
              ["Aligned equations", "\\begin{align*}\n${} & ${} \\\\\n${} & ${}\n\\end{align*}"],
              [
                "Figure",
                "\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=\\linewidth]{${}}\n  \\caption{${}}\n  \\label{fig:}\n\\end{figure}",
              ],
              ["Table", "\\begin{tabular}{cc}\n${} & ${} \\\\\n${} & ${}\n\\end{tabular}"],
              ["Bulleted list", "\\begin{itemize}\n  \\item ${}\n\\end{itemize}"],
              ["Numbered list", "\\begin{enumerate}\n  \\item ${}\n\\end{enumerate}"],
              ["Section", "\\section{${}}"],
              ["Citation", "\\cite{${}}"],
              ["Reference", "\\ref{${}}"],
              ["Footnote", "\\footnote{${}}"],
            ].map(([label, source]) => (
              <MenuItem size="compact" key={label} onClick={() => insert(source!)}>
                {label}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        <span className="scient-source-spacer" />
        {!props.disabled ? <MathInputTools controller={math} /> : null}
        <Action
          label={shortcutLabel("source.pdf", "Find selection in PDF")}
          onClick={() => run(showInPdf)}
        >
          <Locate />
        </Action>
        <Menu>
          <ScientTooltip content="Source editor options">
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" aria-label="Source editor options">
                  <Settings2 />
                </Button>
              }
            />
          </ScientTooltip>
          <MenuPopup
            align="end"
            finalFocus={() => {
              view.current?.focus();
              return false;
            }}
          >
            <MenuCheckboxItem
              checked={options.autoBuild}
              onCheckedChange={(autoBuild) => setOptions((value) => ({ ...value, autoBuild }))}
            >
              Auto update PDF after saving
            </MenuCheckboxItem>
            <MenuCheckboxItem
              checked={options.wrap}
              onCheckedChange={(wrap) => setOptions((value) => ({ ...value, wrap }))}
            >
              Wrap long lines
            </MenuCheckboxItem>
            <MenuCheckboxItem
              checked={options.numbers}
              onCheckedChange={(numbers) => setOptions((value) => ({ ...value, numbers }))}
            >
              Line numbers
            </MenuCheckboxItem>
            <MenuCheckboxItem
              checked={options.complete}
              onCheckedChange={(complete) => setOptions((value) => ({ ...value, complete }))}
            >
              Suggest while typing
            </MenuCheckboxItem>
            <MenuCheckboxItem
              checked={options.spellcheck}
              onCheckedChange={(spellcheck) => setOptions((value) => ({ ...value, spellcheck }))}
            >
              System spellcheck
            </MenuCheckboxItem>
            <MenuSeparator />
            <MenuItem size="compact" onClick={() => run(foldAll)}>
              Fold sections and environments
            </MenuItem>
            <MenuItem size="compact" onClick={() => run(unfoldAll)}>
              Unfold all
            </MenuItem>
            <MenuItem size="compact" disabled={props.disabled} onClick={() => run(indentSelection)}>
              Indent selection
            </MenuItem>
            <MenuItem size="compact" onClick={() => run(gotoLine)}>
              Go to line
            </MenuItem>
            <MenuItem size="compact" onClick={() => run(startCompletion)}>
              Show completions
            </MenuItem>
            <MenuItem size="compact" onClick={() => run((editor) => goToDefinition(editor))}>
              Go to definition (F12)
            </MenuItem>
            <MenuSeparator />
            <MenuItem size="compact" onClick={() => run(undo)}>
              <Undo2 /> Undo
            </MenuItem>
            <MenuItem size="compact" onClick={() => run(redo)}>
              <Redo2 /> Redo
            </MenuItem>
            <MenuItem size="compact" onClick={project.refresh}>
              <RefreshCw /> Refresh linked references
            </MenuItem>
            <MenuItem size="compact" onClick={() => setShortcuts(true)}>
              <Keyboard /> Keyboard shortcuts
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="scient-latex-source-body">
        {outlineOpen ? (
          <nav className="scient-latex-source-outline" aria-label="Source outline">
            <div>
              <input
                aria-label="Filter outline"
                placeholder="Find a section..."
                value={outlineQuery}
                onChange={(event) => setOutlineQuery(event.target.value)}
              />
              <Action label="Close outline" onClick={() => setOutlineOpen(false)}>
                <X />
              </Action>
            </div>
            {sections
              .filter((section) => section.title.toLowerCase().includes(outlineQuery.toLowerCase()))
              .map((section) => (
                <button
                  key={section.from}
                  style={{ paddingInlineStart: 10 + Math.max(0, section.level - 2) * 10 }}
                  onClick={() => {
                    if (view.current) reveal(view.current.state.doc.lineAt(section.from).number);
                  }}
                >
                  {section.title}
                </button>
              ))}
            {!sections.length ? <p>Sections and chapters appear here as you write.</p> : null}
          </nav>
        ) : null}
        <div ref={host} className="scient-latex-source-code" />
      </div>
      <div className="scient-latex-source-status">
        <button
          onClick={() => run(gotoLine)}
          aria-label={`Go to line. Line ${cursor.line}, column ${cursor.column}`}
        >
          Ln {cursor.line}, Col {cursor.column}
        </button>
        {cursor.selected > 0 ? <span>{cursor.selected} selected</span> : null}
        <span role="status">{props.saveStatus}</span>
        {project.pending ? (
          <span>Reading references...</span>
        ) : project.unavailable.length || project.limited ? (
          <ScientTooltip
            content={
              project.unavailable.length
                ? `Could not read: ${project.unavailable.join(", ")}`
                : "Reference suggestions cover up to 40 linked files and 2 million source characters."
            }
          >
            <button onClick={project.refresh}>References incomplete</button>
          </ScientTooltip>
        ) : null}
        {props.diagnosticsCurrent && props.diagnostics.length ? (
          <button onClick={props.onShowDiagnostics}>Build messages</button>
        ) : null}
        <span className="scient-source-spacer" />
        <label>
          Size{" "}
          <input
            aria-label="Source font size"
            type="number"
            min={10}
            max={24}
            value={options.fontSize}
            onChange={(event) => {
              const fontSize = Number(event.target.value);
              if (fontSize >= 10 && fontSize <= 24) setOptions((value) => ({ ...value, fontSize }));
            }}
          />
        </label>
      </div>
      <WritingShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} initialScope="source" />
    </div>
  );
}
