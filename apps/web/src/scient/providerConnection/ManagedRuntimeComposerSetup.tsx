import { msg, T, useGT, useMessages } from "gt-react";
import type {
  EnvironmentId,
  ProviderConnectionAccount,
  ProviderManagedRuntimeAction,
  ServerProvider,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  DownloadIcon,
  LoaderIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useContext, useState, type ReactNode } from "react";

import { ProviderAppUpdateButton } from "../desktopUpdate/ProviderAppUpdateButton";
import type { Icon } from "../../components/Icons";
import { Button } from "../../components/ui/button";
import {
  AssistedSetupActions,
  AssistedSetupDiagnostics,
  AssistedSetupFrame,
  AssistedSetupStatus,
  AssistedSetupUpdateButton,
  AssistedSetupUpdateStatus,
  ProviderSetupIcon,
} from "./AssistedProviderSetup";
import { ModelPickerOverlayContext } from "./ModelPickerOverlayContext";
import { ConnectModelsButton } from "./ConnectModelsButton";
import {
  cancelRuntimeActionLabel,
  failedRuntimeOperationMessage,
  isActiveProviderRuntimeOperation,
  isProviderRuntimePresentedAsInstalled,
  managedRuntimeRepairMessage,
  needsManagedRuntimeRecovery,
  providerLifecycleFailureMessage,
  providerRuntimeComputerLabel,
  runtimeDownloadPercent,
} from "./providerConnectionPresentation";
import {
  externalProviderUpdate,
  externalProviderUpdateProgress,
  providerUpdateIssue,
  providerUpdateOffer,
  startReviewedProviderRuntimeAction,
} from "./providerLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";
import { m } from "~/i18n/messages";

type Pending = "install" | "repair" | "update" | "external-update" | "cancel";

const WORKING_TITLES = {
  install: msg("Installing {provider}"),
  repair: msg("Repairing {provider}"),
  update: msg("Updating {provider}"),
  remove: msg("Removing {provider}"),
} satisfies Record<ProviderManagedRuntimeAction, string>;

const ACTION_FAILURES = {
  install: msg("Scient could not install {provider}."),
  repair: msg("Scient could not repair {provider}."),
  update: msg("Scient could not update {provider}."),
  "external-update": msg("Scient could not update {provider}."),
  cancel: msg("Scient could not cancel {provider} setup."),
} satisfies Record<Pending, string>;

/**
 * Composer setup for providers whose only Scient-owned lifecycle is a managed
 * runtime and whose models come from the tool itself or from custom model
 * connections. One frame, one next step; runtime management stays in
 * Settings. Mount with `key={provider.instanceId}` so local state resets.
 */
