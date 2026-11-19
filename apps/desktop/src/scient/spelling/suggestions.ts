// @effect-diagnostics nodeBuiltinImport:off -- Dictionaries are plain files read and written beside the context menu, outside Effect.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Windows mixes its own spellchecker with downloaded dictionaries, and Electron's menu then gets
 * only the downloaded ones' suggestions, so Scient asks Hunspell itself. Pinned `dictionary-<name>`
 * npm packages are fetched on first use; a bare Chromium code also covers its regions.
 */
const DICTIONARY_PACKAGES: Readonly<Record<string, string>> = {
  bg: "bg@2.0.0",
  ca: "ca@3.0.0",
  cs: "cs@4.0.0",
  cy: "cy@2.0.0",
  da: "da@6.0.0",
  de: "de@3.0.0",
  el: "el@4.0.0",
  en: "en@4.0.0",
  "en-AU": "en-au@3.0.0",
  "en-CA": "en-ca@3.0.0",
  "en-GB": "en-gb@3.0.0",
  "en-GB-oxendict": "en-gb@3.0.0",
  es: "es@4.0.0",
  "es-AR": "es-ar@2.0.0",
  "es-MX": "es-mx@2.0.0",
  "es-US": "es-us@2.0.0",
  et: "et@2.0.0",
  fa: "fa@2.0.0",
  fo: "fo@3.0.0",
  fr: "fr@3.0.0",
  he: "he@2.0.0",
  hr: "hr@2.0.0",
  hu: "hu@3.0.0",
  hy: "hy@2.0.0",
  it: "it@2.0.0",
  ko: "ko@2.0.0",
  lt: "lt@2.0.0",
  lv: "lv@2.0.0",
  nb: "nb@3.0.0",
  nl: "nl@2.0.0",
  pl: "pl@2.0.0",
  pt: "pt@4.0.0",
  "pt-PT": "pt-pt@2.0.0",
  ro: "ro@3.0.0",
  ru: "ru@3.0.0",
  sk: "sk@2.0.0",
  sl: "sl@3.0.0",
  sr: "sr@4.0.0",
  sv: "sv@4.0.0",
  tr: "tr@2.0.0",
  uk: "uk@4.0.0",
  vi: "vi@3.0.0",
};

const packageFor = (code: string): string | undefined =>
  DICTIONARY_PACKAGES[code] ?? DICTIONARY_PACKAGES[code.split("-")[0] ?? ""];

interface Dictionary {
  readonly testSpelling: (word: string) => boolean;
  readonly getSpellingSuggestions: (word: string) => string[];
}

export interface Suggester {
  /** Starts loading the dictionaries for these languages; a failed load is retried next time. */
  readonly prepare: (codes: readonly string[]) => void;
  /** Suggestions from each loaded dictionary that rejects the word, in the order of `codes`. */
  readonly suggest: (word: string, codes: readonly string[]) => string[][];
}

export function makeSuggester(options: {
  readonly directory: string;
  readonly fetchText: (url: string) => Promise<string>;
  readonly onError: (message: string, cause: unknown) => void;
}): Suggester {
  const loading = new Map<string, Promise<void>>();
  const loaded = new Map<string, Dictionary>();

  const readOrFetch = async (name: string, file: string): Promise<string> => {
    const path = NodePath.join(options.directory, name, file);
    const cached = await NodeFSP.readFile(path, "utf8").catch(() => null);
    if (cached !== null) return cached;
    const text = await options.fetchText(`https://cdn.jsdelivr.net/npm/dictionary-${name}/${file}`);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(`${path}.tmp`, text);
    await NodeFSP.rename(`${path}.tmp`, path);
    return text;
  };

  const load = async (name: string) => {
    const [affixes, words] = await Promise.all([
      readOrFetch(name, "index.aff"),
      readOrFetch(name, "index.dic"),
    ]);
    const { createHunspellFromStrings } = await import("hunspell-wasm");
    loaded.set(name, await createHunspellFromStrings(affixes, words));
  };

  return {
    prepare: (codes) => {
      for (const name of unique(codes.flatMap((code) => packageFor(code) ?? []))) {
        if (loading.has(name)) continue;
        loading.set(
          name,
          load(name).catch((cause: unknown) => {
            loading.delete(name);
            options.onError(`Could not load the ${name} spelling dictionary`, cause);
          }),
        );
      }
    },
    suggest: (word, codes) =>
      unique(codes.flatMap((code) => packageFor(code) ?? [])).flatMap((name) => {
        const dictionary = loaded.get(name);
        return dictionary && !dictionary.testSpelling(word)
          ? [dictionary.getSpellingSuggestions(word)]
          : [];
      }),
  };
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];
