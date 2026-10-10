import type { MathfieldElement, Style } from "mathlive";
import { latexSourceArgument, latexSourceCommands } from "./latexSourceSyntax";
import { mathColorInput, mathColorSource } from "./mathColorSyntax";

export type MathTextFormat = "bold" | "italic" | "monospace";

/** Single-argument formatting commands need an editable slot even when empty. */
export const MATH_FORMATTING_ARGUMENTS: Readonly<Record<string, "text" | "math">> = {
  text: "text",
  textbf: "text",
  textit: "text",
  texttt: "text",
  textrm: "text",
  textsf: "text",
  textmd: "text",
  textup: "text",
  textsl: "text",
  textsc: "text",
  textnormal: "text",
  mathbf: "math",
  mathit: "math",
  mathrm: "math",
  mathsf: "math",
  mathtt: "math",
  mathnormal: "math",
  mathbfit: "math",
  mathbb: "math",
  mathcal: "math",
  mathfrak: "math",
  mathscr: "math",
  boldsymbol: "math",
  bm: "math",
};

const formattingStyles: Readonly<Record<string, Style>> = {
  text: {},
  textbf: { fontSeries: "b" },
  textmd: { fontSeries: "m" },
  textit: { fontShape: "it" },
  textup: { fontShape: "n" },
  textsl: { fontShape: "sl" },
  textsc: { fontShape: "sc" },
  textnormal: { fontShape: "n", fontSeries: "m" },
  textrm: { fontFamily: "roman" },
  textsf: { fontFamily: "sans-serif" },
  texttt: { fontFamily: "monospace" },
  mathbf: { variant: "normal", variantStyle: "bold" },
  mathit: { variant: "main", variantStyle: "italic" },
  mathrm: { variant: "normal", variantStyle: "up" },
  mathsf: { variant: "sans-serif", variantStyle: "up" },
  mathtt: { variant: "monospace", variantStyle: "up" },
  mathnormal: { variant: "normal", variantStyle: "italic" },
  mathbfit: { variant: "main", variantStyle: "bolditalic" },
  mathbb: { variant: "double-struck" },
  mathcal: { variant: "calligraphic" },
  mathfrak: { variant: "fraktur" },
  mathscr: { variant: "script" },
  boldsymbol: { variantStyle: "bold" },
  bm: { variantStyle: "bold" },
};
const scopeMarker = "scient-format=";

function formattingScopeStyle(command: string, inherited: Style): Style {
  const style = { ...inherited, ...formattingStyles[command] };
  if (["mathbb", "mathcal", "mathfrak", "mathscr"].includes(command))
    style.variantStyle = String(inherited.variantStyle ?? "").includes("bold") ? "bold" : "up";
  return style;
}

/** Screen-only wrappers keep a font argument editable instead of flattening it. */
export function mathFormattingScopeCommand(atom: {
  readonly command?: string;
  readonly args?: readonly unknown[];
}): string | null {
  if (atom.command !== "\\htmlData" || typeof atom.args?.[0] !== "string") return null;
  const marker = atom.args[0];
  if (!marker.startsWith(scopeMarker)) return null;
  const command = marker.slice(scopeMarker.length);
  return Object.hasOwn(MATH_FORMATTING_ARGUMENTS, command) ? command : null;
}

function formattingScopesInput(source: string, customCommands?: Readonly<Record<string, unknown>>) {
  if (customCommands?.htmlData) return source;
  const commands = latexSourceCommands(source);
  const wrapped = new Set<number>();
  for (const command of commands) {
    if (command.name !== "htmlData") continue;
    const marker = latexSourceArgument(source, command.to);
    const body = marker && latexSourceArgument(source, marker.end);
    if (body && mathFormattingScopeCommand({ command: "\\htmlData", args: [marker!.value] }))
      wrapped.add(body.from);
  }
  for (const command of commands.toReversed()) {
    if (
      !Object.hasOwn(MATH_FORMATTING_ARGUMENTS, command.name) ||
      customCommands?.[command.name] ||
      wrapped.has(command.from)
    )
      continue;
    const body = latexSourceArgument(source, command.to);
    if (!body) continue;
    const content = source.slice(command.from, body.end);
    source =
      source.slice(0, command.from) +
      `\\htmlData{${scopeMarker}${command.name}}{${content}}` +
      source.slice(body.end);
  }
  return source;
}

