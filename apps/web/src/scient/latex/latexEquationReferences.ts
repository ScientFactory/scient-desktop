import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { isOrdinaryTyping } from "./visualTyping";
import {
  compiledBibliographyItems,
  type CompiledBibliographyItem,
} from "./latexCompiledBibliography";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { latexCounterLabel } from "./latexDocumentStructure";
import { projectMathNumbering } from "./latexMathNumbering";
import { latexWithoutComments } from "./latexPackages";
import {
  latexRomanNumber,
  latexVisualFloatHasCaption,
  serializeLatexVisualBlock,
} from "./latexVisualDocument";
import { algorithmLineLayout } from "./latexAlgorithm";
import { activeLatexSource } from "./latexLiteral";
import {
  latexEnvironmentDeclarations,
  type LatexEnvironmentDeclaration,
} from "./latexEnvironmentDeclarations";

interface EquationRow {
  number: string | null;
  display: string | null;
}

interface EquationTarget {
  position: number;
  row: number;
  number: string | null;
  kind:
    | "equation"
    | "statement"
    | "table"
    | "figure"
    | "algorithm"
    | "listing"
    | "heading"
    | "anchor"
    | "bibliography";
  title?: string;
  panelIndex?: number;
  panelNumber?: string | null;
}

interface StatementPresentation {
  title: string;
  number: string | null;
  style: LatexEnvironmentDeclaration["style"];
  kind: "theorem" | "quote";
  boldPrefix: boolean;
  proof: boolean;
  proofEnd: boolean;
}

interface EquationReferences {
  documentClass: string;
  titlePage: boolean;
  headings: Map<number, { number: string | null; chapterName: string }>;
  floatContents: {
    position: number;
    level: number;
    number: string | null;
    title: string;
    kind: "figure" | "table";
  }[];
  equations: Map<number, EquationRow[]>;
  labels: Map<string, EquationTarget>;
  statements: Map<number, StatementPresentation>;
  tables: Map<number, { number: string | null }>;
  figures: Map<number, { number: string | null; panels: (string | null)[] }>;
  algorithms: Map<number, { number: string | null }>;
  listings: Map<number, { number: string | null }>;
  algorithmLines: Map<number, { indent: number; number: string }>;
  anchors: Map<string, EquationTarget>;
  contents: { position: number; level: number; number: string | null; title: string }[];
  footnotes: Map<number, { number: string | null; body: string }>;
  citations: Map<string, EquationTarget>;
  bibliographies: Map<
    number,
    { title: string; labels: (string | null)[]; items?: CompiledBibliographyItem[] | null }
  >;
  manualCitations: boolean;
  environments: LatexEnvironmentDeclaration[];
  defaultProofEnd: boolean;
}

export const latexEquationReferencesKey = new PluginKey<EquationReferences>(
  "latexEquationReferences",
);

const referenceLayouts = new WeakMap<EquationReferences, EquationReferences>();

export function latexReferencePresentation(state: EditorState) {
  const references = latexEquationReferencesKey.getState(state);
  return references && (referenceLayouts.get(references) ?? references);
}

/** Moving a target with typed text does not change its numbering or visual presentation. */
export function latexReferenceLayoutChanged(before: EditorState, after: EditorState): boolean {
  return latexReferencePresentation(before) !== latexReferencePresentation(after);
}

