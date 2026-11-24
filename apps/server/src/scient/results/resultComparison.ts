// @effect-diagnostics nodeBuiltinImport:off -- reads stored outputs from the revision vault.
import * as NodeFSP from "node:fs/promises";

import type {
  ComputeResultInput,
  ComputeResultRevision,
  ComputeResultsCompareResult,
} from "@t3tools/contracts";
import { pairedResultValues } from "@t3tools/shared/computeResults";

import { observedDirectoryInputs, type ResultsReader } from "./resultRevisions.ts";

type Change = ComputeResultsCompareResult["inputs"][number]["change"];
type ValueDiff = ComputeResultsCompareResult["values"][number];

const MAXIMUM_VALUES = 500;

const keys = (left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>) =>
  [...new Set([...left.keys(), ...right.keys()])].toSorted();

function compare<A>(
  left: A | undefined,
  right: A | undefined,
  same: (a: A, b: A) => boolean,
): Change {
  if (left === undefined) return "added";
  if (right === undefined) return "removed";
  return same(left, right) ? "same" : "changed";
}

type RecordedInput =
  | ComputeResultInput
  | NonNullable<ComputeResultRevision["inputs"]["directories"]>[number];

function inputChange(path: string, from: RecordedInput | undefined, to: RecordedInput | undefined) {
  if (from === undefined || to === undefined)
    return { path, change: from === undefined ? ("added" as const) : ("removed" as const) };
  if ("size" in from !== "size" in to) return { path, change: "changed" as const };
  const contentUnchecked = from.sha256 === null || to.sha256 === null;
  const change =
    !contentUnchecked && from.sha256 !== to.sha256 ? ("changed" as const) : ("same" as const);
  if (!("size" in from) || !("size" in to)) return { path, change };
  const evidence = ({ origin, via, changedDuringRun }: ComputeResultInput) => ({
    origin: origin ?? ("observed" as const),
    ...(via === undefined ? {} : { via }),
    changedDuringRun,
  });
  const a = evidence(from);
  const b = evidence(to);
  return {
    path,
    change,
    ...(contentUnchecked ? { contentUnchecked: true as const } : {}),
    ...(a.origin === b.origin && a.via === b.via && a.changedDuringRun === b.changedDuringRun
      ? {}
      : { evidence: { from: a, to: b } }),
  };
}

function versionChanges(
  kind: "lockfile" | "package",
  from: ReadonlyMap<string, string>,
  to: ReadonlyMap<string, string>,
) {
  return keys(from, to).flatMap((name) => {
    const before = from.get(name) ?? null;
    const after = to.get(name) ?? null;
    return before === after ? [] : [{ kind, name, from: before, to: after }];
  });
}

const lockfiles = (revision: ComputeResultRevision) =>
  new Map(revision.environment?.lockfiles.map(({ path, sha256 }) => [path, sha256]));

const packageVersions = (revision: ComputeResultRevision) =>
  new Map(
    revision.environment?.packages?.map(({ name, version }) => [
      name.toLowerCase().replace(/[-_.]+/gu, "-"),
      version,
    ]),
  );

type Leaf = { readonly value: string; readonly numeric: boolean };
const integerLiteral = /^-?\d+$/u;

function numericDelta(from: string, to: string): number {
  if (integerLiteral.test(from) && integerLiteral.test(to))
    return Number(BigInt(to) - BigInt(from));
  return Number(to) - Number(from);
}

function valueDiff(
  output: string,
  pointer: string,
  from: Leaf | undefined,
  to: Leaf | undefined,
): ValueDiff {
  const delta = from?.numeric && to?.numeric ? numericDelta(from.value, to.value) : NaN;
  const baseline = from?.numeric ? Number(from.value) : NaN;
  const relativeChange = Number.isFinite(baseline) ? delta / Math.abs(baseline) : NaN;
  return {
    output,
    pointer,
    from: from?.value ?? null,
    to: to?.value ?? null,
    ...(Number.isFinite(delta) ? { delta } : {}),
    ...(Number.isFinite(relativeChange) ? { relativeChange } : {}),
    ...(from !== undefined && to !== undefined && from.numeric !== to.numeric
      ? { typeChanged: true }
      : {}),
  };
}

