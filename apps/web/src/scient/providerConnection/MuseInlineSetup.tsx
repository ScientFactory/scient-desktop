import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { providerAuthPresentation } from "@t3tools/client-runtime/provider-auth-presentation";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { ExternalLinkIcon, LoaderIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AssistedSetupActions,
  AssistedSetupDeviceCode,
  AssistedSetupFrame,
  AssistedSetupStatus,
  ProviderSetupIcon,
} from "./AssistedProviderSetup";
import { ManagedRuntimeComposerSetup } from "./ManagedRuntimeComposerSetup";
import { ProviderAuthorizationCodeForm } from "./ProviderAuthorizationCodeForm";
import {
  isActiveProviderRuntimeOperation,
  needsManagedRuntimeRecovery,
  providerRuntimeComputerLabel,
} from "./providerConnectionPresentation";
import { useProviderEnableAction } from "./useProviderEnableAction";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const DEVICE_METHOD = "muse_device";
const KEY_METHOD = "muse_key";

/** Muse installs through the shared runtime setup and signs in through its native account flow. */
export function MuseInlineSetup(props: {
  readonly controller: ProviderLifecycleController;
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
}) {
  const { access } = useProviderEnableAction(props);
  const runtime = props.provider.connection?.runtime;
  if (
    !props.managedRuntimePresentedExternally &&
    (!props.provider.installed ||
      needsManagedRuntimeRecovery(props.provider) ||
      isActiveProviderRuntimeOperation(runtime?.operation))
  ) {
    return (
      <ManagedRuntimeComposerSetup
        {...props}
        icon={ShieldCheckIcon}
        modelSetupHint="Sign in with a Meta account or API key."
      />
    );
  }
  if (!props.provider.installed) return null;
  return (
    <MuseAccountSetup
      key={props.provider.instanceId}
      controller={props.controller}
      displayName={props.displayName}
      environmentId={props.environmentId}
      provider={props.provider}
      readOnly={access !== "granted"}
    />
  );
}

type PendingAction = "device" | "key" | "submit" | "cancel" | "sign-out";

