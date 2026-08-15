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
 * Pure and read-only: everything here is a function of source text a caller
 * already has in memory, and it decides nothing about what happens next. It
 * is not wired into the build path — `LatexBuildService.ts` calls this once
 * a caller (outside this module) decides where the check belongs in the
 * build sequence.
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
 * for another engine, or a refusal naming exactly what was found. Magic
 * comments are checked across every text handed in before any package load
 * is, so a document that both declares `% !TEX program = xelatex` and loads
 * `fontspec` is reported by the directive that named the engine on purpose
 * rather than the package that merely implies it.
 */
export function evaluateLatexEngineGate(input: LatexEngineGateInput): LatexEngineVerdict {
  const texts = [input.rootText, ...(input.includedTexts ?? [])];
  for (const text of texts) {
    const verdict = magicCommentVerdict(text);
    if (verdict !== null) return verdict;
  }
  for (const text of texts) {
    const verdict = packageLoadVerdict(text);
    if (verdict !== null) return verdict;
  }
  return SUPPORTED_VERDICT;
}