type FormattingSerialization = {
  defaultMode?: "math" | "text" | "latex";
  skipStyles?: boolean;
};
interface FormattingAtom {
  readonly type?: string;
  readonly command?: string;
  readonly args?: readonly unknown[];
  readonly body?: readonly FormattingAtom[];
  readonly parent?: FormattingAtom;
  readonly rightSibling?: FormattingAtom;
  style: Style;
  bodyToLatex(options: FormattingSerialization): string;
  supsubToLatex(options: FormattingSerialization): string;
  _serialize(options: FormattingSerialization): string;
}
interface FormattingController {
  readonly model: {
    readonly atoms: readonly FormattingAtom[];
    at(offset: number): FormattingAtom;
    offsetOf(atom: FormattingAtom): number;
    getValue(...args: unknown[]): string;
  };
  readonly defaultStyle: Style;
  readonly styleBias: string;
}

/** Preserve native font scopes, insertion style, and portable source through undo. */
export function installMathFormattingScopes(math: MathfieldElement) {
  const controller = (math as unknown as { _mathfield?: FormattingController })._mathfield;
  if (!controller) return { dispose: () => {} };
  const model = controller.model;
  const getValue = model.getValue;
  const insertStyle = math.onInsertStyle;
  const patched = new WeakSet<FormattingAtom>();
  const refresh = () => {
    for (const atom of model.atoms) {
      const command = mathFormattingScopeCommand(atom);
      if (!command || patched.has(atom)) continue;
      atom._serialize = (options) => {
        const inherited = atom.style;
        // Native math serialization compares children with their parent style.
        // Supply the argument's context only while serializing its body, so the
        // outer run does not wrap the owner in a second copy of the same font.
        atom.style = formattingScopeStyle(command, inherited);
        let body: string;
        try {
          body = atom.bodyToLatex({
            ...options,
            defaultMode: MATH_FORMATTING_ARGUMENTS[command]!,
          });
        } finally {
          atom.style = inherited;
        }
        // Text serialization repeats its font even within the same context.
        if (MATH_FORMATTING_ARGUMENTS[command] === "text" && body.startsWith(`\\${command}{`)) {
          const repeated = latexSourceArgument(body, command.length + 1);
          if (repeated?.end === body.length) body = repeated.value;
        }
        return `${options.skipStyles ? body : `\\${command}{${body}}`}${atom.supsubToLatex(options)}`;
      };
      patched.add(atom);
    }
  };
  model.getValue = function (...args) {
    refresh();
    return getValue.apply(this, args);
  };
  math.onInsertStyle = (sender, at, info) => {
    refresh();
    if (insertStyle) return insertStyle(sender, at, info);
    if (insertStyle === null || math.mode === "latex") return {};
    const bias = controller.styleBias;
    const adjacent = model.at(bias === "right" ? info.after : info.before);
    let scope = model.at(at)?.parent;
    while (scope && !mathFormattingScopeCommand(scope)) scope = scope.parent;
    if (scope) {
      const scopeStyle = formattingScopeStyle(mathFormattingScopeCommand(scope)!, scope.style);
      return {
        ...scopeStyle,
        ...adjacent?.style,
        ...controller.defaultStyle,
        ...(scopeStyle.variant ? { variant: scopeStyle.variant } : {}),
      };
    }
    if (bias === "none" || !adjacent) return controller.defaultStyle;
    return math.mode === "math"
      ? { ...adjacent.style, variant: "normal", ...controller.defaultStyle }
      : adjacent.style;
  };
  math.addEventListener("input", refresh);
  return {
    dispose: () => {
      math.removeEventListener("input", refresh);
      model.getValue = getValue;
      math.onInsertStyle = insertStyle;
    },
  };
}

/** Show an insertion caret inside the new argument rather than selecting its slot. */
export function enterMathArgument(math: MathfieldElement, adjacent = false): boolean {
  const model = (math as unknown as { _mathfield?: FormattingController })._mathfield?.model;
  if (!model || math.readOnly) return false;
  const range = math.selection.ranges[0];
  const atom = model.at(math.position);
  const selectedAtom =
    range && math.selection.ranges.length === 1 && Math.abs(range[1] - range[0]) === 1
      ? model.at(Math.max(range[0], range[1]))
      : undefined;
  const brackets =
    selectedAtom?.type === "leftright"
      ? selectedAtom
      : math.selectionIsCollapsed && atom?.type === "leftright"
        ? atom
        : undefined;
  if (brackets?.body?.length) {
    math.position = model.offsetOf(brackets.body.at(-1)!);
    return true;
  }
  const next = atom?.rightSibling;
  const owner =
    selectedAtom?.type === "placeholder"
      ? selectedAtom.parent
      : mathFormattingScopeCommand(atom)
        ? atom
        : adjacent && next && mathFormattingScopeCommand(next)
          ? next
          : atom?.parent;
  const command = owner && mathFormattingScopeCommand(owner);
  // The placeholder's own stop paints the caret at the empty guide's center.
  // Its preceding sentinel paints at the edge and leaves the slot marked vacant.
  if (selectedAtom?.type === "placeholder") {
    math.position = model.offsetOf(selectedAtom);
    if (command) math.executeCommand(["switchMode", MATH_FORMATTING_ARGUMENTS[command]!]);
    return true;
  }
  if (!command) return false;
  if (math.selectionIsCollapsed && owner === atom && atom.body?.length)
    math.position = model.offsetOf(atom.body.at(-1)!);
  else if (math.selectionIsCollapsed && owner === next && next?.body?.length)
    math.position = model.offsetOf(
      next.body.length === 2 && next.body[1]?.type === "placeholder" ? next.body[1] : next.body[0]!,
    );
  else return false;
  math.executeCommand(["switchMode", MATH_FORMATTING_ARGUMENTS[command]!]);
  return true;
}

