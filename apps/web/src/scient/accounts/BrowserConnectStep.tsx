import { msg, T, useGT, useMessages, Var } from "gt-react";
import type { BrowserImportSource } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";

import { usePermissionStatus } from "~/components/permissions/usePermissionStatus";
import { Button } from "~/components/ui/button";
import {
  DialogAction,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "~/components/ui/dialog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

/** The switch's label on the browser's inspect page, resolved where it is shown. */
export const REMOTE_DEBUGGING_SETTING = msg("Allow remote debugging for this browser instance", {
  $context: "Chrome's own switch label on chrome://inspect; use Chrome's translation",
});

/** The browser's own question, word for word, resolved where it is shown. */
export const REMOTE_DEBUGGING_QUESTION = msg("Allow remote debugging?", {
  $context: "Chrome's own dialog question; use Chrome's translation",
});

/** A browser Windows keeps from other apps that hands its sign-ins over itself. */
export type ConnectableSource<S extends BrowserImportSource = BrowserImportSource> = S & {
  readonly connection: NonNullable<BrowserImportSource["connection"]>;
};

export const isConnectable = <S extends BrowserImportSource>(
  source: S,
): source is ConnectableSource<S> =>
  source.unavailable === "appBoundEncryption" && source.connection !== undefined;

function CopyAddress({ address }: { readonly address: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const gt = useGT();
  return (
    <span className="mt-1 flex items-center gap-2">
      <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
        {address}
      </code>
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(address, undefined)}>
        {isCopied ? <CheckIcon /> : <CopyIcon />}
        {isCopied ? gt("Copied") : gt("Copy")}
      </Button>
    </span>
  );
}

/**
 * Before importing from a browser that hands its sign-ins over itself: the person turns on remote
 * debugging once, which this step notices by itself, and learns the browser will ask to allow it.
 */
export function BrowserConnectStep({
  source,
  alternative,
  onCancel,
  onContinue,
}: {
  readonly source: ConnectableSource;
  /** Another way in that needs no setting, such as one site's sign-in in a browser window. */
  readonly alternative?: { readonly label: string; readonly onSelect: () => void };
  readonly onCancel: () => void;
  readonly onContinue: () => void;
}) {
  const check = window.desktopBridge?.accounts?.browserConnection;
  const { status } = usePermissionStatus(
    async () => ({ on: (await check?.(source.id))?.on ?? false }),
    { on: false },
  );
  const browser = source.name;
  const messages = useMessages();
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <T>
            Import from <Var>{browser}</Var>
          </T>
        </DialogTitle>
        <DialogDescription>
          <T>
            Windows lets only <Var>{browser}</Var> read its sign-ins, so Scient asks{" "}
            <Var>{browser}</Var> to hand them over.
          </T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ol className="grid list-decimal gap-3 pl-5 text-sm">
          <li>
            <T>
              In <Var>{browser}</Var>, open
            </T>
            <CopyAddress address={source.connection.settingsUrl} />
          </li>
          <li>
            <T>
              Turn on{" "}
              <span className="font-medium">
                <Var>{messages(REMOTE_DEBUGGING_SETTING)}</Var>
              </span>
              .
            </T>{" "}
            {status.on ? (
              <span role="status" className="inline-flex items-center gap-1 text-muted-foreground">
                <CheckIcon className="size-3.5" /> <T>It&rsquo;s on.</T>
              </span>
            ) : (
              <span role="status" className="text-muted-foreground">
                <T>Scient notices when it&rsquo;s on.</T>
              </span>
            )}
          </li>
          <li>
            <T>
              <Var>{browser}</Var> asks &ldquo;<Var>{messages(REMOTE_DEBUGGING_QUESTION)}</Var>
              &rdquo;: click <span className="font-medium">Allow</span>. Scient copies the sign-ins,
              closes the tab it opened and disconnects.
            </T>
          </li>
        </ol>
        <p className="mt-4 text-xs text-muted-foreground">
          <T>
            The setting can be turned off again on the same page afterwards. Saved passwords stay in{" "}
            <Var>{browser}</Var>.
          </T>
        </p>
      </DialogPanel>
      <DialogFooter>
        {alternative ? (
          <Button variant="ghost" className="sm:mr-auto" onClick={alternative.onSelect}>
            {alternative.label}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onCancel}>
          <T>Cancel</T>
        </Button>
        <DialogAction disabled={!status.on} onClick={onContinue}>
          <T>Continue</T>
        </DialogAction>
      </DialogFooter>
    </>
  );
}
