import { memo, useRef } from "react";
import { CheckIcon, CopyIcon } from "~/lib/icons";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { MessageActionButton, MESSAGE_ACTION_ICON_CLASS_NAME } from "./MessageActionButton";

const ANCHORED_TOAST_TIMEOUT_MS = 1000;

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    timeout: ANCHORED_TOAST_TIMEOUT_MS,
  });

  return (
    <MessageActionButton
      ref={ref}
      label={isCopied ? "Message copied" : "Copy message"}
      tooltip={isCopied ? "Copied" : "Copy to clipboard"}
      disabled={isCopied}
      className={className}
      onClick={() => copyToClipboard(text)}
    >
      {isCopied ? (
        <CheckIcon className={`${MESSAGE_ACTION_ICON_CLASS_NAME} text-success`} />
      ) : (
        <CopyIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
      )}
    </MessageActionButton>
  );
});
