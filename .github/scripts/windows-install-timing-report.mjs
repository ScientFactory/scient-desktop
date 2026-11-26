// Compares a Windows install timing (windows-install-timing.mjs) with a baseline. Advisory:
// regressions print warnings and a summary, never a failing exit code. Usage: --measurement
// <file> --context <json> --out <file> [--baseline <file> [--committed-baseline]] [--summary <file>]
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

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

const seconds = (ms) => (ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);
const signed = (ms) => `${ms > 0 ? "+" : ""}${(ms / 1000).toFixed(1)} s`;

function describeBaseline(baseline) {
  if (!baseline) return "none found";
  const { context = {} } = baseline;
  const name = context.version ? `\`${context.version}\`` : "an earlier installer";
  const where = context.runUrl ? ` from [run ${context.runId}](${context.runUrl})` : "";
  return `${name}${where}${context.committed ? " (committed baseline)" : ""}`;
}

export function renderSummary(result) {
  const { context, measurement, comparison, baseline } = result;
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
  const lines = [
    "## Windows install and launch timing",
    "",
    `- Installer: \`${measurement.installer.name}\` (${(measurement.installer.bytes / 1e6).toFixed(0)} MB), installs \`${measurement.installedVersion ?? "unknown"}\`; SHA-256 \`${measurement.installer.sha256.slice(0, 16)}…\``,
    `- Source: ${context.kind}${context.version ? ` \`${context.version}\`` : ""}${context.channel ? ` (${context.channel}${context.rehearsal ? " rehearsal" : ""})` : ""}`,
    `- Runner: ${measurement.runner.image ?? "unknown image"}, ${measurement.runner.logicalCpus} logical CPUs, Defender real-time scanning ${measurement.runner.defenderRealtime === null ? "unknown" : measurement.runner.defenderRealtime ? "on" : "off"}`,
    `- Ready means: ${measurement.readiness}`,
    `- Baseline: ${describeBaseline(baseline)}`,
    "",
    "| Stage | Median | Samples | Baseline | Change | Result |",
    "| ----- | ------ | ------- | -------- | ------ | ------ |",
    ...comparison.map(
      (row) =>
        `| ${row.label} | ${seconds(row.value)} | ${samples(row.key)} | ${seconds(row.baseline)} | ${row.changeMs === undefined ? "—" : signed(row.changeMs)} | ${row.status === "regressed" ? "⚠️ regressed" : row.status} |`,
    ),
    "",
    `A stage regresses when its median is more than ${RELATIVE_TOLERANCE * 100}% and more than its floor (install 5 s, first launch 1.5 s, second launch 1 s) slower than the baseline. Regressions warn; they do not block the release.`,
  ];
  if (regressions.length > 0) {
    lines.push(
      "",
      `**${regressions.length} stage(s) regressed:** ${regressions.map((row) => row.label).join(", ")}.`,
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

export function report({ measurement, baseline, committedBaseline = false, context }) {
  const comparison = compare(measurement.median, baseline?.measurement?.median ?? null);
  return {
    schemaVersion: 1,
    context,
    measurement,
    baseline: baseline
      ? {
          context: { ...baseline.context, committed: committedBaseline },
          median: baseline.measurement.median,
        }
      : null,
    comparison,
  };
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const { values } = NodeUtil.parseArgs({
    options: {
      measurement: { type: "string" },
      baseline: { type: "string" },
      "committed-baseline": { type: "boolean" },
      context: { type: "string" },
      out: { type: "string" },
      summary: { type: "string" },
    },
  });
  if (!values.measurement || !values.context || !values.out) {
    throw new Error(
      "usage: --measurement <file> --context <json> --out <file> [--baseline <file>] [--summary <file>]",
    );
  }
  const read = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const baseline =
    values.baseline && NodeFS.existsSync(values.baseline) ? read(values.baseline) : null;
  const result = report({
    measurement: read(values.measurement),
    baseline,
    committedBaseline: values["committed-baseline"] === true,
    context: JSON.parse(values.context),
  });
  NodeFS.writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
  const summary = renderSummary(result);
  if (values.summary) NodeFS.appendFileSync(values.summary, summary);
  console.log(summary);
  for (const row of result.comparison.filter((row) => row.status === "regressed")) {
    console.log(
      `::warning title=Windows ${row.label.toLowerCase()} regressed::${seconds(row.value)} against ${seconds(row.baseline)} (${signed(row.changeMs)})`,
    );
  }
}
