import { msg, useGT } from "gt-react";
import type {
  EnvironmentId,
  ProviderConnectionAccount,
  ProviderDriverKind,
  ServerProvider,
} from "@t3tools/contracts";
import { LoaderIcon, LogOutIcon, PowerIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useContext, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
  ProviderSetupIcon,
} from "./AssistedProviderSetup";
import { AntigravityInlineSetup } from "./AntigravityInlineSetup";
import { ClaudeInlineSetup } from "./ClaudeInlineSetup";
import { CodexInlineSetup } from "./CodexInlineSetup";
import { CursorInlineSetup } from "./CursorInlineSetup";
import { DroidInlineSetup } from "./DroidInlineSetup";
import { ModelPickerOverlayContext } from "./ModelPickerOverlayContext";
import { ConnectModelsButton } from "./ConnectModelsButton";
import { GrokInlineSetup } from "./GrokInlineSetup";
import { OmpInlineSetup } from "./OmpInlineSetup";
import { ScientAgentInlineSetup } from "./ScientAgentInlineSetup";
import { PiInlineSetup } from "./PiInlineSetup";
import { MuseInlineSetup } from "./MuseInlineSetup";
import {
  isProviderAccountPresentedAsConnected,
  providerLifecycleFailureMessage,
} from "./providerConnectionPresentation";
import { useProviderLifecycleController } from "./useProviderLifecycleController";
import { useProviderEnableAction } from "./useProviderEnableAction";
import { m } from "~/i18n/messages";

export type AssistedProviderSetupSurface = "composer" | "management";

export function supportsAssistedProviderSetupSurface(
  driver: ProviderDriverKind,
  _surface: AssistedProviderSetupSurface,
): boolean {
  switch (driver) {
    case "antigravity":
    case "claudeAgent":
    case "codex":
    case "cursor":
    case "droid":
    case "grok":
    case "omp":
    case "scient":
    case "pi":
    case "muse":
      return true;
    default:
      return false;
  }
}

interface AssistedProviderSetupHostBaseProps {
  readonly displayName: string;
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  /** A Scient Agent model account whose sign-in ended, to sign in again. */
  readonly signedOutAccount?: ProviderConnectionAccount | undefined;
}

type AssistedProviderSetupHostProps = AssistedProviderSetupHostBaseProps &
  (
    | { readonly surface: "composer" }
    | {
        readonly surface: "management";
        readonly accountActionDisabled: boolean;
        readonly managedRuntimePresentedExternally: boolean;
        readonly onAccountActionPendingChange: (pending: boolean) => void;
        readonly onRepairSucceeded: () => void;
      }
  );

/**
 * The single frontend dispatch seam for assisted provider setup. Provider
 * flows stay in their own inline views; this host owns only controller
 * construction and the management surface's shared account action.
 */
export function AssistedProviderSetupHost(props: AssistedProviderSetupHostProps) {
  const overlay = useContext(ModelPickerOverlayContext);
  if (!supportsAssistedProviderSetupSurface(props.provider.driver, props.surface)) return null;
  const displayName =
    props.displayName.trim() || props.provider.displayName?.trim() || String(props.provider.driver);
  if (!props.provider.enabled) {
    return (
      <DisabledProviderSetup
        displayName={displayName}
        environmentId={props.environmentId}
        provider={props.provider}
      />
    );
  }
  if (props.provider.probePending === true && overlay?.instanceId !== props.provider.instanceId) {
    return <ProviderProbePendingSetup displayName={displayName} />;
  }
  return <SupportedAssistedProviderSetupHost {...props} />;
}

export function ProviderProbePendingSetup(props: { readonly displayName: string }) {
  const gt = useGT();
  return (
    <AssistedSetupFrame>
      <AssistedSetupStatus
        body={gt("Verifying installation and connection status.")}
        icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
        role="status"
        title={gt("Checking {provider}…", { provider: props.displayName })}
      />
    </AssistedSetupFrame>
  );
}

