import { latexPreambleEnd, latexSourceArgument, latexSourceCommands } from "./latexSourceSyntax";
import { latexLengthInches, latexVisualLayoutProfile } from "./latexVisualLayout";
import { latexRunningPageSourceFields, latexRunningPageStyle } from "./latexPageLayouts";
import { latexDocumentLanguage } from "./latexLanguage";

export interface DocumentLayoutSettings {
  columns?: 1 | 2;
  columnGap?: string;
  columnRule?: string;
  lineSpacing?: number;
  paragraphIndent?: string;
  paragraphGap?: string;
  alignment?: "justify" | "left";
  paperWidth?: string;
  paperHeight?: string;
  gutter?: string;
  mirroredMargins?: boolean;
  engine?: "pdflatex" | "xelatex" | "lualatex";
  mainFont?: string;
  sansFont?: string;
  monoFont?: string;
  headerLeft?: string;
  headerCenter?: string;
  headerRight?: string;
  footerLeft?: string;
  footerCenter?: string;
  footerRight?: string;
  pageNumbering?: "arabic" | "roman" | "Roman" | "alph" | "Alph";
  headingSize?: number;
  headingBefore?: string;
  headingAfter?: string;
  numberingDepth?: number;
  titleSize?: number;
  firstPageStyle?: "default" | "same" | "plain" | "empty";
  evenHeaderLeft?: string;
  evenHeaderRight?: string;
  evenFooterLeft?: string;
  evenFooterRight?: string;
}

const length = (value: string) =>
  /^(?:\d+(?:\.\d*)?|\.\d+)\s*(?:in|cm|mm|pt|bp|em|ex)$/u.test(value.trim());
const plain = (value: string) => !/[\\{}%#$&_~^\r\n]/u.test(value);

/** Current literal settings, scoped to active preamble declarations rather than macro bodies. */
export function documentLayoutSettings(source: string) {
  const profile = latexVisualLayoutProfile(source);
  const preamble = source.slice(0, latexPreambleEnd(source));
  const commands = new Set(
    latexSourceCommands(preamble)
      .filter((command) => command.depth === 0)
      .map((command) => command.from),
  );
  const last = (pattern: RegExp) =>
    [...preamble.matchAll(pattern)].findLast((match) => commands.has(match.index));
  const family = (name: string) =>
    last(new RegExp(`\\\\set${name}font\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^{}]+)\\}`, "gu"))?.[1] ?? "";
  const classOptions = last(/\\documentclass\s*(?:\[([^\]]*)\])?\s*\{[^{}]+\}/gu)?.[1] ?? "";
  const running = latexRunningPageStyle(source);
  const odd = latexRunningPageSourceFields(running, 1);
  const even = latexRunningPageSourceFields(running, 2);
  const field = (kind: "head" | "foot", slot: string) =>
    (slot.includes("E") ? even : odd)[kind][["L", "C", "R"].indexOf(slot[0]!)] ?? "";
  const engine =
    /^%\s*!\s*tex\s+(?:program|ts-program)\s*=\s*(pdflatex|xelatex|lualatex)\s*$/imu.exec(
      source,
    )?.[1] ?? "pdflatex";
  return {
    columns: (/\btwocolumn\b/u.test(classOptions) ? 2 : 1) as 1 | 2,
    columnGap: `${profile.columnGapPt.toFixed(2)}pt`,
    columnRule: `${profile.columnRulePt.toFixed(2)}pt`,
    lineSpacing: Number(
      (
        profile.lineHeight /
        ((profile.baseFontPt === 11 ? 13.6 : profile.baseFontPt === 12 ? 14.5 : 12) /
          profile.fontSizePt)
      ).toFixed(6),
    ),
    paragraphIndent: `${profile.paragraphIndentEm.toFixed(2)}em`,
    paragraphGap: `${profile.paragraphGapEm.toFixed(2)}em`,
    alignment: profile.textAlign,
    paperWidth: `${profile.paperWidthIn.toFixed(4)}in`,
    paperHeight: `${profile.paperHeightIn.toFixed(4)}in`,
    gutter: `${profile.bindingOffsetIn.toFixed(4)}in`,
    mirroredMargins: profile.twoSided,
    engine,
    mainFont: latexDocumentLanguage(source).mainFont ?? family("main"),
    sansFont: family("sans"),
    monoFont: family("mono"),
    headerLeft: field("head", "L"),
    headerCenter: field("head", "C"),
    headerRight: field("head", "R"),
    footerLeft: field("foot", "L"),
    footerCenter: field("foot", "C"),
    footerRight: field("foot", "R"),
    pageNumbering: last(/\\pagenumbering\s*\{(arabic|roman|Roman|alph|Alph)\}/gu)?.[1] ?? "arabic",
    headingSize: profile.sectionSizePt,
    headingBefore:
      last(/\\titlespacing\*?\s*\{\\section\}\s*\{[^{}]*\}\s*\{([^{}]*)\}\s*\{([^{}]*)\}/gu)?.[1] ??
      "3.5ex",
    headingAfter:
      last(/\\titlespacing\*?\s*\{\\section\}\s*\{[^{}]*\}\s*\{([^{}]*)\}\s*\{([^{}]*)\}/gu)?.[2] ??
      "2.3ex",
    numberingDepth: Number(last(/\\setcounter\s*\{secnumdepth\}\s*\{(-?\d+)\}/gu)?.[1] ?? 3),
    titleSize: profile.titleSizePt,
    firstPageStyle: (last(
      /\\AtBeginDocument\s*\{\\thispagestyle\{(plain|empty|fancy)\}\}/gu,
    )?.[1]?.replace("fancy", "same") ?? "default") as "default" | "same" | "plain" | "empty",
    evenHeaderLeft: field("head", "LE"),
    evenHeaderRight: field("head", "RE"),
    evenFooterLeft: field("foot", "LE"),
    evenFooterRight: field("foot", "RE"),
  };
}

