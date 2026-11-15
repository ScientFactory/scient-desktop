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

/** The switch's label on the browser's inspect page. */
export const REMOTE_DEBUGGING_SETTING = "Allow remote debugging for this browser instance";

/** The browser's own question, word for word. */
export const REMOTE_DEBUGGING_QUESTION = "Allow remote debugging?";

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
  return (
    <span className="mt-1 flex items-center gap-2">
      <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
        {address}
      </code>
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(address, undefined)}>
        {isCopied ? <CheckIcon /> : <CopyIcon />}
        {isCopied ? "Copied" : "Copy"}
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
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import from {browser}</DialogTitle>
        <DialogDescription>
          Windows lets only {browser} read its sign-ins, so Scient asks {browser} to hand them over.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ol className="grid list-decimal gap-3 pl-5 text-sm">
          <li>
            In {browser}, open
            <CopyAddress address={source.connection.settingsUrl} />
          </li>
          <li>
            Turn on <span className="font-medium">{REMOTE_DEBUGGING_SETTING}</span>.{" "}
            {status.on ? (
              <span role="status" className="inline-flex items-center gap-1 text-muted-foreground">
                <CheckIcon className="size-3.5" /> It&rsquo;s on.
              </span>
            ) : (
              <span role="status" className="text-muted-foreground">
                Scient notices when it&rsquo;s on.
              </span>
            )}
          </li>
          <li>
            {browser} asks &ldquo;{REMOTE_DEBUGGING_QUESTION}&rdquo;: click{" "}
            <span className="font-medium">Allow</span>. Scient copies the sign-ins, closes the tab
            it opened and disconnects.
          </li>
        </ol>
        <p className="mt-4 text-xs text-muted-foreground">
          The setting can be turned off again on the same page afterwards. Saved passwords stay in{" "}
          {browser}.
        </p>
      </DialogPanel>
      <DialogFooter>
        {alternative ? (
          <Button variant="ghost" className="sm:mr-auto" onClick={alternative.onSelect}>
            {alternative.label}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <DialogAction disabled={!status.on} onClick={onContinue}>
          Continue
        </DialogAction>
      </DialogFooter>
    </>
  );
}
