// Compares a Windows install timing with a baseline; regressions warn, never fail. Usage:
// --measurement <file> --context <file> --out <file> [--baseline <file> [--committed-baseline]]
// [--rerun <file>] [--summary <file>]; or --check --measurement <file> [--baseline <file>], which
// only adds regressed= to $GITHUB_OUTPUT.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { SCHEMA_VERSION } from "./windows-install-timing-baseline.mjs";

/** A metric regresses only past both bounds: runner noise moves short launches by seconds. */
export const RELATIVE_TOLERANCE = 0.25;
export const METRICS = [
  { key: "installMs", label: "Install", floorMs: 5_000 },
  { key: "firstLaunchMs", label: "First launch to ready", floorMs: 1_500 },
  { key: "secondLaunchMs", label: "Second launch to ready", floorMs: 1_000 },
];

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function compare(current, baseline) {
  return METRICS.map(({ key, label, floorMs }) => {
    const value = current?.[key] ?? null;
    const base = baseline?.[key] ?? null;
    if (value === null) return { key, label, value, baseline: base, status: "not measured" };
    if (base === null) return { key, label, value, baseline: base, status: "no baseline" };
    const change = value - base;
    const beyond = Math.abs(change) > floorMs && Math.abs(change) > base * RELATIVE_TOLERANCE;
    const status = !beyond ? "within tolerance" : change > 0 ? "regressed" : "improved";
    return { key, label, value, baseline: base, changeMs: change, status };
  });
}

/** Why `rerun` cannot re-check a regression against `baseline`, or null when it can. */
export function rerunRejection(rerun, baseline) {
  if (!rerun) return "the baseline's installer could not be timed again";
  if (rerun.installer?.sha256 !== baseline?.measurement?.installer?.sha256)
    return "the installer timed again is not the baseline's";
  if (rerun.complete !== true || rerun.failures.length > 0)
    return "timing the baseline's installer again did not finish cleanly";
  return null;
}

/**
 * Runner speed alone moves a whole timing past the bounds, so a stage that regressed against the
 * baseline's record stays regressed only if it is also slower, past both bounds, than the
 * baseline's own installer timed on this runner (`rerunMedian`). Without one, it stands.
 */
export function recheck(comparison, current, rerunMedian) {
  const again = rerunMedian ? compare(current, rerunMedian) : null;
  return comparison.map((row, index) => {
    if (row.status !== "regressed" || !again || again[index].changeMs === undefined) return row;
    const confirmed = again[index].status === "regressed";
    return {
      ...row,
      rerunMs: again[index].baseline,
      status: confirmed ? "regressed" : "not confirmed",
    };
  });
}

const seconds = (ms) => (ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);
const signed = (ms) => `${ms > 0 ? "+" : ""}${(ms / 1000).toFixed(1)} s`;

function describeBaseline(baseline) {
  if (!baseline) return "none found";
  const { context = {} } = baseline;
  const name = context.version
    ? `\`${context.version}\`${context.channel ? ` (${context.channel})` : ""}`
    : "an earlier installer";
  const where = context.runUrl ? ` from [run ${context.runId}](${context.runUrl})` : "";
  return `${name}${where}${context.committed ? " (committed baseline)" : ""}`;
}

