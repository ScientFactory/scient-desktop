import { SplitIcon } from "lucide-react";
import { Button } from "../ui/button";

export function ModelPickerNewChatFooter(props: {
  readonly disabled: boolean;
  readonly onFork: () => void;
}) {
  return (
    <div className="mt-auto flex shrink-0 items-center gap-2 border-t border-border/70 px-2 py-1">
      <p className="min-w-0 text-2xs leading-snug text-muted-foreground">Continue in a new chat</p>
      <Button
        type="button"
        size="micro"
        variant="ghost-muted"
        className="shrink-0"
        disabled={props.disabled}
        aria-label="Continue in a new chat"
        onClick={props.onFork}
      >
        <SplitIcon className="size-3 rotate-90 text-primary/80" />
        Fork
      </Button>
    </div>
  );
}