function SupportedAssistedProviderSetupHost(props: AssistedProviderSetupHostProps) {
  const controller = useProviderLifecycleController({
    environmentId: props.environmentId,
    provider: props.provider,
  });
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const gt = useGT();
  const displayName =
    props.displayName.trim() || props.provider.displayName?.trim() || String(props.provider.driver);
  const isManagement = props.surface === "management";

  const disconnect = async () => {
    setDisconnecting(true);
    if (isManagement) props.onAccountActionPendingChange(true);
    setDisconnectError(null);
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await controller.disconnect();
      } catch (error) {
        setDisconnectError(
          providerLifecycleFailureMessage(
            error,
            m(msg("Scient could not sign out of {provider}.", { provider: displayName })),
          ),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setDisconnecting(false);
    if (isManagement) props.onAccountActionPendingChange(false);
    if (actionFailure) throw actionFailure.cause;
  };

  const accountAction =
    isManagement &&
    isProviderAccountPresentedAsConnected(props.provider) &&
    props.provider.connection?.canDisconnect ? (
      <Button
        disabled={disconnecting || props.accountActionDisabled}
        onClick={() => void disconnect()}
        size="sm"
        type="button"
        variant="ghost-destructive-action"
      >
        {disconnecting ? <LoaderIcon className="animate-spin" /> : <LogOutIcon />}
        {props.provider.connection.methods.includes("antigravity_credentials")
          ? gt("Disconnect")
          : gt("Sign out")}
      </Button>
    ) : undefined;

  const managementProps = isManagement
    ? {
        accountAction,
        managedRuntimePresentedExternally: props.managedRuntimePresentedExternally,
        onRepairSucceeded: props.onRepairSucceeded,
      }
    : {};

  let setup: ReactNode;
  switch (props.provider.driver) {
    case "muse":
      setup = (
        <MuseInlineSetup
          {...managementProps}
          controller={controller}
          environmentId={props.environmentId}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "omp":
      setup = (
        <OmpInlineSetup
          {...managementProps}
          {...(!isManagement ? { composerController: controller } : {})}
          environmentId={props.environmentId}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "scient":
      setup = (
        <ScientAgentInlineSetup
          {...managementProps}
          {...(!isManagement ? { composerController: controller } : {})}
          signedOutAccount={props.signedOutAccount}
          environmentId={props.environmentId}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "pi":
      setup = (
        <PiInlineSetup
          {...managementProps}
          {...(!isManagement ? { composerController: controller } : {})}
          environmentId={props.environmentId}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "antigravity":
      setup = (
        <AntigravityInlineSetup
          {...managementProps}
          controller={controller}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "claudeAgent":
      setup = (
        <ClaudeInlineSetup
          {...managementProps}
          controller={controller}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "codex":
      setup = (
        <CodexInlineSetup
          {...managementProps}
          controller={controller}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "cursor":
      setup = (
        <CursorInlineSetup
          {...managementProps}
          controller={controller}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    case "droid":
      setup = isManagement ? (
        <>
          <DroidInlineSetup
            {...managementProps}
            controller={controller}
            displayName={displayName}
            provider={props.provider}
          />
          {props.provider.installed && !props.provider.probePending ? (
            <ConnectModelsButton
              environmentId={props.environmentId}
              instanceId={props.provider.instanceId}
            />
          ) : null}
        </>
      ) : (
        <DroidInlineSetup
          controller={controller}
          displayName={displayName}
          modelsActions={{
            primary: (
              <ConnectModelsButton
                appearance="setup-action"
                environmentId={props.environmentId}
                instanceId={props.provider.instanceId}
              />
            ),
            secondary: (
              <ConnectModelsButton
                appearance="setup-secondary"
                environmentId={props.environmentId}
                instanceId={props.provider.instanceId}
              />
            ),
          }}
          provider={props.provider}
        />
      );
      break;
    case "grok":
      setup = (
        <GrokInlineSetup
          {...managementProps}
          controller={controller}
          displayName={displayName}
          provider={props.provider}
        />
      );
      break;
    default:
      setup = null;
  }

  if (setup === null) return null;
  return (
    <>
      {setup}
      {isManagement && disconnectError ? (
        <div
          className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-destructive text-xs leading-relaxed"
          role="alert"
        >
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{disconnectError}</span>
        </div>
      ) : null}
    </>
  );
}

export function DisabledProviderSetup(props: {
  readonly displayName: string;
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
}) {
  const { access, canEnable, enable } = useProviderEnableAction({
    environmentId: props.environmentId,
    provider: props.provider,
  });
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gt = useGT();

  const runEnable = async () => {
    setError(null);
    setEnabling(true);
    try {
      await enable();
      // Keep the pending state until the canonical provider snapshot reports
      // enabled. This component then unmounts and the next action is revealed;
      // installation or sign-in is never started implicitly.
    } catch (cause) {
      setEnabling(false);
      setError(
        providerLifecycleFailureMessage(
          cause,
          m(msg("Scient could not enable {provider}.", { provider: props.displayName })),
        ),
      );
    }
  };

  const body = error
    ? error
    : access === "pending"
      ? gt("Checking whether this session can enable {provider}.", { provider: props.displayName })
      : access === "denied"
        ? gt("This session can view {provider}, but cannot enable it.", {
            provider: props.displayName,
          })
        : canEnable
          ? gt("Enable {provider} to continue.", { provider: props.displayName })
          : gt("Open provider settings to enable {provider}.", { provider: props.displayName });

  return (
    <AssistedSetupFrame>
      <AssistedSetupStatus
        body={body}
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
            ? gt("{provider} couldn’t be enabled", { provider: props.displayName })
            : gt("{provider} is disabled", { provider: props.displayName })
        }
      />
      {canEnable ? (
        <AssistedSetupActions>
          <Button
            disabled={enabling}
            onClick={() => void runEnable()}
            size="sm"
            type="button"
            variant="ghost-primary"
          >
            {enabling ? (
              <LoaderIcon aria-hidden className="animate-spin" />
            ) : (
              <PowerIcon aria-hidden />
            )}
            {enabling ? gt("Enabling…") : gt("Enable")}
          </Button>
        </AssistedSetupActions>
      ) : null}
    </AssistedSetupFrame>
  );
}
