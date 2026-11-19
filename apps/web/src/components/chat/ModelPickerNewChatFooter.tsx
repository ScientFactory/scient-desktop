import { SplitIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ModelPickerNewChatFooter(props: {
  readonly inline?: boolean;
  readonly disabled: boolean;
  readonly onFork: () => void;
}) {
  const button = (
    <Button
      type="button"
      size="compact-sm"
      variant="ghost-muted"
      disabled={props.disabled}
      aria-label={
        props.inline ? "Fork to switch, continue in a new chat" : "Fork to continue in a new chat"
      }
      onClick={props.onFork}
    >
      {props.inline ? (
        <span className="@max-[21rem]/model-picker-footer:hidden">Fork to switch</span>
      ) : (
        "Fork to continue in a new chat"
      )}
      <SplitIcon className="size-3 rotate-90 text-primary/80" />
    </Button>
  );
  return (
    <div
      className={cn(
        "flex shrink-0 items-center",
        !props.inline && "mt-auto border-t border-border/70 px-2 py-1",
      )}
    >
      {props.inline ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipPopup side="top">Continue in a new chat with this model.</TooltipPopup>
        </Tooltip>
      ) : (
        button
      )}
    </div>
  );
}
