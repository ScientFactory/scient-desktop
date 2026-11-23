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

export function alternativeAt(
  alternatives: ReadonlyArray<Alternative>,
  published: Alternative | undefined,
  pending: Readonly<Record<string, string>>,
): { readonly current: Alternative | null; readonly earlier: boolean } {
  if (published === undefined) return { current: null, earlier: false };
  const setting = parameterValues(published.parameters);
  const key = settingKey({ ...setting, ...pending });
  if (key === null) return { current: null, earlier: false };
  if (key === settingKey(setting)) return { current: published, earlier: false };
  let earlier = false;
  for (const run of alternatives) {
    if (settingKey(parameterValues(run.parameters)) !== key) continue;
    if (published.codeSha256 !== undefined && run.codeSha256 === published.codeSha256) {
      return { current: run, earlier: false };
    }
    earlier = true;
  }
  return { current: null, earlier };
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
