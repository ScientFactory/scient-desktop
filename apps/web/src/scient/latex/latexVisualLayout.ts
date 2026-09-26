/** Dimensions are kept in TeX points or inches until the presentation boundary. */
export const TEX_POINTS_PER_INCH = 72.27;
export const CSS_PIXELS_PER_INCH = 96;

export type LatexVisualListKind = "itemize" | "enumerate" | "description";
export interface LatexVisualListLayout {
  readonly topSepEm: number;
  readonly itemSepEm: number;
  readonly parsepEm: number;
  readonly leftMarginEm: number;
}

/** Standard class font sizes and baselines, in TeX points. */
export function latexVisualFontMetrics(base: 10 | 11 | 12) {
  return {
    tiny: [base === 10 ? 5 : 6, base === 10 ? 6 : 7],
    scriptsize: [base === 10 ? 7 : 8, base === 10 ? 8 : 9.5],
    footnotesize: [
      base === 10 ? 8 : base === 11 ? 9 : 10,
      base === 10 ? 9.5 : base === 11 ? 11 : 12,
    ],
    small: [base === 10 ? 9 : base === 11 ? 10 : 10.95, base === 10 ? 11 : base === 11 ? 12 : 13.6],
    normalsize: [base === 11 ? 10.95 : base, base === 10 ? 12 : base === 11 ? 13.6 : 14.5],
  } as const;
}

export const LATEX_PAPER_SIZES = {
  letter: { label: "Letter", width: 8.5, height: 11 },
  a4: { label: "A4", width: 210 / 25.4, height: 297 / 25.4 },
  a5: { label: "A5", width: 148 / 25.4, height: 210 / 25.4 },
  b5: { label: "B5", width: 176 / 25.4, height: 250 / 25.4 },
  legal: { label: "Legal", width: 8.5, height: 14 },
  executive: { label: "Executive", width: 7.25, height: 10.5 },
} as const;

export interface LatexVisualLayoutProfile {
  readonly documentClass: string;
  readonly paper: keyof typeof LATEX_PAPER_SIZES;
  readonly paperWidthIn: number;
  readonly paperHeightIn: number;
  readonly baseFontPt: 10 | 11 | 12;
  readonly fontSizePt: number;
  readonly fontFamily: string;
  readonly marginTopIn: number;
  readonly marginRightIn: number;
  readonly marginBottomIn: number;
  readonly marginLeftIn: number;
  readonly lineHeight: number;
  readonly paragraphIndentEm: number;
  readonly paragraphGapEm: number;
  readonly indentAfterHeading: boolean;
  readonly textAlign: "justify" | "left";
  readonly sectionSizePt: number;
  readonly subsectionSizePt: number;
  readonly subsubsectionSizePt: number;
  readonly titleSizePt: number;
  readonly authorSizePt: number;
  readonly lists: Readonly<Record<LatexVisualListKind, LatexVisualListLayout>>;
}

export function latexLengthInches(value: string): number | null {
  const match = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(in|cm|mm|pt|bp|pc|sp)\s*$/u.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const units: Record<string, number> = {
    in: 1,
    cm: 1 / 2.54,
    mm: 1 / 25.4,
    pt: 1 / TEX_POINTS_PER_INCH,
    bp: 1 / 72,
    pc: 12 / TEX_POINTS_PER_INCH,
    sp: 1 / (65536 * TEX_POINTS_PER_INCH),
  };
  return Number.isFinite(amount) ? amount * units[match[2]!]! : null;
}

function lengthEm(value: string, fontSizePt: number): number | null {
  // The natural part of glue determines the preview; stretch/shrink is TeX's job.
  const natural = value.split(/\s+(?:plus|minus)\s+/u)[0] ?? "";
  const em = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*em\s*$/u.exec(natural);
  if (em) return Number(em[1]);
  const inches = latexLengthInches(natural);
  return inches === null ? null : (inches * TEX_POINTS_PER_INCH) / fontSizePt;
}

function withoutComments(source: string): string {
  return source
    .split(/\r?\n/u)
    .map((line) => {
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] === "\\") {
          index += 1;
          continue;
        }
        if (line[index] === "%") return line.slice(0, index);
      }
      return line;
    })
    .join("\n");
}

