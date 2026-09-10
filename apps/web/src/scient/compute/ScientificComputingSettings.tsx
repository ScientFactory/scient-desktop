import { Download, LoaderCircle, RefreshCwIcon, SigmaIcon, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  ComputeLanguageRuntimeInspection,
  ComputeManagedRuntimeAction,
  ComputeManagedRuntimeStatus,
  EnvironmentId,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
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
      return "Installing the locked scientific packages…";
    case "verifying":
      return "Verifying Python, Jupyter, data, and figures…";
    case "removing":
      return "Removing Scient-managed Python…";
  }
}

export function ManagedRuntimeCard(props: {
  readonly environmentId: EnvironmentId | null;
  readonly language: ComputeLanguageRuntimeInspection;
  readonly enabled: boolean;
  readonly ensureEnabled: () => void;
}) {
  const manageRuntime = useAtomCommand(computeEnvironment.manageRuntime, { reportFailure: false });
  const cancelRuntime = useAtomCommand(computeEnvironment.cancelManagedRuntime, {
    reportFailure: false,
  });
  const [actionPending, setActionPending] = useState(false);
  const [localFailure, setLocalFailure] = useState<string | null>(null);
  const [removeConfirmation, setRemoveConfirmation] = useState(false);
  const languageId = props.language.descriptor.languageId;
  const statusAtom = props.environmentId
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

  const runAction = async (action: ComputeManagedRuntimeAction) => {
    if (!props.environmentId || actionPending) return;
    if (action === "install" || action === "use-managed") props.ensureEnabled();
    setLocalFailure(null);
    setActionPending(true);
    const result = await manageRuntime({
      environmentId: props.environmentId,
      input: { languageId, action },
    });
    setActionPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setLocalFailure(
        failure instanceof Error ? failure.message : "Scient could not manage Scientific Python.",
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
        failure instanceof Error ? failure.message : "Scient could not cancel Python setup.",
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
    managedCandidate !== undefined && managedCandidate.verification.readiness !== "ready";

  return (
    <>
      <div className="@container/managed-runtime mt-3 rounded-lg border border-border/60 bg-muted/20 p-3">
        <div className="flex flex-col gap-3 @[32rem]/managed-runtime:flex-row @[32rem]/managed-runtime:items-start @[32rem]/managed-runtime:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              Scientific Python
              {status.installed ? (
                <span
                  className={`text-[11px] font-normal ${needsRepair ? "text-warning" : "text-success"}`}
                >
                  {needsRepair
                    ? "Needs repair"
                    : status.selection === "managed" && props.enabled
                      ? "In use"
                      : "Installed"}
                </span>
              ) : null}
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              A private Python environment with NumPy, pandas, SciPy, Matplotlib, and Jupyter. Your
              system Python and project environments stay untouched.
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
                {status.selection === "managed" && props.enabled && existingRuntimeReady ? (
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
                  aria-label="Remove Scient-managed Python"
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
            <AlertDialogTitle>Remove Scient-managed Python?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes only Scient&apos;s private Scientific Python. System installations and
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
}: {
  language: ComputeLanguageRuntimeInspection;
  enabled: boolean;
}) {
  if (!enabled || language.runtimes.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 border-t border-border/50 py-2">
      {language.runtimes.map(({ profile, verification, toolkits }) => (
        <div key={`${profile.source}:${profile.executable}`} className="min-w-0 py-1.5 text-xs">
          <div className="flex min-w-0 items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="truncate font-medium text-foreground/90">{profile.displayName}</div>
              <div className="truncate font-mono text-muted-foreground">{profile.executable}</div>
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
                ? "Ready"
                : verification.missingRequirements.length > 0
                  ? `Missing: ${verification.missingRequirements.join(", ")}`
                  : (verification.message ?? verification.readiness.replaceAll("-", " "))}
            </div>
          </div>
          {verification.readiness === "missing-requirement" && verification.message !== null ? (
            <p className="mt-2 max-w-2xl text-[11px] leading-snug text-muted-foreground">
              {verification.message}
            </p>
          ) : null}
          {toolkits.map((toolkit) =>
            toolkit.readiness === "missing-requirement" ? (
              <p key={toolkit.toolkitId} className="mt-1 text-[11px] text-warning">
                {language.toolkits.find((descriptor) => descriptor.toolkitId === toolkit.toolkitId)
                  ?.displayName ?? "Scientific packages"}
                : missing {toolkit.missingRequirements.join(", ")}
              </p>
            ) : null,
          )}
        </div>
      ))}
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
  onChange: (next: ScientificComputingLanguageSettings) => void;
  onRefresh: () => void;
  refreshing: boolean;
  environmentId: EnvironmentId | null;
}) {
  const [executable, setExecutable] = useState(preference.executable);
  useEffect(() => setExecutable(preference.executable), [preference.executable]);

  const persistExecutable = () => {
    const next = executable.trim();
    if (next !== preference.executable) onChange({ ...preference, executable: next });
  };

  return (
    <SettingsRow
      title={language.descriptor.displayName}
      description={`Enable ${language.descriptor.displayName} for new scientific sessions on this server.`}
      status={readinessLabel(language, preference.enabled)}
      control={
        <Switch
          checked={preference.enabled}
          onCheckedChange={(enabled) => onChange({ ...preference, enabled })}
          aria-label={`Enable ${language.descriptor.displayName}`}
        />
      }
    >
      <ManagedRuntimeCard
        environmentId={environmentId}
        language={language}
        enabled={preference.enabled}
        ensureEnabled={() => {
          if (!preference.enabled) onChange({ ...preference, enabled: true });
        }}
      />
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
      <RuntimeDetails language={language} enabled={preference.enabled} />
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
            This server is unavailable. Reconnect it to manage Python.
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
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
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

  const updateLanguage = (
    languageId: ComputeLanguageRuntimeInspection["descriptor"]["languageId"],
    next: ScientificComputingLanguageSettings,
  ) => {
    updateSettings({
      scientificComputing: {
        schemaVersion: 1,
        languages: { [languageId]: next },
      },
    });
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
        failure instanceof Error ? failure.message : "Scient could not refresh Python.",
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
                executable: "",
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
