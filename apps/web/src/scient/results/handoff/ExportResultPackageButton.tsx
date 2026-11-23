import { useAtomValue } from "@effect/atom-react";
import type {
  ComputeResultRevisionId,
  ComputeResultScript,
  EnvironmentId,
  ResultHandoffChoices,
  ResultHandoffExportProgress,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogAction,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field, FieldControl, FieldLabel } from "~/components/ui/field";
import { Spinner } from "~/components/ui/spinner";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { NativeSelect } from "~/components/ui/select";
import { useFileContextMenu } from "~/fileContextMenu";
import { useClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { formatBytes } from "~/lib/formatBytes";
import { randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { computeEnvironment } from "~/state/compute";
import { localEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { formatReceiptDateTime } from "~/timestampFormat";
import { resultErrorMessage } from "../resultState";
import { PackageDisclosure } from "./PackageDisclosure";

export function ExportResultPackageButton(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly size?: "sm" | "xs";
  readonly menuLabel?: string;
  readonly scriptPath?: string;
  readonly revision?: ComputeResultRevisionId;
  readonly renderTrigger?: (start: (() => void) | undefined) => ReactNode;
}) {
  const gt = useGT();
  const { environmentId, cwd } = props;
  const revisionParametersId = useId();
  const localEnvironmentId = useAtomValue(localEnvironmentIdAtom);
  const pickFolder =
    environmentId === localEnvironmentId && window.desktopBridge
      ? readLocalApi()?.dialogs.pickFolder
      : undefined;
  const canExport = useAtomValue(computeEnvironment.resultsExport.permissionAtom(environmentId));
  const list = useAtomCommand(computeEnvironment.resultsList, { reportFailure: false });
  const choices = useAtomCommand(computeEnvironment.resultsHandoffChoices, {
    reportFailure: false,
  });
  const exportPackage = useAtomCommand(computeEnvironment.resultsExport, { reportFailure: false });
  const files = useFileContextMenu(environmentId);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scripts, setScripts] = useState<ReadonlyArray<ComputeResultScript>>([]);
  const [scriptPath, setScriptPath] = useState<string | null>(null);
  const [revision, setRevision] = useState<ComputeResultRevisionId | null>(null);
  const [inputs, setInputs] = useState<ResultHandoffChoices["inputs"] | null>(null);
  const [code, setCode] = useState<ReadonlyArray<string>>([]);
  const [lockfiles, setLockfiles] = useState<NonNullable<ResultHandoffChoices["lockfiles"]>>([]);
  const [excludedLockfiles, setExcludedLockfiles] = useState<ReadonlyArray<string>>([]);
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);
  const [destination, setDestination] = useState(cwd);
  const [folder, setFolder] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<ReadonlyArray<string>>([]);
  const [progressId, setProgressId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<ResultHandoffExportProgress | null>(null);
  const readProgress = useStableCallback(
    useAtomCommand(computeEnvironment.resultsExportProgress, { reportFailure: false }),
  );

  const history = useEnvironmentQuery(
    open && scriptPath !== null
      ? computeEnvironment.resultsHistory({ environmentId, input: { cwd, scriptPath } })
      : null,
  );
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const revisions = (history.data?.revisions ?? []).map((entry, index, entries) => {
    const label = gt("Revision {number} · {time}", {
      number: entries.length - index,
      time: formatReceiptDateTime(entry.finishedAt, timestampFormat) || entry.finishedAt,
    });
    const parameters = entry.parameters?.map(({ name, value }) => `${name} = ${value}`).join(", ");
    return {
      value: entry.revision,
      label,
      parameters,
    };
  });
  const selectedRevision = revisions.find((entry) => entry.value === revision);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the active export reports progress over the environment connection
  useEffect(() => {
    if (progressId === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const next = await readProgress({ environmentId, input: { progressId } });
      if (!active) return;
      if (next._tag === "Success" && next.value !== null) setProgress(next.value);
      timer = setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [environmentId, progressId, readProgress]);

  const readInputs = async (requested: ComputeResultRevisionId) => {
    setBusy(true);
    setMessage(null);
    setInputs(null);
    setCode([]);
    setSelected([]);
    setLockfiles([]);
    setExcludedLockfiles([]);
    setRevision(requested);
    const result = await choices({ environmentId, input: { cwd, revision: requested } });
    if (result._tag === "Success") {
      setInputs(result.value.inputs);
      setCode(result.value.code ?? []);
      setLockfiles(result.value.lockfiles ?? []);
    } else setMessage(resultErrorMessage(result, gt("The recorded inputs could not be read.")));
    setBusy(false);
  };

  const openDialog = async () => {
    setOpen(true);
    setFolder(null);
    setWarnings([]);
    setMessage(null);
    setInputs(null);
    setScripts([]);
    setScriptPath(props.scriptPath ?? null);
    setRevision(null);
    setDestination(cwd);
    if (props.revision !== undefined && props.scriptPath !== undefined) {
      await readInputs(props.revision);
      return;
    }
    setBusy(true);
    const result = await list({ environmentId, input: { cwd } });
    if (result._tag === "Success") {
      setScripts(result.value.scripts);
      if (result.value.scripts.length === 0) setMessage(gt("No saved results in this project."));
    } else {
      setMessage(resultErrorMessage(result, gt("The saved results could not be read.")));
    }
    setBusy(false);
  };

  const save = async (chosenRevision: ComputeResultRevisionId) => {
    setBusy(true);
    setMessage(null);
    const target =
      pickFolder === undefined
        ? destination.trim()
        : await pickFolder({ initialPath: cwd }).catch(() => null);
    if (target) {
      setSaving(true);
      const id = randomUUID();
      setProgress(null);
      setProgressId(id);
      const result = await exportPackage({
        environmentId,
        input: {
          cwd,
          revision: chosenRevision,
          destination: target,
          includeInputs: selected,
          excludeLockfiles: excludedLockfiles,
          progressId: id,
        },
      });
      setProgressId(null);
      setProgress(null);
      if (result._tag === "Success") {
        setWarnings(result.value.warnings ?? []);
        setFolder(result.value.folder);
        if (files.capabilities.revealLabel !== undefined) {
          await files.activate("reveal-in-folder", {
            environmentId,
            filePath: result.value.folder,
            workspaceRoot: undefined,
          });
        }
      } else {
        setMessage(resultErrorMessage(result, gt("The result package could not be saved.")));
      }
    }
    setSaving(false);
    setBusy(false);
  };

  const trigger = props.renderTrigger?.(canExport ? () => void openDialog() : undefined);
  if (!canExport) return trigger ?? null;
  const ready = inputs !== null && selectedRevision !== undefined;
  const dataRemaining = inputs?.filter((file) => !selected.includes(file.path)).length ?? 0;
  return (
    <>
      {props.renderTrigger === undefined && props.menuLabel === undefined ? (
        <Button
          type="button"
          size={props.size ?? "xs"}
          variant="ghost-muted"
          onClick={() => void openDialog()}
        >
          <T>Export for rerun…</T>
        </Button>
      ) : (
        (trigger ?? (
          <Menu>
            <MenuTrigger
              render={<Button type="button" variant="ghost-inset" size="icon-sm" />}
              aria-label={props.menuLabel}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => void openDialog()}>
                <T>Export for rerun…</T>
              </MenuItem>
            </MenuPopup>
          </Menu>
        ))
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogPopup layer="above-popovers" gap="none" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {folder === null ? gt("Export for rerun") : gt("Result package saved")}
            </DialogTitle>
            {folder === null && scriptPath === null ? (
              <DialogDescription>
                <T>Choose a saved result to share.</T>
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogPanel>
            <div className="flex min-w-0 flex-col gap-4">
              {folder !== null ? (
                <p dir="auto" className="break-all text-sm text-muted-foreground">
                  {folder}
                </p>
              ) : scriptPath === null ? (
                <div className="flex flex-col items-stretch gap-1">
                  {busy ? (
                    <p role="status" className="text-sm">
                      <T>Loading saved results…</T>
                    </p>
                  ) : null}
                  {scripts.map(({ latest }) => (
                    <Button
                      type="button"
                      key={latest.revision}
                      size="sm-multiline"
                      variant="ghost-muted"
                      disabled={busy}
                      onClick={() => {
                        setScriptPath(latest.scriptPath);
                        void readInputs(latest.revision);
                      }}
                    >
                      <span dir="auto" className="min-w-0 break-all">
                        {latest.scriptPath}
                      </span>
                    </Button>
                  ))}
                </div>
              ) : (
                <>
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
                      <span dir="auto" className="min-w-0 break-all text-sm font-medium">
                        {scriptPath}
                      </span>
                      {props.scriptPath === undefined ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost-muted"
                          disabled={busy}
                          onClick={() => {
                            setScriptPath(null);
                            setRevision(null);
                            setInputs(null);
                            setMessage(null);
                          }}
                        >
                          <T>Change file</T>
                        </Button>
                      ) : null}
                    </div>
                    {history.error !== null ? (
                      <p role="alert" className="text-sm text-destructive">
                        {history.error}
                      </p>
                    ) : history.data === null ? (
                      <p role="status" className="text-sm text-muted-foreground">
                        <T>Loading revisions…</T>
                      </p>
                    ) : revisions.length === 0 ? (
                      <p className="text-sm">
                        <T>No saved revisions for this file.</T>
                      </p>
                    ) : (
                      <div className="flex min-w-0 flex-col gap-1">
                        <NativeSelect
                          aria-label={gt("Saved revision")}
                          aria-describedby={
                            selectedRevision?.parameters ? revisionParametersId : undefined
                          }
                          value={revision ?? ""}
                          disabled={busy}
                          onChange={(event) => {
                            const next = revisions.find(
                              (entry) => entry.value === event.target.value,
                            );
                            if (next !== undefined && next.value !== revision)
                              void readInputs(next.value);
                          }}
                        >
                          <option value="" disabled>
                            {gt("Choose a saved revision")}
                          </option>
                          {revisions.map(({ value, label, parameters }) => (
                            <option value={value} key={value}>
                              {value !== revision && parameters
                                ? `${label} · ${parameters}`
                                : label}
                            </option>
                          ))}
                        </NativeSelect>
                        {selectedRevision?.parameters ? (
                          <p
                            id={revisionParametersId}
                            dir="auto"
                            className="break-words text-xs text-muted-foreground tabular-nums"
                          >
                            {selectedRevision.parameters}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </div>

                  {ready && inputs !== null ? (
                    <>
                      <div className="space-y-1 text-xs text-muted-foreground">
                        <p>
                          <T>
                            The package includes the source, saved outputs, a README and a manifest.
                          </T>
                        </p>
                        {dataRemaining > 0 ? (
                          <p>
                            {gt(
                              "Supply {count, plural, one {# unchecked input} other {# unchecked inputs}} separately when rerunning.",
                              { count: dataRemaining },
                            )}
                          </p>
                        ) : null}
                      </div>
                      {code.length > 0 ? (
                        <PackageDisclosure title={<T>Code included automatically</T>}>
                          <ul className="grid gap-1 text-xs text-muted-foreground">
                            {code.map((path) => (
                              <li key={path} dir="auto" className="break-all">
                                {path}
                              </li>
                            ))}
                          </ul>
                        </PackageDisclosure>
                      ) : null}
                      <fieldset className="min-w-0 space-y-1">
                        <legend className="text-sm font-medium">
                          <T>Input files</T>
                        </legend>
                        {inputs.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            <T>No input files were recorded.</T>
                          </p>
                        ) : (
                          inputs.map((input) => (
                            <PackageFileChoice
                              key={input.path}
                              path={input.path}
                              size={input.size}
                              checked={selected.includes(input.path)}
                              disabled={busy || input.copyAvailable === false}
                              note={
                                input.copyAvailable === false
                                  ? gt("Copy unavailable")
                                  : input.changedSinceRun || input.changedDuringRun
                                    ? gt("Changed since the run")
                                    : undefined
                              }
                              onChange={(checked) =>
                                setSelected((values) =>
                                  checked
                                    ? [...values, input.path]
                                    : values.filter((value) => value !== input.path),
                                )
                              }
                            />
                          ))
                        )}
                      </fieldset>
                      {lockfiles.length === 0 ? null : (
                        <fieldset className="min-w-0 space-y-1">
                          <legend className="text-sm font-medium">
                            <T>Environment files</T>
                          </legend>
                          {lockfiles.map((file) => {
                            const available =
                              file.status === "ready" || file.status === "prefix-removed";
                            return (
                              <PackageFileChoice
                                key={file.path}
                                path={file.path}
                                size={file.size}
                                checked={available && !excludedLockfiles.includes(file.path)}
                                disabled={busy || !available}
                                note={
                                  file.status === "private-path"
                                    ? gt("Contains a home-folder path")
                                    : file.status === "unavailable"
                                      ? gt("Recorded copy unavailable")
                                      : file.status === "prefix-removed"
                                        ? gt("Machine-specific prefix removed")
                                        : undefined
                                }
                                onChange={(checked) =>
                                  setExcludedLockfiles((values) =>
                                    checked
                                      ? values.filter((path) => path !== file.path)
                                      : [...values, file.path],
                                  )
                                }
                              />
                            );
                          })}
                        </fieldset>
                      )}
                      {pickFolder === undefined ? (
                        <Field>
                          <FieldLabel>
                            <T>Save in folder on the Compute computer</T>
                          </FieldLabel>
                          <FieldControl
                            render={<Input dir="auto" />}
                            value={destination}
                            disabled={busy}
                            onChange={(event) => setDestination(event.target.value)}
                          />
                        </Field>
                      ) : null}
                    </>
                  ) : history.data !== null && busy ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      <T>Reading recorded files…</T>
                    </p>
                  ) : null}
                </>
              )}
              {warnings.length === 0 ? null : (
                <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                  {warnings.map((warning) => (
                    <li key={warning} className="break-words">
                      {warning}
                    </li>
                  ))}
                </ul>
              )}
              {message === null ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {message}
                </p>
              )}
            </div>
          </DialogPanel>
          {folder !== null ? (
            <DialogFooter>
              <DialogAction onClick={() => setOpen(false)}>
                <T>Done</T>
              </DialogAction>
            </DialogFooter>
          ) : ready && revision !== null ? (
            <DialogFooter>
              {saving && progress !== null ? (
                <p
                  role="status"
                  className="flex items-center gap-2 self-center text-xs text-muted-foreground tabular-nums sm:me-auto"
                >
                  <Spinner size="xs" aria-hidden />
                  {gt("{count} of {total} inputs checked · {bytes}", {
                    count: progress.filesHashed,
                    total: progress.totalFiles,
                    bytes: formatBytes(progress.bytesHashed),
                  })}
                </p>
              ) : null}
              <DialogAction
                disabled={busy || (pickFolder === undefined && destination.trim() === "")}
                onClick={() => void save(revision)}
              >
                {saving
                  ? gt("Saving…")
                  : pickFolder === undefined
                    ? gt("Save package")
                    : gt("Choose where to save…")}
              </DialogAction>
            </DialogFooter>
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}

function PackageFileChoice(props: {
  readonly path: string;
  readonly size: number | undefined;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly note: string | undefined;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 has-[[data-slot=checkbox]:not([data-disabled])]:cursor-pointer has-[[data-slot=checkbox]:not([data-disabled])]:hover:bg-accent">
      <Checkbox
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
      <span className="min-w-0 flex-1">
        <span dir="auto" className="block break-all text-sm font-medium">
          {props.path}
        </span>
        {props.note === undefined ? null : (
          <span className="block text-xs text-muted-foreground">{props.note}</span>
        )}
      </span>
      {props.size === undefined ? null : (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatBytes(props.size)}
        </span>
      )}
    </label>
  );
}
