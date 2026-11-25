import type { ComputeResultSummary } from "@t3tools/contracts";
import { resultInputCoverageIncomplete } from "@t3tools/shared/computeResults";
import { useGT } from "gt-react";

export function ResultRunEvidence({ summary }: { readonly summary: ComputeResultSummary }) {
  const gt = useGT();
  const list = new Intl.ListFormat(undefined, { style: "short", type: "unit" });
  const pathsLabel = (paths: ReadonlyArray<string>) =>
    paths.length <= 3
      ? list.format(paths)
      : gt("{paths} +{count} more", {
          paths: list.format(paths.slice(0, 3)),
          count: paths.length - 3,
        });
  const paths = [
    ...new Set([
      ...(summary.declaredInputs ?? []),
      ...summary.inputs.filter(
        (path) => !/(^|[\\/])(?:site-packages|dist-packages|__pycache__)(?:[\\/]|$)/.test(path),
      ),
      ...(summary.observedDirectories ?? []).map((path) => `${path}/`),
    ]),
  ];
  const outside = summary.outsideDataPaths ?? [];
  const unchecked = [
    outside.length === 0
      ? null
      : gt("Read {paths} outside the project.", { paths: pathsLabel(outside) }),
    summary.unresolvedViewInputCount ? gt("Some saved view inputs could not be checked.") : null,
    summary.inputTracking === "not-tracked"
      ? gt("This runtime does not track file reads. Declare any other inputs.")
      : summary.inputsTruncated
        ? gt(
            "Some file reads could not be recorded. Declare files read by native readers such as DuckDB, PyArrow or Polars.",
          )
        : null,
  ].filter((reason) => reason !== null);
  if (unchecked.length === 0 && resultInputCoverageIncomplete(summary))
    unchecked.push(gt("Some saved view inputs could not be checked."));

  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <p className="wrap-anywhere">
        {paths.length === 0
          ? gt("No project inputs were checked.")
          : gt(
              "{count, plural, one {Checked # input: {paths}} other {Checked # inputs: {paths}}}",
              {
                count: paths.length,
                paths: pathsLabel(paths),
              },
            )}
      </p>
      {unchecked.length > 0 ? <p className="wrap-anywhere">{unchecked.join(" ")}</p> : null}
      {(summary.parameters ?? []).map(({ name, value }) => (
        <bdi key={name} className="font-mono wrap-anywhere">
          {name} = {value}
        </bdi>
      ))}
      <span>{[summary.language, summary.runtime.version].filter(Boolean).join(" ")}</span>
    </div>
  );
}
