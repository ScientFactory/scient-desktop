/** Bibliographic inputs named by a saved Markdown file's YAML front matter. */
import { CslItem, type DocumentCitation, type DocumentWarning } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

export interface MarkdownReferenceDeclarations {
  readonly citations: ReadonlyArray<DocumentCitation>;
  readonly bibliographyPaths: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<DocumentWarning>;
}

const isCslItem = Schema.is(CslItem);
const MAX_BIBLIOGRAPHIES = 8;

/** Read only reference fields; all other front matter stays in the document. */
export function markdownReferenceDeclarations(markdown: string): MarkdownReferenceDeclarations {
  const empty = { citations: [], bibliographyPaths: [], warnings: [] };
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match) return empty;
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "", { maxAliasCount: 20 });
  } catch {
    return {
      ...empty,
      warnings: [{
        code: "unsupported-construct",
        message: "The document's YAML references could not be read; citation keys remain as written.",
      }],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const fields = parsed as Record<string, unknown>;
  const warnings: Array<DocumentWarning> = [];
  const citations: Array<DocumentCitation> = [];
  if (fields.references !== undefined) {
    if (!Array.isArray(fields.references)) {
      warnings.push({
        code: "unsupported-construct",
        message: "YAML references must be a list of CSL items; citation keys remain as written.",
      });
    } else {
      for (const [index, item] of fields.references.entries()) {
        if (!isCslItem(item)) {
          warnings.push({
            code: "unsupported-construct",
            message: `YAML reference ${index + 1} is not a valid CSL item and was not used.`,
          });
          continue;
        }
        citations.push({
          _tag: "bibliographic",
          id: `frontmatter-${index + 1}`,
          key: item.id,
          reference: item,
        });
      }
    }
  }
  const declared =
    fields.bibliography === undefined
      ? []
      : typeof fields.bibliography === "string"
        ? [fields.bibliography]
        : fields.bibliography;
  const bibliographyPaths: Array<string> = [];
  if (!Array.isArray(declared)) {
    warnings.push({
      code: "unsupported-construct",
      message: "YAML bibliography must name a local .json or .bib file; citation keys remain as written.",
    });
  } else {
    for (const entry of declared.slice(0, MAX_BIBLIOGRAPHIES)) {
      if (typeof entry === "string" && entry.trim() && /\.(?:json|bib)$/iu.test(entry)) {
        bibliographyPaths.push(entry);
      } else {
        warnings.push({
          code: "resource-unresolved",
          message: "A bibliography entry is not a local .json or .bib path and was not used.",
        });
      }
    }
    if (declared.length > MAX_BIBLIOGRAPHIES) {
      warnings.push({
        code: "resource-unresolved",
        message: `Only the first ${MAX_BIBLIOGRAPHIES} bibliography files are used for Word export.`,
      });
    }
  }
  return { citations, bibliographyPaths, warnings };
}

/** A CSL-JSON bibliography can be an array or an object keyed by citation id. */
export function citationsFromCslJson(contents: string): ReadonlyArray<DocumentCitation> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  const values = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object"
      ? Object.entries(parsed).map(([id, item]) =>
          item !== null && typeof item === "object" && !Array.isArray(item)
            ? { ...item, id }
            : item,
        )
      : null;
  if (values === null || !values.every(isCslItem)) return null;
  return values.map((reference, index) => ({
    _tag: "bibliographic",
    id: `bibliography-${index + 1}`,
    key: reference.id,
    reference,
  }));
}
