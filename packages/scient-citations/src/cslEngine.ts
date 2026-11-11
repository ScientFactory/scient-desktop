import bundledLocales from "@citation-js/plugin-csl/lib-mjs/locales.json" with { type: "json" };
import bundledStyles from "@citation-js/plugin-csl/lib-mjs/styles.json" with { type: "json" };

import extraLocales from "./bundledLocales.json" with { type: "json" };

import type { ScientReferenceStyleId } from "./styles.ts";

interface CslItem {
  readonly id: string;
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

interface CiteprocModule {
  readonly Engine: CslEngineConstructor;
}

// citeproc-js is JavaScript-only. Keep its untyped boundary isolated here so
// the public Scient citation API and every caller remain fully typed.
// @ts-expect-error citeproc-js does not publish TypeScript declarations.
import UntypedCiteproc from "citeproc";

const Citeproc = UntypedCiteproc as CiteprocModule;

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