function MuseAccountSetup(props: {
  readonly controller: ProviderLifecycleController;
  readonly displayName: string;
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
}) {
  const { environmentId, provider } = props;
  const instanceId = provider.instanceId;
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const commands = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commands);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, commands);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commands);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, commands);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const startedHere = useRef(false);
  const openedInteraction = useRef<string | null>(null);

  const auth = query.data;
  const interaction = auth?.interaction ?? null;
  const { active, unverified } = providerAuthPresentation(provider, auth);
  const deviceCode = interaction?.type === "deviceCode" ? interaction : null;
  const methods = new Set(auth?.methods?.map((method) => method.id));
  const disabled = props.readOnly || pending !== null || query.error !== null;
  const { openAuthorizationPage } = props.controller;

  // Like other providers' sign-in, open the provider's page for the flow this view started.
  useEffect(() => {
    if (!deviceCode || !startedHere.current || openedInteraction.current === deviceCode.id) return;
    openedInteraction.current = deviceCode.id;
    openAuthorizationPage(deviceCode.url).catch(() => {
      setError("Couldn’t open Meta’s sign-in page. Use Reopen sign-in page.");
    });
  }, [deviceCode, openAuthorizationPage]);

  async function run(
    action: PendingAction,
    command: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) {
    if (pending !== null) return false;
    setPending(action);
    setError(null);
    try {
      const result = await command();
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Muse sign-in failed. Try again.");
      }
      return false;
    } catch {
      setError("Muse sign-in failed. Try again.");
      return false;
    } finally {
      setPending(null);
    }
  }

  const begin = (method: typeof DEVICE_METHOD | typeof KEY_METHOD) => {
    startedHere.current = true;
    void run(method === DEVICE_METHOD ? "device" : "key", () =>
      start({ environmentId, input: { instanceId, methodId: method } }),
    );
  };
  const stop = () => {
    if (!auth?.flowId) return;
    void run("cancel", () =>
      cancel({ environmentId, input: { instanceId, flowId: auth.flowId! } }),
    );
  };
  const cancelButton = (
    <Button
      aria-label="Cancel Muse sign-in"
      disabled={disabled}
      onClick={stop}
      size="sm"
      variant="ghost-destructive-action"
    >
      Cancel
    </Button>
  );

  if (active) {
    const verifying = auth?.phase === "verifying";
    if (interaction?.type === "credentials" && auth?.flowId) {
      const flowId = auth.flowId;
      return (
        <AssistedSetupFrame>
          <AssistedSetupStatus
            body="Muse saves the key on this computer."
            icon={<ProviderSetupIcon displayName={props.displayName} driver={provider.driver} />}
            title="Use a Meta API key"
          />
          <ProviderAuthorizationCodeForm
            authorizationCode={apiKey}
            disabled={disabled}
            inputLabel="Meta API key"
            onAuthorizationCodeChange={setApiKey}
            onSubmit={() =>
              void run("submit", () =>
                respond({
                  environmentId,
                  input: {
                    instanceId,
                    flowId,
                    interactionId: interaction.id,
                    response: { type: "credentials", values: { apiKey } },
                  },
                }),
              ).then((sent) => {
                if (sent) setApiKey("");
              })
            }
            placeholder="Paste your Meta API key"
            providerName="Muse"
            secret
            submitting={pending === "submit"}
          />
          <AssistedSetupActions>{cancelButton}</AssistedSetupActions>
        </AssistedSetupFrame>
      );
    }
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            error ??
            (verifying
              ? "Muse is saving your sign-in…"
              : deviceCode
                ? "Confirm this code on Meta’s sign-in page."
                : "Starting Muse sign-in…")
          }
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={verifying ? "Finishing sign-in" : "Finish signing in"}
        />
        {deviceCode ? (
          <AssistedSetupDeviceCode code={deviceCode.userCode} providerName="Muse" />
        ) : null}
        {!verifying ? (
          <AssistedSetupActions>
            {deviceCode ? (
              <Button
                disabled={props.readOnly}
                onClick={() =>
                  void openAuthorizationPage(deviceCode.url).catch(() => {
                    setError("Couldn’t open Meta’s sign-in page.");
                  })
                }
                size="sm"
                variant="ghost-muted"
              >
                <ExternalLinkIcon aria-hidden /> Reopen sign-in page
              </Button>
            ) : null}
            {cancelButton}
          </AssistedSetupActions>
        ) : null}
      </AssistedSetupFrame>
    );
  }

  // Runtimes that cannot change their account (unsupported version, instance API key) offer nothing here.
  if (!methods.has(DEVICE_METHOD) && !methods.has(KEY_METHOD)) return null;

  // Muse has no account-status check: a completed write is reported as saved, never as verified.
  const saved = unverified && auth?.phase === "idle" && auth.flowId !== null;
  const failure = error ?? (auth?.phase === "failed" ? auth.message : null);
  if (saved && !failure) {
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body="Muse uses it for new messages."
          icon={<ProviderSetupIcon displayName={props.displayName} driver={provider.driver} />}
          title="Sign-in saved"
        />
        <AssistedSetupActions>
          <Button
            disabled={disabled || provider.auth.canLogout !== true}
            onClick={() =>
              void ensureLocalApi()
                .dialogs.confirm(
                  `Sign out of ${props.displayName} on ${providerRuntimeComputerLabel(provider)}? This stops running threads that share this sign-in. Thread history is kept.`,
                )
                .then((confirmed) => {
                  if (confirmed) void run("sign-out", () => logout(target));
                })
            }
            size="sm"
            variant="ghost-destructive-action"
          >
            Sign out
          </Button>
        </AssistedSetupActions>
      </AssistedSetupFrame>
    );
  }
  return (
    <AssistedSetupFrame>
      <AssistedSetupStatus
        body={failure ?? "Use your Meta account or an API key."}
        icon={
          failure ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <ProviderSetupIcon displayName={props.displayName} driver={provider.driver} />
          )
        }
        role={failure ? "alert" : undefined}
        title={failure ? "Muse sign-in didn’t finish" : "Sign in to Muse"}
      />
      <AssistedSetupActions>
        {methods.has(KEY_METHOD) ? (
          <Button
            disabled={disabled}
            onClick={() => begin(KEY_METHOD)}
            size="sm"
            variant="ghost-muted"
          >
            Use API key
          </Button>
        ) : null}
        {methods.has(DEVICE_METHOD) ? (
          <Button
            disabled={disabled}
            onClick={() => begin(DEVICE_METHOD)}
            size="sm"
            variant="ghost-primary"
          >
            <ExternalLinkIcon aria-hidden /> {failure ? "Try again" : "Sign in with Meta"}
          </Button>
        ) : null}
      </AssistedSetupActions>
    </AssistedSetupFrame>
  );
}
