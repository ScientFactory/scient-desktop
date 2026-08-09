import {
  type EnvironmentId,
  type ProviderConnectionMethod,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderIcon,
  LogOutIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  isSafeProviderAuthorizationUrl,
  preferredProviderConnectionMethod,
  providerConnectionPresentation,
} from "./providerConnectionPresentation";
import { ProviderRuntimeSection } from "./ProviderRuntimeSection";

type PendingAction = "browser" | "device" | "cancel" | "disconnect" | null;

function failureMessage(value: unknown, fallback: string): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.trim().length > 0
  ) {
    return value.message;
  }
  return fallback;
}

function providerFromResult(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ServerProvider["instanceId"],
): ServerProvider | undefined {
  return providers.find((provider) => provider.instanceId === instanceId);
}

export function ProviderConnectionDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const startConnection = useAtomCommand(serverEnvironment.startProviderConnection, {
    reportFailure: false,
  });
  const cancelConnection = useAtomCommand(serverEnvironment.cancelProviderConnection, {
    reportFailure: false,
  });
  const disconnectProvider = useAtomCommand(serverEnvironment.disconnectProvider, {
    reportFailure: false,
  });
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [localOperation, setLocalOperation] = useState<ProviderConnectionOperation | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const presentation = providerConnectionPresentation(props.provider);
  const isConnected = presentation.kind === "connected";
  const operation = isConnected
    ? (props.provider.connection?.operation ?? null)
    : (props.provider.connection?.operation ?? localOperation);
  const availableMethods = props.provider.connection?.methods ?? [];
  const preferredMethod = preferredProviderConnectionMethod(props.provider);
  const isWorking = pendingAction !== null;
  const canCancel =
    operation !== null &&
    operation.status !== "connected" &&
    operation.status !== "cancelled" &&
    operation.status !== "failed";
  const { copyToClipboard } = useCopyToClipboard();

  useEffect(() => {
    setLocalOperation(null);
    setLocalError(null);
    setPendingAction(null);
  }, [props.provider.instanceId]);

  const accountLabel = useMemo(() => {
    const email = props.provider.auth.email?.trim();
    return email || props.provider.auth.label || props.provider.auth.type || null;
  }, [props.provider.auth.email, props.provider.auth.label, props.provider.auth.type]);

  const openAuthorizationPage = async (url: string) => {
    if (!isSafeProviderAuthorizationUrl(url)) {
      setLocalError("Scient refused an invalid or insecure provider sign-in link.");
      return;
    }
    try {
      await ensureLocalApi().shell.openExternal(url);
    } catch (error) {
      setLocalError(failureMessage(error, "Scient could not open the secure sign-in page."));
    }
  };

  const start = async (method: ProviderConnectionMethod) => {
    setLocalError(null);
    setPendingAction(method === "codex_device_code" ? "device" : "browser");
    const result = await startConnection({
      environmentId: props.environmentId,
      input: {
        instanceId: props.provider.instanceId,
        method,
      },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setLocalError(
          failureMessage(
            squashAtomCommandFailure(result),
            `Scient could not start ${props.displayName} sign in.`,
          ),
        );
      }
      return;
    }
    const returnedProvider = providerFromResult(result.value.providers, props.provider.instanceId);
    const nextOperation = returnedProvider?.connection?.operation ?? null;
    setLocalOperation(nextOperation);
    if (nextOperation?.authorizationUrl) {
      await openAuthorizationPage(nextOperation.authorizationUrl);
    }
  };

  const cancel = async () => {
    if (!operation) return;
    setLocalError(null);
    setPendingAction("cancel");
    const result = await cancelConnection({
      environmentId: props.environmentId,
      input: {
        instanceId: props.provider.instanceId,
        operationId: operation.operationId,
      },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setLocalError(
          failureMessage(squashAtomCommandFailure(result), "Scient could not cancel sign in."),
        );
      }
      return;
    }
    const returnedProvider = providerFromResult(result.value.providers, props.provider.instanceId);
    setLocalOperation(returnedProvider?.connection?.operation ?? null);
  };

  const disconnect = async () => {
    setLocalError(null);
    setPendingAction("disconnect");
    const result = await disconnectProvider({
      environmentId: props.environmentId,
      input: { instanceId: props.provider.instanceId },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setLocalError(
          failureMessage(
            squashAtomCommandFailure(result),
            `Scient could not sign out of ${props.displayName}.`,
          ),
        );
      }
      return;
    }
    setLocalOperation(null);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>{props.displayName} connection</DialogTitle>
          <DialogDescription>
            Set up the provider tool and sign in through {props.displayName}. Scient never asks for,
            receives, or stores your provider password.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <ProviderRuntimeSection
            environmentId={props.environmentId}
            provider={props.provider}
            displayName={props.displayName}
          />
          {isConnected ? (
            <div className="flex items-start gap-3 rounded-lg border border-success/25 bg-success/5 p-3">
              <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Connected</p>
                <p className="mt-0.5 break-all text-xs leading-relaxed text-muted-foreground">
                  {accountLabel ?? `${props.displayName} reports an authenticated account.`}
                </p>
                {props.provider.connection?.canDisconnect ? (
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    Signing out affects this provider credential home and any other app using the
                    same account files.
                  </p>
                ) : null}
              </div>
            </div>
          ) : !props.provider.installed ? null : operation &&
            operation.status !== "failed" &&
            operation.status !== "cancelled" ? (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
                <LoaderIcon
                  className="mt-0.5 size-5 shrink-0 animate-spin text-primary"
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {operation.status === "verifying" ? "Verifying connection" : "Finish sign in"}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {operation.message}
                  </p>
                </div>
              </div>
              {operation.userCode ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Device code
                    </p>
                    <code className="mt-1 block text-base font-semibold tracking-wider text-foreground">
                      {operation.userCode}
                    </code>
                  </div>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label="Copy device code"
                    onClick={() => copyToClipboard(operation.userCode!, undefined)}
                  >
                    <CopyIcon />
                  </Button>
                </div>
              ) : null}
              {operation.authorizationUrl ? (
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => void openAuthorizationPage(operation.authorizationUrl!)}
                >
                  <ExternalLinkIcon />
                  Open secure sign-in page
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3">
                <ShieldCheckIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-foreground">{presentation.label}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {presentation.kind === "not-required"
                      ? "This provider is ready without account sign in."
                      : preferredMethod
                        ? "Your browser is the fastest option. Device-code sign in is available when browser callbacks are inconvenient."
                        : "This provider currently uses its own manual setup flow."}
                  </p>
                </div>
              </div>
              {operation?.status === "failed" || operation?.status === "cancelled" ? (
                <p className="text-xs leading-relaxed text-muted-foreground">{operation.message}</p>
              ) : null}
            </div>
          )}

          {localError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive"
            >
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{localError}</span>
            </div>
          ) : null}

          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            The provider owns credential storage, refresh, expiry, and revocation. Scient only
            starts the official flow and verifies the resulting provider state.
          </p>
        </DialogPanel>
        <DialogFooter className="sm:justify-between">
          {isConnected && props.provider.connection?.canDisconnect ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={isWorking}
              onClick={() => void disconnect()}
            >
              {pendingAction === "disconnect" ? (
                <LoaderIcon className="animate-spin" />
              ) : (
                <LogOutIcon />
              )}
              Sign out on this computer
            </Button>
          ) : canCancel ? (
            <Button
              type="button"
              variant="ghost"
              disabled={isWorking}
              onClick={() => void cancel()}
            >
              {pendingAction === "cancel" ? <LoaderIcon className="animate-spin" /> : null}
              Cancel sign in
            </Button>
          ) : (
            <span />
          )}
          {props.provider.installed && !isConnected && !canCancel && preferredMethod ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              {availableMethods.includes("codex_device_code") ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={isWorking}
                  onClick={() => void start("codex_device_code")}
                >
                  {pendingAction === "device" ? <LoaderIcon className="animate-spin" /> : null}
                  Use device code
                </Button>
              ) : null}
              <Button
                type="button"
                disabled={isWorking}
                onClick={() => void start(preferredMethod)}
              >
                {pendingAction === "browser" ? <LoaderIcon className="animate-spin" /> : null}
                Continue in browser
              </Button>
            </div>
          ) : (
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
