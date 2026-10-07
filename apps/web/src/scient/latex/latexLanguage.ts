import { latexWithoutComments } from "./latexPackages";

export type LatexTextDirection = "ltr" | "rtl";
export type LatexWritingLanguage = "english" | "hebrew";

export const LATEX_DIRECTION_MARKS = [
  { command: "textenglish", name: "latexEnglish", direction: "ltr", language: "english" },
  { command: "texthebrew", name: "latexHebrew", direction: "rtl", language: "hebrew" },
  { command: "LR", name: "latexLR", direction: "ltr", language: null },
  { command: "RL", name: "latexRL", direction: "rtl", language: null },
  { command: "textLR", name: "latexTextLR", direction: "ltr", language: null },
  { command: "textRL", name: "latexTextRL", direction: "rtl", language: null },
  {
    command: "foreignlanguage{english}",
    name: "latexForeignEnglish",
    direction: "ltr",
    language: "english",
  },
  {
    command: "foreignlanguage{hebrew}",
    name: "latexForeignHebrew",
    direction: "rtl",
    language: "hebrew",
  },
] as const;

export function latexDirectionMark(name: string) {
  return LATEX_DIRECTION_MARKS.find((mark) => mark.name === name);
}

/** Only literal, top-level declarations are settings; macro bodies are not evaluated. */
function preambleDeclarations(source: string) {
  const withoutComments = latexWithoutComments(source);
  const begin = withoutComments.indexOf("\\begin{document}");
  const clean = begin < 0 ? withoutComments : withoutComments.slice(0, begin);
  const depths = new Int32Array(clean.length);
  let depth = 0;
  for (let at = 0; at < clean.length; at++) {
    depths[at] = depth;
    if (clean[at] === "\\") {
      at++;
      depths[at] = depth;
    } else if (clean[at] === "{") depth++;
    else if (clean[at] === "}") depth--;
  }
  return {
    clean,
    find: (pattern: RegExp) =>
      [...clean.matchAll(pattern)].filter((match) => depths[match.index] === 0),
  };
}

export function latexDocumentLanguage(source: string) {
  const { find, clean } = preambleDeclarations(source);
  const packages = find(/\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/gu);
  const has = (name: string) =>
    packages.some((match) => match[2]!.split(",").some((part) => part.trim() === name));
  const defaults = find(/\\set(?:default|main)language\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu);
  const babel = packages.find((match) =>
    match[2]!.split(",").some((part) => part.trim() === "babel"),
  );
  const babelOptions = (babel?.[1] ?? "").split(",").map((part) => part.trim());
  const babelMain =
    babelOptions.find((part) => part.startsWith("main="))?.slice(5) ??
    babelOptions.findLast((part) => part.length > 0 && !part.includes("="));
  const main = defaults.at(-1)?.[1]?.trim() ?? babelMain ?? "english";
  const languages = new Set<string>([main]);
  defaults.forEach((declaration) => languages.add(declaration[1]!.trim()));
  const otherLanguages = new Set<string>();
  for (const declaration of find(/\\setotherlanguages?\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu))
    declaration[1]!.split(",").forEach((language) => {
      languages.add(language.trim());
      otherLanguages.add(language.trim());
    });
  if (babel)
    babelOptions
      .filter((part) => !part.includes("="))
      .forEach((language) => languages.add(language));
  const hebrewFont =
    find(
      /\\newfontfamily\s*(?:\{\\hebrewfont\}|\\hebrewfont\b)\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu,
    ).at(-1)?.[1] ?? null;
  const mainFont = find(/\\setmainfont\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu).at(-1)?.[1] ?? null;
  const polyglossia = has("polyglossia");
  return {
    main,
    direction: (main === "hebrew" ? "rtl" : "ltr") as LatexTextDirection,
    languages,
    otherLanguages,
    provider: polyglossia ? ("polyglossia" as const) : babel ? ("babel" as const) : null,
    hebrewFont,
    mainFont,
    // bidi supplies pure direction switches; language switches also select the language's font.
    bidi: has("bidi") || (polyglossia && languages.has("hebrew")),
    canConfigure:
      !babel &&
      (main === "english" || main === "hebrew") &&
      !/\\(?:babelprovide|babelfont|input|include|if[a-zA-Z]*)\b/u.test(clean) &&
      !defaults.some((declaration) => declaration[0].includes("[")),
  };
}

export type LatexLanguageSetup = ReturnType<typeof latexDocumentLanguage>;

export function latexLanguageFont(font: string | null, fallback: string): string {
  // A LaTeX font declaration is data, never a CSS declaration or URL.
  return font && /^[\p{L}\p{N} ._()+-]+$/u.test(font)
    ? `${JSON.stringify(font)}, ${fallback}`
    : fallback;
}

