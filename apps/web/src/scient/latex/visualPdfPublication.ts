import type { ScientLatexBuildSnapshot } from "@t3tools/contracts";
import { useEffect, useState } from "react";

export interface LatexSourceIdentity {
  readonly source: string;
  readonly revision: string;
}

/**
 * Hash the exact editor buffer without blocking input. The source travels with
 * the digest so an asynchronous result can never authorize newer text.
 */
export function useLatexSourceIdentity(source: string, enabled = true): LatexSourceIdentity | null {
  const [identity, setIdentity] = useState<LatexSourceIdentity | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!globalThis.crypto?.subtle) return;
    let current = true;
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(source))
      .then((bytes) => {
        if (!current) return;
        setIdentity({
          source,
          revision: `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        });
      })
      .catch(() => {
        if (current) setIdentity(null);
      });
    return () => {
      current = false;
    };
  }, [enabled, source]);

  return enabled && identity?.source === source ? identity : null;
}

/**
 * Visual may publish only a PDF whose revision manifest proves it was built
 * from the exact current source. Editing is an additional hard hold: even an
 * exact candidate cannot replace the page under a live overlay.
 */
export function canPublishVisualPdf(input: {
  readonly candidateRevisionId: string | null;
  readonly editing: boolean;
  readonly relativePath: string;
  readonly snapshot: ScientLatexBuildSnapshot | null;
  readonly source: string;
  readonly sourceIdentity: LatexSourceIdentity | null;
  readonly truncated: boolean;
}): boolean {
  const descriptor = input.snapshot?.descriptor;
  if (
    input.editing ||
    input.truncated ||
    input.snapshot?.state !== "succeeded" ||
    input.snapshot.pendingRerun ||
    descriptor?._tag !== "generated-pdf" ||
    descriptor.bindingStatus !== "current" ||
    descriptor.revisionId !== input.candidateRevisionId ||
    input.sourceIdentity?.source !== input.source
  ) {
    return false;
  }
  const compiledSourceRevision = input.snapshot.visualSourceRevisions?.[input.relativePath];
  return (
    compiledSourceRevision !== undefined && compiledSourceRevision === input.sourceIdentity.revision
  );
}
