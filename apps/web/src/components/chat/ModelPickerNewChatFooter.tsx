import { SplitIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export function ModelPickerNewChatFooter(props: {
  readonly inline?: boolean;
  readonly disabled: boolean;
  readonly onFork: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center",
        !props.inline && "mt-auto shrink-0 border-t border-border/70 px-2 py-1",
      )}
    >
      <Button
        type="button"
        size="compact-sm"
        variant="ghost-muted"
        className="shrink-0"
        disabled={props.disabled}
        aria-label="Fork to continue in a new chat"
        onClick={props.onFork}
      >
        Fork to continue in a new chat
        <SplitIcon className="size-3 rotate-90 text-primary/80" />
      </Button>
    </div>
  );
}
