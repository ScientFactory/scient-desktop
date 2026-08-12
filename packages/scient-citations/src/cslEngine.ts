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

export function renderCslBibliographyEntry(item: CslItem, style: ScientReferenceStyleId): string {
  const engine = new Citeproc.Engine(
    {
      retrieveLocale: () => bundledLocales["en-US"],
      retrieveItem: (id) => (id === item.id ? item : null),
    },
    bundledStyles[style],
    "en-US",
  );
  engine.setOutputFormat("text");
  engine.updateItems([item.id]);
  const bibliography = engine.makeBibliography();
  return bibliography ? (bibliography[1][0] ?? "") : "";
}
