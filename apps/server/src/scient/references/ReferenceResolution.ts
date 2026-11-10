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
  const entries = bibtexEntries(source).entries.filter((candidate) => candidate.key === fix.key);
  if (entries.length === 0)
    return { outcome: "not-found", message: `${fix.key} is no longer in ${file.relativePath}.` };
  const [entry] = entries;
  if (!entry || entries.length > 1) {
    return {
      outcome: "stale",
      message: `More than one entry uses ${fix.key}. Give each its own key, then check again.`,
    };
  }
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
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    next = `${kept}${separator}${newline}  ${fix.field} = {${value}}${trailing.includes("\n") ? trailing : newline}${source.slice(entry.bodyTo)}`;
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

type SourceFix = Extract<ScientReferenceFix, { readonly kind: "source-field" }>;

/**
 * Applies one check's fixes to one source as a single credited revision, so fixes from the same
 * report do not make each other stale. Results follow the order of `fixes`.
 */
async function applySourceFixes(
  root: string,
  fixes: ReadonlyArray<SourceFix>,
  actor: ScientSourceActor,
): Promise<ReadonlyArray<FixResult>> {
  const { sourceId, expectedRevision } = fixes[0]!;
  const record = await readScientSourceRecord(root, sourceId);
  if (!record) {
    return fixes.map(() => ({
      outcome: "not-found",
      message: "The source is no longer in the Library.",
    }));
  }
  let metadata = editableMetadataFromRecord(record);
  const results: Array<FixResult | "pending"> = [];
  for (const fix of fixes) {
    const year = Number(fix.value);
    if (fix.field === "issuedYear" && !Number.isInteger(year)) {
      results.push({ outcome: "failed", message: "The year fix is not a whole year." });
      continue;
    }
    if (
      fix.field === "issuedYear" ? metadata.issuedYear === year : metadata[fix.field] === fix.value
    ) {
      results.push({ outcome: "unchanged", message: `The source already has this ${fix.field}.` });
      continue;
    }
    metadata =
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
    results.push("pending");
  }
  const pending = (result: FixResult): ReadonlyArray<FixResult> =>
    results.map((entry) => (entry === "pending" ? result : entry));
  if (!results.includes("pending")) return results as ReadonlyArray<FixResult>;
  const result = await updateScientSource({
    root,
    sourceId,
    expectedRevision,
    metadata,
    allowExistingValidationIssues: true,
    actor,
  });
  switch (result.outcome) {
    case "updated":
      return results.map((entry, index) =>
        entry === "pending"
          ? { outcome: "applied", message: `Updated the source's ${fixes[index]!.field}.` }
          : entry,
      );
    case "unchanged":
      return results.map((entry, index) =>
        entry === "pending"
          ? { outcome: "unchanged", message: `The source already has this ${fixes[index]!.field}.` }
          : entry,
      );
    case "stale":
      return pending({
        outcome: "stale",
        message: "The source changed since the check. Check the references again.",
      });
    case "duplicate":
      return pending({ outcome: "failed", message: result.duplicate.reason });
  }
}

// Fixes and ignores read a file, change it and write it back, so two at once could each
// overwrite the other's change; they run one at a time per project.
const projectWrites = new Map<string, Promise<unknown>>();

function oneAtATime<A>(root: string, run: () => Promise<A>): Promise<A> {
  const previous = projectWrites.get(root) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.catch(() => undefined);
  projectWrites.set(root, settled);
  void settled.then(() => {
    if (projectWrites.get(root) === settled) projectWrites.delete(root);
  });
  return next;
}

type ResolveInput = {
  readonly root: string;
  readonly apply?: ReadonlyArray<ScientReferenceFix>;
  readonly ignore?: ReadonlyArray<string>;
  readonly restore?: ReadonlyArray<string>;
  readonly actor: ScientSourceActor;
  readonly now?: () => Date;
};

/** Applies registry fixes in order and updates the ignore list; one failure never stops the rest. */
export async function resolveReferenceFindings(
  input: ResolveInput,
): Promise<ScientReferenceResolution> {
  const root = await canonicalRoot(input.root);
  return oneAtATime(root, () => resolveInProject(root, input));
}

async function resolveInProject(
  root: string,
  input: ResolveInput,
): Promise<ScientReferenceResolution> {
  const fixes: Array<ScientReferenceResolution["fixes"][number]> = [];
  const failed = (error: unknown): FixResult => ({
    outcome: "failed",
    message: isReferenceCheckError(error) ? error.message : "The fix could not be applied.",
  });
  const apply = (input.apply ?? []).map((fix, index) => ({ fix, index }));
  const sourceGroups = new Map<
    string,
    Array<{ readonly fix: SourceFix; readonly index: number }>
  >();
  for (const { fix, index } of apply) {
    if (fix.kind !== "source-field") continue;
    const group = `${fix.sourceId}\0${fix.expectedRevision}`;
    sourceGroups.set(group, [...(sourceGroups.get(group) ?? []), { fix, index }]);
  }
  for (const { fix, index } of apply) {
    if (fix.kind === "bibtex-field") {
      fixes.push({ index, ...(await applyBibtexFix(root, fix).catch(failed)) });
      continue;
    }
    const groupKey = `${fix.sourceId}\0${fix.expectedRevision}`;
    const group = sourceGroups.get(groupKey);
    if (!group) continue;
    sourceGroups.delete(groupKey);
    const results = await applySourceFixes(
      root,
      group.map((member) => member.fix),
      input.actor,
    ).catch((error: unknown) => group.map(() => failed(error)));
    group.forEach((member, position) => fixes.push({ index: member.index, ...results[position]! }));
  }
  fixes.sort((left, right) => left.index - right.index);
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
