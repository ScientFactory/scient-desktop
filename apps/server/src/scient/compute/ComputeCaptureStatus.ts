/** Closed, content-free observations. Warning text and file identities stay local. */
export type ComputeCaptureReason =
  | "scan-timeout"
  | "scan-entry-limit"
  | "scan-depth-limit"
  | "scan-unreadable"
  | "observation-unavailable"
  | "output-limit"
  | "image-limit"
  | "unsafe-image"
  | "invalid-image"
  | "image-changed"
  | "missing-resource"
  | "resource-mismatch"
  | "persistence-failed"
  | "artifact-collection-failed";

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
