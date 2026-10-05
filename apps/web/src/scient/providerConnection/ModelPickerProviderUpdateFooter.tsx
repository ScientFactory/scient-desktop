import type { ProviderDriverKind } from "@t3tools/contracts";
import { DownloadIcon, Loader2Icon } from "lucide-react";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export function ModelPickerProviderUpdateFooter(props: {
  readonly displayName: string;
  readonly driverKind: ProviderDriverKind;
  readonly accentColor?: string | undefined;
  readonly disabled: boolean;
  readonly disabledReason?: string | undefined;
  readonly isStarting: boolean;
  readonly isUpdating: boolean;
  /** The update is staged and waits for the provider's running turns to finish. */
  readonly isWaitingForIdle?: boolean | undefined;
  readonly hasError?: boolean | undefined;
  readonly onUpdate: () => void;
}) {
  const actionLabel = props.hasError ? "Retry" : "Update";
  const accessibleActionLabel = props.disabledReason
    ? `${props.displayName} update unavailable. ${props.disabledReason}`
    : `${actionLabel} ${props.displayName}`;
  const progressLabel = props.isWaitingForIdle
    ? `${props.displayName} will update when idle`
    : props.isUpdating
      ? `Updating ${props.displayName}…`
      : `Preparing ${props.displayName} update…`;

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border/70 px-2 py-1">
      {props.isStarting || props.isUpdating ? (
        <>
          <ProviderInstanceIcon
            driverKind={props.driverKind}
            displayName={props.displayName}
            accentColor={props.accentColor}
            className="size-3.5"
            iconClassName="size-3.5"
          />
          {/* A wait can last a whole turn; it gets no continuously repainting spinner. */}
          {props.isWaitingForIdle ? null : (
            <Loader2Icon
              aria-hidden="true"
              className="size-3 shrink-0 animate-spin text-primary [animation-duration:1.35s] [animation-timing-function:linear] motion-reduce:animate-none"
            />
          )}
          <p
            aria-live="polite"
            className="min-w-0 truncate text-[11px] leading-snug text-muted-foreground"
          >
            {progressLabel}
          </p>
        </>
      ) : (
        <>
          <p
            aria-live="polite"
            className={cn(
              "min-w-0 truncate text-[11px] leading-snug text-muted-foreground",
              props.hasError && "text-destructive",
            )}
          >
            {props.hasError ? "Couldn’t start update" : `${props.displayName} update available`}
          </p>
          <Button
            type="button"
            size="micro"
            variant="ghost-primary"
            className="shrink-0"
            disabled={props.disabled || props.isStarting}
            aria-label={accessibleActionLabel}
            title={props.disabledReason}
            onClick={props.onUpdate}
          >
            <DownloadIcon className="size-3.5" />
            {actionLabel}
          </Button>
        </>
      )}
    </div>
  );
}
