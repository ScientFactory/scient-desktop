import type { EnvironmentId, ProjectReadFileResult } from "@t3tools/contracts";
import type { DocumentPersistenceCurrentReview } from "@scientfactory/scient-document";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { FilePenLine } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import type {
  DocumentRenameIntent,
  MetadataFileRenameIntent,
  MarkdownDraftCheckpointStore,
} from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";
import type { GenericFileRenameJournal } from "./useFileSaveCoordinator";
import {
  documentCurrentMissingReview,
  documentPublicationOutcome,
} from "~/scient/markdownEditor/persistence/documentFailureReason";

import {
  retainedAttentionCopy,
  retainedFileEvidence,
  type RetainedFileAttention,
} from "~/scient/fileSurfaces/ScientFileFreshnessControls";
import {
  RECOVERY_COPY_UNSETTLED,
  renameOutcomeAttention,
  type RenameOpenDocumentResult,
  renameMetadataFile,
  readMetadataRenameIntent,
  settleMetadataRenameIntent,
} from "~/scient/markdownEditor/persistence/renameOpenDocument";

type CurrentReview =
  | (ProjectReadFileResult & { readonly missing?: false })
  | (Extract<DocumentPersistenceCurrentReview, { readonly missing: true }> & {
      readonly contents?: never;
    });

function renameFailureMessage(cause: unknown): string {
  const failure = failureCode(cause);
  return failure === "path_exists"
    ? "A file already exists at that path."
    : failure === "revision_conflict"
      ? "The file changed before it could be renamed. Reload it and try again."
      : cause instanceof Error
        ? cause.message
        : "Unable to rename the file.";
}

function failureCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("failure" in cause)) return null;
  return typeof cause.failure === "string" ? cause.failure : null;
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/**
 * A typed destination as a workspace-relative path, or null when it is not
 * one. A name typed without an extension keeps the file's own. Spaces around
 * the typed text are dropped, as in every path field here: a name that truly
 * begins or ends with a space is rare, a stray one common.
 */
export function normalizeRenamePath(input: string, original: string): string | null {
  let path = input.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  const name = segments[segments.length - 1]!;
  // Windows cannot store a name that ends in a dot.
  if (name.endsWith(".")) return null;
  // A dotfile such as `.env` is a whole name, not an extension to add to.
  if (extension(path) === "" && !name.startsWith(".")) path += extension(original);
  return path.length <= 512 ? path : null;
}

interface FileRenameButtonProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  /**
   * The revision the editor last read, checked by the server before renaming.
   * Null for a file the app cannot read whole (binary or truncated).
   */
  readonly revision: string | null;
  readonly disabled: boolean;
  /** Acquires the file's short clean-state barrier before dispatching the rename. */
  readonly beforeRename?: () => (() => void) | null;
  /** Narrows the destinations a file type accepts; the default keeps any path. */
  readonly normalize?: (input: string) => string | null;
  /** What to enter, when the default message does not fit the file type. */
  readonly invalidMessage?: string;
  /** A note under the field, for example what else refers to this file. */
  readonly notice?: ReactNode;
  readonly renameJournal?: GenericFileRenameJournal;
  readonly pendingRename?: DocumentRenameIntent | null;
  readonly metadataOnly?: boolean;
  readonly metadataStore?: MarkdownDraftCheckpointStore;
  readonly label: string;
  readonly onRenamed: (destinationRelativePath: string, revision: string) => void;
  readonly onOpenFile?: (path: string) => void;
  readonly onMutationFailure?: (cause: unknown, mutationId: string) => void;
  readonly resolveAttention?: (
    recoveryId: string,
    currentRevision: string | null,
  ) => Promise<boolean>;
  readonly acknowledgeRefusal?: (currentRevision: string | null) => Promise<boolean>;
  /** An owned document never falls back to an unjournaled ordinary rename. */
  readonly moveInPlace?: (destinationRelativePath: string) => Promise<RenameOpenDocumentResult>;
}

