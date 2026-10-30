import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

const COLLAPSED_HEIGHT = 320;

/**
 * One output in a run: copyable, and clipped when long. A `tail` block (streamed text) keeps
 * its newest lines visible while collapsed.
 */
export function ComputeOutputBlock(props: {
  readonly copy: (() => { readonly text: string; readonly html?: string }) | null;
  readonly tail?: boolean;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "output" });
  // The observer reports once on attach and again as streamed output grows.
  const measure = (node: HTMLDivElement | null) => {
    if (node === null) return;
    return observeResize(node, () => setOverflowing(node.scrollHeight > COLLAPSED_HEIGHT + 24));
  };
  const clipped = overflowing && !expanded;
  const toggle = overflowing ? (
    <Button
      size="xs"
      variant="ghost-muted"
      className="self-start"
      aria-expanded={expanded}
      onClick={() => setExpanded((current) => !current)}
    >
      {expanded ? "Show less" : "Show all"}
    </Button>
  ) : null;
  return (
    <div className="group/output relative flex min-w-0 flex-col gap-0.5">
      {props.tail && clipped ? toggle : null}
      <div
        className={cn(
          "min-w-0",
          clipped && "flex max-h-80 flex-col overflow-hidden",
          clipped &&
            (props.tail
              ? "justify-end [mask-image:linear-gradient(to_bottom,transparent,black_3rem)]"
              : "[mask-image:linear-gradient(to_top,transparent,black_3rem)]"),
        )}
      >
        <div ref={measure} className="min-w-0">
          {props.children}
        </div>
      </div>
      {props.tail && clipped ? null : toggle}
      {props.copy !== null ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          className="absolute end-0 top-0 bg-background opacity-0 group-focus-within/output:opacity-100 group-hover/output:opacity-100"
          aria-label={isCopied ? "Copied" : "Copy output"}
          onClick={() => {
            const copy = props.copy?.();
            if (copy === undefined) return;
            copyToClipboard(
              copy.text,
              undefined,
              copy.html === undefined ? undefined : { "text/html": copy.html },
            );
          }}
        >
          {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      ) : null}
    </div>
  );
}
