import type { ProjectFileErrorReason, ProjectFileFailure } from "@t3tools/contracts";

import { FileSurfaceFailure } from "~/components/files/fileSurfaceChrome";
import { Button } from "~/components/ui/button";

import { fileReadFailureCopy, isOutsideProjectFailure } from "./fileFailureCopy";

/**
 * The files panel body for a read that failed: plain copy, and only the
 * actions that can help. A missing file names the location that was tried and
 * offers same-named project files as explicit choices, never an automatic pick.
 */
export function FileReadFailure(props: {
  readonly failure: ProjectFileFailure | null;
  readonly reason?: ProjectFileErrorReason | null;
  readonly message: string | null;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  /** The location that was tried, shown when nothing exists there. */
  readonly path?: string;
  /** Same-named files elsewhere in the project, when the file was not found. */
  readonly candidates?: ReadonlyArray<string>;
  readonly onOpenCandidate?: (path: string) => void;
  /** Opens the absolute path read-only, for servers that refused it as outside the project. */
  readonly onOpenReadOnly?: () => void;
  /** Opens the system privacy settings, when access was denied on this machine. */
  readonly onOpenPrivacySettings?: () => void;
}) {
  const copy = fileReadFailureCopy({
    failure: props.failure,
    reason: props.reason ?? null,
    message: props.message,
  });
  const notFound = props.reason === "not_found";
  const candidates = notFound && props.onOpenCandidate ? (props.candidates ?? []) : [];
  const openCandidate = props.onOpenCandidate;
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
              ? "A file with the same name exists in this project:"
              : "Files with the same name exist in this project:"}
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
      {props.reason === "permission_denied" && props.onOpenPrivacySettings ? (
        <Button type="button" size="xs" variant="outline" onClick={props.onOpenPrivacySettings}>
          Open Privacy Settings
        </Button>
      ) : null}
    </FileSurfaceFailure>
  );
}
