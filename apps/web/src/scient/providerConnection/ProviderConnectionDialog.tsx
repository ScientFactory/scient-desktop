import {
  type EnvironmentId,
  type ProviderConnectionMethod,
  type ProviderConnectionOperation,
  type ProviderManagedRuntimeAction,
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
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
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
  hasActiveProviderRuntimeOperation,
  isActiveProviderConnectionOperation,
  isProviderAccountPresentedAsConnected,
  isSafeProviderAuthorizationUrl,
  preferredProviderConnectionMethod,
  providerAccountIdentity,
  providerConnectionPresentation,
  providerLifecycleFailureMessage,
} from "./providerConnectionPresentation";
import { ProviderRuntimeSection } from "./ProviderRuntimeSection";
import { DESTRUCTIVE_GHOST_ACTION_CLASS } from "./providerConnectionActionStyles";
import { ProviderAuthorizationCodeForm } from "./ProviderAuthorizationCodeForm";
import {
  AssistedProviderSetupHost,
  supportsAssistedProviderSetupSurface,
} from "./AssistedProviderSetupHost";
import { useTransientRepairSuccess } from "./useTransientRepairSuccess";

type PendingAction = "browser" | "device" | "submit-code" | "cancel" | "disconnect" | null;

function providerFromResult(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ServerProvider["instanceId"],
): ServerProvider | undefined {
  return providers.find((provider) => provider.instanceId === instanceId);
}

interface ProviderConnectionDialogProps {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly initialRuntimeAction?: ProviderManagedRuntimeAction | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ProviderConnectionDialog(props: ProviderConnectionDialogProps) {
  const { repairSucceededRecently, reportRuntimeActionSucceeded } = useTransientRepairSuccess(
    props.open,
  );

