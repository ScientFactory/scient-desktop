import bundledLocales from "@citation-js/plugin-csl/lib-mjs/locales.json" with { type: "json" };
import bundledStyles from "@citation-js/plugin-csl/lib-mjs/styles.json" with { type: "json" };
import { CSL_INCOMPLETE_NAMES } from "@scientfactory/scient-sources/bibliography";

import extraLocales from "./bundledLocales.json" with { type: "json" };

import type { ScientReferenceStyleId } from "./styles.ts";

interface CslItem {
  readonly id: string;
  readonly custom?: unknown;
}

interface CslEngine {
  setOutputFormat(format: "text"): void;
  updateItems(ids: ReadonlyArray<string>): void;
  makeBibliography(): readonly [unknown, ReadonlyArray<string>] | false;
}

interface CslEngineConstructor {
  new (
    system: {
      readonly retrieveLocale: (language: string) => string;
      readonly retrieveItem: (id: string) => CslItem | null;
    },
    style: string,
    language: string,
  ): CslEngine;
}

/** The parts of citeproc's name renderer the incomplete-list rule reads. */
interface CiteprocNameOutput {
  readonly persons_count: Record<string, Record<number, number>>;
  readonly freeters_count: Record<string, number>;
  readonly state: { readonly tmp: { readonly sort_key_flag?: boolean } };
  etal_use_last: boolean;
}

interface CiteprocModule {
  readonly Engine: CslEngineConstructor;
  readonly NameOutput: {
    readonly prototype: {
      _setEtAlParameter(
        this: CiteprocNameOutput,
        type: string,
        variable: string,
        index?: number,
      ): void;
    };
  };
}

// citeproc-js is JavaScript-only. Keep its untyped boundary isolated here so
// the public Scient citation API and every caller remain fully typed.
// @ts-expect-error citeproc-js does not publish TypeScript declarations.
import UntypedCiteproc from "citeproc";

const Citeproc = UntypedCiteproc as CiteprocModule;

/** The name variables of the item being rendered whose list stops short; set only while rendering. */
let incompleteNames: ReadonlySet<string> = new Set();

function incompleteNamesOf(item: CslItem): ReadonlySet<string> {
  const custom = item.custom;
  const marked =
    typeof custom === "object" && custom !== null
      ? (custom as Record<string, unknown>)[CSL_INCOMPLETE_NAMES]
      : undefined;
  return new Set(Array.isArray(marked) ? marked.filter((name) => typeof name === "string") : []);
}

// citeproc ends a name list with the style's et-al term when it holds fewer names than counted.
// A known-short list counts one more, so a list the style did not cut ends in et al. and a cut
// one keeps the style's cutoff; "last author" styles get plain et al., as the last given is not.
const setEtAlParameter = Citeproc.NameOutput.prototype._setEtAlParameter;
Citeproc.NameOutput.prototype._setEtAlParameter = function (type, variable, index) {
  if (
    !incompleteNames.has(variable) ||
    this.state.tmp.sort_key_flag ||
    (type !== "persons" && type !== "freeters")
  ) {
    setEtAlParameter.call(this, type, variable, index);
    return;
  }
  const counts: Record<string | number, number> | undefined =
    type === "persons" ? this.persons_count[variable] : this.freeters_count;
  const key = type === "persons" ? (index ?? 0) : variable;
  const useLast = this.etal_use_last;
  if (counts?.[key] !== undefined) counts[key] += 1;
  this.etal_use_last = false;
  try {
    setEtAlParameter.call(this, type, variable, index);
  } finally {
    this.etal_use_last = useLast;
    if (counts?.[key] !== undefined) counts[key] -= 1;
  }
};

type BibliographyEntryRenderer = ((item: CslItem) => string) & { readonly seen: Set<string> };

// Building an engine compiles its CSL style, which takes over a second for APA;
// rendering with a built engine takes milliseconds. Build each style once.
// citeproc keeps a little bookkeeping for every ID it has seen, even after the
// item is removed, so an engine is rebuilt after this many different sources.
const MAX_SOURCES_PER_ENGINE = 500;
const MAX_ENGINES = 8;
const renderersByStyle = new Map<string, BibliographyEntryRenderer>();

const locales: Readonly<Record<string, string>> = { ...bundledLocales, ...extraLocales.locales };

/** A locale the engine does not have renders in US English, as citeproc processors do. */
function retrieveLocale(language: string): string {
  return locales[language] ?? bundledLocales["en-US"];
}

function createRenderer(style: string): BibliographyEntryRenderer {
  let current: CslItem | null = null;
  const engine = new Citeproc.Engine(
    {
      retrieveLocale,
      retrieveItem: (id) => (current !== null && id === current.id ? current : null),
    },
    style,
    "en-US",
  );
  engine.setOutputFormat("text");

  const render = (item: CslItem) => {
    current = item;
    incompleteNames = incompleteNamesOf(item);
    try {
      // citeproc derives sort keys and name disambiguation when an item is first
      // registered and keeps them for a re-registered ID, so render each entry
      // from an empty registry, as a newly built engine would.
      engine.updateItems([]);
      engine.updateItems([item.id]);
      const bibliography = engine.makeBibliography();
      return bibliography ? (bibliography[1][0] ?? "") : "";
    } finally {
      current = null;
      incompleteNames = new Set();
    }
  };
  return Object.assign(render, { seen: new Set<string>() });
}

/** The bundled CSL style XML, for Pandoc's `--csl`. */
export function bundledCslStyle(style: ScientReferenceStyleId): string {
  return bundledStyles[style];
}

/** Renders with a built-in style or with a style's CSL XML. */
export type CslStyleSource = ScientReferenceStyleId | { readonly xml: string };

export function renderCslBibliographyEntry(item: CslItem, source: CslStyleSource): string {
  const style = typeof source === "string" ? bundledStyles[source] : source.xml;
  let render = renderersByStyle.get(style);
  if (render && !render.seen.has(item.id) && render.seen.size >= MAX_SOURCES_PER_ENGINE) {
    render = undefined;
  }
  if (!render) {
    render = createRenderer(style);
    renderersByStyle.set(style, render);
    const oldest = renderersByStyle.keys().next().value;
    if (renderersByStyle.size > MAX_ENGINES && oldest !== undefined) {
      renderersByStyle.delete(oldest);
    }
  }
  try {
    render.seen.add(item.id);
    return render(item);
  } catch (error) {
    // A failed update can leave citeproc's registry inconsistent.
    renderersByStyle.delete(style);
    throw error;
  }
}
