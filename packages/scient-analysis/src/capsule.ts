import type { AnalysisRunSnapshot } from "./contract.ts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export const ANALYSIS_RUN_CAPSULE_VERSION = 1 as const;

export interface AnalysisRunCapsuleFile {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly contentHash: string;
}

export interface AnalysisRunCapsuleArtifactRepresentation extends AnalysisRunCapsuleFile {
  readonly representationId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly presentation: string;
  readonly requiresNetworkForFullExperience: boolean;
}

export interface AnalysisRunCapsuleManifest {
  readonly capsuleVersion: typeof ANALYSIS_RUN_CAPSULE_VERSION;
  readonly kind: "scient-analysis-run";
  readonly createdAt: string;
  readonly projectId: string;
  readonly run: {
    readonly runId: string;
    readonly status: AnalysisRunSnapshot["receipt"]["status"];
    readonly action: AnalysisRunSnapshot["action"];
    readonly source: {
      readonly relativePath: string;
      readonly revision: string;
    };
    readonly runtime: {
      readonly kind: string;
      readonly label: string;
      readonly version: string | null;
      readonly verification: null | {
        readonly status: NonNullable<AnalysisRunSnapshot["runtime"]["verification"]>["status"];
        readonly release: string | null;
        readonly version: string | null;
        readonly architecture: string | null;
        readonly javaAvailable: boolean | null;
        readonly javaVersion: string | null;
        readonly toolboxes: ReadonlyArray<{
          readonly name: string;
          readonly version: string | null;
        }>;
      };
    };
    readonly timing: {
      readonly startedAt: string;
      readonly finishedAt: string | null;
      readonly durationMs: number | null;
    };
    readonly process: {
      readonly exitCode: number | null;
      readonly cancellationRequested: boolean;
      readonly failureMessage: string | null;
    };
    readonly output: AnalysisRunCapsuleFile & {
      readonly truncated: boolean;
      readonly recordedByteLength: number;
      readonly recordedContentHash: string | null;
    };
    readonly diagnostics: AnalysisRunSnapshot["diagnostics"];
    readonly artifactReceipt: AnalysisRunSnapshot["artifactReceipt"];
    readonly artifacts: ReadonlyArray<{
      readonly artifactId: string;
      readonly kind: string;
      readonly label: string;
      readonly createdAt: string;
      readonly representations: ReadonlyArray<AnalysisRunCapsuleArtifactRepresentation>;
    }>;
  };
}

function safePathSegment(input: string, fallback: string): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 80);
  return normalized.length > 0 ? normalized : fallback;
}

function fileStem(relativePath: string): string {
  const fileName = relativePath.replaceAll("\\", "/").split("/").at(-1) ?? relativePath;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function portableTimestamp(startedAt: string): string {
  return Option.match(DateTime.make(startedAt), {
    onNone: () => "unknown-time",
    onSome: (value) =>
      DateTime.formatIso(value)
        .replace(/[-:]/gu, "")
        .replace(/\.\d{3}Z$/u, "Z"),
  });
}

export function analysisRunCapsuleDirectory(run: AnalysisRunSnapshot): string {
  const source = safePathSegment(fileStem(run.source.relativePath), "analysis");
  const runId = safePathSegment(run.receipt.runId, "run").slice(0, 12);
  return `results/${source}/${portableTimestamp(run.receipt.startedAt)}-${runId}`;
}

export function analysisRunOutputText(run: AnalysisRunSnapshot): string {
  return [...run.receipt.output]
    .toSorted((left, right) => left.sequence - right.sequence)
    .map((chunk) => chunk.text)
    .join("");
}

function durationMs(run: AnalysisRunSnapshot): number | null {
  const finishedAtValue = run.receipt.finishedAt;
  if (finishedAtValue === null) return null;
  return Option.flatMap(DateTime.make(run.receipt.startedAt), (startedAt) =>
    Option.map(DateTime.make(finishedAtValue), (finishedAt) =>
      Math.max(0, DateTime.toEpochMillis(finishedAt) - DateTime.toEpochMillis(startedAt)),
    ),
  ).pipe(Option.getOrNull);
}

function redactMachinePaths(message: string, run: AnalysisRunSnapshot): string {
  const machinePaths = [
    run.source.cwd,
    run.runtime.executablePath,
    run.runtime.verification?.installationRoot ?? null,
  ].filter((value): value is string => value !== null && value.length > 0);
  return machinePaths.reduce(
    (redacted, machinePath) => redacted.replaceAll(machinePath, "<local-path>"),
    message,
  );
}

function portableDiagnosticPath(relativePath: string | null): string | null {
  if (relativePath === null) return null;
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized) ? null : normalized;
}

function portableDiagnosticFrame(
  frame: AnalysisRunSnapshot["diagnostics"][number]["frames"][number],
) {
  return { ...frame, relativePath: portableDiagnosticPath(frame.relativePath) };
}