function mapReferences(previous: EquationReferences, transaction: Transaction): EquationReferences {
  const position = (value: number) => transaction.mapping.map(value);
  const headingTitles = new Map<number, string>();
  for (const [index, step] of transaction.steps.entries()) {
    if (!("from" in step) || typeof step.from !== "number") continue;
    const parent = transaction.docs[index]!.resolve(step.from);
    if (parent.parent.type.name !== "heading") continue;
    const mapped = transaction.mapping.slice(index).map(parent.before());
    const heading = transaction.doc.nodeAt(mapped);
    if (heading?.type.name === "heading") headingTitles.set(mapped, referenceHeadingTitle(heading));
  }
  const keyed = <T>(values: Map<number, T>) =>
    new Map([...values].map(([key, value]) => [position(key), value]));
  const targets = (values: Map<string, EquationTarget>) =>
    new Map(
      [...values].map(([key, value]) => {
        const mapped = position(value.position);
        return [key, mapped === value.position ? value : { ...value, position: mapped }];
      }),
    );
  const entries = <T extends { position: number }>(values: T[]) =>
    values.map((value) => {
      const mapped = position(value.position);
      return mapped === value.position ? value : { ...value, position: mapped };
    });
  const next = {
    ...previous,
    headings: keyed(previous.headings),
    equations: keyed(previous.equations),
    statements: keyed(previous.statements),
    tables: keyed(previous.tables),
    figures: keyed(previous.figures),
    algorithms: keyed(previous.algorithms),
    listings: keyed(previous.listings),
    algorithmLines: keyed(previous.algorithmLines),
    footnotes: keyed(previous.footnotes),
    bibliographies: keyed(previous.bibliographies),
    labels: targets(previous.labels),
    anchors: targets(previous.anchors),
    citations: targets(previous.citations),
    contents: entries(previous.contents).map((entry) => {
      const title = headingTitles.get(entry.position);
      return title !== undefined && title !== entry.title ? { ...entry, title } : entry;
    }),
    floatContents: entries(previous.floatContents),
  };
  referenceLayouts.set(next, referenceLayouts.get(previous) ?? previous);
  return next;
}

function referenceHeadingTitle(node: DocumentNode): string {
  let title = "";
  node.forEach((child) => {
    title +=
      child.text ?? String(child.attrs.linkText ?? child.attrs.tex ?? child.attrs.argument ?? "");
  });
  return title;
}

const highlights = new WeakMap<
  EditorView,
  { element: HTMLElement; timer: ReturnType<typeof setTimeout> }
>();

function clearHighlight(view: EditorView) {
  const current = highlights.get(view);
  if (!current) return;
  clearTimeout(current.timer);
  current.element.removeAttribute("data-reference-highlight");
  highlights.delete(view);
}

export function navigateToEquation(view: EditorView, target: EquationTarget): void {
  const node = view.nodeDOM(target.position);
  const selector =
    target.kind === "listing"
      ? '.scient-latex-simple-preview[data-environment="lstlisting"]'
      : target.kind === "algorithm"
        ? ".scient-latex-algorithm"
        : target.kind === "statement"
          ? ".scient-latex-scientific-structure"
          : target.kind === "table"
            ? '.scient-latex-rich-preview[data-kind="table"]'
            : target.kind === "figure"
              ? ".scient-latex-figure-preview"
              : target.kind === "bibliography"
                ? ".scient-latex-bibliography-preview"
                : ".scient-latex-visual-display-math";
  const direct = target.kind === "heading" || target.kind === "anchor";
  const equation =
    node instanceof HTMLElement
      ? direct || node.matches(selector)
        ? node
        : node.querySelector<HTMLElement>(selector)
      : null;
  if (!equation) return;
  const highlighted =
    target.kind === "bibliography"
      ? (equation.querySelector<HTMLElement>(`[data-latex-bibliography-item="${target.row}"]`) ??
        equation)
      : target.panelIndex === undefined
        ? equation
        : (equation.querySelector<HTMLElement>(
            `[data-latex-figure-panel="${target.panelIndex}"]`,
          ) ?? equation);
  const row =
    target.kind === "equation"
      ? equation.querySelector<HTMLElement>(`[data-latex-equation-row="${target.row}"]`)
      : null;
  scrollToLatexTarget(view, highlighted, row ?? highlighted);
}

