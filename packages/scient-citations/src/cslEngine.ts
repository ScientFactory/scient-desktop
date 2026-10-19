import bundledLocales from "@citation-js/plugin-csl/lib-mjs/locales.json" with { type: "json" };
import bundledStyles from "@citation-js/plugin-csl/lib-mjs/styles.json" with { type: "json" };

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

type BibliographyEntryRenderer = (item: CslItem) => string;

// Building an engine compiles its CSL style, which takes over a second for APA;
// rendering with a built engine takes milliseconds. Build each style once.
const renderersByStyle = new Map<ScientReferenceStyleId, BibliographyEntryRenderer>();

function createRenderer(style: ScientReferenceStyleId): BibliographyEntryRenderer {
  let current: CslItem | null = null;
  const engine = new Citeproc.Engine(
    {
      retrieveLocale: () => bundledLocales["en-US"],
      retrieveItem: (id) => (current !== null && id === current.id ? current : null),
    },
    bundledStyles[style],
    "en-US",
  );
  engine.setOutputFormat("text");

  return (item) => {
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
}

export function renderCslBibliographyEntry(item: CslItem, style: ScientReferenceStyleId): string {
  let render = renderersByStyle.get(style);
  if (!render) {
    render = createRenderer(style);
    renderersByStyle.set(style, render);
  }
  try {
    return render(item);
  } catch (error) {
    // A failed update can leave citeproc's registry inconsistent.
    renderersByStyle.delete(style);
    throw error;
  }
}
