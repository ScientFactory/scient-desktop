import type {
  EnvironmentId,
  ProjectFilePublicationAttention,
  ProjectListFileVersionsResult,
  ProjectReadFileResult,
  ProjectWriteFileInput,
} from "@t3tools/contracts";
import type { DocumentPersistenceCurrentReview } from "@scientfactory/scient-document";
import { History } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { normalizeRenamePath } from "~/components/files/FileRenameButton";
import { refreshProjectEntriesQuery } from "~/components/files/projectFilesQueryState";
import { normalizeMarkdownReadSnapshot } from "~/scient/markdownEditor/persistence/markdownReadSnapshot";
import { documentCurrentMissingReview } from "~/scient/markdownEditor/persistence/documentFailureReason";
import { randomUUID } from "~/lib/utils";

type Version = ProjectListFileVersionsResult["versions"][number];
type CurrentReview =
  | (ProjectReadFileResult & { readonly missing?: false })
  | (Extract<DocumentPersistenceCurrentReview, { readonly missing: true }> & {
      readonly contents?: never;
    });

/** Retained inodes are evidence, not immutable snapshots or restore targets. */
export function ScientFileVersionHistoryPanel(props: {
  readonly history: ProjectListFileVersionsResult | null;
  readonly publicationAttention?: ProjectFilePublicationAttention;
  readonly busy: boolean;
  readonly error: string | null;
  readonly canWrite: boolean;
  readonly relativePath: string;
  readonly onRefresh: () => void;
  readonly onOpen: (path: string) => void;
  readonly onDiscard: (versionId: string) => Promise<boolean>;
  readonly onCopy: (version: Version, destination: string, mutationId: string) => Promise<boolean>;
  readonly onAcceptCurrent?: (
    recoveryId: string,
    currentRevision: string | null,
  ) => Promise<boolean>;
  readonly canAcceptCurrent?: boolean;
  readonly reviewRequired?: boolean;
  readonly onAcknowledgeRefusal?: (currentRevision: string | null) => Promise<boolean>;
  readonly currentReview: CurrentReview | null;
  readonly comparison: {
    readonly version: Version;
    readonly retained: ProjectReadFileResult;
  } | null;
  readonly onReviewCurrent: () => Promise<boolean>;
  readonly onCompare: (version: Version) => Promise<boolean>;
  readonly onCopyText: (contents: string) => Promise<boolean>;
}) {
  const attention = props.history?.attention ?? props.publicationAttention ?? null;
  const [discard, setDiscard] = useState<string | null>(null);
  const [copy, setCopy] = useState<Version | null>(null);
  const [destination, setDestination] = useState("");
  const [copyMutationId, setCopyMutationId] = useState("");
  const [invalidPath, setInvalidPath] = useState(false);
  return (
    <div className="mt-2 flex flex-col gap-3 text-xs">
      <p className="text-muted-foreground">
        Versions retained by Scient survive closing the file and restarting. Outside handles may
        still change their bytes. Open read-only to review before saving a separate copy.
      </p>
      <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onRefresh}>
        Refresh versions
      </Button>
      {props.error ? <p role="alert">{props.error}</p> : null}
      {attention ? (
        <div role="alert" className="flex flex-col gap-2">
          <p className="font-medium">This retained file operation still needs review</p>
          <p>{attention.message}</p>
          <p>
            Review the current file and retained bytes before accepting the current disk version.
            This requires backend confirmation, preserves your local draft, and does not confirm the
            old operation succeeded. Discarding versions does not resolve the operation.
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={props.busy}
            onClick={() => void props.onReviewCurrent()}
          >
            Review current disk version read-only
          </Button>
          {attention.retainedPaths.map((path) => (
            <Button
              key={path}
              size="xs"
              variant="outline"
              title={path}
              onClick={() => props.onOpen(path)}
            >
              Review retained file read-only
            </Button>
          ))}
          {props.onAcceptCurrent ? (
            <Button
              size="xs"
              variant="outline"
              disabled={
                props.busy ||
                !props.canWrite ||
                !props.canAcceptCurrent ||
                props.currentReview === null ||
                props.currentReview.readOnly
              }
              onClick={() =>
                void props.onAcceptCurrent?.(attention.recoveryId, props.currentReview!.revision)
              }
            >
              Accept current disk version after review
            </Button>
          ) : null}
        </div>
      ) : null}
      {props.reviewRequired && attention === null ? (
        <div role="alert" className="flex flex-col gap-2">
          <p>
            Scient confirmed this attempt did not publish a change. Acknowledge the refusal only
            after reviewing the current disk version. This does not confirm a save or repair an
            unavailable mutation capability.
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={props.busy}
            onClick={() => void props.onReviewCurrent()}
          >
            Review current disk version read-only
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={
              props.busy ||
              !props.canWrite ||
              !props.canAcceptCurrent ||
              props.currentReview === null ||
              props.currentReview.readOnly
            }
            onClick={() => void props.onAcknowledgeRefusal?.(props.currentReview!.revision)}
          >
            Acknowledge unchanged refusal
          </Button>
        </div>
      ) : null}
      {props.currentReview ? (
        <div
          className="flex flex-col gap-2"
          role="group"
          aria-label="Reviewed current disk version"
        >
          <p className="font-medium">
            Current disk version ·{" "}
            {props.currentReview.missing
              ? "Path is absent (no current revision)"
              : props.currentReview.revision}
          </p>
          <p>
            Accept applies only to this reviewed state. A later disk change requires another review.
            Your local draft is not replaced.
          </p>
          {props.currentReview.missing ? (
            <p role="status">
              The current pathname is missing. Accepting its absence does not create a file or save
              the old draft. A later new save must use exclusive creation.
            </p>
          ) : (
            <>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border p-2">
                {props.currentReview.contents}
              </pre>
              <Button
                size="xs"
                variant="ghost"
                disabled={props.busy}
                onClick={() => void props.onCopyText(props.currentReview!.contents!)}
              >
                Copy current text
              </Button>
            </>
          )}
          {props.comparison ? (
            <>
              <p className="font-medium">Retained version · {props.comparison.version.versionId}</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border p-2">
                {props.comparison.retained.contents}
              </pre>
              <Button
                size="xs"
                variant="ghost"
                disabled={props.busy}
                onClick={() => void props.onCopyText(props.comparison!.retained.contents)}
              >
                Copy retained text
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {props.history ? (
        <>
          <p>
            {props.history.retainedBytes.toLocaleString()} retained bytes
            {props.history.limitBytes === null
              ? " · No retention limit configured"
              : ` · Limit ${props.history.limitBytes.toLocaleString()} bytes`}
          </p>
          {props.history.versions.length === 0 ? (
            <p>No retained versions for this file.</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-3 overflow-y-auto">
              {props.history.versions.map((version) => (
                <li key={version.versionId} className="flex flex-col gap-1">
                  <span>
                    {new Date(version.retainedAt).toLocaleString()} ·{" "}
                    {version.byteLength.toLocaleString()} bytes
                  </span>
                  <span className="break-all text-muted-foreground">
                    {version.versionId}
                    {version.revision === null
                      ? " · Revision unavailable"
                      : ` · ${version.revision}`}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => props.onOpen(version.retainedPath)}
                    >
                      Open read-only
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={props.busy}
                      onClick={() => void props.onCompare(version)}
                    >
                      Compare with current…
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!props.canWrite || props.busy}
                      onClick={() => {
                        setCopy(version);
                        setCopyMutationId(randomUUID());
                        setDiscard(null);
                        setDestination("");
                        setInvalidPath(false);
                      }}
                    >
                      Save copy…
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!props.canWrite || props.busy}
                      onClick={() => {
                        setDiscard(version.versionId);
                        setCopy(null);
                      }}
                    >
                      Discard…
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : props.busy ? (
        <p role="status">Loading retained versions…</p>
      ) : null}
      {discard ? (
        <div
          className="flex flex-col gap-2"
          role="group"
          aria-label="Confirm discard retained version"
        >
          <p>
            Discard this retained version? This removes Scient’s retained name and cannot be undone
            here. Late outside handles may still write the discarded inode. Discard does not resolve
            an unknown mutation outcome.
          </p>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={props.busy}
              onClick={() => setDiscard(null)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              variant="destructive"
              disabled={props.busy || !props.canWrite}
              onClick={() =>
                void props.onDiscard(discard).then((done) => {
                  if (done) setDiscard(null);
                })
              }
            >
              Discard retained version
            </Button>
          </div>
        </div>
      ) : null}
      {copy ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const path = normalizeRenamePath(destination, props.relativePath);
            if (path === null) {
              setInvalidPath(true);
              return;
            }
            void props.onCopy(copy, path, copyMutationId).then((done) => {
              if (done) setCopy(null);
            });
          }}
        >
          <p>
            Save text as a new project file. Existing files are never replaced. For binary files,
            open the retained version and use the viewer’s Save a copy action.
          </p>
          <Input
            size="compact"
            aria-label="Copy file path"
            value={destination}
            disabled={props.busy}
            onChange={(event) => {
              setDestination(event.target.value);
              setCopyMutationId(randomUUID());
              setInvalidPath(false);
            }}
          />
          {invalidPath ? <p role="alert">Enter a relative path inside this workspace.</p> : null}
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="ghost"
              type="button"
              disabled={props.busy}
              onClick={() => setCopy(null)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              variant="outline"
              type="submit"
              disabled={props.busy || !props.canWrite}
            >
              Save new copy
            </Button>
          </div>
        </form>
      ) : null}
      {!props.canWrite ? (
        <p className="text-muted-foreground">
          Read-only connection: versions can be reviewed, but not discarded or copied into the
          project.
        </p>
      ) : null}
    </div>
  );
}

/** Reads history on demand, including after restart; no client history store. */
export function ScientFileVersionHistory(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly canWrite: boolean;
  readonly onOpenFile: (path: string) => void;
  readonly onAcceptCurrent?: (
    recoveryId: string,
    currentRevision: string | null,
  ) => Promise<boolean>;
  readonly canAcceptCurrent?: boolean;
  readonly publicationAttention?: ProjectFilePublicationAttention;
  readonly reviewRequired?: boolean;
  readonly onReviewCurrent?: (currentRevision: string | null) => Promise<boolean>;
}) {
  const list = useAtomCommand(projectEnvironment.listFileVersions, { reportFailure: false });
  const discard = useAtomCommand(projectEnvironment.discardFileVersion, { reportFailure: false });
  const read = useAtomCommand(projectEnvironment.readFileOrdered, { reportFailure: false });
  const write = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const resolve = useAtomCommand(projectEnvironment.resolveFileMutation, { reportFailure: false });
  const [history, setHistory] = useState<ProjectListFileVersionsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentReview, setCurrentReview] = useState<CurrentReview | null>(null);
  const [comparison, setComparison] = useState<{
    readonly version: Version;
    readonly retained: ProjectReadFileResult;
  } | null>(null);
  const copyAttempt = useRef<ProjectWriteFileInput | null>(null);
  const operating = useRef(false);
  const request = {
    environmentId: props.environmentId,
    input: { cwd: props.cwd, relativePath: props.relativePath },
  };
  const displayedAttention = history?.attention ?? props.publicationAttention ?? null;
  const load = async () => {
    const result = await list(request);
    if (result._tag === "Failure") {
      setError("Retained versions could not be loaded. Refresh versions to check again.");
      return false;
    }
    setHistory(result.value);
    setCurrentReview(null);
    setComparison(null);
    return true;
  };
  const run = async (operation: () => Promise<boolean>) => {
    if (operating.current) return false;
    operating.current = true;
    setBusy(true);
    setError(null);
    try {
      return await operation();
    } catch {
      setError(
        "The operation’s outcome could not be confirmed. Review the current file and retained versions before trying a new operation.",
      );
      return false;
    } finally {
      operating.current = false;
      setBusy(false);
    }
  };
  const readComplete = async (path: string) => {
    const result = await read({ ...request, input: { cwd: props.cwd, relativePath: path } });
    if (result._tag === "Failure") throw result.cause;
    // Read-only retained paths still need exact UTF-8 round-tripping before text copy.
    const normalized = normalizeMarkdownReadSnapshot({ ...result.value, readOnly: false });
    return { ...normalized, readOnly: result.value.readOnly ?? false };
  };
  const reviewCurrent = async () => {
    let current: CurrentReview;
    try {
      current = await readComplete(props.relativePath);
    } catch (error) {
      const missing = documentCurrentMissingReview(error, request.input);
      if (!missing) throw error;
      current = missing;
    }
    if (current.truncated) {
      setError(
        "The current file is too large to review completely here. Open it read-only and save a separate copy.",
      );
      return false;
    }
    if (
      displayedAttention &&
      current.publicationAttention != null &&
      current.publicationAttention.recoveryId !== displayedAttention.recoveryId
    ) {
      setCurrentReview(null);
      setError(
        "The retained operation changed. Refresh versions and review the current file again.",
      );
      return false;
    }
    setCurrentReview(current);
    setComparison(null);
    return true;
  };
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) void run(load);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Retained file versions"
            title="Retained file versions"
          />
        }
      >
        <History className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup align="end" width="lg" padding="comfortable">
        <PopoverTitle>Retained file versions</PopoverTitle>
        <ScientFileVersionHistoryPanel
          history={history}
          {...(props.publicationAttention === undefined
            ? {}
            : { publicationAttention: props.publicationAttention })}
          busy={busy}
          error={error}
          canWrite={props.canWrite}
          relativePath={props.relativePath}
          onOpen={props.onOpenFile}
          onRefresh={() => void run(load)}
          currentReview={currentReview}
          comparison={comparison}
          onReviewCurrent={() => run(reviewCurrent)}
          onCompare={(version) =>
            run(async () => {
              if (!(await reviewCurrent())) return false;
              const retained = await readComplete(version.retainedPath);
              if (retained.truncated) {
                setError(
                  "This retained version is too large for a complete text comparison. Open it read-only and use Save a copy to preserve its original bytes.",
                );
                return false;
              }
              setComparison({ version, retained });
              return true;
            })
          }
          onCopyText={(contents) =>
            run(async () => {
              await navigator.clipboard.writeText(contents);
              return true;
            })
          }
          canAcceptCurrent={props.canAcceptCurrent ?? true}
          {...(props.reviewRequired === undefined ? {} : { reviewRequired: props.reviewRequired })}
          {...(props.onReviewCurrent
            ? {
                onAcknowledgeRefusal: (currentRevision: string | null) =>
                  run(async () => {
                    const accepted = await props.onReviewCurrent!(currentRevision);
                    if (!accepted) {
                      setError(
                        "The displayed revision could not be acknowledged. Local input is preserved; review the current file again.",
                      );
                      return false;
                    }
                    return load();
                  }),
              }
            : {})}
          onAcceptCurrent={(recoveryId, currentRevision) =>
            run(async () => {
              let accepted: boolean;
              if (props.onAcceptCurrent) {
                accepted = await props.onAcceptCurrent(recoveryId, currentRevision);
              } else {
                if (!props.canWrite) return false;
                const before = await read({ ...request, input: request.input });
                const beforeReview =
                  before._tag === "Failure"
                    ? documentCurrentMissingReview(before.cause, request.input)
                    : normalizeMarkdownReadSnapshot(before.value);
                if (
                  !beforeReview ||
                  beforeReview.revision !== currentRevision ||
                  beforeReview.truncated ||
                  beforeReview.readOnly ||
                  (beforeReview.publicationAttention &&
                    beforeReview.publicationAttention.recoveryId !== recoveryId)
                ) {
                  setError("The reviewed current state changed. Review it again before accepting.");
                  return false;
                }
                const resolved = await resolve({
                  ...request,
                  input: {
                    ...request.input,
                    recoveryId,
                    currentRevision,
                    choice: "accept-current",
                  },
                });
                if (resolved._tag === "Failure" || resolved.value.revision !== currentRevision) {
                  setError(
                    "The backend did not authorize this reviewed current state. Your retained versions are preserved.",
                  );
                  return false;
                }
                const after = await read({ ...request, input: request.input });
                const afterReview =
                  after._tag === "Failure"
                    ? documentCurrentMissingReview(after.cause, request.input)
                    : normalizeMarkdownReadSnapshot(after.value);
                accepted =
                  afterReview !== null &&
                  afterReview.revision === currentRevision &&
                  !afterReview.truncated &&
                  !afterReview.readOnly &&
                  afterReview.publicationAttention == null;
              }
              if (!accepted) {
                setError(
                  "The current disk version could not be accepted. Local input is preserved; review the current file and retained versions again.",
                );
                return false;
              }
              return load();
            })
          }
          onDiscard={(versionId) =>
            run(async () => {
              if (!props.canWrite) return false;
              const result = await discard({ ...request, input: { ...request.input, versionId } });
              if (result._tag === "Failure") {
                setError(
                  "The retained version could not be discarded. Refresh versions to check what remains.",
                );
                return false;
              }
              await load();
              return true;
            })
          }
          onCopy={(version, destination, mutationId) =>
            run(async () => {
              if (!props.canWrite) return false;
              if (copyAttempt.current?.mutationId !== mutationId) {
                const source = await readComplete(version.retainedPath);
                if (source.truncated) {
                  setError(
                    "This retained version could not be read as complete text. Open it read-only and use Save a copy to preserve the original bytes.",
                  );
                  return false;
                }
                copyAttempt.current = {
                  cwd: props.cwd,
                  relativePath: destination,
                  contents: source.contents,
                  createOnly: true,
                  mutationId,
                };
              }
              const result = await write({ ...request, input: copyAttempt.current });
              if (result._tag === "Failure") {
                setError(
                  "The new copy could not be confirmed. Existing files are not replaced; review the destination before choosing another path.",
                );
                return false;
              }
              refreshProjectEntriesQuery(props.environmentId, props.cwd);
              props.onOpenFile(result.value.relativePath);
              copyAttempt.current = null;
              return true;
            })
          }
        />
      </PopoverPopup>
    </Popover>
  );
}
