/**
 * Whether a LaTeX document can compile under the engine Scient currently
 * drives, or asks for one it does not.
 *
 * `latexCommand.ts` invokes `latexmk` with `-pdf`, which drives `pdflatex`
 * underneath — Scient does not run XeLaTeX or LuaLaTeX yet. A document that
 * asks for one of those, through the `% !TEX program = …` magic comment
 * editors like TeXShop and TeXstudio read and write, or by loading
 * `fontspec`/`unicode-math` — packages pdfLaTeX cannot process at all — would
 * either compile with the wrong fonts silently accepted and ignored, or fail
 * deep inside a TeX error a reader has no way to map back to "wrong engine".
 * Reading the document before a build starts and saying plainly what it
 * found and what engine it wants is the honest alternative to either.
 *
 * Two kinds of finding, and they are not equally strong. The magic comment is
 * an author's declaration — they wrote down which engine this document is for
 * — so it refuses unconditionally. A package load is an inference, and the
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
 * Pure and read-only: everything here is a function of source text a caller
 * already has in memory, and it decides nothing about what happens next.
 * `LatexBuildService.ts` runs it on the root document's head, once per build,
 * before the engine starts and only on the `latexmk` path.
 */

import { stripLatexComments } from "./latexPreamble.ts";

/** The two engines a document can ask for that Scient does not run. */
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
      message: `Scient currently compiles with pdfLaTeX only. This document's engine-selection comment asks for ${engineDisplayName(requiredEngine)} (found: ${evidence}).`,
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
        message: `Scient currently compiles with pdfLaTeX only. This document loads "${hit}" (found: ${evidence}), which needs XeLaTeX or LuaLaTeX; pdfLaTeX cannot process it.`,
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
  // The document tests the engine itself, so whatever it loads it loads in a
  // branch this scan cannot evaluate. Let the compile answer.
  if (texts.some(hasEngineConditional)) return SUPPORTED_VERDICT;
  for (const text of texts) {
    const verdict = packageLoadVerdict(text);
    if (verdict !== null) return verdict;
  }
  return SUPPORTED_VERDICT;
}