  const contentProps = {
    ...props,
    onRuntimeActionSucceeded: reportRuntimeActionSucceeded,
    repairSucceededRecently,
  };
  return supportsAssistedProviderSetupSurface(props.provider.driver, "management") ? (
    <AssistedProviderConnectionDialog key={props.provider.instanceId} {...contentProps} />
  ) : (
    <GenericProviderConnectionDialog key={props.provider.instanceId} {...contentProps} />
  );
}

interface ProviderConnectionDialogContentProps extends ProviderConnectionDialogProps {
  readonly onRuntimeActionSucceeded: (action: ProviderManagedRuntimeAction) => void;
  readonly repairSucceededRecently: boolean;
}

function ProviderConnectionDialogTitle(props: {
  readonly displayName: string;
  readonly driver: ServerProvider["driver"];
  readonly repairSucceededRecently: boolean;
}) {
  return (
    <>
      <span aria-hidden>
        <ProviderInstanceIcon
          className="size-6"
          displayName={props.displayName}
          driverKind={props.driver}
          iconClassName="size-6"
        />
      </span>
      <span>{props.displayName}</span>
      {props.repairSucceededRecently ? (
        <span
          className="ms-1 rounded-full bg-success/10 px-2 py-0.5 font-medium text-success text-xs"
          role="status"
        >
          Repair successful
        </span>
      ) : null}
    </>
  );
}

function AssistedProviderConnectionDialog(props: ProviderConnectionDialogContentProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [accountActionPending, setAccountActionPending] = useState(false);
  const isRuntimeWorking = hasActiveProviderRuntimeOperation(props.provider);
  const isConnected = isProviderAccountPresentedAsConnected(props.provider);
  const isClaude = props.provider.driver === "claudeAgent";
  const isGrok = props.provider.driver === "grok";
  const isDroid = props.provider.driver === "droid";
  const isCursor = props.provider.driver === "cursor";
  const assistedDisplayName = props.displayName;
  const runtime = props.provider.connection?.runtime;
  const hasActionableManagedRuntime =
    runtime?.source === "scient_managed" &&
    (runtime.actions.length > 0 || runtime.operation !== null);
  const hasQualifiedSystemManagedAction =
    runtime?.source === "system" && runtime.actions.includes("install");
  const cursorInlineInstallIsRunning =
    isCursor &&
    props.initialRuntimeAction === "install" &&
    isRuntimeWorking &&
    runtime?.operation?.action === "install";
  const hasRuntimeMaintenanceActions =
    runtime?.actions.some((action) => action !== "install") ?? false;
  const showManagedRuntime =
    runtime !== undefined &&
    !cursorInlineInstallIsRunning &&
    (isCursor
      ? isConnected || hasRuntimeMaintenanceActions
      : isConnected ||
        props.initialRuntimeAction !== undefined ||
        hasActionableManagedRuntime ||
        hasQualifiedSystemManagedAction) &&
    (runtime.actions.length > 0 || runtime.diagnostics !== undefined || runtime.operation !== null);
  const availableInitialRuntimeAction =
    props.initialRuntimeAction !== undefined &&
    showManagedRuntime &&
    runtime.actions.includes(props.initialRuntimeAction)
      ? props.initialRuntimeAction
      : undefined;
  const [isRuntimePlanOpen, setIsRuntimePlanOpen] = useState(
    availableInitialRuntimeAction !== undefined,
  );
  const isManagedRuntimeFocused = showManagedRuntime && (isRuntimePlanOpen || isRuntimeWorking);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-[26rem]" initialFocus={titleRef} showCloseButton>
        <DialogHeader>
          <DialogTitle ref={titleRef} className="flex flex-wrap items-center gap-2.5">
            <ProviderConnectionDialogTitle
              displayName={assistedDisplayName}
              driver={props.provider.driver}
              repairSucceededRecently={props.repairSucceededRecently}
            />
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isClaude
              ? "Connect and manage your Claude account."
              : isGrok
                ? "Install Grok and connect your existing subscription."
                : isDroid
                  ? "Install Droid and connect your Factory account."
                  : isCursor
                    ? "Connect and manage your Cursor account."
                    : "Connect and manage your existing ChatGPT subscription."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {showManagedRuntime ? (
            <ProviderRuntimeSection
              compact
              disabled={accountActionPending}
              displayName={assistedDisplayName}
              environmentId={props.environmentId}
              initialAction={availableInitialRuntimeAction}
              onActionSucceeded={props.onRuntimeActionSucceeded}
              onPlanOpenChange={setIsRuntimePlanOpen}
              provider={props.provider}
            />
          ) : null}
          {isManagedRuntimeFocused ? null : (
            <AssistedProviderSetupHost
              accountActionDisabled={isRuntimeWorking || isRuntimePlanOpen}
              displayName={props.displayName}
              environmentId={props.environmentId}
              managedRuntimePresentedExternally={showManagedRuntime}
              onAccountActionPendingChange={setAccountActionPending}
              onRepairSucceeded={() => props.onRuntimeActionSucceeded("repair")}
              provider={props.provider}
              surface="management"
            />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function GenericProviderConnectionDialog(props: ProviderConnectionDialogContentProps) {
  const startConnection = useAtomCommand(serverEnvironment.startProviderConnection, {
    reportFailure: false,
  });
  const cancelConnection = useAtomCommand(serverEnvironment.cancelProviderConnection, {
    reportFailure: false,
  });
  const submitAuthorizationCode = useAtomCommand(
    serverEnvironment.submitProviderAuthorizationCode,
    { reportFailure: false },
  );
  const disconnectProvider = useAtomCommand(serverEnvironment.disconnectProvider, {
    reportFailure: false,
  });
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [localOperation, setLocalOperation] = useState<ProviderConnectionOperation | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [isRuntimePlanOpen, setIsRuntimePlanOpen] = useState(
    props.initialRuntimeAction !== undefined,
  );
  const presentation = providerConnectionPresentation(props.provider);
  const isRuntimeWorking = hasActiveProviderRuntimeOperation(props.provider);
  const isConnected = isProviderAccountPresentedAsConnected(props.provider);
  const operation = isConnected
    ? (props.provider.connection?.operation ?? null)
    : (props.provider.connection?.operation ?? localOperation);
  const availableMethods = props.provider.connection?.methods ?? [];
  const preferredMethod = preferredProviderConnectionMethod(props.provider);
  const isAntigravityGoogle = preferredMethod === "antigravity_google";
  const isAntigravity = props.provider.driver === "antigravity";
  const isWorking = pendingAction !== null || isRuntimeWorking;
  const canCancel = isActiveProviderConnectionOperation(operation);
  const { copyToClipboard } = useCopyToClipboard();

  useEffect(() => {
    setLocalOperation(null);
    setLocalError(null);
    setAuthorizationCode("");
    setPendingAction(null);
  }, [props.provider.instanceId]);

  useEffect(() => {
    setLocalError(null);
  }, [
    props.provider.auth.status,
    props.provider.connection?.runtime?.operation?.operationId,
    props.provider.connection?.runtime?.operation?.status,
    props.provider.connection?.runtime?.source,
    props.provider.installed,
  ]);

  const accountLabel = providerAccountIdentity(props.provider) ?? props.provider.auth.type ?? null;
  const acceptsAuthorizationCode =
    operation?.acceptsAuthorizationCode === true ||
    (operation?.acceptsAuthorizationCode === undefined &&
      operation?.method === "antigravity_google" &&
      operation.authorizationUrlKind === "primary");

  const openAuthorizationPage = async (url: string) => {
    if (!isSafeProviderAuthorizationUrl(url)) {
      setLocalError("Scient refused an invalid or insecure provider sign-in link.");
      return;
    }
    try {
      await ensureLocalApi().shell.openExternal(url);
    } catch (error) {
      setLocalError(
        providerLifecycleFailureMessage(error, "Scient could not open the secure sign-in page."),
      );
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
          providerLifecycleFailureMessage(
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
    if (
      nextOperation?.authorizationUrl &&
      nextOperation.authorizationUrlKind !== "manual_fallback"
    ) {
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
          providerLifecycleFailureMessage(
            squashAtomCommandFailure(result),
            "Scient could not cancel sign in.",
          ),
        );
      }
      return;
    }
    const returnedProvider = providerFromResult(result.value.providers, props.provider.instanceId);
    setLocalOperation(returnedProvider?.connection?.operation ?? null);
  };

  const submitCode = async () => {
    if (!operation || authorizationCode.trim().length === 0) return;
    setLocalError(null);
    setPendingAction("submit-code");
    const result = await submitAuthorizationCode({
      environmentId: props.environmentId,
      input: {
        instanceId: props.provider.instanceId,
        operationId: operation.operationId,
        authorizationCode,
      },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setLocalError(
          providerLifecycleFailureMessage(
            squashAtomCommandFailure(result),
            "Scient could not return the authorization code to Antigravity.",
          ),
        );
      }
      return;
    }
    setAuthorizationCode("");
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
          providerLifecycleFailureMessage(
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
          <DialogTitle className="flex flex-wrap items-center gap-2.5">
            <ProviderConnectionDialogTitle
              displayName={props.displayName}
              driver={props.provider.driver}
              repairSucceededRecently={props.repairSucceededRecently}
            />
          </DialogTitle>
          <DialogDescription className="sr-only">
            Manage the {props.displayName} installation and account connection.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <ProviderRuntimeSection
            compact={props.provider.driver === "antigravity"}
            disabled={pendingAction !== null}
            environmentId={props.environmentId}
            provider={props.provider}
            displayName={props.displayName}
            initialAction={props.initialRuntimeAction}
            onActionSucceeded={props.onRuntimeActionSucceeded}
            onPlanOpenChange={setIsRuntimePlanOpen}
          />
          {!isRuntimePlanOpen && !isRuntimeWorking ? (
            <div className="contents">
              {isConnected ? (
                <div
                  className={
                    isAntigravity
                      ? "flex items-center justify-between gap-4 py-1"
                      : "flex items-center justify-between gap-4 rounded-lg border p-3"
                  }
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <CheckCircle2Icon className="size-5 shrink-0 text-success" aria-hidden />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">Connected</p>
                      <p className="mt-0.5 break-all text-xs text-muted-foreground">
                        {accountLabel ?? `${props.displayName} reports an authenticated account.`}
                      </p>
                    </div>
                  </div>
                  {props.provider.connection?.canDisconnect ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost-muted"
                      className={`me-2 shrink-0 self-end ${DESTRUCTIVE_GHOST_ACTION_CLASS}`}
                      disabled={isWorking}
                      onClick={() => void disconnect()}
                    >
                      {pendingAction === "disconnect" ? (
                        <LoaderIcon className="animate-spin" />
                      ) : (
                        <LogOutIcon />
                      )}
                      Sign out
                    </Button>
                  ) : null}
                </div>
              ) : isRuntimeWorking || !props.provider.installed ? null : operation &&
                operation.status !== "failed" &&
                operation.status !== "cancelled" ? (
                <div className="space-y-3">
                  <div
                    className={
                      isAntigravity
                        ? "flex items-start gap-3 py-1"
                        : "flex items-start gap-3 rounded-lg border bg-muted/30 p-3"
                    }
                  >
                    <LoaderIcon
                      className="mt-0.5 size-5 shrink-0 animate-spin text-primary"
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {operation.status === "verifying"
                          ? "Verifying connection"
                          : "Finish sign in"}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {isAntigravityGoogle && acceptsAuthorizationCode
                          ? "Sign in with Google, then paste the authorization code below."
                          : operation.message}
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
                      className={isAntigravity ? "w-fit" : "w-full"}
                      onClick={() => void openAuthorizationPage(operation.authorizationUrl!)}
                      size={isAntigravity ? "sm" : "default"}
                      variant={isAntigravity ? "ghost-muted" : "default"}
                    >
                      <ExternalLinkIcon />
                      {operation.authorizationUrlKind === "manual_fallback"
                        ? isAntigravityGoogle
                          ? "Open sign-in help"
                          : "Browser didn’t open?"
                        : isAntigravityGoogle
                          ? "Reopen Google sign-in"
                          : "Open secure sign-in page"}
                    </Button>
                  ) : null}
                  {acceptsAuthorizationCode && operation.status !== "verifying" ? (
                    <div className="space-y-2 pt-1">
                      {!isAntigravityGoogle ? (
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          Paste the one-time authorization code shown by the provider.
                        </p>
                      ) : null}
                      <ProviderAuthorizationCodeForm
                        authorizationCode={authorizationCode}
                        disabled={isWorking}
                        onAuthorizationCodeChange={setAuthorizationCode}
                        onSubmit={() => void submitCode()}
                        providerName={props.displayName}
                        submitting={pendingAction === "submit-code"}
                      />
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-3">
                  <div
                    className={
                      isAntigravity
                        ? "flex items-start gap-3 py-1"
                        : "flex items-start gap-3 rounded-lg border bg-muted/20 p-3"
                    }
                  >
                    <ShieldCheckIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {isAntigravityGoogle ? "Sign in required" : presentation.label}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {presentation.kind === "not-required"
                          ? "This provider is ready without account sign in."
                          : isAntigravityGoogle
                            ? "Sign in with your Google account to use your existing subscription."
                            : preferredMethod
                              ? "Your browser is the fastest option. Device-code sign in is available when browser callbacks are inconvenient."
                              : "This provider currently uses its own manual setup flow."}
                      </p>
                    </div>
                  </div>
                  {operation?.status === "failed" ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {operation.message}
                    </p>
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
            </div>
          ) : null}
        </DialogPanel>
        {!isRuntimePlanOpen &&
        !isRuntimeWorking &&
        !isConnected &&
        (canCancel || (props.provider.installed && preferredMethod)) ? (
          <DialogFooter className="sm:justify-between" variant="bare">
            {canCancel ? (
              <Button
                type="button"
                variant="ghost-muted"
                className={DESTRUCTIVE_GHOST_ACTION_CLASS}
                disabled={isWorking}
                onClick={() => void cancel()}
              >
                {pendingAction === "cancel" ? <LoaderIcon className="animate-spin" /> : <XIcon />}
                Cancel sign in
              </Button>
            ) : (
              <span />
            )}
            {props.provider.installed &&
            !isConnected &&
            !isRuntimeWorking &&
            !canCancel &&
            preferredMethod ? (
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
                  {isAntigravityGoogle ? "Sign in with Google" : "Continue in browser"}
                </Button>
              </div>
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
