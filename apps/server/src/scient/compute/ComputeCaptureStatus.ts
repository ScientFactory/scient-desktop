/** Closed, content-free observations. Warning text and file identities stay local. */
const COMPUTE_CAPTURE_REASONS = [
  "scan-timeout",
  "scan-entry-limit",
  "scan-depth-limit",
  "scan-unreadable",
  "watch-unavailable",
  "watch-overflow",
  "observation-unavailable",
  "output-limit",
  "image-limit",
  "unsafe-image",
  "invalid-image",
  "image-changed",
  "missing-resource",
  "resource-mismatch",
  "persistence-failed",
  "artifact-collection-failed",
] as const;
export type ComputeCaptureReason = (typeof COMPUTE_CAPTURE_REASONS)[number];

const CAPTURE_REASONS: ReadonlySet<string> = new Set(COMPUTE_CAPTURE_REASONS);
export const isComputeCaptureReason = (value: unknown): value is ComputeCaptureReason =>
  typeof value === "string" && CAPTURE_REASONS.has(value);

export interface ComputeProjectCaptureStatus {
  readonly coverage: "complete" | "partial" | "unavailable";
  readonly coverageReason?: ComputeCaptureReason;
  readonly rejectedCount: number;
  readonly rejectionReason?: ComputeCaptureReason;
}

export interface ComputeCaptureSummary {
  readonly captureSchemaVersion: 2;
  readonly captureSource: "interactive" | "run-file";
  readonly captureOutcome: "retained" | "partial" | "none" | "failed" | "unobserved";
  readonly captureCoverage: ComputeProjectCaptureStatus["coverage"];
  readonly captureReason: ComputeCaptureReason | "none";
  readonly retainedOutputCount: number;
  readonly rejectedOutputCount?: number;
}