export function ManagedRuntimeComposerSetup(props: {
  readonly controller: ProviderLifecycleController;
  readonly displayName: string;
  readonly environmentId: EnvironmentId;
  readonly icon: Icon;
  /** Next step when the runtime starts but reports no usable model. */
  readonly modelSetupHint: string;
  readonly renderModelSetupAction?: (appearance: "setup-action" | "setup-secondary") => ReactNode;
  readonly provider: ServerProvider;
  /** The selected model's account, whose sign-in ended: Reconnect signs in to it again. */
  readonly signedOutAccount?: ProviderConnectionAccount | undefined;
}) {
  const overlay = useContext(ModelPickerOverlayContext);
  const ownsOverlay = overlay?.instanceId === props.provider.instanceId;
  const [pending, setPending] = useState<Pending | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const gt = useGT();
  const messages = useMessages();
  const name = props.displayName;
  const runtime = props.provider.connection?.runtime;
  const operation = runtime?.operation ?? null;
  const active = isActiveProviderRuntimeOperation(operation) ? operation : null;
  const updateOffer = providerUpdateOffer(props.provider);
  const externalUpdateProgress = externalProviderUpdateProgress(
    props.provider,
    pending === "external-update",
  );

  const run = async (next: Pending) => {
    setLocalError(null);
    setPending(next);
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        if (next === "cancel") {
          if (active) await props.controller.cancelRuntime(active.operationId);
        } else if (next === "external-update") {
          await props.controller.updateExternalRuntime();
        } else {
          await startReviewedProviderRuntimeAction(props.controller, next);
        }
      } catch (cause) {
        setLocalError(
          providerLifecycleFailureMessage(cause, m(ACTION_FAILURES[next], { provider: name })),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPending(null);
    if (actionFailure) throw actionFailure.cause;
  };

  /** Models need the tool's own probe, so the entry point waits for it. */
  const connectModels = (appearance: "setup-action" | "setup-secondary") =>
    props.provider.probePending && !ownsOverlay ? null : (
      <AssistedSetupActions key="connect-models">
        {props.renderModelSetupAction ? (
          props.renderModelSetupAction(appearance)
        ) : (
          <ConnectModelsButton
            appearance={appearance}
            environmentId={props.environmentId}
            instanceId={props.provider.instanceId}
          />
        )}
      </AssistedSetupActions>
    );
  const primaryAction = (
    action: "install" | "repair",
    label: string,
    accessibleName: string,
    icon: ReactNode,
  ) => (
    <AssistedSetupActions>
      <Button
        aria-label={accessibleName}
        onClick={() => void run(action)}
        size="sm"
        type="button"
        variant="ghost-primary"
      >
        {icon}
        {label}
      </Button>
    </AssistedSetupActions>
  );

  if (ownsOverlay) {
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus icon={null} title={gt("Connect models")} body={props.modelSetupHint} />
        {connectModels("setup-action")}
      </AssistedSetupFrame>
    );
  }

  if (active || pending === "install" || pending === "repair" || pending === "update") {
    const action: ProviderManagedRuntimeAction =
      active?.action ?? (pending === "repair" || pending === "update" ? pending : "install");
    const percent = runtimeDownloadPercent(active);
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            localError ??
            (active?.background
              ? gt("Downloading in the background. You can use another agent meanwhile.")
              : (active?.message ?? gt("Preparing {provider}…", { provider: name })))
          }
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          role={localError ? "alert" : "status"}
          title={`${
            active?.background
              ? gt("Getting {provider} ready", { provider: name })
              : messages(WORKING_TITLES[action], { provider: name })
          }${percent === null ? "" : ` · ${percent}%`}`}
        />
        {active ? (
          <AssistedSetupActions>
            <Button
              aria-label={cancelRuntimeActionLabel(name, action, messages)}
              disabled={pending === "cancel"}
              onClick={() => void run("cancel")}
              size="sm"
              type="button"
              variant="ghost-destructive-action"
            >
              {pending === "cancel" ? (
                <LoaderIcon aria-hidden className="animate-spin" />
              ) : (
                <XIcon aria-hidden />
              )}
              <T>Cancel</T>
            </Button>
          </AssistedSetupActions>
        ) : null}
      </AssistedSetupFrame>
    );
  }

  if (externalUpdateProgress) {
    return (
      <AssistedSetupFrame>
        <AssistedSetupUpdateStatus
          name={name}
          provider={props.provider}
          update={externalProviderUpdate(props.provider)}
          working={externalUpdateProgress}
        />
      </AssistedSetupFrame>
    );
  }

  const appUpdateButton = (
    <ProviderAppUpdateButton requiresAppUpdate={props.provider.requiresAppUpdate} />
  );

  if (needsManagedRuntimeRecovery(props.provider)) {
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            <div className="flex items-center gap-2">
              <span>
                {localError ??
                  managedRuntimeRepairMessage(props.provider, name, undefined, messages)}
              </span>
              {!localError ? appUpdateButton : null}
            </div>
          }
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title={gt("{provider} needs repair", { provider: name })}
        />
        {runtime?.actions.includes("repair")
          ? primaryAction(
              "repair",
              gt("Repair {provider}", { provider: name }),
              gt("Repair {provider}", { provider: name }),
              <RefreshCwIcon aria-hidden />,
            )
          : null}
        <AssistedSetupDiagnostics displayName={name} provider={props.provider} />
      </AssistedSetupFrame>
    );
  }

  if (!isProviderRuntimePresentedAsInstalled(props.provider)) {
    const error = localError ?? failedRuntimeOperationMessage(operation, "install");
    const canInstall = runtime?.actions.includes("install") ?? false;
    const computer = providerRuntimeComputerLabel(props.provider, messages);
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            error ??
            (canInstall
              ? gt("{provider} is not installed on {computer}.", { provider: name, computer })
              : gt(
                  "Assisted installation is not available for {computer}. You can use an existing {provider} installation.",
                  { provider: name, computer },
                ))
          }
          icon={
            error ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
            )
          }
          role={error ? "alert" : undefined}
          title={
            error
              ? gt("{provider} installation couldn’t finish", { provider: name })
              : gt("Install {provider}", { provider: name })
          }
        />
        {canInstall
          ? primaryAction(
              "install",
              error
                ? gt("Retry installation")
                : gt("Install", { $context: "verb, install the provider" }),
              error
                ? gt("Retry installation of {provider}", { provider: name })
                : gt("Install {provider}", { provider: name }),
              error ? <RefreshCwIcon aria-hidden /> : <DownloadIcon aria-hidden />,
            )
          : null}
        {error ? <AssistedSetupDiagnostics displayName={name} provider={props.provider} /> : null}
      </AssistedSetupFrame>
    );
  }

  if (props.signedOutAccount) {
    const account = props.signedOutAccount.name;
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={gt("Sign in to {account} again to keep using its models.", { account })}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title={gt("{account} is signed out", { account })}
        />
        {connectModels("setup-action")}
      </AssistedSetupFrame>
    );
  }

  if (props.provider.status !== "ready" || props.provider.models.length === 0) {
    const failed = props.provider.status === "error";
    const ModelIcon = props.icon;
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            failed ? (
              <div className="flex items-center gap-2">
                <span>{props.provider.message ?? gt("Refresh to try again.")}</span>
                {appUpdateButton}
              </div>
            ) : (
              props.modelSetupHint
            )
          }
          icon={
            failed ? (
              <TriangleAlertIcon className="size-5 text-warning" />
            ) : (
              <ModelIcon className="size-5" />
            )
          }
          role={failed ? "alert" : undefined}
          title={
            failed
              ? gt("Could not load {provider} models", { provider: name })
              : gt("Connect a model provider")
          }
        />
        {connectModels("setup-action")}
        {failed ? <AssistedSetupDiagnostics displayName={name} provider={props.provider} /> : null}
      </AssistedSetupFrame>
    );
  }

  if (updateOffer) {
    const issue = providerUpdateIssue(props.provider, updateOffer, localError);
    return (
      <AssistedSetupFrame>
        <AssistedSetupUpdateStatus
          issue={issue}
          name={name}
          provider={props.provider}
          update={updateOffer}
        />
        <AssistedSetupActions>
          <AssistedSetupUpdateButton
            name={name}
            onClick={() => void run(updateOffer.path === "external" ? "external-update" : "update")}
            retry={issue !== null}
          />
        </AssistedSetupActions>
        {connectModels("setup-secondary")}
        {issue ? <AssistedSetupDiagnostics displayName={name} provider={props.provider} /> : null}
      </AssistedSetupFrame>
    );
  }

  const managed = runtime?.source === "scient_managed";
  const version = (managed ? runtime?.managedVersion : null) ?? props.provider.version;
  const versionSuffix = version ? ` ${version}` : "";
  return (
    <AssistedSetupFrame>
      <AssistedSetupStatus
        body={
          managed
            ? gt("Using Scient-managed {provider}{version}.", {
                provider: name,
                version: versionSuffix,
              })
            : gt("Using {provider}{version} installed on {computer}.", {
                provider: name,
                version: versionSuffix,
                computer: providerRuntimeComputerLabel(props.provider, messages),
              })
        }
        icon={<CheckCircle2Icon className="size-5 text-success" />}
        title={gt("{provider} is ready", { provider: name })}
      />
      {connectModels("setup-action")}
    </AssistedSetupFrame>
  );
}