export function buildAnalysisRunCapsuleManifest(input: {
  readonly run: AnalysisRunSnapshot;
  readonly createdAt: string;
  readonly output: AnalysisRunCapsuleFile;
  readonly representations: ReadonlyMap<string, AnalysisRunCapsuleArtifactRepresentation>;
}): AnalysisRunCapsuleManifest {
  const { run } = input;
  const verification = run.runtime.verification;
  return {
    capsuleVersion: ANALYSIS_RUN_CAPSULE_VERSION,
    kind: "scient-analysis-run",
    createdAt: input.createdAt,
    projectId: run.projectId,
    run: {
      runId: run.receipt.runId,
      status: run.receipt.status,
      action: run.action,
      source: {
        relativePath: run.source.relativePath,
        revision: run.source.revision,
      },
      runtime: {
        kind: run.runtime.kind,
        label: run.runtime.label,
        version: run.runtime.version,
        verification:
          verification === null
            ? null
            : {
                status: verification.status,
                release: verification.release,
                version: verification.version,
                architecture: verification.architecture,
                javaAvailable: verification.javaAvailable,
                javaVersion: verification.javaVersion,
                toolboxes: verification.toolboxes.map(({ name, version }) => ({ name, version })),
              },
      },
      timing: {
        startedAt: run.receipt.startedAt,
        finishedAt: run.receipt.finishedAt,
        durationMs: durationMs(run),
      },
      process: {
        exitCode: run.receipt.exitCode,
        cancellationRequested: run.receipt.cancellationRequested,
        failureMessage:
          run.receipt.failureMessage === null
            ? null
            : redactMachinePaths(run.receipt.failureMessage, run),
      },
      output: {
        ...input.output,
        truncated: run.receipt.outputTruncated,
        recordedByteLength: run.receipt.outputByteLength,
        recordedContentHash: run.receipt.outputContentHash,
      },
      diagnostics: run.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: redactMachinePaths(diagnostic.message, run),
        relativePath: portableDiagnosticPath(diagnostic.relativePath),
        frames: diagnostic.frames.map(portableDiagnosticFrame),
        related: diagnostic.related.map((related) => ({
          ...related,
          message: redactMachinePaths(related.message, run),
          frames: related.frames.map(portableDiagnosticFrame),
        })),
      })),
      artifactReceipt: run.artifactReceipt,
      artifacts: run.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        label: artifact.label,
        createdAt: artifact.createdAt,
        representations: artifact.representations.map((representation) => {
          const promoted = input.representations.get(
            `${artifact.artifactId}:${representation.representationId}`,
          );
          if (promoted === undefined) {
            throw new Error(
              `Missing promoted representation ${artifact.artifactId}/${representation.representationId}`,
            );
          }
          return promoted;
        }),
      })),
    },
  };
}

function escapeMarkdownText(input: string): string {
  return input
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replace(/[_*`]/gu, "\\$&");
}

function markdownCode(input: string): string {
  return input.replaceAll("`", "\\`");
}

function markdownPath(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function renderAnalysisRunCapsuleReadme(manifest: AnalysisRunCapsuleManifest): string {
  const { run } = manifest;
  const lines = [
    `# ${escapeMarkdownText(run.runtime.label)} analysis result`,
    "",
    `- **Status:** ${run.status}`,
    `- **Source:** \`${markdownCode(run.source.relativePath)}\``,
    `- **Source revision:** \`${markdownCode(run.source.revision)}\``,
    `- **Runtime:** ${escapeMarkdownText(run.runtime.label)}${run.runtime.version ? ` ${escapeMarkdownText(run.runtime.version)}` : ""}`,
    `- **Started:** ${run.timing.startedAt}`,
    `- **Finished:** ${run.timing.finishedAt ?? "Not recorded"}`,
    `- **Run ID:** \`${markdownCode(run.runId)}\``,
    "",
    "## Output",
    "",
    `[Open the captured output](${markdownPath(run.output.relativePath)})${
      run.output.truncated ? " — **the captured output was truncated by the run limit**" : ""
    }.`,
  ];

  if (run.artifacts.length > 0) {
    lines.push("", "## Artifacts", "");
    for (const artifact of run.artifacts) {
      lines.push(`### ${escapeMarkdownText(artifact.label)}`, "");
      const staticImage = artifact.representations.find(
        (representation) =>
          representation.presentation === "static" &&
          ["image/png", "image/svg+xml"].includes(representation.mediaType),
      );
      if (staticImage) {
        lines.push(
          `![${escapeMarkdownText(artifact.label)}](${markdownPath(staticImage.relativePath)})`,
          "",
        );
      }
      for (const representation of artifact.representations) {
        lines.push(
          `- [${escapeMarkdownText(representation.fileName)}](${markdownPath(representation.relativePath)}) — ${representation.presentation}, ${representation.mediaType}`,
        );
      }
      lines.push("");
    }
  }

  if (run.diagnostics.length > 0 || run.process.failureMessage !== null) {
    lines.push("## Diagnostics", "");
    if (run.process.failureMessage !== null) {
      lines.push(`- ${escapeMarkdownText(run.process.failureMessage)}`);
    }
    for (const diagnostic of run.diagnostics) {
      lines.push(`- ${escapeMarkdownText(diagnostic.message)}`);
    }
    lines.push("");
  }

  lines.push(
    "## Notes and interpretation",
    "",
    "Add the experimental context, interpretation, and follow-up decisions here.",
    "",
    "---",
    "",
    "This folder is a portable snapshot created by Scient. `manifest.json` contains the machine-readable receipt and SHA-256 hashes.",
    "",
  );
  return lines.join("\n");
}
