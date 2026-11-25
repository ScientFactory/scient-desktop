import type { ComputeResultParameter, NotebookAlternatives } from "@t3tools/contracts";
import {
  findMarkdownResultReferences,
  formatResultValueMarkdown,
} from "@t3tools/shared/computeResults";
import { parseNotebookOverride } from "@t3tools/shared/notebookParameters";

export function sweepValues(
  control: ReturnType<
    typeof import("@t3tools/shared/notebookParameters").notebookParameters
  >[number]["control"],
): ReadonlyArray<string> {
  if (control === undefined) return [];
  if ("options" in control) {
    const values = [...new Set(control.options.map((value) => JSON.stringify(value)))];
    return values.length > 1 && values.length <= 20 ? values : [];
  }
  const count = Math.floor((control.max - control.min) / control.step + 1e-9) + 1;
  return count > 1 && count <= 20
    ? Array.from({ length: count }, (_, offset) =>
        JSON.stringify(Number((control.min + offset * control.step).toPrecision(14))),
      )
    : [];
}

type Alternative = NotebookAlternatives["runs"][number];

export function parameterValues(parameters: ReadonlyArray<ComputeResultParameter>) {
  return Object.fromEntries(parameters.map(({ name, value }) => [name, value]));
}

function settingKey(parameters: Readonly<Record<string, string>>): string | null {
  const entries = [];
  for (const name of Object.keys(parameters).sort()) {
    const json = parameters[name];
    const value = json === undefined ? undefined : parseNotebookOverride(json);
    if (value === undefined) return null;
    entries.push([name, value]);
  }
  return JSON.stringify(entries);
}

export function readerBaseline(
  alternatives: ReadonlyArray<Alternative>,
  publishedRevision: string | null | undefined,
  sourceSha256: string | undefined,
): Alternative | undefined {
  return (
    alternatives.find((run) => run.revision === publishedRevision) ??
    alternatives.find((run) => savedSourceStatus(run, sourceSha256) === "current") ??
    alternatives.find((run) => run.notebookDigestVersion === undefined)
  );
}

function savedSourceStatus(run: Alternative, sourceSha256: string | undefined) {
  if (run.notebookDigestVersion === undefined || sourceSha256 === undefined) return "unconfirmed";
  return run.codeSha256 === sourceSha256 ? "current" : "earlier";
}

export function alternativeAt(
  alternatives: ReadonlyArray<Alternative>,
  baseline: Alternative | undefined,
  pending: Readonly<Record<string, string>>,
  sourceSha256: string | undefined,
  publishedRevision?: string | null,
): {
  readonly current: Alternative | null;
  readonly sourceStatus: ReturnType<typeof savedSourceStatus> | null;
} {
  if (baseline === undefined) return { current: null, sourceStatus: null };
  const setting = parameterValues(baseline.parameters);
  const key = settingKey({ ...setting, ...pending });
  if (key === null) return { current: null, sourceStatus: null };
  const sameSetting = key === settingKey(setting);
  const baselineStatus = savedSourceStatus(baseline, sourceSha256);
  if (sameSetting && baselineStatus === "current") {
    return { current: baseline, sourceStatus: "current" };
  }
  const browsingLegacySweep =
    publishedRevision == null && baseline.notebookDigestVersion === undefined;
  let legacyMatch: Alternative | undefined;
  let sourceStatus: ReturnType<typeof savedSourceStatus> | null = null;
  for (const run of alternatives) {
    if (settingKey(parameterValues(run.parameters)) !== key) continue;
    const status = savedSourceStatus(run, sourceSha256);
    if (status === "current") return { current: run, sourceStatus: status };
    if (browsingLegacySweep && run.notebookDigestVersion === undefined) legacyMatch ??= run;
    if (sourceStatus !== "earlier") sourceStatus = status;
  }
  if (sameSetting) return { current: baseline, sourceStatus: baselineStatus };
  if (legacyMatch !== undefined) return { current: legacyMatch, sourceStatus: "unconfirmed" };
  return { current: null, sourceStatus };
}

export function renderAlternativeProse(
  prose: string,
  revisions: ReadonlySet<string>,
  selected: Alternative | null,
  missing: string,
) {
  let result = prose;
  for (const reference of [...findMarkdownResultReferences(prose)].reverse()) {
    if (reference.kind !== "value" || !revisions.has(reference.revision)) continue;
    const value = selected?.values.find(
      (entry) => entry.output === reference.output && entry.pointer === reference.pointer,
    );
    const text =
      value === undefined || selected === null
        ? formatResultValueMarkdown(missing, reference)
        : formatResultValueMarkdown(value.value, { ...reference, revision: selected.revision });
    result = result.slice(0, reference.start) + text + result.slice(reference.end);
  }
  return result;
}