/** The open file's name, which renames the file when clicked. */
export function FileRenameButton(props: FileRenameButtonProps) {
  const renameFile = useAtomCommand(projectEnvironment.renameFile, { reportFailure: false });
  const readFile = useAtomCommand(projectEnvironment.readFileOrdered, { reportFailure: false });
  const resolveMutation = useAtomCommand(projectEnvironment.resolveFileMutation, {
    reportFailure: false,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(props.relativePath);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attention, setAttention] = useState<{
    kind: RetainedFileAttention;
    cause: unknown;
    destination: string;
  } | null>(null);
  const [review, setReview] = useState<CurrentReview | null>(null);
  const request = {
    environmentId: props.environmentId,
    input: { cwd: props.cwd, relativePath: props.relativePath },
  };
  const [metadataIntent, setMetadataIntent] = useState<MetadataFileRenameIntent | null>(null);
  const [metadataReady, setMetadataReady] = useState(false);
  const metadataOwner = useRef<object | null>(null);
  useLayoutEffect(() => {
    const owner = {};
    metadataOwner.current = owner;
    return () => {
      if (metadataOwner.current === owner) metadataOwner.current = null;
    };
  }, [props.environmentId, props.cwd, props.relativePath, props.disabled]);
  useEffect(() => {
    setMetadataReady(false);
    if (!props.metadataOnly) return;
    const owner = metadataOwner.current;
    void readMetadataRenameIntent(
      {
        environmentId: props.environmentId,
        cwd: props.cwd,
        relativePath: props.relativePath,
      },
      props.metadataStore,
    ).then(
      (intent) => {
        if (metadataOwner.current !== owner) return;
        setMetadataIntent(intent);
        setMetadataReady(true);
      },
      (cause: unknown) => {
        if (metadataOwner.current === owner) setError(renameFailureMessage(cause));
      },
    );
  }, [
    props.metadataOnly,
    props.metadataStore,
    props.environmentId,
    props.cwd,
    props.relativePath,
    props.disabled,
  ]);
  const pendingRename = props.metadataOnly
    ? metadataIntent
    : (props.pendingRename ?? props.renameJournal?.pendingRename ?? null);
  const reviewCurrent = async () => {
    setSubmitting(true);
    try {
      const result = await readFile(request);
      const current =
        result._tag === "Failure"
          ? documentCurrentMissingReview(result.cause, request.input)
          : result.value;
      if (!current || current.truncated || current.readOnly) {
        setError(
          "The current source path could not be reviewed completely. Open the actual source, destination, and retained versions read-only.",
        );
        return;
      }
      setReview(current);
    } catch {
      setError("The current source path could not be read. No recovery choice was accepted.");
    } finally {
      setSubmitting(false);
    }
  };
  const acceptReview = async () => {
    if (!review || !attention) return;
    setSubmitting(true);
    try {
      const read = await readFile(request);
      const current =
        read._tag === "Failure"
          ? documentCurrentMissingReview(read.cause, request.input)
          : read.value;
      if (
        !current ||
        current.truncated ||
        current.readOnly ||
        current.revision !== review.revision
      ) {
        setError("The reviewed source path changed. Review it again before accepting.");
        return;
      }
      const evidence = current.publicationAttention ?? retainedFileEvidence(attention.cause);
      let accepted = false;
      if (evidence.recoveryId !== null) {
        if (props.resolveAttention && !props.metadataOnly)
          accepted = await props.resolveAttention(evidence.recoveryId, review.revision);
        else {
          const result = await resolveMutation({
            ...request,
            input: {
              ...request.input,
              recoveryId: evidence.recoveryId,
              currentRevision: review.revision,
              choice: "accept-current",
            },
          });
          if (result._tag === "Success" && result.value.revision === review.revision) {
            const read = await readFile(request);
            const verified =
              read._tag === "Failure"
                ? documentCurrentMissingReview(read.cause, request.input)
                : read.value;
            accepted =
              verified !== null &&
              verified.revision === review.revision &&
              !verified.truncated &&
              !verified.readOnly &&
              verified.publicationAttention === undefined;
          }
        }
      } else if (
        documentPublicationOutcome(attention.cause) === "unchanged" &&
        current.publicationAttention === undefined
      ) {
        accepted =
          props.acknowledgeRefusal && !props.metadataOnly
            ? await props.acknowledgeRefusal(review.revision)
            : true;
      }
      if (accepted && props.metadataOnly && metadataIntent) {
        accepted = await settleMetadataRenameIntent(
          {
            environmentId: props.environmentId,
            cwd: props.cwd,
            relativePath: props.relativePath,
          },
          metadataIntent.mutationId,
          props.metadataStore,
        );
        if (accepted) setMetadataIntent(null);
      }
      if (accepted) {
        setAttention(null);
        setReview(null);
        setError(null);
      } else
        setError(
          "This rename remains unresolved. The open path was not moved; local input and retained versions are preserved.",
        );
    } catch {
      setError(
        "Recovery confirmation could not finish. Review the current source path again; the rename has not been acknowledged.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setPath(pendingRename?.destination.relativePath ?? props.relativePath);
    setError(null);
    queueMicrotask(() => {
      const input = inputRef.current;
      if (!input) return;
      // The name is selected, not its extension, so typing keeps the file type.
      const slash = props.relativePath.lastIndexOf("/");
      const dot = props.relativePath.lastIndexOf(".");
      input.setSelectionRange(slash + 1, dot > slash + 1 ? dot : props.relativePath.length);
    });
  }, [open, props.relativePath, pendingRename?.mutationId]);

  const submit = async () => {
    if ((props.disabled && !pendingRename) || submitting || (attention !== null && !pendingRename))
      return;
    // The field starts as the file's exact path. Submitting it untouched is not
    // a rename, even when normalizing it as typed text would alter it.
    if (path === props.relativePath) {
      setOpen(false);
      return;
    }
    const destinationRelativePath =
      pendingRename?.destination.relativePath ??
      (props.normalize ? props.normalize(path) : normalizeRenamePath(path, props.relativePath));
    if (!destinationRelativePath) {
      setError(props.invalidMessage ?? "Enter a relative path inside this workspace.");
      return;
    }
    if (destinationRelativePath === props.relativePath) {
      setOpen(false);
      return;
    }
    if (props.metadataOnly) {
      if (!metadataReady) {
        setError(RECOVERY_COPY_UNSETTLED);
        return;
      }
      const owner = metadataOwner.current;
      const release = pendingRename ? undefined : props.beforeRename?.();
      if (!pendingRename && props.beforeRename && !release) {
        setError("Finish the current file operation before renaming.");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const outcome = await renameMetadataFile({
          from: {
            environmentId: props.environmentId,
            cwd: props.cwd,
            relativePath: props.relativePath,
          },
          destination: {
            environmentId: props.environmentId,
            cwd: props.cwd,
            relativePath: destinationRelativePath,
          },
          ...(props.revision === null ? {} : { expectedRevision: props.revision }),
          ...(props.metadataStore ? { store: props.metadataStore } : {}),
          isActive: () => owner !== null && metadataOwner.current === owner,
          rename: async (intent) => {
            const result = await renameFile({
              environmentId: intent.from.environmentId,
              input: {
                cwd: intent.from.cwd,
                relativePath: intent.from.relativePath,
                destinationRelativePath: intent.destination.relativePath,
                mutationId: intent.mutationId,
                ...(intent.expectedRevision === undefined
                  ? {}
                  : { expectedRevision: intent.expectedRevision }),
                ...(intent.removeEmptyFolders ? { removeEmptyFolders: true } : {}),
              },
            });
            return result._tag === "Success"
              ? {
                  ok: true,
                  destinationRelativePath: result.value.destinationRelativePath,
                  revision: result.value.revision,
                }
              : {
                  ok: false,
                  cause: result._tag === "Failure" ? squashAtomCommandFailure(result) : null,
                };
          },
        });
        if (metadataOwner.current !== owner) return;
        if (outcome.kind === "renamed") {
          setMetadataIntent(null);
          setOpen(false);
          props.onRenamed(outcome.destinationRelativePath, outcome.revision);
        } else {
          const retained = await readMetadataRenameIntent(
            {
              environmentId: props.environmentId,
              cwd: props.cwd,
              relativePath: props.relativePath,
            },
            props.metadataStore,
          ).catch(() => metadataIntent);
          if (metadataOwner.current !== owner) return;
          setMetadataIntent(retained);
          if (outcome.kind === "attention")
            setAttention({
              kind: outcome.attention,
              cause: outcome.cause,
              destination: destinationRelativePath,
            });
          else setError(renameFailureMessage(outcome.cause));
        }
      } catch (cause) {
        if (metadataOwner.current === owner) setError(renameFailureMessage(cause));
      } finally {
        release?.();
        if (metadataOwner.current === owner) setSubmitting(false);
      }
      return;
    }
    if (props.moveInPlace) {
      setSubmitting(true);
      setError(null);
      let outcome: RenameOpenDocumentResult;
      try {
        outcome = await props.moveInPlace(destinationRelativePath);
      } catch (cause) {
        outcome = { kind: "attention", attention: "outcome_unknown", cause };
      } finally {
        setSubmitting(false);
      }
      if (outcome.kind === "attention") {
        setAttention({
          kind: outcome.attention,
          cause: outcome.cause,
          destination: destinationRelativePath,
        });
        return;
      }
      if (outcome.kind === "failed") {
        setError(renameFailureMessage(outcome.cause));
        return;
      }
      if (outcome.kind === "legacy-required") {
        setError(
          outcome.reason === "destination"
            ? "The destination already owns a view or recovery copy. Choose another path."
            : "Finish the current document operation before renaming.",
        );
        return;
      }
      setOpen(false);
      return;
    }
    if (!props.renameJournal) {
      setError(RECOVERY_COPY_UNSETTLED);
      return;
    }
    const release = pendingRename ? undefined : props.beforeRename?.();
    if (!pendingRename && props.beforeRename && !release) {
      setError("Finish the current file operation before renaming.");
      return;
    }
    setSubmitting(true);
    setError(null);
    let intent: DocumentRenameIntent | null;
    try {
      intent = await props.renameJournal.beginRename(destinationRelativePath);
      if (!intent) throw new Error(RECOVERY_COPY_UNSETTLED);
    } catch (cause) {
      setError(renameFailureMessage(cause));
      release?.();
      setSubmitting(false);
      return;
    }
    const mutationId = intent.mutationId;
    if (!props.renameJournal.isCurrent(intent)) {
      setError(
        "The rename owner retired before transport dispatch. The original intent remains preserved.",
      );
      release?.();
      setSubmitting(false);
      return;
    }
    try {
      const result = intent.acknowledgement
        ? { _tag: "Success" as const, value: intent.acknowledgement }
        : await renameFile({
            environmentId: intent.from.environmentId,
            input: {
              cwd: intent.from.cwd,
              relativePath: intent.from.relativePath,
              destinationRelativePath: intent.destination.relativePath,
              expectedRevision: intent.expectedRevision,
              mutationId,
              ...(intent.removeEmptyFolders ? { removeEmptyFolders: true } : {}),
            },
          });
      if (result._tag === "Success") {
        if (!(await props.renameJournal.acknowledgeRename(intent, result.value))) {
          const cause = new Error(
            "The rename receipt could not be committed. Local input and the original intent remain preserved.",
          );
          setAttention({ kind: "outcome_unknown", cause, destination: destinationRelativePath });
          return;
        }
        setOpen(false);
        props.onRenamed(result.value.destinationRelativePath, result.value.revision);
        return;
      }
      if (result._tag !== "Failure") {
        const cause = new Error("The rename outcome could not be confirmed.");
        await props.renameJournal.rejectRename(intent, cause);
        props.onMutationFailure?.(cause, mutationId);
        setAttention({ kind: "outcome_unknown", cause, destination: destinationRelativePath });
        return;
      }
      const cause = squashAtomCommandFailure(result);
      if (!(await props.renameJournal.rejectRename(intent, cause))) {
        setAttention({
          kind: "outcome_unknown",
          cause: new Error(
            "The refusal could not be durably settled. The original rename intent remains preserved.",
          ),
          destination: destinationRelativePath,
        });
        return;
      }
      const kind = renameOutcomeAttention(cause);
      if (kind !== null) {
        props.onMutationFailure?.(cause, mutationId);
        setAttention({ kind, cause, destination: destinationRelativePath });
        return;
      }
      setError(renameFailureMessage(cause));
    } catch (cause) {
      await props.renameJournal.rejectRename(intent, cause);
      props.onMutationFailure?.(cause, mutationId);
      setAttention({ kind: "outcome_unknown", cause, destination: destinationRelativePath });
    } finally {
      release?.();
      setSubmitting(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={props.disabled && !pendingRename}
        render={
          <button
            type="button"
            aria-label={`Rename ${props.label}`}
            className="group/file-name -mx-1 inline-flex max-w-48 items-center gap-1 rounded-sm px-1 py-0.5 font-medium text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-70"
            disabled={props.disabled && !pendingRename}
          >
            <span className="truncate">{props.label}</span>
            <FilePenLine
              aria-hidden
              className="size-3 shrink-0 opacity-0 transition-opacity group-hover/file-name:opacity-70 group-focus-visible/file-name:opacity-70"
            />
          </button>
        }
      />
      <PopoverPopup align="end" className="w-80" side="bottom">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <PopoverTitle>Rename file</PopoverTitle>
          <Input
            ref={inputRef}
            aria-invalid={error !== null || undefined}
            aria-label="File path"
            disabled={submitting || pendingRename !== null}
            onChange={(event) => setPath(event.target.value)}
            size="compact"
            spellCheck={false}
            value={path}
          />
          {props.notice ? (
            <div className="text-xs text-muted-foreground">{props.notice}</div>
          ) : null}
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {attention ? (
            <div className="flex flex-col gap-2 text-xs" role="alert">
              <p className="font-medium">{retainedAttentionCopy(attention.kind).title}</p>
              <p>{retainedAttentionCopy(attention.kind).description}</p>
              {props.onOpenFile ? (
                <div className="flex flex-wrap gap-1">
                  {[
                    props.relativePath,
                    attention.destination,
                    ...retainedFileEvidence(attention.cause).retainedPaths,
                  ].map((reviewPath) => (
                    <Button
                      key={reviewPath}
                      size="xs"
                      variant="outline"
                      type="button"
                      title={reviewPath}
                      onClick={() => props.onOpenFile?.(reviewPath)}
                    >
                      Review {reviewPath}
                    </Button>
                  ))}
                </div>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                type="button"
                disabled={submitting}
                onClick={() => void reviewCurrent()}
              >
                Review current source path read-only
              </Button>
              {review ? (
                <>
                  {review.missing ? (
                    <p role="status">
                      The current source pathname was confirmed absent. Accepting absence does not
                      confirm the rename, move the open path, or create an empty file.
                    </p>
                  ) : (
                    <>
                      <p>
                        Current source revision: {review.revision}. Accepting it does not confirm
                        the rename or move the open path.
                      </p>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border p-2">
                        {review.contents}
                      </pre>
                    </>
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    type="button"
                    disabled={submitting}
                    onClick={() => void acceptReview()}
                  >
                    Accept reviewed current source path
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
          <Button
            className="self-end"
            disabled={
              submitting ||
              (props.disabled && !pendingRename) ||
              (attention !== null && !pendingRename)
            }
            size="sm"
            type="submit"
          >
            {submitting ? "Renaming…" : pendingRename ? "Replay original rename" : "Rename"}
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
