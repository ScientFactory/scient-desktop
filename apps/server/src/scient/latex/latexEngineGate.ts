/**
 * Select a declared compiler and check whether the default pdfLaTeX lane can
 * process the document. Only fixed engine names become invocation flags.
 *
 * Without a directive, `latexCommand.ts` uses `latexmk -pdf`. Explicit
 * `% !TEX program = …` declarations select LuaLaTeX or XeLaTeX through latexmk.
 * For the default pdfLaTeX lane, package checks explain incompatible
 * `fontspec`/`unicode-math` loads before compilation.
 *
 * Two kinds of finding, and they are not equally strong. The magic comment is
 * an author's declaration — they wrote down which engine this document is for
 * — so selection honors it. A package load is an inference, and the
 * inference is wrong for every document that guards the load behind an engine
 * test. Pandoc's default template is exactly that document: it loads `iftex`
 * and then `\ifPDFTeX … \else \usepackage{unicode-math} \usepackage{fontspec}
 * \fi`, which compiles perfectly under pdfLaTeX because pdfLaTeX never reaches
 * the branch. So a document that shows any engine-conditional idiom — one of
 * the guard packages, or one of the conditionals they define — has its
 * package-load verdict suppressed and lets the compile decide. This gate reads
 * text, not TeX; it cannot evaluate the branch, and refusing a document it
 * merely failed to understand is worse than letting the engine answer.
 *
 * Pure and read-only: selection uses source text already held by the caller.
 * `LatexBuildService.ts` selects the compiler from the bounded preamble heads
 * before running the existing build and publication pipeline.
 */

import { stripLatexComments } from "./latexPreamble.ts";
import type { LatexEngine, LatexToolchainKind } from "./latexCommand.ts";

/** Engines incompatible with the default pdfLaTeX lane. */
export type LatexRequiredEngine = "xelatex" | "lualatex";

export interface LatexEngineSupported {
  readonly supported: true;
}

export interface LatexEngineUnsupported {
  readonly supported: false;
  readonly requiredEngine: LatexRequiredEngine;
  /** The exact source line that gave it away, trimmed but otherwise verbatim. */
  readonly evidence: string;
  /** User-facing: names what Scient found and what engine it asks for. */
  readonly message: string;
}

export type LatexEngineVerdict = LatexEngineSupported | LatexEngineUnsupported;

export interface LatexEngineGateInput {
  /** The root document's own text. */
  readonly rootText: string;
  /**
   * Text of any files the caller has already read for another reason — the
   * bounded preamble includes `latexPreamble.ts` resolves, most likely. This
   * check never reads a file itself; it only looks at text it is handed.
   */
  readonly includedTexts?: ReadonlyArray<string>;
}

const SUPPORTED_VERDICT: LatexEngineSupported = { supported: true };

/**
 * `% !TEX program = xelatex` and its variants: `%!TEX`, extra spacing, and
 * TeXShop's `TS-program` spelling of the same key. Case-insensitive, because
 * every editor that writes these is inconsistent about casing and the
 * convention itself never was case-sensitive.
 */
const MAGIC_COMMENT_PATTERN = /^\s*%+\s*!\s*TEX\s+(?:program|TS-program)\s*=\s*([A-Za-z]+)/iu;

/**
 * `\usepackage{fontspec}`, `\RequirePackage[no-math]{unicode-math}`, and a
 * package named among others in the same group. The option group — which may
 * itself carry braces and commas — is skipped, matching `latexPreamble.ts`'s
 * own package pattern.
 */
const PACKAGE_LOAD_PATTERN = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/gu;

/** Packages pdfLaTeX cannot process at all, regardless of what they are asked to do. */
const ENGINE_ONLY_PACKAGES: ReadonlySet<string> = new Set(["fontspec", "unicode-math"]);

/**
 * Packages whose whole purpose is to let a document ask which engine is
 * running it. `iftex` is the modern one and defines all of the conditionals
 * below; `ifxetex` and `ifluatex` are the older single-purpose packages it
 * replaced, still loaded by templates written before it existed.
 */
const ENGINE_GUARD_PACKAGES: ReadonlySet<string> = new Set(["iftex", "ifxetex", "ifluatex"]);

/**
 * The conditionals those packages define, in every casing they are written in
 * — `\ifPDFTeX` and `\ifpdftex` are the same macro spelled the two ways the
 * documentation and the wild both use. `\ifpdf` is deliberately absent: it
 * tests PDF *output mode*, not the engine, and a document branching on it says
 * nothing about which engine it wants.
 */
const ENGINE_CONDITIONAL_PATTERN = /\\if(?:pdftex|xetex|luatex|tutex)\b/iu;

function requiredEngineForToken(token: string): LatexRequiredEngine | null {
  const normalized = token.toLowerCase();
  if (normalized === "xelatex" || normalized === "xetex") return "xelatex";
  if (normalized === "lualatex" || normalized === "luatex") return "lualatex";
  return null;
}

function engineDisplayName(requiredEngine: LatexRequiredEngine): string {
  return requiredEngine === "xelatex" ? "XeLaTeX" : "LuaLaTeX";
}