export function renderSummary(result) {
  const { context, measurement, comparison, baseline, recheck: rechecked } = result;
  const samples = (key) =>
    measurement.samples
      .map((sample) =>
        key === "installMs"
          ? sample.installMs
          : sample[key === "firstLaunchMs" ? "first" : "second"]?.readyMs,
      )
      .map(seconds)
      .join(", ");
  const regressions = comparison.filter((row) => row.status === "regressed");
  const outcome = (row) =>
    row.status === "regressed"
      ? rechecked?.rejection
        ? "⚠️ regressed (not re-checked)"
        : "⚠️ regressed (re-checked)"
      : row.status === "not confirmed"
        ? `not confirmed: the baseline's installer took ${seconds(row.rerunMs)} here`
        : row.status;
  const lines = [
    "## Windows install and launch timing",
    "",
    `- Installer: \`${measurement.installer.name}\` (${(measurement.installer.bytes / 1e6).toFixed(0)} MB), installs \`${measurement.installedVersion ?? "unknown"}\`; SHA-256 \`${measurement.installer.sha256.slice(0, 16)}…\``,
    `- Source: ${context.kind}${context.version ? ` \`${context.version}\`` : ""}${context.channel ? ` (${context.channel}${context.rehearsal ? " rehearsal" : ""})` : ""}, ${context.installer}`,
    `- Runner: ${measurement.runner.image ?? "unknown image"}, ${measurement.runner.logicalCpus} logical CPUs, Defender real-time scanning ${measurement.runner.defenderRealtime === null ? "unknown" : measurement.runner.defenderRealtime ? "on" : "off"}`,
    `- Ready means: ${measurement.readiness}`,
    `- Baseline: ${describeBaseline(baseline)}`,
    "",
    "| Stage | Median | Samples | Baseline | Change | Result |",
    "| ----- | ------ | ------- | -------- | ------ | ------ |",
    ...comparison.map(
      (row) =>
        `| ${row.label} | ${seconds(row.value)} | ${samples(row.key)} | ${seconds(row.baseline)} | ${row.changeMs === undefined ? "—" : signed(row.changeMs)} | ${outcome(row)} |`,
    ),
    "",
    `A stage regresses when its median is more than ${RELATIVE_TOLERANCE * 100}% and more than its floor (install 5 s, first launch 1.5 s, second launch 1 s) slower than the baseline, and also slower by both than the baseline's own installer timed again on the same runner. Regressions warn; they do not block the release.`,
  ];
  if (rechecked) {
    lines.push(
      "",
      rechecked.rejection
        ? `Re-check: ${rechecked.rejection}, so each regression stands unconfirmed.`
        : `Re-check: the baseline's installer, timed again on this runner after this one, took ${METRICS.map(({ key, label }) => `${label.toLowerCase()} ${seconds(rechecked.rerun.median[key])}`).join(", ")}.`,
    );
  }
  if (regressions.length > 0) {
    lines.push(
      "",
      `**${regressions.length} stage(s) regressed:** ${regressions.map((row) => row.label).join(", ")}.`,
    );
  }
  if (measurement.complete !== true) {
    lines.push(
      "",
      `**Incomplete:** ${measurement.samples.length} of ${measurement.plannedSamples ?? "the planned"} samples ran; this timing can never become a baseline.`,
    );
  }
  if (measurement.failures.length > 0) {
    lines.push(
      "",
      "**Failed stages:**",
      "",
      ...measurement.failures.map((failure) => `- ${failure}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function report({
  measurement,
  baseline,
  committedBaseline = false,
  context,
  rerun = null,
}) {
  let comparison = compare(measurement.median, baseline?.measurement?.median ?? null);
  let rechecked = null;
  if (comparison.some((row) => row.status === "regressed")) {
    const rejection = rerunRejection(rerun, baseline);
    comparison = recheck(comparison, measurement.median, rejection ? null : rerun.median);
    rechecked = {
      rejection,
      rerun: rerun && {
        installer: rerun.installer,
        runner: rerun.runner,
        median: rerun.median,
        complete: rerun.complete,
        failures: rerun.failures,
      },
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    context,
    measurement,
    baseline: baseline
      ? {
          context: { ...baseline.context, committed: committedBaseline },
          median: baseline.measurement.median,
        }
      : null,
    comparison,
    recheck: rechecked,
  };
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const { values } = NodeUtil.parseArgs({
    options: {
      check: { type: "boolean" },
      measurement: { type: "string" },
      baseline: { type: "string" },
      "committed-baseline": { type: "boolean" },
      rerun: { type: "string" },
      context: { type: "string" },
      out: { type: "string" },
      summary: { type: "string" },
    },
  });
  const read = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const optional = (file) => (file && NodeFS.existsSync(file) ? read(file) : null);
  if (values.check) {
    const regressed = compare(
      read(values.measurement).median,
      optional(values.baseline)?.measurement?.median ?? null,
    ).filter((row) => row.status === "regressed");
    console.log(
      `Regressed against the baseline's record: ${regressed.map((row) => row.label).join(", ") || "none"}`,
    );
    const output = `regressed=${regressed.length > 0}\n`;
    if (process.env.GITHUB_OUTPUT) NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
  } else {
    if (!values.measurement || !values.context || !values.out) {
      throw new Error(
        "usage: --measurement <file> --context <file> --out <file> [--baseline <file>] [--rerun <file>] [--summary <file>]",
      );
    }
    const result = report({
      measurement: read(values.measurement),
      baseline: optional(values.baseline),
      committedBaseline: values["committed-baseline"] === true,
      context: read(values.context),
      rerun: optional(values.rerun),
    });
    NodeFS.writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
    const summary = renderSummary(result);
    if (values.summary) NodeFS.appendFileSync(values.summary, summary);
    console.log(summary);
    for (const row of result.comparison.filter((row) => row.status === "regressed")) {
      const recheckNote = result.recheck.rejection
        ? `; not re-checked: ${result.recheck.rejection}`
        : `, and ${seconds(row.rerunMs)} for the baseline's installer on this runner`;
      console.log(
        `::warning title=Windows ${row.label.toLowerCase()} regressed::${seconds(row.value)} against ${seconds(row.baseline)} (${signed(row.changeMs)})${recheckNote}`,
      );
    }
  }
}