export function latexDirectionOpening(source: string) {
  const opening = /^\\begin\{(english|hebrew|LTR|RTL|otherlanguage\*?)\}/u.exec(source);
  if (!opening) return null;
  const environment = opening[1]!;
  let from = opening[0].length;
  let language: LatexWritingLanguage | null =
    environment === "english" || environment === "hebrew" ? environment : null;
  if (environment.startsWith("otherlanguage")) {
    const argument = /^\s*\{(english|hebrew)\}/u.exec(source.slice(from));
    if (!argument) return null;
    language = argument[1] as LatexWritingLanguage;
    from += argument[0].length;
  }
  // Options and uncommon variants stay source-owned rather than being silently dropped.
  if (/^\s*\[/u.test(source.slice(from))) return null;
  const direction: LatexTextDirection =
    environment === "RTL" || language === "hebrew" ? "rtl" : "ltr";
  return { environment, from, layout: { kind: "direction", direction, language } };
}

export function latexLanguageLabels(language: string) {
  return language === "hebrew"
    ? {
        abstract: "תקציר",
        contents: "תוכן העניינים",
        figures: "רשימת האיורים",
        tables: "רשימת הטבלאות",
        figure: "איור",
        table: "טבלה",
        references: "מקורות",
      }
    : {
        abstract: "Abstract",
        contents: "Contents",
        figures: "List of Figures",
        tables: "List of Tables",
        figure: "Figure",
        table: "Table",
        references: "References",
      };
}

/** A deliberate settings action; never invoked just because Hebrew characters were typed. */
export function updateLatexLanguageSource(
  source: string,
  main: LatexWritingLanguage,
  font: string,
): string | null {
  const setup = latexDocumentLanguage(source);
  if (!setup.canConfigure || !/^[\p{L}\p{N} ._()+-]+$/u.test(font.trim())) return null;
  const { find } = preambleDeclarations(source);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const end = latexWithoutComments(source).indexOf("\\begin{document}");
  if (end < 0) return null;
  const declarations = find(/\\set(?:default|main)language\s*(?:\[[^\]]*\])?\s*\{[^{}]+\}/gu);
  const fonts = find(
    /\\newfontfamily\s*(?:\{\\hebrewfont\}|\\hebrewfont\b)\s*(?:\[[^\]]*\])?\s*\{[^{}]+\}/gu,
  );
  if (fonts.length > 1) return null;
  // Loading Hebrew loads bidi. On first enabling it, wait until after the existing
  // packages (notably hyperref) rather than loading bidi at an earlier English declaration.
  const deferMain = main === "hebrew" && !setup.languages.has("hebrew");
  const replacements = [
    ...declarations
      .slice(-1)
      .filter(() => !deferMain)
      .map((match) => ({
        from: match.index,
        to: match.index + match[0].length,
        text: match[0].replace(/\{[^{}]+\}$/u, `{${main}}`),
      })),
    ...fonts.map((match) => ({
      from: match.index,
      to: match.index + match[0].length,
      text: match[0].replace(/\{[^{}]+\}$/u, `{${font.trim()}}`),
    })),
  ];
  const additions: string[] = [];
  if (!setup.provider) {
    const hasFontspec = find(
      /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu,
    ).some((match) => match[1]!.split(",").some((name) => name.trim() === "fontspec"));
    if (!hasFontspec) additions.push("\\usepackage{fontspec}");
    additions.push("\\usepackage{polyglossia}");
  }
  if (!declarations.length || deferMain) additions.push(`\\setdefaultlanguage{${main}}`);
  for (const language of ["english", "hebrew"])
    if (language !== main && !setup.otherLanguages.has(language))
      additions.push(`\\setotherlanguage{${language}}`);
  if (!fonts.length) additions.push(`\\newfontfamily\\hebrewfont[Script=Hebrew]{${font.trim()}}`);
  let result =
    source.slice(0, end) +
    (additions.length ? `${eol}${additions.join(eol)}${eol}` : "") +
    source.slice(end);
  for (const change of replacements.toSorted((a, b) => b.from - a.from))
    result = result.slice(0, change.from) + change.text + result.slice(change.to);
  // Keep a working Unicode engine; otherwise the explicit language setup selects XeLaTeX.
  const engine = /^%\s*!\s*tex\s+(?:program|ts-program)\s*=\s*([^\r\n]+)/imu;
  const selected = engine.exec(result);
  if (selected && !/^(?:xelatex|lualatex)\s*$/iu.test(selected[1]!))
    result =
      result.slice(0, selected.index) +
      "% !TEX program = xelatex" +
      result.slice(selected.index + selected[0].length);
  else if (!selected) result = `% !TEX program = xelatex${eol}${result}`;
  return result;
}