function magicCommentVerdict(text: string): LatexEngineUnsupported | null {
  for (const rawLine of text.split(/\r?\n/u)) {
    const match = MAGIC_COMMENT_PATTERN.exec(rawLine);
    const token = match?.[1];
    if (token === undefined) continue;
    const requiredEngine = requiredEngineForToken(token);
    if (requiredEngine === null) continue;
    const evidence = rawLine.trim();
    return {
      supported: false,
      requiredEngine,
      evidence,
      message: `This document's engine-selection comment asks for ${engineDisplayName(requiredEngine)}, which cannot be compiled by pdfLaTeX (found: ${evidence}).`,
    };
  }
  return null;
}

/**
 * Whether this text branches on the engine anywhere: it loads one of the guard
 * packages, or it uses one of their conditionals. Either is enough — a
 * template can load `iftex` in one file and branch in another, and both halves
 * mean the same thing about the document as a whole.
 *
 * Comment-stripped, like the package scan, so a commented-out `\ifPDFTeX` in a
 * note to a co-author cannot switch the refusal off.
 */
function hasEngineConditional(text: string): boolean {
  for (const rawLine of text.split(/\r?\n/u)) {
    const strippedLine = stripLatexComments(rawLine);
    if (strippedLine.trim().length === 0) continue;
    if (ENGINE_CONDITIONAL_PATTERN.test(strippedLine)) return true;
    PACKAGE_LOAD_PATTERN.lastIndex = 0;
    for (const match of strippedLine.matchAll(PACKAGE_LOAD_PATTERN)) {
      const names = (match[1] ?? "").split(",").map((name) => name.trim().toLowerCase());
      if (names.some((name) => ENGINE_GUARD_PACKAGES.has(name))) return true;
    }
  }
  return false;
}

function packageLoadVerdict(text: string): LatexEngineUnsupported | null {
  for (const rawLine of text.split(/\r?\n/u)) {
    const strippedLine = stripLatexComments(rawLine);
    if (strippedLine.trim().length === 0) continue;
    PACKAGE_LOAD_PATTERN.lastIndex = 0;
    for (const match of strippedLine.matchAll(PACKAGE_LOAD_PATTERN)) {
      const names = (match[1] ?? "").split(",").map((name) => name.trim());
      const hit = names.find((name) => ENGINE_ONLY_PACKAGES.has(name));
      if (hit === undefined) continue;
      const evidence = rawLine.trim();
      // fontspec and unicode-math both run under either non-pdfLaTeX engine;
      // nothing in the package load names which one the author meant, so
      // xelatex — the more common choice for either package — is reported as
      // the representative answer while the message names both by name.
      const requiredEngine: LatexRequiredEngine = "xelatex";
      return {
        supported: false,
        requiredEngine,
        evidence,
        message: `This document loads "${hit}" (found: ${evidence}), which needs XeLaTeX or LuaLaTeX; pdfLaTeX cannot process it. Add % !TEX program = lualatex or % !TEX program = xelatex to select the compiler.`,
      };
    }
  }
  return null;
}

/**
 * The verdict for one document: `{ supported: true }` when nothing here asks
 * for another engine, or a refusal naming exactly what was found.
 *
 * Order carries meaning. Magic comments are checked across every text handed
 * in first, so a document that both declares `% !TEX program = xelatex` and
 * loads `fontspec` is reported by the directive that named the engine on
 * purpose rather than the package that merely implies it — and so a document
 * that declares an engine is still refused however much `iftex` machinery it
 * also carries. Only then does the engine-conditional check run, and only the
 * weaker package-load inference is suppressed by it.
 */
export function evaluateLatexEngineGate(input: LatexEngineGateInput): LatexEngineVerdict {
  const texts = [input.rootText, ...(input.includedTexts ?? [])];
  for (const text of texts) {
    const verdict = magicCommentVerdict(text);
    if (verdict !== null) return verdict;
  }
  return evaluatePdfLatexPackages(texts);
}

function evaluatePdfLatexPackages(texts: readonly string[]): LatexEngineVerdict {
  // The document tests the engine itself, so whatever it loads it loads in a
  // branch this scan cannot evaluate. Let the compile answer.
  if (texts.some(hasEngineConditional)) return SUPPORTED_VERDICT;
  for (const text of texts) {
    const verdict = packageLoadVerdict(text);
    if (verdict !== null) return verdict;
  }
  return SUPPORTED_VERDICT;
}

/** Root declarations take precedence over declarations in included preambles. */
export function selectLatexBuildEngine(input: LatexEngineGateInput, toolchain: LatexToolchainKind) {
  let declared: LatexEngine | null = null;
  for (const text of [input.rootText, ...(input.includedTexts ?? [])]) {
    for (const line of text.split(/\r?\n/u)) {
      const token = MAGIC_COMMENT_PATTERN.exec(line)?.[1]?.toLowerCase();
      if (!token) continue;
      declared =
        token === "pdflatex" || token === "pdftex" ? "pdflatex" : requiredEngineForToken(token);
      if (declared) break;
    }
    if (declared) break;
  }
  const engine = declared ?? (toolchain === "tectonic" ? "xelatex" : "pdflatex");
  if (toolchain === "tectonic") {
    return {
      engine,
      error:
        engine === "xelatex"
          ? null
          : `This document requests ${engine === "lualatex" ? "LuaLaTeX" : "pdfLaTeX"}, but the available toolchain is Tectonic. Install a TeX distribution with latexmk and the requested compiler, then refresh the LaTeX toolchain.`,
    };
  }
  if (engine !== "pdflatex") return { engine, error: null };
  const verdict = evaluatePdfLatexPackages([input.rootText, ...(input.includedTexts ?? [])]);
  return { engine, error: verdict.supported ? null : verdict.message };
}
