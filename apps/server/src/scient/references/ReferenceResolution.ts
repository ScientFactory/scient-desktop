// @effect-diagnostics nodeBuiltinImport:off -- Fixes rewrite project .bib files in place, atomically.
// @effect-diagnostics globalDate:off -- Ignore entries carry interoperable timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import {
  editableMetadataFromRecord,
  latexPlainText,
  type ScientReferenceFix,
  type ScientReferenceFixOutcome,
  type ScientReferenceResolution,
  type ScientSourceActor,
} from "@scientfactory/scient-sources";
import { bibtexEntries } from "@scientfactory/scient-sources/bibtex";
import { resolveScientProjectFile } from "@scientfactory/scient-sources/project-files";
import { readScientSourceRecord } from "@scientfactory/scient-sources/store";

import { updateScientSource } from "../sources/ScientSourcesCoordinator.ts";
import {
  canonicalRoot,
  isReferenceCheckError,
  MAX_IGNORED_FINDINGS,
  readIgnoreList,
  ReferenceCheckError,
  writeIgnoreList,
} from "./ReferenceCheck.ts";

type FixResult = { readonly outcome: ScientReferenceFixOutcome; readonly message: string };

/** BibTeX text for a plain registry value: TeX specials escaped, braces dropped. */
function bibtexValue(value: string): string {
  return value
    .replace(/[{}]/gu, "")
    .replace(/\\/gu, "\\textbackslash{}")
    .replace(/([&%$#_])/gu, "\\$1")
    .replace(/\s+/gu, " ")
    .trim();
}

async function applyBibtexFix(
  root: string,
  fix: Extract<ScientReferenceFix, { readonly kind: "bibtex-field" }>,
): Promise<FixResult> {
  const file = await resolveScientProjectFile(root, fix.path, {
    extensions: [".bib"],
    description: "bibliography file",
  }).catch((error: unknown) => {
    throw new ReferenceCheckError({
      message: error instanceof Error ? error.message : "The bibliography file could not be read.",
    });
  });
  const source = await NodeFSP.readFile(file.absolutePath, "utf8");
  const entry = bibtexEntries(source).entries.find((candidate) => candidate.key === fix.key);
  if (!entry)
    return { outcome: "not-found", message: `${fix.key} is no longer in ${file.relativePath}.` };
  const field = entry.fields.find((candidate) => candidate.name === fix.field);
  const current = field?.text === null || field === undefined ? null : latexPlainText(field.text);
  const value = bibtexValue(fix.value);
  if (field && field.text !== null && latexPlainText(field.text) === latexPlainText(value)) {
    return { outcome: "unchanged", message: `${fix.key} already has this ${fix.field}.` };
  }
  if ((field === undefined) !== (fix.current === null) || (field && current !== fix.current)) {
    return {
      outcome: "stale",
      message: `${fix.key}'s ${fix.field} changed since the check. Check the references again.`,
    };
  }
  let next: string;
  if (field) {
    next = `${source.slice(0, field.valueFrom)}{${value}}${source.slice(field.valueTo)}`;
  } else {
    const body = source.slice(0, entry.bodyTo);
    const kept = body.replace(/\s*$/u, "");
    const trailing = body.slice(kept.length);
    const separator = kept.endsWith(",") || kept.endsWith("{") ? "" : ",";
    next = `${kept}${separator}\n  ${fix.field} = {${value}}${trailing.includes("\n") ? trailing : "\n"}${source.slice(entry.bodyTo)}`;
  }
  const stats = await NodeFSP.stat(file.absolutePath);
  const temporary = `${file.absolutePath}.tmp-${NodeCrypto.randomUUID()}`;
  try {
    await NodeFSP.writeFile(temporary, next, { flag: "wx", mode: stats.mode & 0o777 });
    await NodeFSP.rename(temporary, file.absolutePath);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
  return { outcome: "applied", message: `Set ${fix.key}'s ${fix.field} in ${file.relativePath}.` };
}

async function applySourceFix(
  root: string,
  fix: Extract<ScientReferenceFix, { readonly kind: "source-field" }>,
  actor: ScientSourceActor,
): Promise<FixResult> {
  const record = await readScientSourceRecord(root, fix.sourceId);
  if (!record) return { outcome: "not-found", message: "The source is no longer in the Library." };
  const metadata = editableMetadataFromRecord(record);
  const year = Number(fix.value);
  if (fix.field === "issuedYear" && !Number.isInteger(year)) {
    return { outcome: "failed", message: "The year fix is not a whole year." };
  }
  const changed =
    fix.field === "issuedYear"
      ? {
          ...metadata,
          issuedYear: year,
          issuedRaw:
            metadata.issuedRaw && metadata.issuedRaw.includes(String(year))
              ? metadata.issuedRaw
              : String(year),
        }
      : { ...metadata, [fix.field]: fix.value };
  const result = await updateScientSource({
    root,
    sourceId: fix.sourceId,
    expectedRevision: fix.expectedRevision,
    metadata: changed,
    allowExistingValidationIssues: true,
    actor,
  });
  switch (result.outcome) {
    case "updated":
      return { outcome: "applied", message: `Updated the source's ${fix.field}.` };
    case "unchanged":
      return { outcome: "unchanged", message: `The source already has this ${fix.field}.` };
    case "stale":
      return {
        outcome: "stale",
        message: "The source changed since the check. Check the references again.",
      };
    case "duplicate":
      return { outcome: "failed", message: result.duplicate.reason };
  }
}

/** Applies registry fixes in order and updates the ignore list; one failure never stops the rest. */
export async function resolveReferenceFindings(input: {
  readonly root: string;
  readonly apply?: ReadonlyArray<ScientReferenceFix>;
  readonly ignore?: ReadonlyArray<string>;
  readonly restore?: ReadonlyArray<string>;
  readonly actor: ScientSourceActor;
  readonly now?: () => Date;
}): Promise<ScientReferenceResolution> {
  const root = await canonicalRoot(input.root);
  const fixes: Array<ScientReferenceResolution["fixes"][number]> = [];
  for (const [index, fix] of (input.apply ?? []).entries()) {
    try {
      const result =
        fix.kind === "bibtex-field"
          ? await applyBibtexFix(root, fix)
          : await applySourceFix(root, fix, input.actor);
      fixes.push({ index, ...result });
    } catch (error) {
      fixes.push({
        index,
        outcome: "failed",
        message: isReferenceCheckError(error) ? error.message : "The fix could not be applied.",
      });
    }
  }
  const ignore = [...new Set(input.ignore ?? [])];
  const restore = new Set(input.restore ?? []);
  if (ignore.length === 0 && restore.size === 0) return { fixes, ignored: [], restored: [] };
  const list = await readIgnoreList(root);
  const known = new Set(list.findings.map(({ findingId }) => findingId));
  const ignoredAt = (input.now ?? (() => new Date()))().toISOString();
  const added = ignore.filter((findingId) => !known.has(findingId) && !restore.has(findingId));
  const findings = [
    ...list.findings.filter(({ findingId }) => !restore.has(findingId)),
    ...added.map((findingId) => ({ findingId, ignoredAt, ignoredBy: input.actor })),
  ];
  if (findings.length > MAX_IGNORED_FINDINGS) {
    throw new ReferenceCheckError({
      message: "Too many ignored findings. Stop ignoring some first.",
    });
  }
  await writeIgnoreList(root, { formatVersion: 1, findings });
  return {
    fixes,
    ignored: ignore.filter((findingId) => !restore.has(findingId)),
    restored: [...restore].filter((findingId) => known.has(findingId)),
  };
}
