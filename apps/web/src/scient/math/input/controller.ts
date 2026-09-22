import {
  commandEdit,
  mathCommand,
  matchingMathCommands,
  type MathEdit,
  type MathSelection,
} from "./catalog";
import {
  declaredMathPackages,
  mathContext,
  mathLiteralAt,
  wrapMathEdit,
  type MathInputFormat,
} from "./context";
import { insertMatrix, matrixEdit, type MatrixAction, type MatrixEnvironment } from "./matrix";
import { registerShortcutClaim } from "../../keyboard/ownership";
import { ShortcutSequence } from "../../keyboard/sequence";
import { getKeyboardPreferences, subscribeKeyboardPreferences } from "../../keyboard/preferences";

export interface MathInputSnapshot {
  readonly source: string;
  readonly selection: MathSelection;
  readonly format: MathInputFormat;
  readonly editable: boolean;
  readonly identity?: object;
  readonly location?: string;
  readonly latexPackages?: readonly string[];
}
export interface MathInputAdapter {
  read(): MathInputSnapshot | null;
  /** Compare against the source snapshot and dispatch one host-editor transaction. */
  apply(expected: MathInputSnapshot, edit: MathEdit, display: boolean): boolean;
  focus(): void;
}
interface PanelState {
  readonly open: boolean;
  readonly query: string;
  readonly notice: string;
  readonly sequenceHint?: string;
  readonly version: number;
}

