import type { ProjectFileFailure } from "@t3tools/contracts";

import { FileSurfaceFailure } from "~/components/files/fileSurfaceChrome";

import { fileReadFailureCopy } from "./fileFailureCopy";

/** The files panel body for a read that failed: plain copy, Try again only when it can help. */
export function FileReadFailure(props: {
  readonly failure: ProjectFileFailure | null;
  readonly message: string | null;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  const copy = fileReadFailureCopy({ failure: props.failure, message: props.message });
  return (
    <FileSurfaceFailure
      title={copy.title}
      description={copy.description}
      details={copy.details}
      {...(copy.retryable ? { onRetry: props.onRetry, retrying: props.retrying } : {})}
    />
  );
}