/** Recreate vacant font slots on load; source serialization omits the placeholders. */
function emptyFormattingInput(
  source: string,
  customCommands?: Readonly<Record<string, unknown>>,
): string {
  if (!/\\(?:text|math|boldsymbol|bm)[A-Za-z]*\s*\{\s*\}/u.test(source)) return source;
  for (const command of latexSourceCommands(source).toReversed()) {
    if (!Object.hasOwn(MATH_FORMATTING_ARGUMENTS, command.name) || customCommands?.[command.name])
      continue;
    const body = latexSourceArgument(source, command.to);
    if (body && !body.value.trim())
      source = source.slice(0, body.from) + "\\placeholder{}" + source.slice(body.to);
  }
  return source;
}

/** Prose and math use different font commands, including inside a formula's text slots. */
export function mathTextFormatActive(math: MathfieldElement, format: MathTextFormat): boolean {
  if (math.mode === "text") {
    const style: Style =
      format === "bold"
        ? { fontSeries: "b" }
        : format === "italic"
          ? { fontShape: "it" }
          : { fontFamily: "monospace" };
    return math.queryStyle(style) === "all";
  }
  if (format === "monospace") return math.queryStyle({ variant: "monospace" }) === "all";
  return (
    math.queryStyle({ variantStyle: format }) === "all" ||
    math.queryStyle({ variantStyle: "bolditalic" }) === "all"
  );
}

export function toggleMathTextFormat(math: MathfieldElement, format: MathTextFormat): void {
  if (math.mode === "text") {
    math.applyStyle(
      format === "bold"
        ? { fontSeries: "b" }
        : format === "italic"
          ? { fontShape: "it" }
          : { fontFamily: "monospace" },
      { operation: "toggle" },
    );
    return;
  }
  if (format === "monospace") {
    math.applyStyle({ variant: "monospace", variantStyle: "up" }, { operation: "toggle" });
    return;
  }
  const bold =
    format === "bold" ? !mathTextFormatActive(math, "bold") : mathTextFormatActive(math, "bold");
  const italic =
    format === "italic"
      ? !mathTextFormatActive(math, "italic")
      : mathTextFormatActive(math, "italic");
  math.applyStyle({
    variant: "main",
    variantStyle: bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "up",
  });
}

/** Native font commands and CSS color arguments need portable LaTeX spellings. */
export function mathTextFormattingSource(
  source: string,
  customCommands?: Readonly<Record<string, unknown>>,
  documentSource?: string,
): string {
  source = mathColorSource(source, customCommands, documentSource);
  if (customCommands?.mathbfit || !source.includes("\\mathbfit")) return source;
  for (const command of latexSourceCommands(source).toReversed()) {
    if (command.name !== "mathbfit") continue;
    const body = latexSourceArgument(source, command.to);
    if (body)
      source =
        source.slice(0, command.from) +
        `\\boldsymbol{\\mathit{${body.value}}}` +
        source.slice(body.end);
  }
  return source;
}

/** Retain combined weight/slant when MathLive reparses standard LaTeX font nesting. */
export function mathTextFormattingInput(
  source: string,
  customCommands?: Readonly<Record<string, unknown>>,
): string {
  source = mathColorInput(source, customCommands);
  source = emptyFormattingInput(source, customCommands);
  if (customCommands?.mathbfit || customCommands?.mathit)
    return formattingScopesInput(source, customCommands);
  if (!source.includes("\\boldsymbol") && !source.includes("\\bm"))
    return formattingScopesInput(source, customCommands);
  for (const command of latexSourceCommands(source).toReversed()) {
    if (command.name !== "boldsymbol" && command.name !== "bm") continue;
    if (customCommands?.[command.name]) continue;
    const body = latexSourceArgument(source, command.to);
    if (!body) continue;
    const inner = /^\s*\\mathit\b/u.exec(body.value);
    const text = inner && latexSourceArgument(body.value, inner[0].length);
    if (text && !body.value.slice(text.end).trim())
      source = source.slice(0, command.from) + `\\mathbfit{${text.value}}` + source.slice(body.end);
  }
  return formattingScopesInput(source, customCommands);
}
