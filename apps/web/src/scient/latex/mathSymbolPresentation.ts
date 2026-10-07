import { convertLatexToMarkup, validateLatex } from "mathlive";
import { MATH_SYMBOLS, type MathSymbol } from "./mathSymbols";
import glyphAtlas from "./mathSymbolGlyphs.json";
import {
  mathSymbolIllustration,
  mathSymbolVisualPreview,
  type MathSymbolIllustration,
} from "./mathSymbolIllustrations";

export interface MathSymbolOutline {
  viewBox: string;
  body: string;
}

const glyphs: Readonly<Record<string, MathSymbolOutline & { latex: string }>> = glyphAtlas;

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

const previews = new WeakMap<
  MathSymbol,
  {
    markup: string;
    sourceOnly: boolean;
    illustration: MathSymbolIllustration | null;
    outline: MathSymbolOutline | null;
  }
>();

export function mathSymbolPreview(symbol: MathSymbol) {
  const cached = previews.get(symbol);
  if (cached) return cached;
  const extraMacros = mathSymbolMacros();
  const latex = mathSymbolVisualPreview(symbol);
  const cannotRender = (source: string) =>
    validateLatex(source).some(
      (error) =>
        error.code === "unknown-command" && !extraMacros[(error.arg ?? "").replace(/^\\/u, "")],
    );
  const unsupported = cannotRender(latex);
  const layoutIllustration = mathSymbolIllustration(symbol);
  const glyph = glyphs[symbol.id];
  const result = {
    // convertLatexToMarkup's macros option replaces the default dictionary;
    // passing only our extras breaks built-ins such as varDelta and implies.
    // Expand only our display aliases, then let the normal renderer retain all
    // of its default commands. This affects thumbnails, never document source.
    markup:
      unsupported || layoutIllustration
        ? ""
        : convertLatexToMarkup(
            latex.replace(/\\[A-Za-z]+/gu, (command) => {
              const macro = extraMacros[command.slice(1)];
              return macro ? `{${macro.def}}` : command;
            }),
          ),
    sourceOnly: latex === symbol.preview ? unsupported : cannotRender(symbol.preview),
    illustration: layoutIllustration,
    // Bundled TeX outlines cover package glyphs absent from the screen renderer.
    // Check the recipe so an edited document macro cannot reuse an unrelated icon.
    outline: unsupported && glyph?.latex === latex ? glyph : null,
  };
  previews.set(symbol, result);
  return result;
}
