import { Download, LoaderCircle, RefreshCwIcon, SigmaIcon, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ComputeLanguageRuntimeInspection,
  ComputeManagedRuntimeAction,
  ComputeManagedRuntimeStatus,
  ComputeRuntimeVerification,
  EnvironmentId,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
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
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";

function readinessLabel(language: ComputeLanguageRuntimeInspection, enabled: boolean): string {
  if (!enabled) return "Disabled";
  if (language.runtimes.length === 0) return "No compatible runtime detected";
  const ready = language.runtimes.filter(
    (candidate) => candidate.verification.readiness === "ready",
  ).length;
  if (language.runtimes.some(({ verification }) => verification.connection === "detected")) {
    return `${language.runtimes.length} installation${language.runtimes.length === 1 ? "" : "s"} detected`;
  }
  return ready > 0
    ? `${ready} ready runtime${ready === 1 ? "" : "s"}`
    : "Runtime requirements are missing";
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
  readonly language: ComputeLanguageRuntimeInspection;
  readonly enabled: boolean;
  readonly ensureEnabled: () => Promise<boolean>;
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
  const existingRuntimeReady = props.language.runtimes.some(
    ({ profile, verification }) =>
      profile.source !== "managed" && verification.readiness === "ready",
  );
  const progress = managedRuntimeOperationLabel(status);
  const failure = localFailure ?? queried.error ?? status.failureMessage;
  const managedCandidate = props.language.runtimes.find(
    ({ profile }) => profile.source === "managed",
  );
  const needsRepair =
    (managedCandidate !== undefined && managedCandidate.verification.readiness !== "ready") ||
    (status.installed && status.selection === "managed" && status.failureMessage !== null);

  return (
    <>
      <div className="@container/managed-runtime mt-3 rounded-lg border border-border/60 bg-muted/20 p-3">
        <div className="flex flex-col gap-3 @[32rem]/managed-runtime:flex-row @[32rem]/managed-runtime:items-start @[32rem]/managed-runtime:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              {displayName}
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
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              {status.description ??
                "A private Python environment with NumPy, pandas, SciPy, Matplotlib, and Jupyter. Your system Python and project environments stay untouched."}
            </p>
            {progress ? (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" /> {progress}
              </p>
            ) : null}
            {failure ? <p className="mt-2 text-xs text-destructive">{failure}</p> : null}
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
    <div className="mt-3 space-y-1 border-t border-border/50 py-2">
      {language.runtimes.map(({ profile, verification: detected, toolkits }) => {
        const state =
          verificationState?.executable === profile.executable ? verificationState : null;
        const verification = state?.result ?? detected;
        return (
          <div key={`${profile.source}:${profile.executable}`} className="min-w-0 py-1.5 text-xs">
            <div className="flex min-w-0 items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground/90">{profile.displayName}</div>
                <div className="select-text font-mono break-all text-muted-foreground">
                  {profile.executable}
                </div>
                <div className="text-muted-foreground">
                  {profile.source === "managed" ? "Scient-managed" : profile.source}
                  {profile.architecture ? ` · ${profile.architecture}` : ""}
                </div>
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
                variant="ghost"
                className="mt-1"
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

function LanguageSettingsRow({
  language,
  preference,
  onChange,
  onRefresh,
  refreshing,
  environmentId,
}: {
  language: ComputeLanguageRuntimeInspection;
  preference: ScientificComputingLanguageSettings;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
  onRefresh: () => void;
  refreshing: boolean;
  environmentId: EnvironmentId | null;
}) {
  const [executable, setExecutable] = useState(preference.executable);
  const verifyRuntime = useAtomCommand(computeEnvironment.verifyRuntime, { reportFailure: false });
  const [verificationState, setVerificationState] =
    useState<Exclude<Parameters<typeof RuntimeDetails>[0]["verificationState"], undefined>>(null);
  const verificationEpoch = useRef(0);
  useEffect(() => {
    verificationEpoch.current += 1;
    setVerificationState(null);
    return () => {
      verificationEpoch.current += 1;
    };
  }, [
    environmentId,
    language.runtimes,
    preference.executable,
    preference.enabled,
    language.managedRuntime?.generationId,
    language.managedRuntime?.selection,
  ]);
  const verify = async (path: string) => {
    if (environmentId === null) return;
    const epoch = ++verificationEpoch.current;
    setVerificationState({ executable: path, pending: true, result: null, error: null });
    const result = await verifyRuntime({
      environmentId,
      input: { cwd: null, languageId: language.descriptor.languageId, executable: path },
    });
    if (epoch !== verificationEpoch.current) return;
    const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    setVerificationState({
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
  useEffect(() => setExecutable(preference.executable), [preference.executable]);

  const persistExecutable = () => {
    const next = executable.trim();
    if (next !== preference.executable) void onChange({ ...preference, executable: next });
  };

  return (
    <SettingsRow
      title={language.descriptor.displayName}
      description={`Enable ${language.descriptor.displayName} for new scientific sessions on this server.`}
      status={readinessLabel(language, preference.enabled)}
      control={
        <Switch
          checked={preference.enabled}
          onCheckedChange={(enabled) => void onChange({ ...preference, enabled })}
          aria-label={`Enable ${language.descriptor.displayName}`}
        />
      }
    >
      <ManagedRuntimeCard
        environmentId={environmentId}
        language={language}
        enabled={preference.enabled}
        ensureEnabled={async () =>
          preference.enabled || (await onChange({ ...preference, enabled: true }))
        }
      />
      {language.descriptor.languageId === "matlab" ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Uses your licensed MATLAB on this server. Refresh finds installations; Verify connection
          starts and closes a test session.{" "}
          <a
            className="underline underline-offset-2"
            href="https://www.mathworks.com/products/matlab.html"
            target="_blank"
            rel="noreferrer"
          >
            Get MATLAB
          </a>
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-2 border-t border-border/50 py-3 sm:flex-row sm:items-center">
        <Input
          nativeInput
          size="compact"
          value={executable}
          disabled={!preference.enabled}
          placeholder="Automatic"
          aria-label={`${language.descriptor.displayName} executable`}
          onChange={(event) => setExecutable(event.currentTarget.value)}
          onBlur={persistExecutable}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              persistExecutable();
              event.currentTarget.blur();
            }
          }}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={!preference.enabled || refreshing}
          onClick={onRefresh}
        >
          <RefreshCwIcon className={refreshing ? "size-3 animate-spin" : "size-3"} />
          Refresh
        </Button>
      </div>
      {preference.enabled ? (
        <p className="text-[11px] text-muted-foreground">
          Capabilities: {language.descriptor.capabilities.join(", ")}
        </p>
      ) : null}
      <RuntimeDetails
        language={language}
        enabled={preference.enabled}
        onVerify={(path) => void verify(path)}
        verificationState={verificationState}
      />
    </SettingsRow>
  );
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
  const refreshRuntimes = useAtomCommand(computeEnvironment.refreshRuntimes, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const runtimesAtom = environmentId
    ? computeEnvironment.runtimes({
        environmentId,
        input: { cwd: null, refresh: false },
      })
    : null;
  const runtimes = useEnvironmentQuery(runtimesAtom);

  const updateLanguage = async (
    languageId: ComputeLanguageRuntimeInspection["descriptor"]["languageId"],
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
    setRefreshing(true);
    const result = await refreshRuntimes({
      environmentId,
      input: { cwd: null, refresh: true },
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
        headerAction={<span className="text-xs text-muted-foreground">{label}</span>}
      >
        <div className="space-y-3">
          <div className="rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none">
            {(runtimes.data?.languages ?? []).map((language) => {
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
                  onRefresh={() => void handleRefresh()}
                  refreshing={runtimes.isPending || refreshing}
                  environmentId={environmentId}
                />
              );
            })}
            {(refreshFailure ?? runtimes.error) ? (
              <p className="px-4 py-3 text-xs text-destructive" role="alert">
                {refreshFailure ?? runtimes.error}
              </p>
            ) : null}
          </div>
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
