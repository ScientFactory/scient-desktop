// @effect-diagnostics nodeBuiltinImport:off -- A maintainer script that writes the bundled style file.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Writes src/bundledStyles.json and src/bundledLocales.json from pinned commits of the CSL styles
 * and locales repositories.
 * The style files are stored byte for byte; their licence (CC BY-SA 3.0) forbids changing them
 * without saying so, and Scient never does.
 */
const COMMIT = "7a37c5a736c10fbd468bc31f92cbc6eafaa2173d";
const LOCALES_COMMIT = "6b70fe79264543aa538f8927fcc98d5b72425a94";
/** Default locales of bundled styles that @citation-js/plugin-csl does not ship. */
const LOCALE_IDS = ["en-GB"];
const STYLE_IDS = [
  "apa",
  "chicago-author-date",
  "chicago-notes-bibliography",
  "harvard-cite-them-right",
  "ieee",
  "nature",
  "science",
  "cell",
  "american-medical-association",
  "modern-language-association",
  "american-chemical-society",
  "nlm-citation-sequence",
  "elsevier-vancouver",
  "bmj",
  "the-lancet",
  "the-new-england-journal-of-medicine",
  "pnas",
  "plos",
  "elsevier-harvard",
  "springer-basic-author-date",
];

async function download(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.text();
}

async function write(name: string, contents: object): Promise<void> {
  const target = NodePath.join(import.meta.dirname, "..", "src", name);
  await NodeFSP.writeFile(target, `${JSON.stringify(contents, null, 2)}\n`);
  console.log(`Wrote ${target}.`);
}

const styles = [];
for (const id of STYLE_IDS) {
  const xml = await download(
    `https://raw.githubusercontent.com/citation-style-language/styles/${COMMIT}/${id}.csl`,
  );
  if (xml.includes('rel="independent-parent"')) throw new Error(`${id} is a dependent style.`);
  styles.push({ id, xml });
}
const locales: Record<string, string> = {};
for (const id of LOCALE_IDS) {
  locales[id] = await download(
    `https://raw.githubusercontent.com/citation-style-language/locales/${LOCALES_COMMIT}/locales-${id}.xml`,
  );
}

await write("bundledStyles.json", {
  source: `https://github.com/citation-style-language/styles/tree/${COMMIT}`,
  styles,
});
await write("bundledLocales.json", {
  source: `https://github.com/citation-style-language/locales/tree/${LOCALES_COMMIT}`,
  locales,
});