function optionList(value: string): string[] {
  // geometry accepts pairs such as hmargin={2cm,3cm}.
  return value
    .split(/,(?![^{}]*\})/u)
    .map((option) => option.trim())
    .filter(Boolean);
}

/** A bounded interpretation of familiar class/geometry settings, never a TeX evaluator. */
export function latexVisualLayoutProfile(source: string): LatexVisualLayoutProfile {
  const uncommented = withoutComments(source);
  const preamble = uncommented.split(/\\begin\s*\{document\}/u)[0] ?? "";
  const depthAt = new Uint32Array(preamble.length + 1);
  let depth = 0;
  for (let index = 0; index < preamble.length; index += 1) {
    depthAt[index] = depth;
    if (preamble[index] === "\\") {
      index += 1;
      depthAt[index] = depth;
    } else if (preamble[index] === "{") depth += 1;
    else if (preamble[index] === "}") depth = Math.max(0, depth - 1);
  }
  const topLevel = (pattern: RegExp) =>
    [...preamble.matchAll(pattern)].filter((match) => depthAt[match.index] === 0);
  const classMatch = topLevel(/\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}/gu)[0];
  const classOptions = optionList(classMatch?.[1] ?? "");
  const documentClass = classMatch?.[2]?.trim() || "article";
  const baseFontPt = classOptions.includes("12pt") ? 12 : classOptions.includes("11pt") ? 11 : 10;
  // Standard LaTeX's 11pt option uses a 10.95pt normal font.
  const fontSizePt = baseFontPt === 11 ? 10.95 : baseFontPt;
  const baselinePt = baseFontPt === 11 ? 13.6 : baseFontPt === 12 ? 14.5 : 12;
  const packages = new Set<string>();
  const geometry = new Map<string, string>();
  const readGeometry = (options: string) => {
    for (const option of optionList(options)) {
      const equal = option.indexOf("=");
      const key = (equal < 0 ? option : option.slice(0, equal)).trim();
      const value =
        equal < 0
          ? "true"
          : option
              .slice(equal + 1)
              .trim()
              .replace(/^\{(.*)\}$/u, "$1");
      if (key === "paper" || Object.hasOwn(LATEX_PAPER_SIZES, key.replace(/paper$/u, ""))) {
        geometry.delete("paper");
        for (const name of Object.keys(LATEX_PAPER_SIZES)) geometry.delete(`${name}paper`);
      }
      geometry.set(key, value);
      // Later shorthand assignments must override earlier individual margins.
      const sides =
        key === "margin"
          ? ["top", "bottom", "left", "right"]
          : key === "hmargin"
            ? ["left", "right"]
            : key === "vmargin"
              ? ["top", "bottom"]
              : [];
      const pair = value.split(",");
      sides.forEach((side, index) => geometry.set(side, pair[index % pair.length]!.trim()));
      if (key === "inner") geometry.set("left", value);
      if (key === "outer") geometry.set("right", value);
    }
  };
  readGeometry(classOptions.filter((option) => /paper$|^landscape$/u.test(option)).join(","));
  for (const match of topLevel(
    /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}|\\geometry\s*\{((?:[^{}]|\{[^{}]*\})*)\}/gu,
  )) {
    if (match[2]) {
      const names = optionList(match[2]);
      names.forEach((name) => packages.add(name));
      if (names.includes("geometry")) readGeometry(match[1] ?? "");
    } else readGeometry(match[3] ?? "");
  }
  let paper: keyof typeof LATEX_PAPER_SIZES = "letter";
  for (const [key, value] of geometry) {
    const name = key === "paper" ? value.replace(/paper$/u, "") : key.replace(/paper$/u, "");
    if (Object.hasOwn(LATEX_PAPER_SIZES, name)) paper = name as typeof paper;
  }
  const dimensions = LATEX_PAPER_SIZES[paper];
  let paperWidthIn = latexLengthInches(geometry.get("paperwidth") ?? "") ?? dimensions.width;
  let paperHeightIn = latexLengthInches(geometry.get("paperheight") ?? "") ?? dimensions.height;
  if (geometry.get("landscape") === "true")
    [paperWidthIn, paperHeightIn] = [paperHeightIn, paperWidthIn];
  paperWidthIn = paperWidthIn > 0 ? paperWidthIn : dimensions.width;
  paperHeightIn = paperHeightIn > 0 ? paperHeightIn : dimensions.height;

  // Standard classes.dtx dimensions. Custom classes retain a conservative profile.
  // https://github.com/latex3/latex2e/blob/main/base/classes.dtx
  const standardClass = /^(?:article|report|book)$/u.test(documentClass);
  const standardWidth = Math.min(
    paperWidthIn - 2,
    (baseFontPt === 12 ? 390 : baseFontPt === 11 ? 360 : 345) / TEX_POINTS_PER_INCH,
  );
  const standardHeight =
    (Math.floor(((paperHeightIn - 3.5) * TEX_POINTS_PER_INCH) / baselinePt) * baselinePt +
      baseFontPt) /
    TEX_POINTS_PER_INCH;
  const hasGeometry = packages.has("geometry") || topLevel(/\\geometry\s*\{/gu).length > 0;
  const horizontalSpace =
    standardClass && !hasGeometry ? paperWidthIn - standardWidth : paperWidthIn * 0.3;
  const verticalSpace =
    standardClass && !hasGeometry ? paperHeightIn - standardHeight : paperHeightIn * 0.3;
  const defaultLeft = horizontalSpace / 2;
  const defaultTop =
    standardClass && !hasGeometry
      ? verticalSpace / 2 +
        (12 + (documentClass === "book" ? (baseFontPt === 10 ? 18.0675 : 19.873) : 25) - 30) /
          (2 * TEX_POINTS_PER_INCH)
      : verticalSpace * 0.4;
  const horizontal = (first: string, second: string, total: number, fallback: number) => {
    const a = latexLengthInches(geometry.get(first) ?? "");
    const b = latexLengthInches(geometry.get(second) ?? "");
    return [
      a ?? (b === null ? fallback : total - b),
      b ?? (a === null ? total - fallback : total - a),
    ] as const;
  };
  let [marginLeftIn, marginRightIn] = horizontal("left", "right", horizontalSpace, defaultLeft);
  let [marginTopIn, marginBottomIn] = horizontal("top", "bottom", verticalSpace, defaultTop);
  const explicitWidth = latexLengthInches(geometry.get("textwidth") ?? geometry.get("width") ?? "");
  const explicitHeight = latexLengthInches(
    geometry.get("textheight") ?? geometry.get("height") ?? "",
  );
  if (explicitWidth !== null && explicitWidth > 0 && explicitWidth < paperWidthIn) {
    marginLeftIn = geometry.has("left") ? marginLeftIn : (paperWidthIn - explicitWidth) / 2;
    marginRightIn = paperWidthIn - explicitWidth - marginLeftIn;
  }
  if (explicitHeight !== null && explicitHeight > 0 && explicitHeight < paperHeightIn) {
    marginTopIn = geometry.has("top") ? marginTopIn : (paperHeightIn - explicitHeight) * 0.4;
    marginBottomIn = paperHeightIn - explicitHeight - marginTopIn;
  }
  // Keep invalid/incomplete input from making the editing surface unusable.
  const fitMargins = (first: number, second: number, size: number) => {
    const a = Math.max(0, first),
      b = Math.max(0, second);
    const scale = Math.min(1, (size * 0.9) / Math.max(a + b, 0.001));
    return [a * scale, b * scale] as const;
  };
  [marginLeftIn, marginRightIn] = fitMargins(marginLeftIn, marginRightIn, paperWidthIn);
  [marginTopIn, marginBottomIn] = fitMargins(marginTopIn, marginBottomIn, paperHeightIn);

  let spread = 1;
  let paragraphIndentEm = packages.has("parskip") ? 0 : baseFontPt === 10 ? 1.5 : 17 / fontSizePt;
  let paragraphGapEm = packages.has("parskip") ? baselinePt / fontSizePt / 2 : 0;
  for (const match of topLevel(
    /\\(?:linespread|setstretch)\s*\{([^{}]+)\}|\\(onehalfspacing|doublespacing|singlespacing)\b|\\setlength\s*\{\\(parindent|parskip)\}\s*\{([^{}]+)\}/gu,
  )) {
    if (match[1]) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) spread = value;
    }
    if (match[2])
      spread =
        match[2] === "singlespacing"
          ? 1
          : match[2] === "onehalfspacing"
            ? baseFontPt === 10
              ? 1.25
              : baseFontPt === 11
                ? 1.213
                : 1.241
            : baseFontPt === 10
              ? 1.667
              : baseFontPt === 11
                ? 1.618
                : 1.655;
    if (match[3]) {
      const value = lengthEm(match[4] ?? "", fontSizePt);
      if (value !== null) {
        if (match[3] === "parindent") paragraphIndentEm = value;
        else paragraphGapEm = value;
      }
    }
  }
  let fontFamily = '"KaTeX_Main", "Cambria", "Times New Roman", serif';
  if (["times", "mathptmx", "newtxtext", "tgtermes"].some((name) => packages.has(name)))
    fontFamily = '"TeX Gyre Termes", "Times New Roman", serif';
  if (["palatino", "mathpazo", "newpxtext", "tgpagella"].some((name) => packages.has(name)))
    fontFamily = '"TeX Gyre Pagella", "Palatino Linotype", "Palatino", serif';
  if (topLevel(/\\renewcommand\s*\{\\familydefault\}\s*\{\\sfdefault\}/gu).length > 0)
    fontFamily = '"KaTeX_SansSerif", "Arial", sans-serif';
  if (topLevel(/\\renewcommand\s*\{\\familydefault\}\s*\{\\ttdefault\}/gu).length > 0)
    fontFamily = '"KaTeX_Typewriter", monospace';
  const lists = {} as Record<LatexVisualListKind, LatexVisualListLayout>;
  const listSettings = topLevel(/\\setlist\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/gu);
  for (const kind of ["itemize", "enumerate", "description"] as const) {
    const settings = new Map<string, string>();
    // enumitem applies global settings before type settings, regardless of
    // their source order. Only first-level settings belong to this profile.
    for (const typed of [false, true]) {
      for (const match of listSettings) {
        const targets = optionList(match[1] ?? "");
        const types = targets.filter((target) => !/^\d+$/u.test(target));
        const level = targets.find((target) => /^\d+$/u.test(target));
        if (level && level !== "1") continue;
        if (typed ? !types.includes(kind) : types.length > 0) continue;
        for (const option of optionList(match[2] ?? "")) {
          const [key, value = ""] = option.split("=").map((part) => part.trim());
          if (key === "nosep" || key === "noitemsep") {
            settings.set("itemsep", "0pt");
            settings.set("parsep", "0pt");
            if (key === "nosep") settings.set("topsep", "0pt");
          } else if (key) settings.set(key, value);
        }
      }
    }
    const length = (name: string, points: number) =>
      lengthEm(settings.get(name) ?? `${points}pt`, fontSizePt) ?? points / fontSizePt;
    lists[kind] = {
      topSepEm: length("topsep", baseFontPt === 12 ? 10 : baseFontPt === 11 ? 9 : 8),
      itemSepEm: length("itemsep", baseFontPt === 10 ? 4 : baseFontPt === 11 ? 4.5 : 5),
      parsepEm: length("parsep", baseFontPt === 10 ? 4 : baseFontPt === 11 ? 4.5 : 5),
      // Standard first-level bullet and "1." metrics; custom label formats
      // still require the compiler's label measurement.
      leftMarginEm:
        settings.get("leftmargin") === "*"
          ? kind === "itemize"
            ? 1
            : kind === "enumerate"
              ? 1.25
              : 2.5
          : (lengthEm(settings.get("leftmargin") ?? "2.5em", fontSizePt) ?? 2.5),
    };
  }
  return {
    documentClass,
    paper,
    paperWidthIn,
    paperHeightIn,
    baseFontPt,
    fontSizePt,
    fontFamily,
    marginTopIn,
    marginRightIn,
    marginBottomIn,
    marginLeftIn,
    lineHeight: (baselinePt * spread) / fontSizePt,
    paragraphIndentEm,
    paragraphGapEm,
    indentAfterHeading: packages.has("indentfirst"),
    textAlign: topLevel(/\\(?:raggedright|RaggedRight)\b/gu).length > 0 ? "left" : "justify",
    sectionSizePt: baseFontPt === 12 ? 17.28 : 14.4,
    subsectionSizePt: baseFontPt === 12 ? 14.4 : 12,
    subsubsectionSizePt: fontSizePt,
    titleSizePt: baseFontPt === 12 ? 20.74 : 17.28,
    authorSizePt: baseFontPt === 12 ? 14.4 : 12,
    lists,
  };
}
