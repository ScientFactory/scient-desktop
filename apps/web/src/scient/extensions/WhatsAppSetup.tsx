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
import {
  type AccountService,
  accountServiceTagline,
  WHATSAPP_BUSINESS_SERVER,
} from "./accountServices";
import {
  AboutCard,
  DetailHeader,
  DetailLayout,
  DetailSection,
  PrimaryAction,
  RELATED_EXTENSION_LINK_CLASS,
  RelatedExtension,
} from "./ExtensionDetailPages";
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

/** Before every new link: the risk, and what keeps it low. */
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
              WhatsApp doesn't officially support apps like Scient, so your account could be
              temporarily restricted. The risk is lower when you:
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3 text-sm">
            <ul className="grid list-disc gap-1 ps-5">
              <li>
                <T>Run Scient on your own computer, not a server or the cloud.</T>
              </li>
              <li>
                <T>Use a number you've had for a while.</T>
              </li>
              <li>
                <T>Don't send many messages at once, or to people who haven't messaged you.</T>
              </li>
            </ul>
            {elsewhere ? <ElsewhereWarning label={elsewhere} /> : null}
          </div>
        </DialogPanel>
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
  "unlink-incomplete": msg("Scient couldn't delete its copy of your chats. Unlink again."),
};

/**
 * The link's controls and what it shows. The header carries Link or Unlink, as Add and Remove
 * on other pages; the section appears only while there is something to show.
 */
function useDeviceLink(
  environmentId: EnvironmentId,
  status: WhatsAppStatus | null,
  elsewhere: string | null,
) {
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

  const state = status?.state;
  const canLinkFromState =
    status?.platformSupported === true &&
    (state?._tag === "Unlinked" ||
      state?._tag === "RemovedByPhone" ||
      (state?._tag === "Failed" &&
        state.reason !== "unsupported-platform" &&
        state.reason !== "unlink-incomplete"));
  const canUnlinkFromState =
    state?._tag === "Linked" ||
    state?._tag === "Restricted" ||
    (state?._tag === "Failed" && state.reason === "unlink-incomplete");
  const linkDisabled = !canWrite || !canStart || pending;
  const unlinkDisabled = !canWrite || !canUnlink || pending;

  const actions = canLinkFromState ? (
    <PrimaryAction icon={PlusIcon} disabled={linkDisabled} onClick={() => setDialog("risk")}>
      {gt("Link", { $context: "verb, links WhatsApp to Scient" })}
    </PrimaryAction>
  ) : canUnlinkFromState ? (
    <Button
      size="sm"
      variant="destructive-outline"
      disabled={unlinkDisabled}
      onClick={() => setDialog("unlink")}
    >
      <T>Unlink</T>
    </Button>
  ) : null;

  const cancelButton = (
    <div>
      <Button
        size="sm"
        variant="outline"
        disabled={!canWrite || !canCancel || pending}
        onClick={() => void run(cancel)}
      >
        <T>Cancel</T>
      </Button>
    </div>
  );
  const working = (label: ReactNode) => (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner size="md" tone="muted" />
      {label}
    </p>
  );

  const body = ((): ReactNode => {
    if (status === null) return null;
    if (!status.platformSupported && !canUnlinkFromState)
      return (
        <MutedLine>
          <T>WhatsApp isn't available on this computer yet.</T>
        </MutedLine>
      );
    switch (state?._tag) {
      case "Installing":
        return (
          <>
            {working(<T>Getting WhatsApp ready…</T>)}
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
            {working(<T>Bringing in your chats…</T>)}
            {cancelButton}
          </>
        );
      case "Linked":
        return (
          <p className="text-sm">
            <T>
              Linked to <Var>{state.account}</Var>
            </T>
          </p>
        );
      case "Restricted":
        return (
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
        );
      case "RemovedByPhone":
        return (
          <MutedLine>
            <T>Your phone removed this link.</T>
          </MutedLine>
        );
      case "Failed":
        return (
          <MutedLine>
            {state.reason === "failed" ? state.message : messages(FAILURE_TEXT[state.reason])}
          </MutedLine>
        );
      default:
        return null;
    }
  })();

  const connection =
    state?._tag === "Restricted"
      ? gt("Restricted")
      : state?._tag !== "Linked"
        ? undefined
        : state.connection === "connected"
          ? gt("Connected")
          : state.connection === "connecting"
            ? gt("Reconnecting…")
            : gt("Offline");

  const dialogs =
    dialog === "risk" && canLinkFromState ? (
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
    ) : null;

  return { actions, body, connection, dialogs, error };
}

/**
 * WhatsApp's page: Scient's own link as a device, driven by the server's live status, and Meta's
 * WhatsApp Business tools as the second, labelled way.
 */
export function WhatsAppDetail({ service }: { readonly service: AccountService }) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, canWrite } = useExtensionsEnvironment();
  const { status, error: statusError } = useWhatsAppStatus(canWrite ? environmentId : null);
  const elsewhere = useElsewhereLabel(environmentId);
  const link = useDeviceLink(environmentId, status, elsewhere);
  const linked = status?.state._tag === "Linked" || status?.state._tag === "Restricted";
  const unavailable =
    status === null
      ? canWrite
        ? (statusError ?? gt("Checking WhatsApp…"))
        : gt("This connection needs permission to change settings to link WhatsApp.")
      : null;
  return (
    <DetailLayout
      back="installed"
      header={
        <DetailHeader
          name={service.name}
          tagline={accountServiceTagline(service, messages) || undefined}
          actions={link.actions}
        />
      }
      description={messages(service.description)}
      feedback={
        <>
          {elsewhere && !linked ? <ElsewhereWarning label={elsewhere} /> : null}
          {unavailable ? <MutedLine>{unavailable}</MutedLine> : null}
          <ActionError message={link.error} />
        </>
      }
    >
      {link.body ? (
        <DetailSection title={gt("Your WhatsApp")} status={link.connection}>
          {link.body}
        </DetailSection>
      ) : null}
      {link.dialogs}
      <Link
        to="/settings/extensions/item/server/$"
        params={{ _splat: WHATSAPP_BUSINESS_SERVER }}
        className={RELATED_EXTENSION_LINK_CLASS}
      >
        <RelatedExtension name="WhatsApp Business" />
      </Link>
      {service.websiteUrl ? (
        <AboutCard rows={[[gt("Website"), service.websiteUrl.replace(/^https:\/\//, "")]]} />
      ) : null}
    </DetailLayout>
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
