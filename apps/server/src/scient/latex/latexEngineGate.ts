/**
 * Honor declared engines before weaker package inference, accepting only fixed invocation flags.
 * Suppress Unicode-package inference when engine guards exist: text scanning cannot evaluate
 * branches, and refusing conditional pdfLaTeX-compatible templates would be dishonest.
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
  /** The directive or package declaration that identified the requirement. */
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
const MAGIC_COMMENT_PATTERN =
  /^\s*%+\s*!\s*TEX\s+(?:program|TS-program)\s*=\s*([A-Za-z]+)(?=\s|$)/iu;

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
 * Do not treat ifpdf as an engine test: it selects PDF output mode. Recognize the documented casing
 * variants of actual engine conditionals.
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
 * Guard packages and conditionals can live in different files; either proves engine branching for
 * the document. Strip comments first so a co-author note cannot disable the refusal.
 */
function hasEngineConditional(text: string): boolean {
  const stripped = stripLatexComments(text);
  if (ENGINE_CONDITIONAL_PATTERN.test(stripped)) return true;
  PACKAGE_LOAD_PATTERN.lastIndex = 0;
  for (const match of stripped.matchAll(PACKAGE_LOAD_PATTERN)) {
    const names = (match[1] ?? "").split(",").map((name) => name.trim().toLowerCase());
    if (names.some((name) => ENGINE_GUARD_PACKAGES.has(name))) return true;
  }
  return false;
}

function packageLoadVerdict(text: string): LatexEngineUnsupported | null {
  PACKAGE_LOAD_PATTERN.lastIndex = 0;
  for (const match of stripLatexComments(text).matchAll(PACKAGE_LOAD_PATTERN)) {
    const names = (match[1] ?? "").split(",").map((name) => name.trim());
    const hit = names.find((name) => ENGINE_ONLY_PACKAGES.has(name));
    if (hit === undefined) continue;
    const evidence = match[0].trim();
    // These packages support either Unicode engine; the load itself does not
    // declare one, so report XeLaTeX as the representative choice.
    const requiredEngine: LatexRequiredEngine = "xelatex";
    return {
      supported: false,
      requiredEngine,
      evidence,
      message: `This document loads "${hit}" (found: ${evidence}), which needs XeLaTeX or LuaLaTeX; pdfLaTeX cannot process it. Add % !TEX program = lualatex or % !TEX program = xelatex to select the compiler.`,
    };
  }
  return null;
}

/**
 * Check all authored engine directives before package inference. Engine guards suppress only the
 * weaker package verdict, never an explicit incompatible declaration.
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
  let declaredDriver: "tectonic" | undefined;
  for (const text of [input.rootText, ...(input.includedTexts ?? [])]) {
    for (const line of text.split(/\r?\n/u)) {
      const token = MAGIC_COMMENT_PATTERN.exec(line)?.[1]?.toLowerCase();
      if (!token) continue;
      if (token === "tectonic") {
        declaredDriver = "tectonic";
        declared = "xelatex";
        break;
      }
      declared =
        token === "pdflatex" || token === "pdftex" ? "pdflatex" : requiredEngineForToken(token);
      if (declared) break;
    }
    if (declared) break;
  }
  const engine = declared ?? (toolchain === "tectonic" ? "xelatex" : "pdflatex");
  if (declaredDriver === "tectonic") {
    return {
      engine: "xelatex" as const,
      driver: declaredDriver,
      error:
        toolchain === "tectonic"
          ? null
          : "This document requests Tectonic. Install Tectonic in this environment, then rebuild.",
    };
  }
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
  if (declared === null && !verdict.supported)
    return { engine: verdict.requiredEngine, error: null };
  return { engine, error: verdict.supported ? null : verdict.message };
}
