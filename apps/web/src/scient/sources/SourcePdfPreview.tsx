import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense, useMemo } from "react";

import { workspacePdfSource } from "../pdf/pdfSource";

const ScientPdfReader = lazy(() =>
  import("../pdf/ScientPdfReader").then((module) => ({ default: module.ScientPdfReader })),
);

export function SourcePdfPreview(props: {
  readonly absolutePath: string;
  readonly environmentId: EnvironmentId;
  readonly fileName: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const source = useMemo(
    () =>
      workspacePdfSource({
        absolutePath: props.absolutePath,
        environmentId: props.environmentId,
        fileName: props.fileName,
        threadId: props.threadRef.threadId,
      }),
    [props.absolutePath, props.environmentId, props.fileName, props.threadRef.threadId],
  );
  return (
    <Suspense fallback={null}>
      <ScientPdfReader source={source} />
    </Suspense>
  );
}
