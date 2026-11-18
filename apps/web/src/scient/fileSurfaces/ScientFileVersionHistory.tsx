import type {
  EnvironmentId,
  ProjectFilePublicationAttention,
  ProjectListFileVersionsResult,
  ProjectReadFileResult,
  ProjectWriteFileInput,
} from "@t3tools/contracts";
import type { DocumentPersistenceCurrentReview } from "@scientfactory/scient-document";
import { History } from "lucide-react";
import { msg, T, useGT, Var } from "gt-react";
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
import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { OverleafKeptCopies } from "~/scient/overleaf/OverleafKeptCopies";

type Version = ProjectListFileVersionsResult["versions"][number];
type CurrentReview =
  | (ProjectReadFileResult & { readonly missing?: false })
  | (Extract<DocumentPersistenceCurrentReview, { readonly missing: true }> & {
      readonly contents?: never;
    });

/** Retained inodes are evidence, not immutable snapshots or restore targets. */
function ScientFileVersionHistoryPanel(props: {
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
  const gt = useGT();
  const attention = props.history?.attention ?? props.publicationAttention ?? null;
  const [discard, setDiscard] = useState<string | null>(null);
  const [copy, setCopy] = useState<Version | null>(null);
  const [destination, setDestination] = useState("");
  const [copyMutationId, setCopyMutationId] = useState("");
  const [invalidPath, setInvalidPath] = useState(false);
  return (
    <div className="mt-2 flex flex-col gap-3 text-xs">
      <p className="text-muted-foreground">
        <T>
          Versions retained by Scient survive closing the file and restarting. Outside handles may
          still change their bytes. Open read-only to review before saving a separate copy.
        </T>
      </p>
      <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onRefresh}>
        <T>Refresh versions</T>
      </Button>
      {props.error ? <p role="alert">{props.error}</p> : null}
      {attention ? (
        <div role="alert" className="flex flex-col gap-2">
          <p className="font-medium">
            <T>A save needs checking</T>
          </p>
          <p>
            <T>
              Check the file on disk and the earlier versions, then continue. Your text is kept.
              Discarding versions doesn’t finish the check.
            </T>
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={props.busy}
            onClick={() => void props.onReviewCurrent()}
          >
            <T>Show file on disk</T>
          </Button>
          {attention.retainedPaths.map((path) => (
            <Button
              key={path}
              size="xs"
              variant="outline"
              title={path}
              onClick={() => props.onOpen(path)}
            >
              <T>Open earlier version</T>
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
              <T>Continue from this version</T>
            </Button>
          ) : null}
        </div>
      ) : null}
      {props.reviewRequired && attention === null ? (
        <div role="alert" className="flex flex-col gap-2">
          <p>
            <T>Nothing was written. Check the file on disk, then continue. Your text is kept.</T>
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={props.busy}
            onClick={() => void props.onReviewCurrent()}
          >
            <T>Show file on disk</T>
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
            <T>Continue from this version</T>
          </Button>
        </div>
      ) : null}
      {props.currentReview ? (
        <div
          className="flex flex-col gap-2"
          role="group"
          aria-label={gt("Reviewed current disk version")}
        >
          <p className="font-medium">
            {props.currentReview.missing ? gt("The file is not on disk") : gt("On disk now")}
          </p>
          <p>
            <T>Continuing applies only to this version and keeps your text.</T>
          </p>
          {props.currentReview.missing ? (
            <p role="status">
              <T>Continuing keeps your text and doesn’t create the file.</T>
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
                <T>Copy current text</T>
              </Button>
            </>
          )}
          {props.comparison ? (
            <>
              <p className="font-medium">
                <T>
                  Retained version · <Var>{props.comparison.version.versionId}</Var>
                </T>
              </p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border p-2">
                {props.comparison.retained.contents}
              </pre>
              <Button
                size="xs"
                variant="ghost"
                disabled={props.busy}
                onClick={() => void props.onCopyText(props.comparison!.retained.contents)}
              >
                <T>Copy retained text</T>
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {props.history ? (
        <>
          <p>
            {gt("{bytes} retained bytes", { bytes: props.history.retainedBytes.toLocaleString() })}
            {" · "}
            {props.history.limitBytes === null
              ? gt("No retention limit configured")
              : gt("Limit {bytes} bytes", { bytes: props.history.limitBytes.toLocaleString() })}
          </p>
          {props.history.versions.length === 0 ? (
            <p>
              <T>No retained versions for this file.</T>
            </p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-3 overflow-y-auto">
              {props.history.versions.map((version) => (
                <li key={version.versionId} className="flex flex-col gap-1">
                  <span>
                    {new Date(version.retainedAt).toLocaleString()} ·{" "}
                    {gt("{bytes} bytes", { bytes: version.byteLength.toLocaleString() })}
                  </span>
                  <span className="break-all text-muted-foreground">
                    {version.versionId}
                    {version.revision === null
                      ? ` · ${gt("Revision unavailable")}`
                      : ` · ${version.revision}`}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => props.onOpen(version.retainedPath)}
                    >
                      <T>Open read-only</T>
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={props.busy}
                      onClick={() => void props.onCompare(version)}
                    >
                      <T>Compare with current…</T>
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
                      <T>Save copy…</T>
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
                      <T>Discard…</T>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : props.busy ? (
        <p role="status">
          <T>Loading retained versions…</T>
        </p>
      ) : null}
      {discard ? (
        <div
          className="flex flex-col gap-2"
          role="group"
          aria-label={gt("Confirm discard retained version")}
        >
          <p>
            <T>
              Discard this retained version? This removes Scient’s retained name and cannot be
              undone here. Late outside handles may still write the discarded inode. Discard does
              not resolve an unknown mutation outcome.
            </T>
          </p>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={props.busy}
              onClick={() => setDiscard(null)}
            >
              <T>Cancel</T>
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
              <T>Discard retained version</T>
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
            <T>
              Save text as a new project file. Existing files are never replaced. For binary files,
              open the retained version and use the viewer’s Save a copy action.
            </T>
          </p>
          <Input
            size="compact"
            aria-label={gt("Copy file path")}
            value={destination}
            disabled={props.busy}
            onChange={(event) => {
              setDestination(event.target.value);
              setCopyMutationId(randomUUID());
              setInvalidPath(false);
            }}
          />
          {invalidPath ? (
            <p role="alert">
              <T>Enter a relative path inside this workspace.</T>
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="ghost"
              type="button"
              disabled={props.busy}
              onClick={() => setCopy(null)}
            >
              <T>Cancel</T>
            </Button>
            <Button
              size="xs"
              variant="outline"
              type="submit"
              disabled={props.busy || !props.canWrite}
            >
              <T>Save new copy</T>
            </Button>
          </div>
        </form>
      ) : null}
      {!props.canWrite ? (
        <p className="text-muted-foreground">
          <T>
            Read-only connection: versions can be reviewed, but not discarded or copied into the
            project.
          </T>
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
  const gt = useGT();
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
      setError(m(msg("Retained versions could not be loaded. Refresh versions to check again.")));
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
    return settleVersionOperation(
      operation,
      () =>
        setError(
          m(
            msg(
              "The operation’s outcome could not be confirmed. Review the current file and retained versions before trying a new operation.",
            ),
          ),
        ),
      () => {
        operating.current = false;
        setBusy(false);
      },
    );
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
        m(
          msg(
            "The current file is too large to review completely here. Open it read-only and save a separate copy.",
          ),
        ),
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
        m(
          msg(
            "The retained operation changed. Refresh versions and review the current file again.",
          ),
        ),
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
            aria-label={gt("Retained file versions")}
            title={gt("Retained file versions")}
          />
        }
      >
        <History className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup align="end" width="lg" padding="comfortable">
        <PopoverTitle>
          <T>Retained file versions</T>
        </PopoverTitle>
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
                  m(
                    msg(
                      "This retained version is too large for a complete text comparison. Open it read-only and use Save a copy to preserve its original bytes.",
                    ),
                  ),
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
                        m(
                          msg(
                            "The displayed revision could not be acknowledged. Local input is preserved; review the current file again.",
                          ),
                        ),
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
                  setError(
                    m(msg("The reviewed current state changed. Review it again before accepting.")),
                  );
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
                    m(
                      msg(
                        "The backend did not authorize this reviewed current state. Your retained versions are preserved.",
                      ),
                    ),
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
                  m(
                    msg(
                      "The current disk version could not be accepted. Local input is preserved; review the current file and retained versions again.",
                    ),
                  ),
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
                  m(
                    msg(
                      "The retained version could not be discarded. Refresh versions to check what remains.",
                    ),
                  ),
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
                    m(
                      msg(
                        "This retained version could not be read as complete text. Open it read-only and use Save a copy to preserve the original bytes.",
                      ),
                    ),
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
                  m(
                    msg(
                      "The new copy could not be confirmed. Existing files are not replaced; review the destination before choosing another path.",
                    ),
                  ),
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
        <OverleafKeptCopies
          environmentId={props.environmentId}
          cwd={props.cwd}
          relativePath={props.relativePath}
        />
      </PopoverPopup>
    </Popover>
  );
}

// Outside the component: the React Compiler does not compile try/finally.
async function settleVersionOperation(
  operation: () => Promise<boolean>,
  failed: () => void,
  settled: () => void,
): Promise<boolean> {
  try {
    return await operation();
  } catch {
    failed();
    return false;
  } finally {
    settled();
  }
}