export class MathInputController {
  private paletteSnapshot: MathInputSnapshot | null = null;
  private paletteCompletion: { from: number; to: number } | null = null;
  private readonly sequence: ShortcutSequence;
  private panel: PanelState = { open: false, query: "", notice: "", version: 0 };
  private readonly listeners = new Set<() => void>();
  private contextCache:
    | {
        source: string;
        from: number;
        to: number;
        format: MathInputFormat;
        region: ReturnType<typeof mathContext>;
      }
    | undefined;
  constructor(
    readonly adapter: MathInputAdapter,
    platform = typeof navigator === "undefined" ? "" : navigator.platform,
  ) {
    this.sequence = new ShortcutSequence(
      "math",
      (sequenceHint) => this.update({ sequenceHint }),
      /Mac|iPhone|iPad/u.test(platform),
    );
  }
  getSnapshot = (): PanelState => this.panel;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<PanelState>): void {
    this.panel = { ...this.panel, ...patch, version: this.panel.version + 1 };
    this.listeners.forEach((listener) => listener());
  }
  open(query = ""): void {
    this.paletteCompletion = null;
    const context = this.context();
    if (context) {
      this.paletteSnapshot = context.snapshot;
      this.update({ open: true, query, notice: "" });
    } else
      this.update({
        open: true,
        query,
        notice:
          "Place the caret in editable prose or a supported equation. Code, comments, and ambiguous source are not rewritten.",
      });
  }
  close(returnFocus = true): void {
    this.paletteSnapshot = null;
    this.paletteCompletion = null;
    this.update({ open: false, notice: "" });
    if (returnFocus) this.adapter.focus();
  }
  search(query: string): void {
    this.update({ query });
  }
  private context() {
    const snapshot = this.adapter.read();
    if (!snapshot?.editable) return null;
    const previous = this.contextCache;
    const { from, to } = snapshot.selection;
    const region =
      previous &&
      previous.source === snapshot.source &&
      previous.from === from &&
      previous.to === to &&
      previous.format === snapshot.format
        ? previous.region
        : mathContext(snapshot.source, snapshot.selection, snapshot.format);
    this.contextCache = { source: snapshot.source, from, to, format: snapshot.format, region };
    return region === null ? null : { snapshot, region };
  }
  private commit(edit: MathEdit, display: boolean): boolean {
    const current = this.context();
    if (!current) return false;
    const captured = this.paletteSnapshot;
    if (
      captured &&
      (captured.source !== current.snapshot.source ||
        captured.identity !== current.snapshot.identity ||
        captured.location !== current.snapshot.location ||
        captured.selection.from !== current.snapshot.selection.from ||
        captured.selection.to !== current.snapshot.selection.to)
    ) {
      this.update({
        notice: "The document or selection changed. Close and reopen the math palette.",
      });
      return false;
    }
    const applied = this.adapter.apply(
      current.snapshot,
      current.region === "prose" ? wrapMathEdit(edit, current.snapshot.format, display) : edit,
      display,
    );
    if (!applied) {
      this.update({ notice: "The equation changed. Place the caret again before inserting." });
      return false;
    }
    this.adapter.focus();
    this.update({ notice: "" });
    return true;
  }
  private allowsPackage(name: string): boolean {
    const snapshot = this.adapter.read();
    if (!snapshot) return false;
    const packages =
      snapshot.latexPackages ??
      (snapshot.format === "latex" ? declaredMathPackages(snapshot.source) : null);
    if (packages === null || packages.includes(name)) return true;
    this.update({
      open: true,
      notice: `This command requires ${name}. Add \\usepackage{${name}} to the LaTeX preamble in Source, then insert it here.`,
    });
    return false;
  }
  execute(id: string): boolean {
    const current = this.context();
    if (!current) return false;
    if (id === "math.palette") {
      const match =
        current.region !== "prose" &&
        current.snapshot.selection.from === current.snapshot.selection.to
          ? /\\([A-Za-z]*)$/u.exec(
              current.snapshot.source.slice(current.region.from, current.snapshot.selection.from),
            )
          : null;
      this.open(match?.[1] ?? "");
      this.paletteCompletion = match
        ? {
            from: current.snapshot.selection.from - match[0].length,
            to: current.snapshot.selection.to,
          }
        : null;
      return true;
    }
    if (id === "math.inline" || id === "math.display") {
      if (current.region !== "prose") return false;
      const { source, selection } = current.snapshot;
      const selected = source.slice(selection.from, selection.to);
      const caret = selected ? selection.to : selection.from + 1;
      return this.commit(
        {
          ...selection,
          insert: selected || "{}",
          selection: { from: caret, to: caret },
        },
        id === "math.display",
      );
    }
    if (id.startsWith("math.matrix.")) {
      if (current.region === "prose") return false;
      const edit = matrixEdit(
        current.snapshot.source,
        current.snapshot.selection,
        id.slice("math.matrix.".length) as MatrixAction,
      );
      return edit !== null && this.commit(edit, false);
    }
    const command = mathCommand(id);
    if (
      current.region !== "prose" &&
      mathLiteralAt(current.snapshot.source, current.region.from, current.snapshot.selection.from)
    )
      return false;
    if (
      (id === "math.limits" || id === "math.nolimits") &&
      (current.region === "prose" ||
        !/\\(?:sum|prod|coprod|int|iint|iiint|oint|lim|sup|inf|bigcap|bigcup|bigoplus|bigotimes)\s*$/u.test(
          current.snapshot.source.slice(current.region.from, current.snapshot.selection.from),
        ))
    )
      return false;
    if (command?.requires && !this.allowsPackage(command.requires)) return false;
    if (command && this.paletteCompletion) {
      const expanded = commandEdit(command, current.snapshot.source, {
        from: this.paletteCompletion.from,
        to: this.paletteCompletion.from,
      });
      return this.commit({ ...expanded, to: this.paletteCompletion.to }, false);
    }
    return (
      command !== undefined &&
      this.commit(commandEdit(command, current.snapshot.source, current.snapshot.selection), false)
    );
  }
  matrix(environment: MatrixEnvironment, rows: number, columns: number): boolean {
    const current = this.context();
    if (!current) return false;
    if (
      current.region !== "prose" &&
      mathLiteralAt(current.snapshot.source, current.region.from, current.snapshot.selection.from)
    )
      return false;
    if (!this.allowsPackage("amsmath")) return false;
    const edit = insertMatrix(current.snapshot.selection, environment, rows, columns);
    return edit !== null && this.commit(edit, true);
  }
  private completion(): { command: string; from: number; to: number } | null {
    const current = this.context();
    if (
      !current ||
      current.region === "prose" ||
      current.snapshot.selection.from !== current.snapshot.selection.to ||
      mathLiteralAt(current.snapshot.source, current.region.from, current.snapshot.selection.from)
    )
      return null;
    const { source, selection } = current.snapshot;
    const match = /\\([A-Za-z]+)$/u.exec(source.slice(current.region.from, selection.from));
    if (!match) return null;
    const commands = matchingMathCommands(match[1]!);
    const command =
      commands.find((item) => item.completion === match[1]) ??
      (commands.length === 1 ? commands[0] : undefined);
    return command
      ? { command: command.id, from: selection.from - match[0].length, to: selection.to }
      : null;
  }

  owns(event: KeyboardEvent): boolean {
    if (event.isComposing || event.defaultPrevented || event.getModifierState?.("AltGraph"))
      return false;
    if (this.context() && this.sequence.peek(event)) return true;
    if (!this.context()) return false;

    if (
      (event.key === "Tab" || event.key === " ") &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      getKeyboardPreferences().preferences.completion !== "off" &&
      (event.key === "Tab" || getKeyboardPreferences().preferences.completion === "space-tab") &&
      this.completion()
    )
      return true;
    const current = this.context();
    return (
      current !== null &&
      current.region !== "prose" &&
      (event.key === "Tab" ||
        (event.key === "Enter" && getKeyboardPreferences().preferences.matrixEnter)) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      matrixEdit(
        current.snapshot.source,
        current.snapshot.selection,
        event.key === "Enter" ? "addRow" : event.shiftKey ? "previous" : "next",
      ) !== null
    );
  }
  handle(event: KeyboardEvent): boolean {
    if (event.isComposing || event.defaultPrevented || event.getModifierState?.("AltGraph"))
      return false;
    if (
      this.context() &&
      this.sequence.handle(event, (command) => {
        const applied = this.execute(command);
        if (!applied && !this.panel.notice)
          this.update({
            open: true,
            notice: "This math command is unavailable. The source was not changed.",
          });
        return applied;
      })
    )
      return true;
    const current = this.context();
    if (!current || current.region === "prose" || event.ctrlKey || event.metaKey || event.altKey)
      return false;
    const literal = mathLiteralAt(
      current.snapshot.source,
      current.region.from,
      current.snapshot.selection.from,
    );
    let edit: MathEdit | null = null;
    const preferences = getKeyboardPreferences().preferences;
    if (
      !literal &&
      preferences.completion !== "off" &&
      (event.key === "Tab" || (event.key === " " && preferences.completion === "space-tab"))
    ) {
      const completion = this.completion();
      if (completion) {
        const command = mathCommand(completion.command)!;
        if (command.requires && !this.allowsPackage(command.requires)) {
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        const expanded = commandEdit(command, current.snapshot.source, {
          from: completion.from,
          to: completion.from,
        });
        edit = { ...expanded, to: completion.to };
      }
    }
    if (!edit && (event.key === "Tab" || (event.key === "Enter" && preferences.matrixEnter)))
      edit = matrixEdit(
        current.snapshot.source,
        current.snapshot.selection,
        event.key === "Enter" ? "addRow" : event.shiftKey ? "previous" : "next",
      );
    if (
      !edit &&
      preferences.automaticOperators &&
      !literal &&
      event.key.length === 1 &&
      current.snapshot.selection.from === current.snapshot.selection.to
    ) {
      const { source, selection } = current.snapshot;
      const pair =
        source.slice(Math.max(current.region.from, selection.from - 1), selection.from) + event.key;
      const natural: Readonly<Record<string, string>> = {
        "->": "to",
        "<=": "leq",
        ">=": "geq",
        "!=": "neq",
        "+-": "pm",
      };
      const symbol = natural[pair];
      if (symbol && source[selection.from - 2] !== "\\")
        edit = commandEdit(mathCommand(`math.symbol.${symbol}`)!, source, {
          from: selection.from - 1,
          to: selection.to,
        });
    }
    if (!edit) return false;
    // Hold-to-repeat must not add structural edits such as matrix rows.
    if (!event.repeat && !this.commit(edit, false)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  attach(host: HTMLElement, accepts: (event: KeyboardEvent) => boolean = () => true): () => void {
    const belongs = (event: KeyboardEvent) => event.composedPath().includes(host) && accepts(event);
    const release = registerShortcutClaim(host, (event) => belongs(event) && this.owns(event));
    const unsubscribe = subscribeKeyboardPreferences(() => {
      this.sequence.cancel();
      this.update({});
    });
    const handler = (event: KeyboardEvent) => {
      if (accepts(event)) this.handle(event);
    };
    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !host.contains(event.relatedTarget))
        this.sequence.cancel();
    };
    host.addEventListener("keydown", handler, true);
    host.addEventListener("focusout", blur);
    return () => {
      release();
      unsubscribe();
      host.removeEventListener("keydown", handler, true);
      host.removeEventListener("focusout", blur);
      this.sequence.cancel();
    };
  }
}
