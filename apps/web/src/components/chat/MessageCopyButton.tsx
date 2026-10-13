import { memo, useRef } from "react";
import { Check, Copy } from "lucide";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  label = "Copy message",
  icon = Copy,
  extraFlavors,
  // SCIENT-FORK:START
  resolveHtml,
  // SCIENT-FORK:END
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  label?: string;
  /** The icon shown until the copy lands. */
  icon?: typeof Copy;
  /** Additional clipboard types written beside `text/plain` when the platform allows it. */
  extraFlavors?: Readonly<Record<string, string>>;
  // SCIENT-FORK:START
  /** Rich `text/html` built at click time from the rendered message; null keeps the plain copy. */
  resolveHtml?: (button: HTMLButtonElement) => string | null;
  // SCIENT-FORK:END
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    ...(extraFlavors ? { extraFlavors } : {}),
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={isCopied}
            // SCIENT-FORK:START
            onClick={() => {
              const html = ref.current && resolveHtml ? resolveHtml(ref.current) : null;
              copyToClipboard(
                text,
                undefined,
                html ? { ...extraFlavors, "text/html": html } : undefined,
              );
            }}
            // SCIENT-FORK:END
            ref={ref}
            type="button"
            size={size}
            variant={variant === "ghost" ? "ghost-muted" : variant}
            className={className}
          />
        }
      >
        <MorphIcon
          className={cn("size-3", isCopied && "text-primary")}
          icon={isCopied ? Check : icon}
        />
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
});
