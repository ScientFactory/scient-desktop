// @effect-diagnostics globalConsole:off globalFetch:off -- A maintenance script that reads Zotero's published schema and prints differences.
/**
 * Compares Scient's own statement of Zotero's data model (`src/zoteroSchema.ts`) with the one
 * Zotero publishes for apps. Reads the network, so it is run by hand, not in CI:
 *   node scripts/checkZoteroSchema.ts
 */
import {
  ZOTERO_BASE_FIELD,
  ZOTERO_FIELD_TARGET,
  ZOTERO_PRIMARY_ROLE,
  ZOTERO_ROLE_CSL,
  ZOTERO_SCHEMA_VERSION,
  ZOTERO_TYPE_CSL,
} from "../src/zoteroSchema.ts";

interface ZoteroSchema {
  readonly version: number;
  readonly itemTypes: ReadonlyArray<{
    readonly itemType: string;
    readonly fields: ReadonlyArray<{ readonly field: string; readonly baseField?: string }>;
    readonly creatorTypes: ReadonlyArray<{
      readonly creatorType: string;
      readonly primary?: boolean;
    }>;
  }>;
  readonly csl: {
    readonly types: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly fields: {
      readonly text: Readonly<Record<string, ReadonlyArray<string>>>;
      readonly date: Readonly<Record<string, string>>;
    };
    readonly names: Readonly<Record<string, string>>;
  };
}

/** Fields that are identifiers or read elsewhere, not bibliographic text. */
const IDENTIFIERS = new Set(["DOI", "ISBN", "ISSN", "PMID", "PMCID", "citationKey", "extra"]);

const response = await fetch("https://api.zotero.org/schema");
if (!response.ok) throw new Error(`Zotero's schema could not be read: HTTP ${response.status}.`);
const schema = (await response.json()) as ZoteroSchema;
const differences: string[] = [];
const differs = (what: string) => differences.push(what);

for (const type of schema.itemTypes) {
  if (["attachment", "note", "annotation"].includes(type.itemType)) continue;
  for (const { field, baseField } of type.fields) {
    if (baseField !== undefined && ZOTERO_BASE_FIELD[field] !== baseField) {
      differs(`${field} is ${baseField} for ${type.itemType}; here: ${ZOTERO_BASE_FIELD[field]}`);
    }
    const general = baseField ?? field;
    if (!(general in ZOTERO_FIELD_TARGET) && !IDENTIFIERS.has(general)) {
      differs(`${general} (${type.itemType}) has no place here; it is kept as a line of Extra`);
    }
  }
  const primary = type.creatorTypes.find((role) => role.primary)?.creatorType ?? "author";
  if ((ZOTERO_PRIMARY_ROLE[type.itemType] ?? "author") !== primary) {
    differs(`${type.itemType}'s primary role is ${primary}`);
  }
}
for (const [csl, zoteroTypes] of Object.entries(schema.csl.types)) {
  for (const zoteroType of zoteroTypes) {
    if (["attachment", "note"].includes(zoteroType)) continue;
    if (ZOTERO_TYPE_CSL[zoteroType] !== csl) differs(`${zoteroType} is CSL ${csl}`);
  }
}
// Where each field goes: the CSL variable Zotero names, under Scient's name for it.
const RENAMED: Readonly<Record<string, string>> = {
  journalAbbreviation: "container-title-short",
  shortTitle: "title-short",
};
const TYPED: Readonly<Record<string, string>> = {
  title: "title",
  issuedRaw: "issued",
  abstract: "abstract",
  containerTitle: "container-title",
  publisher: "publisher",
  volume: "volume",
  issue: "issue",
  pages: "page",
  language: "language",
  url: "URL",
};
for (const [csl, fields] of [
  ...Object.entries(schema.csl.fields.text),
  ...Object.entries(schema.csl.fields.date).map(([name, field]) => [name, [field]] as const),
]) {
  for (const field of fields) {
    const target = ZOTERO_FIELD_TARGET[field];
    if (!target) continue;
    const ours = "typed" in target ? TYPED[target.typed] : target.more;
    if (ours !== (RENAMED[csl] ?? csl)) differs(`${field} is CSL ${csl}; here: ${ours}`);
  }
}
for (const [role, csl] of Object.entries(schema.csl.names)) {
  if (ZOTERO_ROLE_CSL[role.toLowerCase()] !== csl) differs(`role ${role} is CSL ${csl}`);
}

console.log(
  `Zotero's schema is version ${schema.version}; this table was read from ${ZOTERO_SCHEMA_VERSION}.`,
);
console.log(differences.length === 0 ? "No differences." : differences.join("\n"));