function scrollToLatexTarget(view: EditorView, highlighted: HTMLElement, scroll = highlighted) {
  clearHighlight(view);
  highlighted.setAttribute("data-reference-highlight", "");
  scroll.scrollIntoView({
    block: "center",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  highlights.set(view, {
    element: highlighted,
    timer: setTimeout(() => clearHighlight(view), 1400),
  });
}

/** Marker and note share selection for editing, but scroll in opposite directions. */
export function navigateToFootnote(view: EditorView, position: number, toNote = true): boolean {
  const marker = view.nodeDOM(position);
  const target = toNote
    ? view.dom.querySelector<HTMLElement>(`[data-latex-footnote-position="${position}"]`)
    : marker instanceof HTMLElement
      ? (marker.querySelector<HTMLElement>(".scient-latex-visual-command") ?? marker)
      : null;
  if (!(target instanceof HTMLElement)) return false;
  scrollToLatexTarget(view, target);
  return true;
}

/** Derived presentation only: numbering never becomes a source-editing attribute. */
function equationReferences(
  doc: DocumentNode,
  source: string,
  compiled: CompiledBibliographyItem[] | null,
): EquationReferences {
  const clean = latexWithoutComments(activeLatexSource(source));
  const begin = clean.indexOf("\\begin{document}");
  const preamble = begin < 0 ? "" : clean.slice(0, begin);
  const documentClass = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/u.exec(preamble)?.[1];
  const scopeCommands = [...preamble.matchAll(/\\numberwithin\s*\{equation\}\s*\{([^{}]+)\}/gu)];
  const scope = scopeCommands.at(-1)?.[1] ?? (documentClass === "article" ? null : "chapter");
  let reliable =
    !!documentClass &&
    ["article", "book", "report"].includes(documentClass) &&
    (scope === null || scope === "section" || scope === "chapter") &&
    !(documentClass === "article" && scope === "chapter") &&
    scopeCommands.length <= 1 &&
    [...preamble.matchAll(/\\numberwithin\b/gu)].length === scopeCommands.length &&
    !/\\(?:setcounter|addtocounter|counterwithin|counterwithout|theequation|catcode|frontmatter|backmatter|includeonly)\b|\\(?:renewcommand|def)\s*\{?\\the(?:equation|section|chapter)\b|\\newtheorem\s*\{[^{}]+\}\s*\[equation\]|showonlyrefs/u.test(
      clean,
    ) &&
    !/\\numberwithin\b/u.test(begin < 0 ? clean : clean.slice(begin));
  const declarations = latexEnvironmentDeclarations(source);
  const result: EquationReferences = {
    documentClass: documentClass ?? "article",
    titlePage:
      /\\documentclass\s*\[[^\]]*\btitlepage\b/u.test(preamble) ||
      (["report", "book"].includes(documentClass ?? "") &&
        !/\\documentclass\s*\[[^\]]*\bnotitlepage\b/u.test(preamble)),
    headings: new Map(),
    floatContents: [],
    equations: new Map(),
    labels: new Map(),
    statements: new Map(),
    tables: new Map(),
    figures: new Map(),
    algorithms: new Map(),
    listings: new Map(),
    algorithmLines: new Map(),
    anchors: new Map(),
    contents: [],
    footnotes: new Map(),
    citations: new Map(),
    bibliographies: new Map(),
    manualCitations: false,
    environments: [...declarations.environments.values()],
    defaultProofEnd: declarations.defaultProofEnd,
  };
  const duplicateLabels = new Set<string>();
  const duplicateCitations = new Set<string>();
  const citationPackages = new Set(
    [
      ...preamble.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu),
    ].flatMap((match) => match[1]!.split(",").map((name) => name.trim())),
  );
  const citationsReliable =
    !!documentClass &&
    ["article", "book", "report"].includes(documentClass) &&
    !["natbib", "biblatex", "jurabib", "apacite", "cite"].some((name) =>
      citationPackages.has(name),
    ) &&
    !/\\(?:newcommand|renewcommand|def|gdef|xdef)\s*\*?\s*\{?\\(?:cite|@cite|@biblabel|theenumiv|refname|bibname)\b|\\(?:setcounter|addtocounter)\s*\{enumiv\}|\\renewenvironment\s*\{thebibliography\}/u.test(
      clean,
    );
  const addLabel = (label: string, target: EquationTarget) => {
    if (result.labels.has(label) || duplicateLabels.has(label)) {
      duplicateLabels.add(label);
      result.labels.delete(label);
    } else result.labels.set(label, target);
  };
  const statementCounters = new Map<string, { value: number; scope: string }>();
  let statementsReliable =
    !!documentClass &&
    ["article", "book", "report"].includes(documentClass) &&
    !/\\(?:setcounter|addtocounter|counterwithin|counterwithout|numberwithin|catcode|frontmatter|backmatter|includeonly|newtheoremstyle)\b|\\(?:renewcommand|def|gdef|xdef)\s*\*?\s*\{?\\the[A-Za-z]+/u.test(
      clean,
    ) &&
    !/\\(?:newtheorem|theoremstyle|newenvironment|renewenvironment)\b/u.test(
      begin < 0 ? clean : clean.slice(begin),
    );
  let counter = 0;
  let tableCounter = 0;
  let figureCounter = 0;
  let algorithmCounter = 0;
  let listingCounter = 0;
  let listingsReliable =
    !!documentClass &&
    ["article", "book", "report"].includes(documentClass) &&
    !/\\(?:setcounter|addtocounter|counterwithin|counterwithout|numberwithin|catcode|includeonly)\b|\\(?:renewcommand|def|gdef|xdef)\s*\*?\s*\{?\\thelstlisting\b|numberbychapter\s*=|\\lstlistingname\b/u.test(
      clean,
    );
  let algorithmsReliable =
    !/\\(?:setcounter|addtocounter|counterwithin|counterwithout|numberwithin|catcode)\b|\\(?:renewcommand|def|gdef|xdef)\s*\*?\s*\{?\\thealgorithm\b|\\usepackage\s*\[[^\]]*\]\s*\{algorithm\}/u.test(
      clean,
    );
  let figuresReliable =
    !!documentClass &&
    ["article", "book", "report"].includes(documentClass) &&
    !/\\(?:setcounter|addtocounter|counterwithin|counterwithout|catcode|frontmatter|backmatter|includeonly|captionof|captionsetup|subcaptionsetup|thefigure|thesubfigure)\b|\\(?:renewcommand|def|gdef|xdef)\s*\*?\s*\{?\\(?:thefigure|thesubfigure|p@subfigure|thechapter)\b|\\numberwithin\s*\{(?:figure|subfigure)\}/u.test(
      clean,
    );
  let tablesReliable =
    !!documentClass &&
    ["article", "book", "report"].includes(documentClass) &&
    !/\\(?:setcounter|addtocounter|counterwithin|counterwithout|catcode|frontmatter|backmatter|includeonly|captionof|captionsetup)\b|\\(?:renewcommand|def|gdef|xdef)\s*\*?\s*\{?\\the(?:table|chapter)\b|\\numberwithin\s*\{table\}/u.test(
      clean,
    );
  let chapter = 0;
  let appendix = false;
  const chapterLabel = () => latexCounterLabel(chapter, appendix ? "Alph" : "arabic");
  const chapterPrefix = () => (documentClass === "article" ? "" : `${chapterLabel()}.`);
  let section = 0;
  let subsection = 0;
  let subsubsection = 0;
  let part = 0;
  let footnote = 0;
  let headingsReliable =
    !!documentClass &&
    ["article", "book", "report"].includes(documentClass) &&
    !/\\(?:setcounter|addtocounter|counterwithin|counterwithout|catcode|frontmatter|backmatter|includeonly)\b|\\(?:renewcommand|def)\s*\{?\\the(?:section|subsection|subsubsection|chapter)\b/u.test(
      clean,
    );
  let footnotesReliable =
    headingsReliable &&
    !/\\(?:renewcommand|def)\s*\{?\\thefootnote\b|\\(?:footnotemark|footnotetext)\b/u.test(clean);
  const bySourceId = new Map<string, number>();
  doc.forEach((node, position) => {
    if (node.attrs.sourceId != null) bySourceId.set(String(node.attrs.sourceId), position);
  });
  const manualContents: {
    level?: unknown;
    title?: unknown;
    number?: unknown;
    targetSourceId?: unknown;
  }[] = [];
  const duplicateAnchors = new Set<string>();
  doc.descendants((node, position) => {
    if (node.type.name === "latexRichPreview" && node.attrs.kind === "documentCommand") {
      if (node.attrs.environment === "appendix") {
        appendix = true;
        chapter = section = subsection = subsubsection = 0;
      }
      return false;
    }
    if (node.type.name === "latexRichPreview" && node.attrs.kind === "bibliography") {
      result.manualCitations ||= citationsReliable;
      const external = node.attrs.sourceMeta?.externalBibliography === true;
      const items = external
        ? (compiled ?? [])
        : Array.isArray(node.attrs.items)
          ? node.attrs.items
          : [];
      const entries = external
        ? (compiled ?? []).map((entry) => ({ key: entry.label, displayLabel: entry.displayLabel }))
        : Array.isArray(node.attrs.sourceMeta?.entries)
          ? (node.attrs.sourceMeta.entries as { key: string; displayLabel: string | null }[])
          : [];
      let counter = 0;
      const labels = items.map((item: { label?: unknown }, row: number) => {
        const key = String(item.label ?? "");
        const explicit = entries.find((entry) => entry.key === key)?.displayLabel;
        if (explicit == null) counter++;
        const number = citationsReliable ? (explicit ?? String(counter)) : null;
        if (result.citations.has(key) || duplicateCitations.has(key)) {
          duplicateCitations.add(key);
          result.citations.delete(key);
        } else
          result.citations.set(key, {
            position,
            row,
            number,
            kind: "bibliography",
            title: "Reference",
          });
        return number;
      });
      result.bibliographies.set(position, {
        ...(external ? { items: compiled } : {}),
        title:
          documentClass === "book" || documentClass === "report" ? "Bibliography" : "References",
        labels,
      });
      return false;
    }
    if (
      node.type.name === "latexRichPreview" &&
      node.attrs.kind === "toc" &&
      Array.isArray(node.attrs.tocEntries)
    )
      manualContents.push(
        ...node.attrs.tocEntries.filter((entry: { number?: unknown }) => entry.number === ""),
      );
    if (
      node.type.name === "latexRichPreview" &&
      node.attrs.kind === "part" &&
      node.attrs.unnumbered !== true
    ) {
      part++;
      result.contents.push({
        position,
        level: 0,
        number: headingsReliable ? latexRomanNumber(part) : null,
        title: String(node.attrs.title ?? ""),
      });
    }
    if (node.type.name === "latexInlineCommand") {
      if (node.attrs.name === "hypertarget") {
        const label = String(node.attrs.argument);
        if (result.anchors.has(label) || duplicateAnchors.has(label)) {
          duplicateAnchors.add(label);
          result.anchors.delete(label);
        } else
          result.anchors.set(label, {
            position,
            row: 0,
            number: null,
            kind: "anchor",
            title: String(node.attrs.linkText ?? label),
          });
      }
      if (node.attrs.name === "footnote") {
        footnote++;
        result.footnotes.set(position, {
          number: footnotesReliable ? String(footnote) : null,
          body: String(node.attrs.argument),
        });
      }
    }
    if (node.type.name === "heading") {
      const level = Number(node.attrs.level);
      if (node.attrs.unnumbered !== true && level === 6) {
        chapter++;
        section = 0;
        subsection = 0;
        subsubsection = 0;
        if (documentClass !== "article") footnote = 0;
        if (documentClass !== "article") tableCounter = 0;
        if (documentClass !== "article") figureCounter = 0;
        if (documentClass !== "article") listingCounter = 0;
        if (scope !== null) counter = 0;
      } else if (node.attrs.unnumbered !== true && level === 1) {
        section++;
        subsection = 0;
        subsubsection = 0;
        if (scope === "section") counter = 0;
      } else if (node.attrs.unnumbered !== true && level === 2) {
        subsection++;
        subsubsection = 0;
      } else if (node.attrs.unnumbered !== true && level === 3) {
        subsubsection++;
      }
      const local =
        level === 6
          ? chapterLabel()
          : `${chapterPrefix()}${latexCounterLabel(section, appendix && documentClass === "article" ? "Alph" : "arabic")}${level >= 2 ? `.${subsection}` : ""}${level >= 3 ? `.${subsubsection}` : ""}`;
      const number =
        headingsReliable && node.attrs.unnumbered !== true && (level <= 3 || level === 6)
          ? local
          : null;
      const title = referenceHeadingTitle(node);
      result.headings.set(position, { number, chapterName: appendix ? "Appendix" : "Chapter" });
      if (node.attrs.referenceLabel)
        addLabel(String(node.attrs.referenceLabel), {
          position,
          row: 0,
          number,
          kind: "heading",
          title: level === 6 ? (appendix ? "Appendix" : "Chapter") : "Section",
        });
      if (node.attrs.unnumbered !== true && (level <= 3 || level === 6))
        result.contents.push({ position, level: level === 6 ? 0 : level, number, title });
    }
    if (node.type.name === "latexRawBlock" && String(node.attrs.raw ?? "").includes("\\")) {
      // Unknown source may introduce equations or change the counter.
      reliable = false;
      statementsReliable = false;
      tablesReliable = false;
      figuresReliable = false;
      algorithmsReliable = false;
      listingsReliable = false;
      headingsReliable = false;
      footnotesReliable = false;
      return false;
    }
    if (node.type.name === "latexRichPreview" && node.attrs.environment === "lstlisting") {
      const captioned = node.attrs.caption !== null;
      if (captioned) listingCounter++;
      const number =
        captioned && listingsReliable
          ? `${chapter > 0 ? chapterPrefix() : ""}${listingCounter}`
          : null;
      result.listings.set(position, { number });
      if (captioned && node.attrs.label)
        addLabel(String(node.attrs.label), {
          position,
          row: 0,
          number,
          kind: "listing",
          title: "Listing",
        });
    }
    if (
      (node.type.name === "latexScientific" && node.attrs.layout?.kind === "algorithm") ||
      (node.type.name === "latexRichPreview" && node.attrs.kind === "compiledAlgorithm")
    ) {
      const layout = node.attrs.layout ?? node.attrs.sourceMeta;
      if (layout.captioned) algorithmCounter++;
      const number = algorithmsReliable && layout.captioned ? String(algorithmCounter) : null;
      result.algorithms.set(position, { number });
      const names: string[] = [];
      node.forEach((line) => names.push(String(line.attrs.command)));
      const lines = algorithmLineLayout(names, Number(layout.interval));
      if (lines)
        node.forEach((_line, offset, index) =>
          result.algorithmLines.set(position + 1 + offset, lines[index]!),
        );
      if (layout.label)
        addLabel(String(layout.label), {
          position,
          row: 0,
          number,
          kind: "algorithm",
          title: "Algorithm",
        });
    }
    if (
      node.type.name === "latexRichPreview" &&
      ["figure", "figureLayout"].includes(String(node.attrs.kind))
    ) {
      const meta = node.attrs.sourceMeta;
      const raw = latexWithoutComments(
        node.attrs.kind === "figure" && node.attrs.editable === true
          ? (serializeLatexVisualBlock(node.toJSON()) ?? String(node.attrs.raw ?? ""))
          : String(node.attrs.raw ?? ""),
      );
      const captioned =
        node.attrs.kind === "figureLayout"
          ? meta?.captionRange != null
          : latexVisualFloatHasCaption({ attrs: node.attrs });
      if (captioned) figureCounter++;
      if (/\\caption\s*\*/u.test(raw)) figuresReliable = false;
      const number = captioned && figuresReliable ? `${chapterPrefix()}${figureCounter}` : null;
      const label = String(node.attrs.label ?? "");
      const captionAt = raw.indexOf("\\caption");
      const labelAt = raw.indexOf("\\label");
      if (
        label &&
        node.attrs.captionRemoved !== true &&
        ((node.attrs.kind === "figure" && captionAt >= 0 && labelAt > captionAt) ||
          (meta?.captionRange && meta?.labelRange?.from > meta.captionRange.from))
      )
        addLabel(label, { position, row: 0, number, kind: "figure", title: "Figure" });
      const panels: (string | null)[] = [];
      let panelCounter = 0;
      if (node.attrs.kind === "figureLayout" && Array.isArray(node.attrs.items)) {
        (node.attrs.items as { label: string }[]).forEach((item, index) => {
          const panel = meta?.panels?.[index];
          if (!panel?.subfigure) {
            panels.push(null);
            return;
          }
          if (panel.captionRange) panelCounter++;
          const letter =
            panel.captionRange && figuresReliable ? String.fromCharCode(96 + panelCounter) : null;
          panels.push(letter);
          if (item.label && panel.captionRange && panel.labelRange?.from > panel.captionRange.from)
            addLabel(item.label, {
              position,
              row: 0,
              number: number !== null && letter !== null ? number + letter : null,
              kind: "figure",
              title: "Figure panel",
              panelIndex: index,
              panelNumber: letter,
            });
        });
      }
      result.figures.set(position, { number, panels });
      if (captioned)
        result.floatContents.push({
          position,
          level: 1,
          number,
          title: String(node.attrs.caption ?? ""),
          kind: "figure",
        });
      return false;
    }
    if (node.type.name === "latexRichPreview" && node.attrs.kind === "table") {
      const raw = latexWithoutComments(String(node.attrs.raw ?? ""));
      const hasCaption = latexVisualFloatHasCaption({ attrs: node.attrs });
      const captions = [...raw.matchAll(/\\caption\b/gu)];
      const numbered =
        hasCaption &&
        (/\\begin\{(?:table\*?|longtable)\}/u.test(raw) ||
          node.attrs.tableKind === "long" ||
          node.attrs.sourceMeta?.longtable != null);
      if (numbered) tableCounter++;
      if (captions.length > 1 || /\\caption\s*\*/u.test(raw)) tablesReliable = false;
      const number = numbered && tablesReliable ? `${chapterPrefix()}${tableCounter}` : null;
      result.tables.set(position, { number });
      if (numbered)
        result.floatContents.push({
          position,
          level: 1,
          number,
          title: String(node.attrs.caption ?? ""),
          kind: "table",
        });
      const label = String(node.attrs.label ?? "");
      const captionAt = captions[0]?.index;
      const labelAt = raw.indexOf("\\label");
      // A label before its caption binds an earlier TeX counter, not this table.
      if (
        label &&
        node.attrs.captionRemoved !== true &&
        (node.attrs.tableCanonical === true ||
          captionAt === undefined ||
          labelAt < 0 ||
          captionAt < labelAt)
      )
        addLabel(label, { position, row: 0, number, kind: "table", title: "Table" });
      return false;
    }
    if (node.type.name === "latexScientific" && !node.attrs.layout) {
      const environment = String(node.attrs.environment);
      const declaration = declarations.environments.get(environment);
      let number: string | null = null;
      if (declaration?.counter) {
        const counterScope =
          declaration.within === "chapter"
            ? chapterLabel()
            : declaration.within === "section"
              ? `${chapterPrefix()}${latexCounterLabel(section, appendix && documentClass === "article" ? "Alph" : "arabic")}`
              : "";
        const current = statementCounters.get(declaration.counter);
        const value = current?.scope === counterScope ? current.value + 1 : 1;
        statementCounters.set(declaration.counter, { value, scope: counterScope });
        if (
          statementsReliable &&
          !(documentClass === "article" && declaration.within === "chapter")
        )
          number = `${counterScope ? `${counterScope}.` : ""}${value}`;
      }
      const title = declaration?.title ?? environment[0]!.toUpperCase() + environment.slice(1);
      result.statements.set(position, {
        title,
        number,
        kind: declaration?.kind ?? "theorem",
        style:
          declaration?.style ??
          (["definition", "example", "proof"].includes(environment)
            ? "definition"
            : ["remark", "remarks"].includes(environment)
              ? "remark"
              : "plain"),
        boldPrefix:
          declaration?.boldPrefix ?? !["proof", "remark", "remarks"].includes(environment),
        proof: environment === "proof" && !declaration,
        proofEnd: environment === "proof" && !declaration && declarations.defaultProofEnd,
      });
      node.descendants((child) => {
        // Nested statements and equations own their labels.
        if (["latexScientific", "latexDisplayMath"].includes(child.type.name)) return false;
        if (child.type.name === "latexInlineCommand" && child.attrs.name === "label")
          addLabel(String(child.attrs.argument), {
            position,
            row: 0,
            number,
            kind: "statement",
            title,
          });
      });
    }
    if (
      node.type.name === "latexRichPreview" &&
      /\\begin\s*\{(?:equation|align|gather|multline|eqnarray|subequations)\*?\}/u.test(
        String(node.attrs.raw ?? ""),
      )
    ) {
      // Opaque previews do not expose their internal equation order to the editor.
      reliable = false;
    }
    if (node.type.name !== "latexDisplayMath") return;
    const environment = String(node.attrs.environment ?? "");
    const projected = projectMathNumbering(String(node.attrs.tex ?? ""));
    const commands: readonly (readonly string[])[] =
      Array.isArray(node.attrs.numbering) &&
      node.attrs.numbering.every(
        (row: unknown) =>
          Array.isArray(row) && row.every((command: unknown) => typeof command === "string"),
      )
        ? node.attrs.numbering
        : (projected?.commands ?? [[]]);
    if (!projected || (environment === "equation" && commands.length !== 1)) reliable = false;
    const numbered = /^(?:equation|align|gather)$/u.test(environment);
    const prefix =
      scope === "chapter"
        ? chapterPrefix()
        : scope === "section"
          ? `${chapterPrefix()}${latexCounterLabel(section, appendix && documentClass === "article" ? "Alph" : "arabic")}.`
          : "";
    const rows = commands.map((row, rowIndex) => {
      const tags = row.filter((command) => /^\\tag\b/u.test(command));
      const tag = tags[0];
      const tagValue =
        tags.length === 1 && tag ? /^\\tag(\*)?\s*\{([^{}\\%#$&_^~]+)\}$/u.exec(tag) : null;
      if (tags.length > 1) reliable = false;
      const suppressed = row.some((command) => /^\\(?:notag|nonumber)\b/u.test(command));
      if (numbered && !suppressed && !tag) counter++;
      const number = tag
        ? (tagValue?.[2] ?? null)
        : numbered && !suppressed && reliable
          ? prefix + counter
          : null;
      const display = number === null ? null : tagValue?.[1] === "*" ? number : `(${number})`;
      for (const command of row) {
        const label = /^\\label\s*\{([^{}\\%\s]+)\}$/u.exec(command)?.[1];
        if (!label) continue;
        addLabel(label, { position, row: rowIndex, number, kind: "equation" });
      }
      return { number, display };
    });
    result.equations.set(position, rows);
    return false;
  });
  const seenManual = new Set<string>();
  for (const entry of manualContents) {
    const position = bySourceId.get(String(entry.targetSourceId));
    const key = JSON.stringify([position, entry.level, entry.title]);
    if (position !== undefined && !seenManual.has(key)) {
      seenManual.add(key);
      result.contents.push({
        position,
        level: Number(entry.level ?? 1),
        number: "",
        title: String(entry.title ?? ""),
      });
    }
  }
  result.contents.sort((a, b) => a.position - b.position);
  return result;
}

export function latexEquationReferences(
  source: () => string,
  compiledSource: () => string | null = () => null,
) {
  let cachedSource: string | null | undefined;
  let compiled: CompiledBibliographyItem[] | null = null;
  const bibliography = () => {
    const value = compiledSource();
    if (value !== cachedSource) {
      cachedSource = value;
      compiled = compiledBibliographyItems(value);
    }
    return compiled;
  };
  let decoratedDocument: DocumentNode | undefined;
  let decoratedReferences: EquationReferences | undefined;
  let headingDecorations = DecorationSet.empty;
  return new Plugin({
    key: latexEquationReferencesKey,
    state: {
      init: (_config, state) => equationReferences(state.doc, source(), bibliography()),
      apply: (transaction, previous, _oldState, state) => {
        if (transaction.getMeta(latexEquationReferencesKey))
          return equationReferences(state.doc, source(), bibliography());
        if (!transaction.docChanged) return previous;
        // Text edits preserve numbering and labels; heading edits update only their titles.
        if (isOrdinaryTyping(transaction)) {
          const mapped = mapReferences(previous, transaction);
          if (decoratedDocument === transaction.before && decoratedReferences === previous) {
            headingDecorations = headingDecorations.map(transaction.mapping, transaction.doc);
            decoratedDocument = transaction.doc;
            decoratedReferences = mapped;
          }
          return mapped;
        }
        return equationReferences(state.doc, source(), bibliography());
      },
    },
    view: (view) => ({ destroy: () => clearHighlight(view) }),
    props: {
      decorations(state) {
        const references = latexEquationReferencesKey.getState(state);
        if (decoratedDocument === state.doc && decoratedReferences === references)
          return headingDecorations;
        headingDecorations = DecorationSet.create(
          state.doc,
          [...(references?.headings ?? [])].flatMap(([position, heading]) => {
            const node = state.doc.nodeAt(position);
            return node
              ? [
                  Decoration.node(position, position + node.nodeSize, {
                    "data-latex-heading-number": heading.number ?? "",
                    "data-latex-chapter-name": heading.chapterName,
                  }),
                ]
              : [];
          }),
        );
        decoratedDocument = state.doc;
        decoratedReferences = references;
        return headingDecorations;
      },
    },
  });
}
