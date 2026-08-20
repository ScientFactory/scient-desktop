import { lazy, Suspense } from "react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { AnalysisRunFilePanel } from "~/scient/analysis/AnalysisRunFilePanel";
import { SCIENT_UX_LAB_ENABLED } from "~/scient/uxLab/state";

/*
 * The Python compute strip is a UX Lab design proposition, not shipped
 * behaviour: Phase 4 has no compute client yet. It is gated on the lab flag and
 * imported lazily so a normal build never loads the chunk.
 */
const ScientComputeEditorLabDock = lazy(() =>
  import("~/scient/uxLab/ScientComputeEditorLabDock").then((module) => ({
    default: module.ScientComputeEditorLabDock,
  })),
);

interface ScientFileAuxiliarySurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string | null;
  readonly sourceRevision: string | null;
  readonly sourcePending: boolean;
  readonly truncated: boolean;
}

/**
 * Stable Scient-owned extension point beneath the inherited source viewer.
 * Format-specific surfaces belong here so upstream viewer updates stay isolated.
 */
export function ScientFileAuxiliarySurface(props: ScientFileAuxiliarySurfaceProps) {
  if (props.relativePath === null || props.sourceRevision === null || props.truncated) {
    return null;
  }

  const path = props.relativePath.toLowerCase();

  if (path.endsWith(".py")) {
    return SCIENT_UX_LAB_ENABLED ? (
      <Suspense fallback={null}>
        <ScientComputeEditorLabDock />
      </Suspense>
    ) : null;
  }

  if (!path.endsWith(".m")) {
    return null;
  }

  return (
    <AnalysisRunFilePanel
      key={`${props.environmentId}:${props.cwd}:${props.relativePath}`}
      environmentId={props.environmentId}
      threadRef={props.threadRef}
      cwd={props.cwd}
      relativePath={props.relativePath}
      sourceRevision={props.sourceRevision}
      sourcePending={props.sourcePending}
      runtimeKind="matlab"
      runtimeLabel="MATLAB"
    />
  );
}
