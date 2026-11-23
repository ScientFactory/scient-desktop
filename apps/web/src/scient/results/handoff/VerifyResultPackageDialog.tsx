import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ResultHandoffOutputFinding,
  ResultHandoffVerifyResult,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogAction,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";
import { Field, FieldControl, FieldDescription, FieldLabel } from "~/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Spinner } from "~/components/ui/spinner";
import { Input } from "~/components/ui/input";
import { useFileContextMenu } from "~/fileContextMenu";
import { randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { computeEnvironment } from "~/state/compute";
import { localEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useAtomCommand } from "~/state/use-atom-command";
import { resultErrorMessage } from "../resultState";
import { PackageDisclosure } from "./PackageDisclosure";

export function VerifyResultPackageDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly open: boolean;
  readonly onClose: (keepMounted: boolean) => void;
  readonly onReopen: () => void;
}) {
  const gt = useGT();
  const { environmentId, cwd, onClose } = props;
  const local = useAtomValue(localEnvironmentIdAtom);
  const picker =
    environmentId === local && window.desktopBridge
      ? readLocalApi()?.dialogs.pickFolder
      : undefined;
  const verify = useAtomCommand(computeEnvironment.resultsVerify, { reportFailure: false });
  const cancelVerification = useAtomCommand(computeEnvironment.resultsCancelVerification, {
    reportFailure: false,
  });
  const files = useFileContextMenu(environmentId);

  const [packageFolder, setPackageFolder] = useState("");
  const [inputsOpen, setInputsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inputsFolder, setInputsFolder] = useState("");
  const [executable, setExecutable] = useState("");
  const [absolute, setAbsolute] = useState("1e-12");
  const [relative, setRelative] = useState("1e-9");
  const [verifierName, setVerifierName] = useState("");
  const [timeout, setTimeoutMinutes] = useState("60");
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const busy = verificationId !== null;
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ResultHandoffVerifyResult | null>(null);

  const backgroundStatus = busy
    ? gt("Result package verification is running")
    : result?.report.status === "cancelled"
      ? gt("Result package verification was cancelled")
      : result !== null
        ? gt("Result package verification finished")
        : message;
  const reopenLabel = gt("View verification");
  const { onReopen, open } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sync the persistent toast with the hidden dialog and verification result
  useEffect(() => {
    if (open || backgroundStatus === null) return;
    const id = toastManager.add({
      type: "info",
      timeout: 0,
      title: backgroundStatus,
      actionProps: { children: reopenLabel, onClick: onReopen },
    });
    return () => toastManager.close(id);
  }, [open, backgroundStatus, reopenLabel, onReopen]);

  const close = () => onClose(busy);
  const choose = async (set: (path: string) => void) => {
    if (!picker) return;
    const path = await picker(cwd === null ? undefined : { initialPath: cwd }).catch(() => null);
    if (path) set(path);
  };

  const absoluteTolerance = Number(absolute);
  const relativeTolerance = Number(relative);
  const timeoutMinutes = Number(timeout);
  const invalidAbsolute =
    absolute.trim() === "" || !Number.isFinite(absoluteTolerance) || absoluteTolerance < 0;
  const invalidRelative =
    relative.trim() === "" || !Number.isFinite(relativeTolerance) || relativeTolerance < 0;
  const invalidTimeout = !Number.isSafeInteger(timeoutMinutes) || timeoutMinutes < 1;
  const invalidSettings = invalidAbsolute || invalidRelative || invalidTimeout;
  const ready = packageFolder.trim() !== "" && !invalidSettings;

  const run = async () => {
    if (!ready || busy) return;
    const id = randomUUID();
    setVerificationId(id);
    setMessage(null);
    const outcome = await verify({
      environmentId,
      input: {
        packageFolder: packageFolder.trim(),
        ...(inputsFolder.trim() === "" ? {} : { inputsFolder: inputsFolder.trim() }),
        ...(executable.trim() === "" ? {} : { executable: executable.trim() }),
        ...(verifierName.trim() === "" ? {} : { verifierName: verifierName.trim() }),
        absoluteTolerance,
        relativeTolerance,
        timeoutMinutes,
        verificationId: id,
        allowExecution: true,
      },
    });
    if (outcome._tag === "Success") {
      setResult(outcome.value);
      if (outcome.value.report.files.some((file) => file.separatelySupplied)) setInputsOpen(true);
    } else setMessage(resultErrorMessage(outcome, gt("The result package could not be verified.")));
    setVerificationId(null);
    setCancelling(false);
  };

  const cancel = async () => {
    if (verificationId === null || cancelling) return;
    setCancelling(true);
    const outcome = await cancelVerification({ environmentId, input: { verificationId } });
    if (outcome._tag !== "Success" || !outcome.value.requested) {
      setCancelling(false);
      setMessage(
        resultErrorMessage(
          outcome,
          gt(
            "The cancellation could not be requested. Try again if the verification is still running.",
          ),
        ),
      );
    }
  };

  const openFile = (filePath: string) =>
    files.activate("open", {
      environmentId,
      filePath,
      workspaceRoot: undefined,
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPopup layer="above-popovers" gap="none">
        <DialogHeader>
          <DialogTitle>
            <T>Verify a result package</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {result === null ? (
            <div className="flex min-w-0 flex-col gap-4">
              <Alert variant="warning" controlAlignment="first-line">
                <TriangleAlertIcon aria-hidden />
                <AlertDescription>
                  <T>
                    This runs someone else’s code with access to files on the Compute computer.
                    Continue only if you trust the code.
                  </T>
                </AlertDescription>
              </Alert>
              <VerificationFolderField
                label={gt("Package folder")}
                chooseLabel={gt("Choose package folder")}
                value={packageFolder}
                onChange={setPackageFolder}
                disabled={busy}
                onChoose={picker ? () => void choose(setPackageFolder) : undefined}
              />
              <PackageDisclosure
                title={<T>Separately supplied inputs</T>}
                summary={inputsFolder.trim() === "" ? undefined : <bdi>{inputsFolder}</bdi>}
                open={inputsOpen}
                onOpenChange={setInputsOpen}
              >
                <VerificationFolderField
                  label={gt("Folder with separately supplied inputs")}
                  chooseLabel={gt("Choose separately supplied inputs folder")}
                  value={inputsFolder}
                  onChange={setInputsFolder}
                  disabled={busy}
                  onChoose={picker ? () => void choose(setInputsFolder) : undefined}
                />
              </PackageDisclosure>
              <PackageDisclosure
                title={<T>Verification settings</T>}
                summary={
                  invalidSettings ? (
                    gt("Check tolerances and time limit")
                  ) : (
                    <>
                      <span className="block">
                        {executable.trim() === "" ? (
                          gt("Automatic runtime")
                        ) : (
                          <bdi>{executable}</bdi>
                        )}
                        {" · "}
                        {gt("{minutes} min", { minutes: timeoutMinutes })}
                      </span>
                      <span className="block">
                        {gt("Tolerances {absolute} absolute · {relative} relative", {
                          absolute,
                          relative,
                        })}
                      </span>
                      <span className="block">
                        {verifierName.trim() === "" ? (
                          gt("No name on report")
                        ) : (
                          <bdi>{verifierName}</bdi>
                        )}
                      </span>
                    </>
                  )
                }
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
              >
                <div className="grid min-w-0 gap-3 tabular-nums">
                  <Field>
                    <FieldLabel>
                      <T>Runtime executable path</T>
                    </FieldLabel>
                    <FieldControl
                      render={<Input dir="auto" />}
                      value={executable}
                      disabled={busy}
                      placeholder={gt("Automatic")}
                      onChange={(event) => setExecutable(event.target.value)}
                    />
                  </Field>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <Field invalid={invalidAbsolute}>
                      <FieldLabel>
                        <T>Absolute tolerance</T>
                      </FieldLabel>
                      <FieldControl
                        render={<Input dir="ltr" />}
                        value={absolute}
                        disabled={busy}
                        onChange={(event) => setAbsolute(event.target.value)}
                      />
                      {invalidAbsolute ? (
                        <FieldDescription>
                          <T>Enter a non-negative number.</T>
                        </FieldDescription>
                      ) : null}
                    </Field>
                    <Field invalid={invalidRelative}>
                      <FieldLabel>
                        <T>Relative tolerance</T>
                      </FieldLabel>
                      <FieldControl
                        render={<Input dir="ltr" />}
                        value={relative}
                        disabled={busy}
                        onChange={(event) => setRelative(event.target.value)}
                      />
                      {invalidRelative ? (
                        <FieldDescription>
                          <T>Enter a non-negative number.</T>
                        </FieldDescription>
                      ) : null}
                    </Field>
                  </div>
                  <Field invalid={invalidTimeout}>
                    <FieldLabel>
                      <T>Rerun time limit (minutes)</T>
                    </FieldLabel>
                    <FieldControl
                      render={<Input dir="ltr" inputMode="numeric" />}
                      value={timeout}
                      disabled={busy}
                      onChange={(event) => setTimeoutMinutes(event.target.value)}
                    />
                    {invalidTimeout ? (
                      <FieldDescription>
                        <T>Enter a positive whole number.</T>
                      </FieldDescription>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel>
                      <T>Your name on the report (optional)</T>
                    </FieldLabel>
                    <FieldControl
                      render={<Input dir="auto" maxLength={200} />}
                      value={verifierName}
                      disabled={busy}
                      onChange={(event) => setVerifierName(event.target.value)}
                    />
                  </Field>
                </div>
              </PackageDisclosure>
              {message === null ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {message}
                </p>
              )}
            </div>
          ) : (
            <VerificationOutcome
              result={result}
              openFile={files.capabilities.canOpenDefault ? openFile : undefined}
            />
          )}
        </DialogPanel>
        <DialogFooter>
          {busy ? (
            <>
              <p
                role="status"
                className="flex items-center gap-2 self-center text-xs text-muted-foreground sm:me-auto"
              >
                <Spinner size="xs" aria-hidden />
                {cancelling ? gt("Cancelling…") : gt("Running verification…")}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                <T>Cancel verification</T>
              </Button>
            </>
          ) : result === null ? (
            <DialogAction type="button" disabled={!ready} onClick={() => void run()}>
              <T>Run and verify</T>
            </DialogAction>
          ) : result.report.status === "verified" ? (
            <DialogAction type="button" onClick={close}>
              <T>Done</T>
            </DialogAction>
          ) : (
            <DialogAction type="button" onClick={() => setResult(null)}>
              <T>Try again</T>
            </DialogAction>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function VerificationFolderField(props: {
  readonly label: string;
  readonly chooseLabel: string;
  readonly value: string;
  readonly onChange: (path: string) => void;
  readonly disabled: boolean;
  readonly onChoose: (() => void) | undefined;
}) {
  return (
    <Field>
      <FieldLabel>{props.label}</FieldLabel>
      <InputGroup>
        <FieldControl
          render={<InputGroupInput dir="auto" />}
          value={props.value}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}
        />
        {props.onChoose === undefined ? null : (
          <InputGroupAddon align="inline-end">
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-label={props.chooseLabel}
              disabled={props.disabled}
              onClick={props.onChoose}
            >
              <T>Choose…</T>
            </Button>
          </InputGroupAddon>
        )}
      </InputGroup>
    </Field>
  );
}

function VerificationOutcome(props: {
  readonly result: ResultHandoffVerifyResult;
  readonly openFile: ((path: string) => Promise<void>) | undefined;
}) {
  const gt = useGT();
  const { report, reportPath, figures } = props.result;
  const matched = report.outputs.filter((output) => output.status === "matched");
  const other = report.outputs.filter((output) => output.status !== "matched");
  const files = report.files.filter(
    (file) => file.status !== "matched" || file.message !== undefined,
  );
  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm">
      <p role="status" className="font-semibold">
        {report.status === "verified"
          ? gt("Verified")
          : report.status === "differs"
            ? gt("Differs")
            : report.status === "cancelled"
              ? gt("Cancelled")
              : gt("Could not run")}
      </p>
      {report.message === undefined || report.status === "cancelled" ? null : (
        <p>{report.message}</p>
      )}
      {report.outputs.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">
            <T>Outputs</T>
          </h3>
          {other.length === 0 ? null : <VerificationOutputs outputs={other} />}
          {matched.length === 0 ? null : (
            <PackageDisclosure
              title={gt("{count, plural, one {# matched output} other {# matched outputs}}", {
                count: matched.length,
              })}
            >
              <VerificationOutputs outputs={matched} />
            </PackageDisclosure>
          )}
        </section>
      )}
      {files.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">
            <T>Package file checks</T>
          </h3>
          <ul className="flex flex-col gap-1">
            {files.map((file) => (
              <li
                key={`${file.path}:${file.status}:${file.message ?? ""}`}
                dir="auto"
                className="break-all"
              >
                <span className="font-medium">{file.path}</span>
                {file.message ? ` · ${file.message}` : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      {figures.map((figure) => (
        <section key={figure.name} className="flex flex-col gap-1">
          <h3 dir="auto" className="font-medium">
            {figure.name}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {[
              {
                title: gt("Saved figure"),
                path: figure.originalPath,
                preview: figure.originalPreview,
              },
              { title: gt("Rerun figure"), path: figure.rerunPath, preview: figure.rerunPreview },
            ].map(({ title, path, preview }) => (
              <figure key={title} className="flex min-w-0 flex-col gap-1">
                <figcaption>{title}</figcaption>
                {preview === undefined ? (
                  props.openFile === undefined ? (
                    <span dir="auto" className="break-all">
                      {path}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void props.openFile?.(path)}
                    >
                      <T>Open figure</T>
                    </Button>
                  )
                ) : (
                  <img
                    className="h-auto max-w-full object-contain"
                    alt={title}
                    src={`data:${figure.mediaType};base64,${preview}`}
                  />
                )}
              </figure>
            ))}
          </div>
        </section>
      ))}
      {report.environment === null && report.environmentChanges.length === 0 ? null : (
        <PackageDisclosure
          title={gt("Rerun environment · {count, plural, one {# change} other {# changes}}", {
            count: report.environmentChanges.length,
          })}
        >
          {report.environment === null ? null : (
            <p className="text-muted-foreground" dir="auto">
              {[
                report.environment.version ?? report.environment.language,
                report.environment.platform,
                report.environment.architecture,
              ].join(" · ")}
            </p>
          )}
          {report.environmentChanges.length === 0 ? null : (
            <ul className="flex flex-col gap-1">
              {report.environmentChanges.map((change) => (
                <li key={change.name} dir="auto">
                  {gt("{name} changed from {recorded} to {rerun}", {
                    name: change.name,
                    recorded: change.recorded ?? gt("unknown"),
                    rerun: change.rerun ?? gt("unknown"),
                  })}
                </li>
              ))}
            </ul>
          )}
        </PackageDisclosure>
      )}
      {props.openFile === undefined ? (
        <p dir="auto" className="break-all">
          {reportPath}
        </p>
      ) : (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void props.openFile?.(reportPath)}
          >
            <T>Open verification report</T>
          </Button>
        </div>
      )}
    </div>
  );
}

function VerificationOutputs(props: {
  readonly outputs: ReadonlyArray<ResultHandoffOutputFinding>;
}) {
  const gt = useGT();
  return (
    <ul className="flex flex-col gap-2">
      {props.outputs.map((file) => (
        <li key={file.path} dir="auto" className="break-words">
          <bdi className="font-medium">{file.path}</bdi>
          {" · "}
          {file.status === "matched"
            ? file.maxAbsoluteError && file.maxAbsoluteError.error > 0
              ? gt("Matched within tolerance")
              : gt("Matched")
            : file.status === "differs"
              ? file.differenceCount === undefined
                ? gt("Differs")
                : gt("{count, plural, one {# value differs} other {# values differ}}", {
                    count: file.differenceCount,
                  })
              : gt("Not compared")}
          {file.message ? ` · ${file.message}` : null}
          {file.values === undefined ? null : (
            <ul className="ps-4">
              {file.values.map((value) => (
                <li key={value.pointer}>
                  {gt("{field}: saved {before}, rerun {after}", {
                    field: value.pointer || gt("Value"),
                    before: value.expected ?? gt("missing"),
                    after: value.actual ?? gt("missing"),
                  })}
                  {value.absoluteDifference === undefined ? null : (
                    <>
                      {" · "}
                      {gt("absolute difference {difference}", {
                        difference: String(value.absoluteDifference),
                      })}
                    </>
                  )}
                  {value.relativeDifference === undefined ? null : (
                    <>
                      {" · "}
                      {gt("relative difference {difference}", {
                        difference: String(value.relativeDifference),
                      })}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