/** Change only supported literal declarations. The caller publishes one preamble patch and undo step. */
export function updateDocumentLayoutSettings(
  source: string,
  update: DocumentLayoutSettings,
): string | null {
  let result = source;
  const previousProfile = latexVisualLayoutProfile(source);
  const width =
    update.paperWidth === undefined
      ? previousProfile.paperWidthIn
      : latexLengthInches(update.paperWidth);
  const height =
    update.paperHeight === undefined
      ? previousProfile.paperHeightIn
      : latexLengthInches(update.paperHeight);
  const gutter =
    update.gutter === undefined
      ? previousProfile.bindingOffsetIn
      : latexLengthInches(update.gutter);
  if (
    width === null ||
    height === null ||
    gutter === null ||
    width <=
      previousProfile.marginLeftIn -
        previousProfile.bindingOffsetIn +
        previousProfile.marginRightIn +
        gutter ||
    height <= previousProfile.marginTopIn + previousProfile.marginBottomIn
  )
    return null;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const replace = (pattern: RegExp, declaration: string) => {
    const end = latexPreambleEnd(result);
    const active = new Set(
      latexSourceCommands(result.slice(0, end))
        .filter((command) => command.depth === 0)
        .map((command) => command.from),
    );
    const matches = [...result.slice(0, end).matchAll(pattern)].filter((match) =>
      active.has(match.index),
    );
    const found = matches.at(-1);
    result = found
      ? result.slice(0, found.index) + declaration + result.slice(found.index + found[0].length)
      : result.slice(0, end) + declaration + eol + result.slice(end);
  };
  const requirePackage = (name: string) => {
    const preamble = result.slice(0, latexPreambleEnd(result));
    const loaded = latexSourceCommands(preamble).some((command) => {
      if (command.depth !== 0 || !["usepackage", "RequirePackage"].includes(command.name))
        return false;
      const options = latexSourceArgument(preamble, command.to, "[", "]");
      return latexSourceArgument(preamble, options?.end ?? command.to)
        ?.value.split(",")
        .some((item) => item.trim() === name);
    });
    if (!loaded) replace(/(?!) /gu, `\\usepackage{${name}}`);
  };
  const lengths: [keyof DocumentLayoutSettings, string][] = [
    ["columnGap", "columnsep"],
    ["columnRule", "columnseprule"],
    ["paragraphIndent", "parindent"],
    ["paragraphGap", "parskip"],
  ];
  for (const [key, command] of lengths) {
    const value = update[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !length(value)) return null;
    replace(
      new RegExp(`\\\\setlength\\s*\\{\\\\${command}\\}\\s*\\{[^{}]*\\}`, "gu"),
      `\\setlength{\\${command}}{${value.trim()}}`,
    );
  }
  if (update.lineSpacing !== undefined) {
    if (!Number.isFinite(update.lineSpacing) || update.lineSpacing < 0.5 || update.lineSpacing > 3)
      return null;
    requirePackage("setspace");
    replace(
      /\\(?:linespread|setstretch)\s*\{[^{}]*\}|\\(?:onehalfspacing|doublespacing|singlespacing)\b/gu,
      `\\setstretch{${update.lineSpacing}}`,
    );
  }
  if (update.columns !== undefined || update.mirroredMargins !== undefined) {
    const command = latexSourceCommands(result).find(
      (item) => item.name === "documentclass" && item.depth === 0,
    );
    const match =
      command &&
      /^\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/u.exec(result.slice(command.from));
    if (!command || !match) return null;
    const options = (match[1] ?? "")
      .split(",")
      .filter(
        (option) =>
          !(update.columns !== undefined && /^(?:onecolumn|twocolumn)$/u.test(option.trim())) &&
          !(update.mirroredMargins !== undefined && /^(?:oneside|twoside)$/u.test(option.trim())),
      );
    if (update.columns === 2) options.push("twocolumn");
    if (update.mirroredMargins !== undefined)
      options.push(update.mirroredMargins ? "twoside" : "oneside");
    const value = options.filter(Boolean).join(",");
    result =
      result.slice(0, command.from) +
      `\\documentclass${value ? `[${value}]` : ""}{${match[2]}}` +
      result.slice(command.from + match[0].length);
  }
  const geometry: string[] = [];
  for (const [key, option] of [
    ["paperWidth", "paperwidth"],
    ["paperHeight", "paperheight"],
    ["gutter", "bindingoffset"],
  ] as const) {
    const value = update[key];
    if (value === undefined) continue;
    const inches = latexLengthInches(value);
    if (inches === null || inches < 0 || (key !== "gutter" && inches <= 0)) return null;
    geometry.push(`${option}=${value.trim()}`);
  }
  if (geometry.length) {
    requirePackage("geometry");
    const active = latexSourceCommands(result).findLast(
      (command) =>
        command.name === "geometry" &&
        command.depth === 0 &&
        command.from < latexPreambleEnd(result),
    );
    const argument = active && latexSourceArgument(result, active.to);
    const keys = new Set(geometry.map((option) => option.split("=")[0]));
    const retained = (argument?.value ?? "")
      .split(",")
      .filter((option) => option.trim() && !keys.has(option.split("=")[0]?.trim()));
    replace(/\\geometry\s*\{[^{}]*\}/gu, `\\geometry{${[...retained, ...geometry].join(",")}}`);
  }
  if (update.alignment !== undefined) {
    requirePackage("ragged2e");
    replace(
      /\\(?:raggedright|RaggedRight|justifying)\b/gu,
      update.alignment === "left" ? "\\RaggedRight" : "\\justifying",
    );
  }
  if (update.engine !== undefined) {
    if (
      update.engine === "pdflatex" &&
      /\\(?:babelfont|setmainfont|usepackage(?:\[[^\]]*\])?\{(?:fontspec|polyglossia)\})/u.test(
        result,
      )
    )
      return null;
    const pattern = /^%\s*!\s*tex\s+(?:program|ts-program)\s*=\s*[^\r\n]*/imu;
    const declaration = `% !TEX program = ${update.engine}`;
    result = pattern.test(result)
      ? result.replace(pattern, declaration)
      : declaration + eol + result;
  }
  for (const [key, command] of [
    ["mainFont", "setmainfont"],
    ["sansFont", "setsansfont"],
    ["monoFont", "setmonofont"],
  ] as const) {
    const value = update[key];
    if (value === undefined) continue;
    if (
      !value.trim() ||
      !plain(value) ||
      !/^(?:xelatex|lualatex)$/u.test(documentLayoutSettings(result).engine)
    )
      return null;
    // Babel's scoped font options are preserved by its own language adapter.
    if (key === "mainFont" && /\\babelfont\b/u.test(result.slice(0, latexPreambleEnd(result))))
      return null;
    requirePackage("fontspec");
    const active = latexSourceCommands(result).findLast(
      (item) => item.name === command && item.depth === 0 && item.from < latexPreambleEnd(result),
    );
    if (active) {
      const options = latexSourceArgument(result, active.to, "[", "]");
      const argument = latexSourceArgument(result, options?.end ?? active.to);
      if (!argument) return null;
      result = result.slice(0, argument.from) + value.trim() + result.slice(argument.to);
    } else replace(/(?!) /gu, `\\${command}{${value.trim()}}`);
  }
  for (const [key, kind, slot] of [
    ["headerLeft", "head", "L"],
    ["headerCenter", "head", "C"],
    ["headerRight", "head", "R"],
    ["footerLeft", "foot", "L"],
    ["footerCenter", "foot", "C"],
    ["footerRight", "foot", "R"],
    ["evenHeaderLeft", "head", "LE"],
    ["evenHeaderRight", "head", "RE"],
    ["evenFooterLeft", "foot", "LE"],
    ["evenFooterRight", "foot", "RE"],
  ] as const) {
    const value = update[key];
    if (value === undefined) continue;
    // Literal text and the three supported running tokens; no arbitrary TeX injection.
    if (
      !plain(
        value
          .replaceAll("\\thepage", "")
          .replaceAll("\\leftmark", "")
          .replaceAll("\\rightmark", ""),
      )
    )
      return null;
    requirePackage("fancyhdr");
    if (latexRunningPageStyle(result).style !== "fancy") {
      replace(/\\pagestyle\s*\{[^{}]*\}/gu, "\\pagestyle{fancy}");
      replace(/(?!) /gu, "\\fancyhf{}");
    }
    replace(
      new RegExp(`\\\\fancy${kind}\\s*\\[${slot}\\]\\s*\\{[^{}]*\\}`, "gu"),
      `\\fancy${kind}[${slot}]{${value}}`,
    );
  }
  if (update.pageNumbering !== undefined)
    replace(/\\pagenumbering\s*\{[^{}]*\}/gu, `\\pagenumbering{${update.pageNumbering}}`);
  if (update.firstPageStyle !== undefined) {
    const pattern =
      /\\AtBeginDocument\s*\{\\thispagestyle\{(?:plain|empty|fancy)\}\}|\\AddToHook\s*\{cmd\/maketitle\/after\}\s*\{\\thispagestyle\{(?:plain|empty|fancy)\}\}/gu;
    const end = latexPreambleEnd(result);
    const active = new Set(
      latexSourceCommands(result.slice(0, end))
        .filter((command) => command.depth === 0)
        .map((command) => command.from),
    );
    for (const match of [...result.slice(0, end).matchAll(pattern)].toReversed())
      if (active.has(match.index))
        result = result.slice(0, match.index) + result.slice(match.index + match[0].length);
    if (update.firstPageStyle !== "default") {
      const style =
        update.firstPageStyle === "same"
          ? latexRunningPageStyle(result).style
          : update.firstPageStyle;
      replace(/(?!) /gu, `\\AtBeginDocument{\\thispagestyle{${style}}}`);
      replace(/(?!) /gu, `\\AddToHook{cmd/maketitle/after}{\\thispagestyle{${style}}}`);
    }
  }
  if (update.titleSize !== undefined) {
    if (!Number.isFinite(update.titleSize) || update.titleSize < 6 || update.titleSize > 72)
      return null;
    const existing = /\\pretitle\b/u.test(result.slice(0, latexPreambleEnd(result)));
    const pattern =
      /\\pretitle\s*\{\\begin\{center\}\\fontsize\{[\d.]+\}\{[\d.]+\}\\selectfont\}/gu;
    if (existing && !pattern.test(result)) return null;
    requirePackage("titling");
    replace(
      pattern,
      `\\pretitle{\\begin{center}\\fontsize{${update.titleSize}}{${update.titleSize * 1.2}}\\selectfont}`,
    );
  }
  if (
    update.headingSize !== undefined ||
    update.headingBefore !== undefined ||
    update.headingAfter !== undefined
  ) {
    if (!/\\documentclass(?:\[[^\]]*\])?\{(?:article|report|book)\}/u.test(result)) return null;
    requirePackage("titlesec");
    if (update.headingSize !== undefined) {
      if (!Number.isFinite(update.headingSize) || update.headingSize < 6 || update.headingSize > 72)
        return null;
      const formats = latexSourceCommands(result.slice(0, latexPreambleEnd(result))).filter(
        (command) => command.name === "titleformat" && command.depth === 0,
      );
      const owned =
        /^\\titleformat\s*\{\\section\}\s*\{\\normalfont\\fontsize\{[\d.]+\}\{[\d.]+\}\\selectfont\\bfseries\}\s*\{\\thesection\}\s*\{1em\}\s*\{\}/u;
      for (const command of formats) {
        const target = latexSourceArgument(result, command.to);
        if (target?.value === "\\section" && !owned.test(result.slice(command.from))) return null;
      }
      replace(
        /\\titleformat\s*\{\\section\}\s*\{\\normalfont\\fontsize\{[\d.]+\}\{[\d.]+\}\\selectfont\\bfseries\}\s*\{\\thesection\}\s*\{1em\}\s*\{\}/gu,
        `\\titleformat{\\section}{\\normalfont\\fontsize{${update.headingSize}}{${update.headingSize * 1.2}}\\selectfont\\bfseries}{\\thesection}{1em}{}`,
      );
    }
    const current = documentLayoutSettings(result);
    const before = update.headingBefore ?? current.headingBefore,
      after = update.headingAfter ?? current.headingAfter;
    if (!length(before) || !length(after)) return null;
    const spacingPattern =
      /\\titlespacing(\*)?\s*\{\\section\}\s*\{([^{}]*)\}\s*\{[^{}]*\}\s*\{[^{}]*\}/gu;
    const spacingCommands = latexSourceCommands(result.slice(0, latexPreambleEnd(result))).filter(
      (command) => command.name === "titlespacing" && command.depth === 0,
    );
    const supported = [...result.matchAll(spacingPattern)].filter((match) =>
      spacingCommands.some((command) => command.from === match.index),
    );
    for (const command of spacingCommands) {
      const target = latexSourceArgument(result, command.to + (result[command.to] === "*" ? 1 : 0));
      if (target?.value === "\\section" && !supported.some((match) => match.index === command.from))
        return null;
    }
    const currentSpacing = supported.at(-1);
    replace(
      spacingPattern,
      `\\titlespacing${currentSpacing ? (currentSpacing[1] ?? "") : "*"}{\\section}{${currentSpacing?.[2] ?? "0pt"}}{${before}}{${after}}`,
    );
  }
  if (update.numberingDepth !== undefined) {
    if (
      !Number.isInteger(update.numberingDepth) ||
      update.numberingDepth < -1 ||
      update.numberingDepth > 3
    )
      return null;
    replace(
      /\\setcounter\s*\{secnumdepth\}\s*\{[^{}]*\}/gu,
      `\\setcounter{secnumdepth}{${update.numberingDepth}}`,
    );
  }
  const profile = latexVisualLayoutProfile(result);
  if (
    profile.marginLeftIn + profile.marginRightIn >= profile.paperWidthIn ||
    profile.marginTopIn + profile.marginBottomIn >= profile.paperHeightIn
  )
    return null;
  return result;
}
