import type { ProjectFileErrorReason, ProjectFileFailure } from "@t3tools/contracts";

import { FileSurfaceFailure } from "~/components/files/fileSurfaceChrome";
import { Button } from "~/components/ui/button";

import { fileReadFailureCopy, isOutsideProjectFailure } from "./fileFailureCopy";

/**
 * The files panel body for a read that failed: plain copy, and only the
 * actions that can help. A missing file names the location that was tried and
 * offers the workspace files it may have meant as explicit choices; the panel
 * never picks one itself.
 */
export function FileReadFailure(props: {
  readonly failure: ProjectFileFailure | null;
  readonly reason?: ProjectFileErrorReason | null;
  /** The system's own error code and the host's operating system, for a denied read. */
  readonly osErrorCode?: string | null;
  readonly hostOs?: string | null;
  readonly message: string | null;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  /** The location that was tried, shown when nothing exists there. */
  readonly path?: string;
  /** Workspace files the missing path may have meant. */
  readonly candidates?: ReadonlyArray<string>;
  /** The workspace could not be searched completely, so there may be other candidates. */
  readonly candidatesIncomplete?: boolean;
  readonly onOpenCandidate?: (path: string) => void;
  /** Opens the absolute path read-only, for servers that refused it as outside the project. */
  readonly onOpenReadOnly?: () => void;
}) {
  const notFound = props.reason === "not_found";
  const openCandidate = props.onOpenCandidate;
  const candidates = notFound && openCandidate ? (props.candidates ?? []) : [];
  const copy = fileReadFailureCopy({
    failure: props.failure,
    reason: props.reason ?? null,
    osErrorCode: props.osErrorCode ?? null,
    hostOs: props.hostOs ?? null,
    message: props.message,
    candidateCount: candidates.length,
  });
  const description =
    notFound && props.path ? (
      <>
        {copy.description}
        <span className="mt-1.5 block font-mono break-all text-muted-foreground/80 select-text">
          {props.path}
        </span>
        {candidates.length > 0 ? (
          <span className="mt-2 block">
            {candidates.length === 1
              ? "One file in this project has the same name:"
              : "These files in this project have the same name:"}
          </span>
        ) : null}
        {props.candidatesIncomplete ? (
          <span className="mt-2 block">
            Scient couldn't search the whole project, so there may be others.
          </span>
        ) : null}
      </>
    ) : (
      copy.description
    );
  return (
    <FileSurfaceFailure
      title={copy.title}
      description={description}
      details={copy.details}
      {...(copy.retryable ? { onRetry: props.onRetry, retrying: props.retrying } : {})}
    >
      {openCandidate
        ? candidates.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              size="xs"
              variant="outline"
              className="max-w-full"
              title={candidate}
              onClick={() => openCandidate(candidate)}
            >
              <span className="truncate">{candidate}</span>
            </Button>
          ))
        : null}
      {isOutsideProjectFailure(props.failure) && props.onOpenReadOnly ? (
        <Button type="button" size="xs" variant="outline" onClick={props.onOpenReadOnly}>
          Open read-only
        </Button>
      ) : null}
    </FileSurfaceFailure>
  );
}
