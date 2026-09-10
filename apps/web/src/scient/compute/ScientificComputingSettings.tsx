import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  Download,
  ExternalLinkIcon,
  LoaderCircle,
  RefreshCwIcon,
  SigmaIcon,
  Trash2,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ComputeLanguageRuntimeInventory,
  ComputeLanguageRuntimeInspection,
  ComputeManagedRuntimeAction,
  ComputeManagedRuntimeStatus,
  ComputeRuntimeVerification,
  EnvironmentId,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import { ComputeLanguageId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "~/components/settings/settingsLayout";

export function inventoryStatusLabel(
  language: ComputeLanguageRuntimeInventory,
  enabled: boolean,
  verificationState: {
    pending: boolean;
    result: ComputeRuntimeVerification | null;
    error: string | null;
  } | null,
  selectedProblem: string | null = null,
): string {
  if (!enabled) return "Disabled";
  if (verificationState?.pending) return "Verifying…";
  if (verificationState?.error || language.failureMessage || selectedProblem) {
    return "Needs attention";
  }
  if (verificationState?.result?.connection === "verified") return "Verified";
  if (language.installations.length === 0) return "Not detected";
  if (language.installations.every((installation) => installation.problem !== null)) {
    return "Needs attention";
  }
  return language.installations.length === 1
    ? "Detected"
    : `${language.installations.length} detected`;
}

function runtimeSourceLabel(source: string): string {
  switch (source) {
    case "managed":
      return "Scient-managed";
    case "configured":
      return "Custom runtime";
    case "project":
      return "Project environment";
    case "path":
    case "conventional":
      return "System installation";
    default:
      return source;
  }
}

function RuntimePath({ value }: { readonly value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "runtime path",
    timeout: 1600,
  });
  return (
    <div className="group/runtime-path mt-1 flex min-w-0 items-center gap-0.5">
      <code className="min-w-0 truncate text-[11px] text-muted-foreground">{value}</code>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost-muted"
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/runtime-path:opacity-70 focus-visible:opacity-100"
              aria-label={isCopied ? "Runtime path copied" : "Copy runtime path"}
              onClick={() => copyToClipboard(value)}
            >
              {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </Button>
          }
        />
        <TooltipPopup side="top">{isCopied ? "Copied" : "Copy path"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function managedRuntimeOperationLabel(status: ComputeManagedRuntimeStatus): string | null {
  const operation = status.operation;
  if (operation === null) return null;
  switch (operation.phase) {
    case "downloading": {
      if (operation.downloadedBytes === null || operation.totalBytes === null) {
        return "Downloading the verified installer…";
      }
      const downloaded = Math.max(0.1, operation.downloadedBytes / (1024 * 1024)).toFixed(1);
      const total = Math.max(0.1, operation.totalBytes / (1024 * 1024)).toFixed(1);
      return `Downloading the verified installer · ${downloaded} of ${total} MB`;
    }
    case "installing-python":
      return "Installing private Python…";
    case "installing-packages":
      return status.displayName
        ? "Preparing the connection helper…"
        : "Installing the locked scientific packages…";
    case "verifying":
      return status.displayName
        ? "Checking the connection helper…"
        : "Verifying Python, Jupyter, data, and figures…";
    case "removing":
      return `Removing ${status.displayName ?? "Scient-managed Python"}…`;
  }
}

export function ManagedRuntimeCard(props: {
  readonly environmentId: EnvironmentId | null;
  readonly language: ComputeLanguageRuntimeInspection | ComputeLanguageRuntimeInventory;
  readonly enabled: boolean;
  readonly ensureEnabled: () => Promise<boolean>;
  readonly embedded?: boolean;
  readonly selected?: boolean;
  readonly separated?: boolean;
}) {
  const manageRuntime = useAtomCommand(computeEnvironment.manageRuntime, { reportFailure: false });
  const cancelRuntime = useAtomCommand(computeEnvironment.cancelManagedRuntime, {
    reportFailure: false,
  });
  const [actionPending, setActionPending] = useState(false);
  const [localFailure, setLocalFailure] = useState<string | null>(null);
  const [removeConfirmation, setRemoveConfirmation] = useState(false);
  const languageId = props.language.descriptor.languageId;
  const statusAtom =
    props.environmentId && props.language.managedRuntime !== null
      ? computeEnvironment.managedRuntime({
          environmentId: props.environmentId,
          input: { languageId },
        })
      : null;
  const queried = useEnvironmentQuery(statusAtom);
  const status = queried.data ?? props.language.managedRuntime;

  useEffect(() => {
    setLocalFailure(null);
    setRemoveConfirmation(false);
  }, [props.environmentId, languageId]);

  if (status === null) return null;
  const displayName = status.displayName ?? "Scientific Python";

  const runAction = async (action: ComputeManagedRuntimeAction) => {
    if (!props.environmentId || actionPending) return;
    setLocalFailure(null);
    setActionPending(true);
    if ((action === "install" || action === "use-managed") && !(await props.ensureEnabled())) {
      setLocalFailure(
        "Enable scientific sessions first, then try again. The setting could not be saved.",
      );
      setActionPending(false);
      return;
    }
    const result = await manageRuntime({
      environmentId: props.environmentId,
      input: { languageId, action },
    });
    setActionPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setLocalFailure(
        failure instanceof Error ? failure.message : `Scient could not manage ${displayName}.`,
      );
      return;
    }
  };

  const cancel = async () => {
    if (!props.environmentId) return;
    const result = await cancelRuntime({
      environmentId: props.environmentId,
      input: { languageId },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setLocalFailure(
        failure instanceof Error ? failure.message : "Scient could not cancel setup.",
      );
    }
  };

  const working = status.operation !== null || actionPending || queried.isPending;
  const existingRuntimeReady =
    "runtimes" in props.language
      ? props.language.runtimes.some(
          ({ profile, verification }) =>
            profile.source !== "managed" && verification.readiness === "ready",
        )
      : props.language.installations.some(
          (installation) => installation.source !== "managed" && installation.problem === null,
        );
  const progress = managedRuntimeOperationLabel(status);
  const failure = localFailure ?? queried.error ?? status.failureMessage;
  const managedCandidate =
    "runtimes" in props.language
      ? props.language.runtimes.find(({ profile }) => profile.source === "managed")
      : props.language.installations.find((installation) => installation.source === "managed");
  const managedExecutable =
    managedCandidate === undefined
      ? null
      : "profile" in managedCandidate
        ? managedCandidate.profile.executable
        : managedCandidate.executable;
  const needsRepair =
    (managedCandidate !== undefined &&
      ("verification" in managedCandidate
        ? managedCandidate.verification.readiness !== "ready"
        : managedCandidate.problem !== null)) ||
    (status.installed && status.selection === "managed" && status.failureMessage !== null);

  return (
    <>
      <div
        className={cn(
          "@container/managed-runtime",
          props.embedded
            ? cn("py-3", props.separated && "border-t border-border/50")
            : "mt-3 rounded-lg border border-border/60 bg-muted/20 p-3",
        )}
      >
        <div className="flex flex-col gap-3 @[32rem]/managed-runtime:flex-row @[32rem]/managed-runtime:items-start @[32rem]/managed-runtime:justify-between">
          <div className="min-w-0">
            {!props.embedded || !props.selected ? (
              <div className="flex items-center gap-2 text-sm font-medium">
                {props.embedded && languageId === "python" ? "Scient-managed" : displayName}
                {status.installed ? (
                  <span
                    className={`text-[11px] font-normal ${needsRepair ? "text-warning" : "text-success"}`}
                  >
                    {needsRepair
                      ? "Needs repair"
                      : status.selection === "managed" && props.enabled
                        ? status.displayName
                          ? "Selected"
                          : "In use"
                        : "Installed"}
                  </span>
                ) : null}
              </div>
            ) : null}
            {!props.embedded ? (
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                {status.description ??
                  "A private Python environment with NumPy, pandas, SciPy, Matplotlib, and Jupyter. Your system Python and project environments stay untouched."}
              </p>
            ) : null}
            {progress ? (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" /> {progress}
              </p>
            ) : null}
            {failure ? <p className="mt-2 text-xs text-destructive">{failure}</p> : null}
            {props.embedded && managedExecutable ? <RuntimePath value={managedExecutable} /> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {!status.installed ? (
              <Button
                size="xs"
                disabled={working || props.environmentId === null}
                onClick={() => void runAction("install")}
              >
                <Download /> Set up
              </Button>
            ) : props.embedded ? (
              <>
                {!props.selected ? (
                  <Button
                    size="xs"
                    disabled={working}
                    onClick={() => void runAction("use-managed")}
                  >
                    Use
                  </Button>
                ) : null}
                {status.updateAvailable ? (
                  <Button size="xs" disabled={working} onClick={() => void runAction("update")}>
                    <Download /> Update
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={working}
                  onClick={() => void runAction("repair")}
                >
                  <Wrench /> Repair
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={working}
                  onClick={() => setRemoveConfirmation(true)}
                  aria-label={`Remove ${displayName}`}
                >
                  <Trash2 /> Remove
                </Button>
              </>
            ) : (
              <>
                {status.selection === "managed" &&
                props.enabled &&
                (existingRuntimeReady || status.displayName) ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={working}
                    onClick={() => void runAction("use-existing")}
                  >
                    Use existing
                  </Button>
                ) : status.selection !== "managed" || !props.enabled ? (
                  <Button
                    size="xs"
                    disabled={working}
                    onClick={() => void runAction("use-managed")}
                  >
                    Use
                  </Button>
                ) : null}
                {status.updateAvailable ? (
                  <Button size="xs" disabled={working} onClick={() => void runAction("update")}>
                    <Download /> Update
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={working}
                  onClick={() => void runAction("repair")}
                >
                  <Wrench /> Repair
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={working}
                  onClick={() => setRemoveConfirmation(true)}
                  aria-label={`Remove ${displayName}`}
                >
                  <Trash2 /> Remove
                </Button>
              </>
            )}
            {status.operation !== null && status.operation.action !== "remove" ? (
              <Button size="xs" variant="ghost" onClick={() => void cancel()}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <AlertDialog open={removeConfirmation} onOpenChange={setRemoveConfirmation}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes only Scient&apos;s private {displayName}. System installations and
              project environments are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setRemoveConfirmation(false);
                void runAction("remove");
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function RuntimeDetails({
  language,
  enabled,
  onVerify,
  verificationState,
}: {
  language: ComputeLanguageRuntimeInspection;
  enabled: boolean;
  onVerify?: (executable: string) => void;
  verificationState?: {
    executable: string;
    pending: boolean;
    result: ComputeRuntimeVerification | null;
    error: string | null;
  } | null;
}) {
  if (!enabled || language.runtimes.length === 0) return null;
  return (
    <div className="space-y-1">
      {language.runtimes.map(({ profile, verification: detected, toolkits }) => {
        const state =
          verificationState?.executable === profile.executable ? verificationState : null;
        const verification = state?.result ?? detected;
        return (
          <div
            key={`${profile.source}:${profile.executable}`}
            className="min-w-0 rounded-lg border border-border/50 px-3 py-2.5 text-xs"
          >
            <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground/90">{profile.displayName}</div>
                <div className="text-muted-foreground">
                  {runtimeSourceLabel(profile.source)}
                  {profile.architecture ? ` · ${profile.architecture}` : ""}
                </div>
                <RuntimePath value={profile.executable} />
              </div>
              <div
                className={
                  verification.readiness === "ready"
                    ? "shrink-0 text-success"
                    : "max-w-64 shrink-0 text-right text-warning"
                }
              >
                {verification.readiness === "ready"
                  ? verification.connection === "detected"
                    ? "Detected"
                    : verification.connection === "verified"
                      ? "Verified"
                      : "Ready"
                  : verification.missingRequirements.length > 0
                    ? `Missing: ${verification.missingRequirements.join(", ")}`
                    : verification.readiness === "unusable"
                      ? "Needs attention"
                      : verification.readiness.replaceAll("-", " ")}
              </div>
            </div>
            {onVerify && detected.connection === "detected" ? (
              <Button
                size="xs"
                variant="outline"
                className="mt-2"
                disabled={verificationState?.pending}
                onClick={() => onVerify(profile.executable)}
              >
                {state?.pending ? <LoaderCircle className="size-3 animate-spin" /> : null}
                {state?.pending ? "Verifying connection…" : "Verify connection"}
              </Button>
            ) : null}
            {state?.error ? (
              <p className="mt-1 text-xs text-destructive" role="alert">
                {state.error}
              </p>
            ) : null}
            {verification.message !== null ? (
              <p className="mt-2 max-w-2xl text-[11px] leading-snug text-muted-foreground">
                {verification.message}
              </p>
            ) : null}
            {toolkits.map((toolkit) =>
              toolkit.readiness === "missing-requirement" ? (
                <p key={toolkit.toolkitId} className="mt-1 text-[11px] text-warning">
                  {language.toolkits.find(
                    (descriptor) => descriptor.toolkitId === toolkit.toolkitId,
                  )?.displayName ?? "Scientific packages"}
                  : missing {toolkit.missingRequirements.join(", ")}
                </p>
              ) : null,
            )}
          </div>
        );
      })}
    </div>
  );
}

export function RuntimeInventoryDetails({
  language,
  onVerify,
  onUse,
  verificationState,
  excludedExecutables = [],
}: {
  readonly language: ComputeLanguageRuntimeInventory;
  readonly onVerify: (executable: string) => void;
  readonly onUse?: ((executable: string) => void) | undefined;
  readonly excludedExecutables?: ReadonlyArray<string>;
  readonly verificationState: {
    executable: string;
    pending: boolean;
    result: ComputeRuntimeVerification | null;
    error: string | null;
  } | null;
}) {
  if (!language.enabled || language.installations.length === 0) return null;
  return (
    <div>
      {language.installations
        .filter((installation) => !excludedExecutables.includes(installation.executable))
        .map((installation) => {
          const state =
            verificationState?.executable === installation.executable ? verificationState : null;
          const status = state?.pending
            ? "Verifying…"
            : state?.result?.connection === "verified"
              ? "Verified"
              : state?.error || installation.problem
                ? "Needs attention"
                : "Detected";
          return (
            <div
              key={`${installation.source}:${installation.executable}`}
              className="min-w-0 border-t border-border/50 py-3 text-xs"
            >
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground/90">
                    {runtimeSourceLabel(installation.source)}
                  </div>
                  {installation.version ? (
                    <div className="mt-0.5 text-muted-foreground">{installation.version}</div>
                  ) : null}
                  <RuntimePath value={installation.executable} />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={cn(
                      "text-xs",
                      status === "Verified"
                        ? "text-success"
                        : status === "Detected"
                          ? "text-muted-foreground"
                          : "text-warning",
                    )}
                  >
                    {status}
                  </span>
                  {onUse ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onUse(installation.executable)}
                    >
                      Use
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={state?.pending}
                      onClick={() => onVerify(installation.executable)}
                    >
                      {state?.pending ? <LoaderCircle className="animate-spin" /> : null}
                      {state?.pending ? "Verifying…" : "Verify"}
                    </Button>
                  )}
                </div>
              </div>
              {state?.error || installation.problem ? (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {state?.error ?? installation.problem}
                </p>
              ) : null}
              {state?.result?.message ? (
                <p className="mt-2 text-xs text-muted-foreground">{state.result.message}</p>
              ) : null}
            </div>
          );
        })}
    </div>
  );
}

function LanguageSettingsRow({
  language,
  preference,
  onChange,
  environmentId,
  loading,
  refreshing,
  refreshRevision,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
  environmentId: EnvironmentId | null;
  loading?: boolean;
  refreshing: boolean;
  refreshRevision: number;
}) {
  const [executableDraft, setExecutableDraft] = useState(() => ({
    source: preference.executable,
    value: preference.executable,
  }));
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [customPathRequested, setCustomPathRequested] = useState(false);
  const verifyRuntime = useAtomCommand(computeEnvironment.verifyRuntime, { reportFailure: false });
  const [verificationState, setVerificationState] = useState<
    | (Exclude<Parameters<typeof RuntimeDetails>[0]["verificationState"], undefined | null> & {
        scopeKey: string;
      })
    | null
  >(null);
  const verificationEpoch = useRef(0);
  const verificationScopeKey = JSON.stringify([
    environmentId,
    language.installations.map(({ executable, problem, version }) => [
      executable,
      problem,
      version,
    ]),
    refreshRevision,
    preference.executable,
    preference.enabled,
    language.managedRuntime?.generationId,
    language.managedRuntime?.selection,
  ]);
  const visibleVerificationState =
    verificationState?.scopeKey === verificationScopeKey ? verificationState : null;
  const verify = async (path: string) => {
    if (environmentId === null) return;
    const epoch = ++verificationEpoch.current;
    const scopeKey = verificationScopeKey;
    setVerificationState({ scopeKey, executable: path, pending: true, result: null, error: null });
    const result = await verifyRuntime({
      environmentId,
      input: { cwd: null, languageId: language.descriptor.languageId, executable: path },
    });
    if (epoch !== verificationEpoch.current) return;
    const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    setVerificationState({
      scopeKey,
      executable: path,
      pending: false,
      result: result._tag === "Success" ? result.value : null,
      error:
        failure === null
          ? null
          : failure instanceof Error
            ? failure.message
            : "The connection could not be verified.",
    });
  };

  const executable =
    executableDraft.source === preference.executable
      ? executableDraft.value
      : preference.executable;

  const persistExecutable = () => {
    const next = executable.trim();
    if (next !== preference.executable) void onChange({ ...preference, executable: next });
    setExecutableDraft({ source: next, value: next });
  };

  const configured = preference.executable.trim();
  const configuredInstallation = language.installations.find(
    (installation) => installation.executable === configured,
  );
  const customPathOpen = customPathRequested;
  const selectedInstallation =
    language.installations.find(
      (installation) =>
        language.managedRuntime?.selection === "managed" && installation.source === "managed",
    ) ??
    configuredInstallation ??
    language.installations[0];
  const selectedVerificationState =
    visibleVerificationState?.executable === selectedInstallation?.executable
      ? visibleVerificationState
      : null;
  const canVerify =
    !loading && !refreshing && preference.enabled && selectedInstallation?.problem === null;
  const isMatlab = language.descriptor.languageId === "matlab";
  const isManagedSelected = selectedInstallation?.source === "managed";
  const managedRuntimeRepresentsInstallation = !isMatlab && language.managedRuntime !== null;
  const managedExecutable = language.installations.find(
    (installation) => installation.source === "managed",
  )?.executable;
  const alternativeExclusions = [
    ...(selectedInstallation ? [selectedInstallation.executable] : []),
    ...(managedRuntimeRepresentsInstallation && managedExecutable ? [managedExecutable] : []),
  ];

  return (
    <section className="space-y-2" aria-labelledby={`${language.descriptor.languageId}-heading`}>
      <h3
        id={`${language.descriptor.languageId}-heading`}
        className="px-3 text-sm font-normal text-foreground/70 sm:px-4"
      >
        {language.descriptor.displayName}
      </h3>
      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <div className="rounded-xl border border-border/60 bg-card/40 shadow-xs/5">
          <div className="flex flex-col gap-3 px-3 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6 sm:px-4">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">
                  {loading
                    ? "Checking installations"
                    : (selectedInstallation?.version ??
                      (selectedInstallation
                        ? runtimeSourceLabel(selectedInstallation.source)
                        : "No installation detected"))}
                </span>
                <span
                  className={cn(
                    "text-xs",
                    !preference.enabled
                      ? "text-muted-foreground"
                      : selectedVerificationState?.result?.connection === "verified"
                        ? "text-success"
                        : language.failureMessage ||
                            selectedVerificationState?.error ||
                            selectedInstallation?.problem
                          ? "text-warning"
                          : "text-muted-foreground",
                  )}
                >
                  {loading
                    ? "Checking…"
                    : inventoryStatusLabel(
                        language,
                        preference.enabled,
                        selectedVerificationState,
                        selectedInstallation?.problem,
                      )}
                </span>
              </div>
              {selectedInstallation?.version ? (
                <p className="mt-1 text-[13px] text-muted-foreground/80">
                  {runtimeSourceLabel(selectedInstallation.source)}
                </p>
              ) : !selectedInstallation ? (
                <p className="mt-1 text-[13px] text-muted-foreground/80">
                  {configured === "" ? "Automatic detection" : "Custom path"}
                </p>
              ) : null}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 sm:justify-end">
              {canVerify ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={selectedVerificationState?.pending}
                  onClick={() => void verify(selectedInstallation.executable)}
                >
                  {selectedVerificationState?.pending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}
                  {selectedVerificationState?.pending ? "Verifying…" : "Verify connection"}
                </Button>
              ) : preference.enabled && isMatlab && language.installations.length === 0 ? (
                <Button
                  size="xs"
                  variant="outline"
                  render={
                    <a
                      href="https://www.mathworks.com/products/matlab.html"
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  Get MATLAB <ExternalLinkIcon />
                </Button>
              ) : null}
              <CollapsibleTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    aria-label={`${detailsOpen ? "Hide" : "Show"} ${language.descriptor.displayName} details`}
                  />
                }
              >
                Manage
                <ChevronDownIcon
                  className={cn("transition-transform", detailsOpen && "rotate-180")}
                />
              </CollapsibleTrigger>
              <Switch
                checked={preference.enabled}
                disabled={loading}
                onCheckedChange={(enabled) => void onChange({ ...preference, enabled })}
                aria-label={`Enable ${language.descriptor.displayName}`}
              />
            </div>
          </div>
          <CollapsiblePanel>
            <div className="border-t border-border/50 px-3 pb-3 sm:px-4">
              {isManagedSelected && managedRuntimeRepresentsInstallation ? (
                <ManagedRuntimeCard
                  embedded
                  selected
                  environmentId={environmentId}
                  language={language}
                  enabled={preference.enabled}
                  ensureEnabled={async () =>
                    preference.enabled || (await onChange({ ...preference, enabled: true }))
                  }
                />
              ) : selectedInstallation ? (
                <div className="py-3">
                  <RuntimePath value={selectedInstallation.executable} />
                </div>
              ) : null}
              {language.managedRuntime !== null &&
              (!managedRuntimeRepresentsInstallation || !isManagedSelected) ? (
                <ManagedRuntimeCard
                  embedded
                  separated={selectedInstallation !== undefined}
                  environmentId={environmentId}
                  language={language}
                  enabled={preference.enabled}
                  ensureEnabled={async () =>
                    preference.enabled || (await onChange({ ...preference, enabled: true }))
                  }
                />
              ) : null}
              <RuntimeInventoryDetails
                language={language}
                onVerify={(path) => void verify(path)}
                onUse={(path) => {
                  setCustomPathRequested(false);
                  void onChange({ ...preference, executable: path });
                }}
                verificationState={visibleVerificationState}
                excludedExecutables={alternativeExclusions}
              />
              <div className="border-t border-border/50 pt-2">
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={!preference.enabled}
                  onClick={() => setCustomPathRequested(!customPathOpen)}
                >
                  Advanced path
                  <ChevronDownIcon
                    className={cn("transition-transform", customPathOpen && "rotate-180")}
                  />
                </Button>
                {customPathOpen ? (
                  <div className="mt-2 flex items-center gap-2">
                    <Input
                      nativeInput
                      size="compact"
                      value={executable}
                      disabled={!preference.enabled}
                      placeholder="Executable path"
                      aria-label={`${language.descriptor.displayName} executable`}
                      onChange={(event) =>
                        setExecutableDraft({
                          source: preference.executable,
                          value: event.currentTarget.value,
                        })
                      }
                      onBlur={persistExecutable}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          persistExecutable();
                          event.currentTarget.blur();
                        }
                      }}
                    />
                    {configured !== "" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setExecutableDraft({ source: "", value: "" });
                          setCustomPathRequested(false);
                          void onChange({ ...preference, executable: "" });
                        }}
                      >
                        Use automatic
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </CollapsiblePanel>
        </div>
      </Collapsible>
    </section>
  );
}

const PENDING_RUNTIME_DESCRIPTORS = [
  {
    languageId: ComputeLanguageId.make("python"),
    displayName: "Python",
    sourceExtensions: [".py"],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  },
  {
    languageId: ComputeLanguageId.make("matlab"),
    displayName: "MATLAB",
    sourceExtensions: [".m"],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  },
] as const;

function pendingRuntimeInventory(
  preferences: Readonly<Record<string, ScientificComputingLanguageSettings>>,
): ReadonlyArray<ComputeLanguageRuntimeInventory> {
  return PENDING_RUNTIME_DESCRIPTORS.map((descriptor) => {
    const preference = preferences[descriptor.languageId] ?? { enabled: false, executable: "" };
    return {
      descriptor,
      enabled: preference.enabled,
      configuredExecutable: preference.executable || null,
      managedRuntime: null,
      toolkits: [],
      installations: [],
      failureMessage: null,
    };
  });
}

export function ScientificComputingSettings(
  props: { environmentId?: EnvironmentId | undefined } = {},
) {
  const primaryId = usePrimaryEnvironmentId();
  const environmentId = props.environmentId ?? primaryId;
  const environment = useEnvironment(environmentId);
  if (environmentId === null || environment === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Scientific Computing">
          <p className="text-sm text-muted-foreground">
            This server is unavailable. Reconnect it to manage scientific runtimes.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <EnvironmentScientificComputingSettings
      key={environmentId}
      environmentId={environmentId}
      label={environment.label}
    />
  );
}

function EnvironmentScientificComputingSettings({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const preferences = useEnvironmentSettings(
    environmentId,
    (settings) => settings.scientificComputing,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const refreshRuntimes = useAtomCommand(computeEnvironment.refreshRuntimeInventory, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const runtimesAtom = environmentId
    ? computeEnvironment.runtimeInventory({
        environmentId,
        input: {},
      })
    : null;
  const runtimes = useEnvironmentQuery(runtimesAtom);
  const inventoryPending = runtimes.data === undefined && runtimes.error === null;
  const displayedLanguages =
    runtimes.data?.languages ?? pendingRuntimeInventory(preferences.languages);

  const updateLanguage = async (
    languageId: ComputeLanguageRuntimeInventory["descriptor"]["languageId"],
    next: ScientificComputingLanguageSettings,
  ) => {
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          scientificComputing: {
            schemaVersion: 1,
            languages: { [languageId]: next },
          },
        },
      },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setRefreshFailure(
        failure instanceof Error ? failure.message : "The setting could not be saved.",
      );
      return false;
    }
    setRefreshFailure(null);
    return true;
  };

  const handleRefresh = useCallback(async () => {
    if (environmentId === null) return;
    setRefreshFailure(null);
    setRefreshRevision((revision) => revision + 1);
    setRefreshing(true);
    const result = await refreshRuntimes({
      environmentId,
      input: {},
    });
    setRefreshing(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setRefreshFailure(
        failure instanceof Error
          ? failure.message
          : "Scient could not refresh scientific runtimes.",
      );
      return;
    }
    setRefreshFailure(null);
  }, [environmentId, refreshRuntimes]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="scientific-computing"
        title="Scientific Computing"
        icon={<SigmaIcon className="size-4 text-muted-foreground" />}
        variant="plain"
        headerAction={
          <div className="flex items-center gap-1.5">
            <span className="hidden text-xs text-muted-foreground sm:inline">{label}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={runtimes.isPending || refreshing}
                    aria-label="Refresh scientific runtimes"
                    onClick={() => void handleRefresh()}
                  >
                    <RefreshCwIcon
                      className={cn(runtimes.isPending || refreshing ? "animate-spin" : undefined)}
                    />
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh runtimes</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <div className="space-y-5">
          {displayedLanguages.map((language) => {
            const preference = preferences.languages[language.descriptor.languageId] ?? {
              enabled: false,
              executable: language.configuredExecutable ?? "",
            };
            return (
              <LanguageSettingsRow
                key={language.descriptor.languageId}
                language={language}
                preference={preference}
                onChange={(next) => updateLanguage(language.descriptor.languageId, next)}
                environmentId={environmentId}
                loading={inventoryPending}
                refreshing={refreshing}
                refreshRevision={refreshRevision}
              />
            );
          })}
          {(refreshFailure ?? runtimes.error) ? (
            <p className="px-4 py-3 text-xs text-destructive" role="alert">
              {refreshFailure ?? runtimes.error}
            </p>
          ) : null}
          <div className="mx-auto w-full max-w-xl rounded-xl border border-dashed border-border/60 bg-muted/15 px-4 py-5 text-center">
            <p className="text-sm font-medium text-foreground/85">
              More scientific tools are coming soon
            </p>
            <p className="mt-1 text-xs text-muted-foreground/80">
              Additional languages and purpose-built scientific workflows are on the way.
            </p>
          </div>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
