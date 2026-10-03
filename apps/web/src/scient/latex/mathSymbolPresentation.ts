import { convertLatexToMarkup, validateLatex } from "mathlive";
import { MATH_SYMBOLS, type MathSymbol } from "./mathSymbols";

let macros: Record<string, { def: string; expand: false }> | undefined;

export function mathSymbolMacros() {
  if (macros) return macros;
  macros = {};
  for (const symbol of MATH_SYMBOLS) {
    if (!symbol.glyph || !/^\\[A-Za-z]+$/u.test(symbol.command)) continue;
    if (!validateLatex(symbol.command).some((error) => error.code === "unknown-command")) continue;
    // A Unicode glyph is a local screen representation only. Preserve the
    // original package command for TeX; never substitute a look-alike in source.
    if (/[{}\\]/u.test(symbol.glyph)) continue;
    const glyph = symbol.glyph.replace(/[$%#&_]/gu, (character) => `\\${character}`);
    macros[symbol.command.slice(1)] = { def: `\\text{${glyph}}`, expand: false };
  }
  return macros;
}

const previews = new Map<string, { markup: string; sourceOnly: boolean }>();

export function mathSymbolPreview(symbol: MathSymbol) {
  const cached = previews.get(symbol.id);
  if (cached) return cached;
  const extraMacros = mathSymbolMacros();
  const unsupported = validateLatex(symbol.preview).some(
    (error) =>
      error.code === "unknown-command" && !extraMacros[(error.arg ?? "").replace(/^\\/u, "")],
  );
  const result = {
    // convertLatexToMarkup's macros option replaces the default dictionary;
    // passing only our extras breaks built-ins such as varDelta and implies.
    // Expand only our display aliases, then let the normal renderer retain all
    // of its default commands. This affects thumbnails, never document source.
    markup: unsupported
      ? ""
      : convertLatexToMarkup(
          symbol.preview.replace(/\\[A-Za-z]+/gu, (command) => {
            const macro = extraMacros[command.slice(1)];
            return macro ? `{${macro.def}}` : command;
          }),
        ),
    sourceOnly: unsupported,
  };
  previews.set(symbol.id, result);
  return result;
}
