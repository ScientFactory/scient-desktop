import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentAuthorizationError,
  type EnvironmentId,
  WhatsAppError,
  type WhatsAppFailureReason,
  type WhatsAppLinkState,
  type WhatsAppStatus,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { QRCodeSvg } from "../../components/ui/qr-code";
import { Spinner } from "../../components/ui/spinner";
import { m } from "../../i18n/messages";
import { useEnvironment, useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { type AccountService, accountServiceTagline } from "./accountServices";
import { DetailSection } from "./ExtensionDetailPages";
import { ActionError } from "./ExtensionsFeedback";
import { ExtensionRow } from "./ExtensionRow";
import { MutedLine, useExtensionsEnvironment } from "./ExtensionsPage";
import { runsOnThisComputer } from "./whatsAppHost";
import {
  cancelWhatsAppLink,
  isWhatsAppInstalled,
  startWhatsAppLink,
  unlinkWhatsApp,
  useWhatsAppStatus,
} from "./whatsAppState";

/** Meta's WhatsApp Business Tools in the curated catalog (`scient.curated/<id>`). */
const WHATSAPP_BUSINESS_SERVER = "scient.curated/whatsapp-business";

const isWhatsAppError = Schema.is(WhatsAppError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

function linkFailureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  if (isWhatsAppError(error)) return error.message;
  if (isAuthorizationError(error))
    return m(msg("This connection is not allowed to change WhatsApp."));
  return m(msg("Scient could not complete this request. Try again."));
}

/**
 * The label of the machine running this environment's Scient server when it is not this
 * computer: WhatsApp then sees the link coming from there.
 */
function useElsewhereLabel(environmentId: EnvironmentId): string | null {
  const environment = useEnvironment(environmentId);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  if (environment === null) return null;
  return runsOnThisComputer(
    environment.entry.target,
    httpBaseUrl,
    typeof window !== "undefined" && window.desktopBridge !== undefined,
  ) === false
    ? environment.label
    : null;
}

function ElsewhereWarning({ label }: { readonly label: string }) {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertDescription>
        <T>
          Scient is running on <Var>{label}</Var>, not this computer. This raises the risk.
        </T>
      </AlertDescription>
    </Alert>
  );
}

