import { ExternalLinkIcon, RefreshCwIcon, SigmaIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ComputeLanguageRuntimeInventory,
  ComputeManagedRuntimeAction,
  ComputeRuntimeVerification,
  EnvironmentId,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import { ComputeLanguageDescriptor, ComputeLanguageId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import {
  useComputeManagedRuntime,
  ManagedRuntimeNotice,
  ManagedRuntimeActions,
  type ComputeManagedRuntimeController,
} from "./ComputeManagedRuntimeControls";
import {
  computeCurrentRuntimeSummary,
  computeManagedPrimaryAction,
  computeRuntimePickerLabel,
  defaultComputeInstallation,
  selectExistingComputeInstallation,
} from "./computeInstallationSettingsModel";

function LanguageRuntimeSummary({
  language,
  preference,
  onChange,
  environmentId,
  loading,
  refreshing,
  onRefresh,
  refreshVersion,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
  environmentId: EnvironmentId | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  refreshVersion: number;
}) {
  const languageId = language.descriptor.languageId;
  const runtime = useComputeManagedRuntime({
    environmentId,
    languageId,
    initialStatus: language.managedRuntime,
    ensureEnabled: async () =>
      preference.enabled || (await onChange({ ...preference, enabled: true })),
  });
  const summary = computeCurrentRuntimeSummary({
    language,
    preference,
    managed: runtime.status,
  });
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const disabled = Boolean(loading || refreshing || runtime.busy || !environmentId);
  const setup = () => void runtime.act(computeManagedPrimaryAction(runtime.status));
  const operationId = runtime.status?.operation?.operationId ?? null;
  const previousOperationId = useRef<string | null>(null);
  useEffect(() => {
    if (previousOperationId.current !== null && operationId === null) void onRefresh();
    previousOperationId.current = operationId;
  }, [onRefresh, operationId]);
  const showManagedNotice = runtime.status?.operation != null || Boolean(runtime.failure);
  const story = loading
    ? "Checking…"
    : summary.kind === "disabled"
      ? "Off"
      : summary.kind === "ready" ||
          summary.kind === "update-managed" ||
          summary.kind === "repair-managed" ||
          summary.kind === "unavailable"
        ? `${summary.title} · ${summary.detail}`
        : summary.title;
  const action = (() => {
    if (loading || summary.kind === "ready" || summary.kind === "disabled") return null;
    if (summary.kind === "setup" || summary.kind === "repair-managed") {
      return (
        <Button size="sm" disabled={disabled} onClick={setup}>
          {summary.kind === "repair-managed" ? "Repair" : "Set up Python"}
        </Button>
      );
    }
    if (summary.kind === "update-managed") {
      return (
        <Button size="sm" disabled={disabled} onClick={() => void runtime.act("update")}>
          Update
        </Button>
      );
    }
    if (summary.kind === "connect") {
      return (
        <Button size="sm" disabled={disabled} onClick={setup}>
          Connect MATLAB
        </Button>
      );
    }
    if (summary.kind === "unavailable") {
      return (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setRecoveryOpen(true)}
        >
          Choose runtime
        </Button>
      );
    }
    if (summary.kind === "missing") {
      return (
        <Button
          size="sm"
          variant="ghost"
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
      );
    }
    return null;
  })();
  const primaryManagedAction: ComputeManagedRuntimeAction | null =
    summary.kind === "update-managed"
      ? "update"
      : summary.kind === "repair-managed"
        ? "repair"
        : null;
  const control = (
    <div className="flex items-center gap-2">
      {action}
      <Switch
        size="sm"
        checked={preference.enabled}
        disabled={disabled}
        onCheckedChange={(enabled) => {
          void onChange({ ...preference, enabled }).then((saved) => {
            if (saved) void onRefresh();
          });
        }}
        aria-label={`Enable ${language.descriptor.displayName}`}
      />
    </div>
  );
  return (
    <SettingsRow
      id={`${languageId}-runtime`}
      title={language.descriptor.displayName}
      description={<span data-compute-summary={languageId}>{story}</span>}
      control={control}
    >
      {showManagedNotice ? <ManagedRuntimeNotice runtime={runtime} /> : null}
      <details
        className="mt-2"
        open={recoveryOpen}
        onToggle={(event) => setRecoveryOpen(event.currentTarget.open)}
      >
        <summary className="w-fit cursor-pointer text-xs text-muted-foreground">
          Change runtime
        </summary>
        <LanguageRuntimeRecovery
          language={language}
          preference={preference}
          onChange={onChange}
          environmentId={environmentId}
          loading={loading}
          refreshing={refreshing}
          runtime={runtime}
          onRefresh={onRefresh}
          refreshVersion={refreshVersion}
          primaryManagedAction={primaryManagedAction}
        />
      </details>
    </SettingsRow>
  );
}

function LanguageRuntimeRecovery({
  language,
  preference,
  onChange,
  environmentId,
  loading,
  refreshing,
  runtime,
  onRefresh,
  refreshVersion,
  primaryManagedAction,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
  environmentId: EnvironmentId | null;
  loading: boolean;
  refreshing: boolean;
  runtime: ComputeManagedRuntimeController;
  onRefresh: () => Promise<void>;
  refreshVersion: number;
  primaryManagedAction: ComputeManagedRuntimeAction | null;
}) {
  const languageId = language.descriptor.languageId;
  const isPython = languageId === "python";
  const isMatlab = languageId === "matlab";
  const [pathOpen, setPathOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectionFailure, setSelectionFailure] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<{
    readonly runtimeFingerprint: string;
    readonly result: ComputeRuntimeVerification | null;
    readonly error: string | null;
  } | null>(null);
  const selectionLock = useRef(false);
  const selectedInstallation = defaultComputeInstallation(language, preference, runtime.status);
  const managedInstallation = language.installations.find(
    (installation) => installation.source === "managed",
  );
  const disabled = Boolean(
    loading || refreshing || selecting || testing || runtime.busy || !environmentId,
  );
  const helperOwner = runtime.status?.installationExecutable;
  const helperNeedsRetarget =
    isMatlab &&
    runtime.status?.installed &&
    helperOwner &&
    helperOwner !== selectedInstallation?.executable;
  const hasExplicitSelection =
    Boolean(preference.executable.trim()) || (isPython && runtime.status?.selection === "managed");
  const helperCanRepair = !isMatlab || selectedInstallation?.executable === helperOwner;
  const verifyRuntime = useAtomCommand(computeEnvironment.verifyRuntime, { reportFailure: false });
  const runtimeFingerprint = JSON.stringify([
    refreshVersion,
    preference.enabled,
    selectedInstallation?.executable,
    selectedInstallation?.version,
    selectedInstallation?.problem,
    runtime.status?.generationId,
    runtime.status?.selection,
    runtime.status?.operation?.operationId,
    runtime.status?.installed,
    runtime.status?.installationExecutable,
    runtime.status?.failureMessage,
  ]);
  // Retire proof when its runtime changes, not when polling allocates a new
  // object for the same status. Returning to an old runtime must not revive it.
  if (testState !== null && testState.runtimeFingerprint !== runtimeFingerprint) {
    setTestState(null);
  }
  const currentTestState = testState?.runtimeFingerprint === runtimeFingerprint ? testState : null;
  const testPassed =
    currentTestState?.result?.readiness === "ready" &&
    currentTestState.result.connection === "verified";
  const testError = currentTestState?.error ?? null;

  const select = async (executable: string | null) => {
    if (selectionLock.current || runtime.busy || loading || refreshing) return;
    selectionLock.current = true;
    setSelecting(true);
    setSelectionFailure(null);
    setTestState(null);
    try {
      if (executable !== null && executable === managedInstallation?.executable) {
        if (!(await runtime.act("use-managed")))
          throw new Error("Scient-managed Python could not be selected. Try again.");
      } else {
        await selectExistingComputeInstallation({
          executable: executable ?? "",
          preference,
          releaseManaged: isPython && runtime.status?.selection === "managed",
          save: onChange,
          useExisting: async () => {
            if (!(await runtime.act("use-existing")))
              throw new Error(
                "Scient-managed Python is still selected. Try switching again when its current operation finishes.",
              );
          },
        });
      }
      setPathOpen(false);
      setPathDraft("");
      await onRefresh();
    } catch (cause) {
      setSelectionFailure(
        cause instanceof Error ? cause.message : "The installation could not be selected.",
      );
    } finally {
      selectionLock.current = false;
      setSelecting(false);
    }
  };

  const runTest = async () => {
    if (!environmentId || !selectedInstallation || testing || loading || refreshing) return;
    setTesting(true);
    const pendingTest = { runtimeFingerprint, result: null, error: null };
    setTestState(pendingTest);
    const complete = (result: ComputeRuntimeVerification | null, error: string | null) => {
      // A late reply cannot revive proof invalidated by a runtime change.
      setTestState((current) =>
        current === pendingTest ? { ...pendingTest, result, error } : current,
      );
    };
    try {
      const result = await verifyRuntime({
        environmentId,
        input: { cwd: null, languageId, executable: selectedInstallation.executable },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const verified = result.value.readiness === "ready" && result.value.connection === "verified";
      complete(
        result.value,
        verified
          ? null
          : (result.value.message ??
              "The connection could not be verified. Scient did not start a test session."),
      );
    } catch (cause) {
      complete(
        null,
        cause instanceof Error ? cause.message : "The connection could not be verified.",
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="mt-3 space-y-2" data-compute-recovery={languageId}>
      {loading ? (
        <p className="text-xs text-muted-foreground" role="status">
          Checking…
        </p>
      ) : language.installations.length === 0 ? (
        <p className="text-xs text-muted-foreground">No runtime detected</p>
      ) : (
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <span className="text-xs text-muted-foreground">For new sessions</span>
          <Select
            value={selectedInstallation?.executable ?? null}
            onValueChange={(value) => {
              if (!value || value === selectedInstallation?.executable) return;
              void select(value);
            }}
            disabled={disabled || !preference.enabled}
          >
            <SelectTrigger
              size="sm"
              className="w-auto max-w-52"
              aria-label={`Choose ${language.descriptor.displayName} runtime`}
              data-compute-runtime={selectedInstallation?.executable ?? ""}
            >
              <SelectValue>
                {selectedInstallation
                  ? computeRuntimePickerLabel(
                      selectedInstallation,
                      language.descriptor.displayName,
                      language.installations,
                    )
                  : "Choose a runtime"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup
              align="end"
              alignItemWithTrigger={false}
              matchTriggerWidth={false}
              className="max-w-[calc(100vw-1rem)]"
            >
              {language.installations.map((installation) => (
                <SelectItem
                  key={installation.executable}
                  hideIndicator
                  value={installation.executable}
                  data-compute-runtime={installation.executable}
                >
                  <span className="block max-w-[calc(100vw-3rem)] truncate sm:max-w-80">
                    {computeRuntimePickerLabel(
                      installation,
                      language.descriptor.displayName,
                      language.installations,
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}
      {selectedInstallation?.problem ? (
        <p className="text-xs text-destructive" role="alert">
          {selectedInstallation.problem}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-0.5" data-compute-actions={languageId}>
        {preference.enabled && selectedInstallation ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled}
                  onClick={() => void runTest()}
                />
              }
            >
              {testing ? "Testing…" : testPassed ? "Test passed" : "Test"}
            </TooltipTrigger>
            <TooltipPopup>Starts and closes a test session.</TooltipPopup>
          </Tooltip>
        ) : null}
        <ManagedRuntimeActions
          className="contents"
          runtime={runtime}
          connection={isMatlab}
          maintenanceOnly
          omitAction={primaryManagedAction}
          canProvision={!isMatlab || helperCanRepair}
          disabled={selecting || refreshing || !environmentId}
        />
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={disabled || !preference.enabled}
          onClick={() => {
            setPathOpen(!pathOpen);
            setPathDraft("");
            setSelectionFailure(null);
          }}
        >
          Use another path…
        </Button>
        {hasExplicitSelection ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={disabled || !preference.enabled}
            onClick={() => void select(null)}
          >
            Reset to automatic
          </Button>
        ) : null}
      </div>
      {testError ? (
        <p className="text-xs text-destructive" role="alert">
          {testError}
        </p>
      ) : null}
      {helperNeedsRetarget ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            The connection helper belongs to a different MATLAB. Set up a connection for this one.
          </p>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => void runtime.act("repair")}
          >
            Set up connection
          </Button>
        </div>
      ) : null}
      {pathOpen ? (
        <form
          className="flex min-w-0 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (pathDraft.trim()) void select(pathDraft.trim());
          }}
        >
          <Input
            nativeInput
            size="compact"
            className="min-w-0 flex-1"
            value={pathDraft}
            disabled={disabled}
            placeholder="Executable path"
            aria-label={`${language.descriptor.displayName} executable path`}
            onChange={(event) => setPathDraft(event.currentTarget.value)}
          />
          <Button
            size="xs"
            variant="outline"
            type="submit"
            disabled={disabled || !pathDraft.trim()}
          >
            Use
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={selecting}
            onClick={() => setPathOpen(false)}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {selectionFailure ? (
        <p className="text-xs text-destructive" role="alert">
          {selectionFailure}
        </p>
      ) : null}
      {language.failureMessage ? (
        <p className="text-xs text-destructive" role="alert">
          {language.failureMessage}
        </p>
      ) : null}
    </div>
  );
}

const PENDING_RUNTIME_DESCRIPTORS: ReadonlyArray<ComputeLanguageDescriptor> = [
  ComputeLanguageDescriptor.make({
    languageId: ComputeLanguageId.make("python"),
    displayName: "Python",
    sourceExtensions: [".py"],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  }),
  ComputeLanguageDescriptor.make({
    languageId: ComputeLanguageId.make("matlab"),
    displayName: "MATLAB",
    sourceExtensions: [".m"],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  }),
];

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
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const runtimesAtom = environmentId
    ? computeEnvironment.runtimeInventory({
        environmentId,
        input: {},
      })
    : null;
  const runtimes = useEnvironmentQuery(runtimesAtom);
  const inventoryPending = runtimes.data === null && runtimes.error === null;
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
    setRefreshVersion((current) => current + 1);
    return true;
  };

  const handleRefresh = useCallback(async () => {
    if (environmentId === null) return;
    // Refresh is a new observation, not proof that an earlier Test still holds.
    setRefreshVersion((current) => current + 1);
    setRefreshFailure(null);
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
              <TooltipPopup side="top">Find runtimes again</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {displayedLanguages.map((language) => {
          const preference = preferences.languages[language.descriptor.languageId] ?? {
            enabled: false,
            executable: language.configuredExecutable ?? "",
          };
          return (
            <LanguageRuntimeSummary
              key={language.descriptor.languageId}
              language={language}
              preference={preference}
              onChange={(next) => updateLanguage(language.descriptor.languageId, next)}
              environmentId={environmentId}
              loading={inventoryPending}
              refreshing={refreshing}
              onRefresh={handleRefresh}
              refreshVersion={refreshVersion}
            />
          );
        })}
        {(refreshFailure ?? runtimes.error) ? (
          <p className="px-4 py-3 text-xs text-destructive" role="alert">
            {refreshFailure ?? runtimes.error}
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