async function compareValues(
  reader: ResultsReader,
  from: ComputeResultRevision,
  to: ComputeResultRevision,
) {
  const names = new Set(
    [...from.outputs, ...to.outputs]
      .filter((output) => output.kind === "values")
      .map(({ name }) => name),
  );
  const changed: ValueDiff[] = [];
  const unchanged: ValueDiff[] = [];
  const read = async (revision: ComputeResultRevision, name: string) => {
    const stored = await reader.outputFile(revision, name);
    if (stored === null || stored.output.kind !== "values") return "";
    return NodeFSP.readFile(stored.path, "utf8");
  };
  for (const name of [...names].toSorted()) {
    const [left, right] = await Promise.all([read(from, name), read(to, name)]);
    for (const { from: a, to: b } of pairedResultValues(left, right)) {
      const leaf = a ?? b;
      if (leaf === undefined) continue;
      if (a?.value !== b?.value || a?.numeric !== b?.numeric) {
        if (changed.length >= MAXIMUM_VALUES) return { values: changed, valuesTruncated: true };
        changed.push(valueDiff(name, leaf.pointer, a, b));
      } else if (unchanged.length + changed.length < MAXIMUM_VALUES) {
        unchanged.push(valueDiff(name, leaf.pointer, a, b));
      }
    }
  }
  return {
    values: [...changed, ...unchanged.slice(0, MAXIMUM_VALUES - changed.length)],
    valuesTruncated: false,
  };
}

function codeChanged(from: ComputeResultRevision["script"], to: ComputeResultRevision["script"]) {
  if (from.kind !== "notebook" || to.kind !== "notebook") return from.sha256 !== to.sha256;
  if (from.notebookDigestVersion !== to.notebookDigestVersion) return null;
  if (from.codeSha256 === undefined || to.codeSha256 === undefined) {
    return from.sha256 !== to.sha256 ? true : null;
  }
  if (from.codeSha256 !== to.codeSha256) return true;
  return from.notebookDigestVersion === undefined ? null : false;
}

export async function compareResultRevisions(
  reader: ResultsReader,
  from: ComputeResultRevision,
  to: ComputeResultRevision,
): Promise<ComputeResultsCompareResult> {
  const [fromSummary, toSummary, comparedValues] = await Promise.all([
    reader.summary(from),
    reader.summary(to),
    compareValues(reader, from, to),
  ]);
  const fromParameters = new Map(from.parameters?.map(({ name, value }) => [name, value]));
  const toParameters = new Map(to.parameters?.map(({ name, value }) => [name, value]));
  const fromInputs = new Map(
    [...from.inputs.files, ...observedDirectoryInputs(from), ...(from.inputs.globs ?? [])].map(
      (file) => [file.path, file],
    ),
  );
  const toInputs = new Map(
    [...to.inputs.files, ...observedDirectoryInputs(to), ...(to.inputs.globs ?? [])].map((file) => [
      file.path,
      file,
    ]),
  );
  const fromOutputs = new Map(from.outputs.map((file) => [file.name, file]));
  const toOutputs = new Map(to.outputs.map((file) => [file.name, file]));
  const fromLockfiles = from.environment !== undefined;
  const toLockfiles = to.environment !== undefined;
  const fromPackages = from.environment?.packages !== undefined;
  const toPackages = to.environment?.packages !== undefined;
  return {
    from: fromSummary,
    to: toSummary,
    codeChanged: codeChanged(from.script, to.script),
    parameters: keys(fromParameters, toParameters).map((name) => ({
      name,
      from: fromParameters.get(name) ?? null,
      to: toParameters.get(name) ?? null,
    })),
    inputs: keys(fromInputs, toInputs).map((path) =>
      inputChange(path, fromInputs.get(path), toInputs.get(path)),
    ),
    runtime: {
      from: fromSummary.runtime,
      to: toSummary.runtime,
      changed:
        from.runtime.fingerprint !== to.runtime.fingerprint ||
        from.runtime.executable !== to.runtime.executable ||
        from.runtime.version !== to.runtime.version,
    },
    environment: [
      ...(fromLockfiles && toLockfiles
        ? versionChanges("lockfile", lockfiles(from), lockfiles(to))
        : []),
      ...(fromPackages && toPackages
        ? versionChanges("package", packageVersions(from), packageVersions(to))
        : []),
    ],
    environmentEvidence: {
      fromLockfiles,
      toLockfiles,
      fromPackages,
      toPackages,
      packagesTruncated:
        from.environment?.packagesTruncated === true || to.environment?.packagesTruncated === true,
    },
    outputs: keys(fromOutputs, toOutputs).map((name) => {
      const before = fromOutputs.get(name);
      const after = toOutputs.get(name);
      return {
        name,
        kind: (after ?? before)!.kind,
        change: compare(
          before,
          after,
          (left, right) => left.sha256 === right.sha256 && left.kind === right.kind,
        ),
      };
    }),
    ...comparedValues,
  };
}