/** What WhatsApp's linking risks are, shown before every new link. */
function RiskDialog({
  elsewhere,
  busy,
  onLink,
  onClose,
}: {
  readonly elsewhere: string | null;
  readonly busy: boolean;
  readonly onLink: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <T>Before you link</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              WhatsApp doesn't officially support linking apps like Scient, and some accounts linked
              this way have been restricted. It's safest on your own computer, with your own number.
            </T>
          </DialogDescription>
        </DialogHeader>
        {elsewhere ? (
          <DialogPanel>
            <ElsewhereWarning label={elsewhere} />
          </DialogPanel>
        ) : null}
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button disabled={busy} onClick={onLink}>
            <T>Link WhatsApp</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function UnlinkDialog({
  disabled,
  onUnlink,
  onClose,
}: {
  readonly disabled: boolean;
  readonly onUnlink: () => void;
  readonly onClose: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <T>Unlink WhatsApp?</T>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <T>This also deletes Scient's copy of your chats.</T>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button variant="destructive" disabled={disabled} onClick={onUnlink}>
            <T>Unlink</T>
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const FAILURE_TEXT: Readonly<Record<Exclude<WhatsAppFailureReason, "failed">, string>> = {
  "passkey-required": msg("WhatsApp asked for a passkey, which Scient doesn't support yet."),
  "scan-timed-out": msg("The code expired."),
  "unsupported-platform": msg("WhatsApp isn't available on this computer yet."),
  "install-failed": msg("Couldn't set up WhatsApp. Check your connection and try again."),
  "client-outdated": msg("Update Scient and try again."),
};

function Actions({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

/** Scient's own link: the phone scans a code and this computer becomes one of its linked devices. */
function DeviceLink({
  environmentId,
  status,
  elsewhere,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: WhatsAppStatus;
  readonly elsewhere: string | null;
}) {
  const gt = useGT();
  const locale = useLocale();
  const messages = useMessages();
  const { canWrite } = useExtensionsEnvironment();
  const canStart = useAtomValue(startWhatsAppLink.permissionAtom(environmentId));
  const canCancel = useAtomValue(cancelWhatsAppLink.permissionAtom(environmentId));
  const canUnlink = useAtomValue(unlinkWhatsApp.permissionAtom(environmentId));
  const start = useAtomCommand(startWhatsAppLink, { reportFailure: false });
  const cancel = useAtomCommand(cancelWhatsAppLink, { reportFailure: false });
  const unlink = useAtomCommand(unlinkWhatsApp, { reportFailure: false });
  const [dialog, setDialog] = useState<"risk" | "unlink" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (command: typeof start | typeof cancel | typeof unlink) => {
    setDialog(null);
    setError(null);
    setPending(true);
    const result = await command({ environmentId, input: {} });
    setPending(false);
    setError(linkFailureMessage(result));
  };
  const linkDisabled = !canWrite || !canStart || pending;
  const unlinkDisabled = !canWrite || !canUnlink || pending;
  const linkButton = (label: ReactNode) =>
    status.platformSupported ? (
      <Actions>
        <Button size="sm" disabled={linkDisabled} onClick={() => setDialog("risk")}>
          {label}
        </Button>
      </Actions>
    ) : null;
  const cancelButton = (
    <Actions>
      <Button
        size="sm"
        variant="outline"
        disabled={!canWrite || !canCancel || pending}
        onClick={() => void run(cancel)}
      >
        <T>Cancel</T>
      </Button>
    </Actions>
  );
  const unlinkButton = (
    <Actions>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={unlinkDisabled}
        onClick={() => setDialog("unlink")}
      >
        <T>Unlink</T>
      </Button>
    </Actions>
  );

  const state: WhatsAppLinkState = status.state;
  const canLinkFromState =
    status.platformSupported &&
    (state._tag === "Unlinked" ||
      state._tag === "RemovedByPhone" ||
      (state._tag === "Failed" && state.reason !== "unsupported-platform"));
  const canUnlinkFromState = state._tag === "Linked" || state._tag === "Restricted";
  const body = ((): ReactNode => {
    if (!status.platformSupported && !canUnlinkFromState)
      return (
        <MutedLine>
          <T>WhatsApp isn't available on this computer yet.</T>
        </MutedLine>
      );
    switch (state._tag) {
      case "Unlinked":
        return linkButton(<T>Link WhatsApp</T>);
      case "Installing":
        return (
          <>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="md" tone="muted" />
              <T>Getting WhatsApp ready…</T>
            </p>
            {cancelButton}
          </>
        );
      case "AwaitingScan":
        return (
          <>
            <div className="w-fit rounded-xl border bg-white p-2">
              <QRCodeSvg value={state.qr} size={208} marginSize={4} title={gt("WhatsApp code")} />
            </div>
            <p className="text-sm">
              <T>Scan with your phone: WhatsApp → Settings → Linked devices → Link a device.</T>
            </p>
            {cancelButton}
          </>
        );
      case "Syncing":
        return (
          <>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="md" tone="muted" />
              <T>Bringing in your chats…</T>
            </p>
            {cancelButton}
          </>
        );
      case "Linked":
        return (
          <>
            <p className="text-sm">
              <T>
                Linked to <Var>{state.account}</Var>
              </T>
            </p>
            {unlinkButton}
          </>
        );
      case "Restricted":
        return (
          <>
            <p className="text-sm">
              {state.until === undefined
                ? gt("WhatsApp has restricted this account for now.")
                : gt("WhatsApp has restricted this account until {date}.", {
                    date: new Date(state.until).toLocaleString(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
            </p>
            {unlinkButton}
          </>
        );
      case "RemovedByPhone":
        return (
          <>
            <MutedLine>
              <T>Your phone removed this link.</T>
            </MutedLine>
            {linkButton(<T>Link again</T>)}
          </>
        );
      case "Failed":
        return (
          <>
            <MutedLine>
              {state.reason === "failed" ? state.message : messages(FAILURE_TEXT[state.reason])}
            </MutedLine>
            {canLinkFromState ? linkButton(<T>Try again</T>) : null}
          </>
        );
    }
  })();

  const connection =
    state._tag !== "Linked"
      ? state._tag === "Restricted"
        ? gt("Restricted")
        : undefined
      : state.connection === "connected"
        ? gt("Connected")
        : state.connection === "connecting"
          ? gt("Reconnecting…")
          : gt("Offline");

  return (
    <DetailSection title={gt("Your WhatsApp")} status={connection}>
      {elsewhere && state._tag !== "Linked" && state._tag !== "Restricted" ? (
        <ElsewhereWarning label={elsewhere} />
      ) : null}
      {body}
      <ActionError message={error} />
      {dialog === "risk" && canLinkFromState ? (
        <RiskDialog
          elsewhere={elsewhere}
          busy={linkDisabled}
          onLink={() => void run(start)}
          onClose={() => setDialog(null)}
        />
      ) : dialog === "unlink" && canUnlinkFromState ? (
        <UnlinkDialog
          disabled={unlinkDisabled}
          onUnlink={() => void run(unlink)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </DetailSection>
  );
}

/**
 * WhatsApp's page: Scient's own link as a device, driven by the server's live status, and Meta's
 * WhatsApp Business tools as the second, labelled way.
 */
export function WhatsAppSetup() {
  const gt = useGT();
  const { environmentId, canWrite } = useExtensionsEnvironment();
  const { status, error } = useWhatsAppStatus(canWrite ? environmentId : null);
  const elsewhere = useElsewhereLabel(environmentId);
  return (
    <>
      {status ? (
        <DeviceLink
          key={environmentId}
          environmentId={environmentId}
          status={status}
          elsewhere={elsewhere}
        />
      ) : (
        <DetailSection title={gt("Your WhatsApp")}>
          <MutedLine>
            {canWrite
              ? (error ?? gt("Checking WhatsApp…"))
              : gt("This connection needs permission to change settings to link WhatsApp.")}
          </MutedLine>
        </DetailSection>
      )}
      <DetailSection title={gt("WhatsApp Business")}>
        <MutedLine>
          <T>Meta's official tools for business accounts.</T>
        </MutedLine>
        <Actions>
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/settings/extensions/item/server/$"
                params={{ _splat: WHATSAPP_BUSINESS_SERVER }}
              />
            }
          >
            <T>Open</T>
          </Button>
        </Actions>
      </DetailSection>
    </>
  );
}

/** WhatsApp's row in Discover and Installed: its link state, or a + that opens its page. */
export function WhatsAppServiceItem({ service }: { readonly service: AccountService }) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, canWrite } = useExtensionsEnvironment();
  const state = useWhatsAppStatus(canWrite ? environmentId : null).status?.state;
  const status =
    state?._tag === "Linked"
      ? gt("Linked")
      : state?._tag === "Restricted"
        ? gt("Restricted")
        : isWhatsAppInstalled(state)
          ? gt("Linking…")
          : null;
  return (
    <ExtensionRow
      target={{ kind: "account", serviceId: service.id }}
      name={service.name}
      type={messages(msg("Built in", { $context: "extension type" }))}
      {...(state?._tag === "Linked" ? { audience: { layer: "scient" } as const } : {})}
      status={status}
      tagline={accountServiceTagline(service, messages) || undefined}
      trailing={
        status === null ? (
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={gt("Connect {name}", { name: service.name })}
            render={
              <Link
                to="/settings/extensions/item/account/$serviceId"
                params={{ serviceId: service.id }}
              />
            }
          >
            <PlusIcon aria-hidden />
          </Button>
        ) : null
      }
    />
  );
}
