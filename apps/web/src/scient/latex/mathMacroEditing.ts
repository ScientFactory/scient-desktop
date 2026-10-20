import type { MathfieldElement, MacroDictionary } from "mathlive";
import type { DocumentMathMacro } from "./latexDocumentMacros";

type SerializationOptions = { expandMacro?: boolean; skipPlaceholders?: boolean };
interface MacroAtom {
  readonly type?: string;
  readonly command?: string;
  readonly body?: readonly MacroAtom[];
  readonly leftDelim?: string;
  readonly rightDelim?: string;
  readonly variant?: string;
  captureSelection: boolean;
  bodyToLatex(options: SerializationOptions): string;
  supsubToLatex(options: SerializationOptions): string;
  _serialize(options: SerializationOptions): string;
}
interface MacroModel {
  readonly atoms: readonly MacroAtom[];
  getValue(...args: unknown[]): string;
}

// Delimiter wrappers have one unambiguous editable argument. Other definitions
// may consume literal tokens, duplicate arguments, or discard them; unlocking
// those expansions would not provide a reversible edit of the original call.
function delimiterMacro(macro: unknown) {
  if (
    !macro ||
    typeof macro !== "object" ||
    !("args" in macro) ||
    macro.args !== 1 ||
    !("def" in macro) ||
    typeof macro.def !== "string"
  )
    return null;
  const match =
    /^\s*\\left\s*(\\[A-Za-z]+|\\[^A-Za-z\s]|[()[\]|.])\s*#1\s*\\right\s*(\\[A-Za-z]+|\\[^A-Za-z\s]|[()[\]|.])\s*$/u.exec(
      macro.def,
    );
  return match ? { left: match[1], right: match[2] } : null;
}

export function editableMathMacros(
  macros: Readonly<Record<string, DocumentMathMacro>>,
): MacroDictionary {
  return Object.fromEntries(
    Object.entries(macros).map(([name, macro]) => [
      name,
      delimiterMacro(macro) ? { ...macro, captureSelection: false } : macro,
    ]),
  );
}

/**
 * MathLive 0.108 serializes the original macroArgs even after its expansion is
 * edited. For delimiter wrappers, recover the current argument from the native
 * fence atom. Use the same adapter for newly inserted and undo-restored atoms.
 * Changing the delimiters materializes that occurrence instead of losing edits.
 */
export function installMathMacroEditing(math: MathfieldElement) {
  const model = (math as unknown as { _mathfield?: { model?: MacroModel } })._mathfield?.model;
  if (!model) return { refresh: () => {}, dispose: () => {} };
  const original = model.getValue;
  const patched = new WeakSet<MacroAtom>();
  const refresh = () => {
    const macros = math.macros;
    for (const atom of model.atoms) {
      if (atom.type !== "macro" || atom.captureSelection || patched.has(atom)) continue;
      const definition = delimiterMacro(macros[atom.command?.slice(1) ?? ""]);
      if (!definition) continue;
      atom._serialize = (options) => {
        const body = atom.body?.filter((child) => child.type !== "first") ?? [];
        const fence = body[0];
        if (
          body.length !== 1 ||
          fence?.type !== "leftright" ||
          fence.variant !== "left...right" ||
          fence.leftDelim !== definition.left ||
          fence.rightDelim !== definition.right
        )
          return atom.bodyToLatex(options);
        return `${atom.command}{${fence.bodyToLatex(options)}}${fence.supsubToLatex(options)}`;
      };
      patched.add(atom);
    }
  };
  model.getValue = function (...args) {
    refresh();
    return original.apply(this, args);
  };
  math.addEventListener("input", refresh);
  return {
    refresh,
    dispose: () => {
      math.removeEventListener("input", refresh);
      model.getValue = original;
    },
  };
}
