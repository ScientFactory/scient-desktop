import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Fades the last characters of a clipped label instead of replacing them with
 * an ellipsis, so the visible part of a long version keeps its own text.
 */
const OVERFLOW_FADE_MASK_CLASS =
  "[mask-image:linear-gradient(to_right,black_calc(100%-2.5ch),transparent)]";

/**
 * A provider version that stays on one line. When the row is too narrow the
 * tail fades out and the full version is shown on hover or keyboard focus; a
 * version that fits renders unchanged. `data-overflowing` is absent until the
 * first measurement.
 */
export function ProviderVersionLabel(props: {
  readonly version: string;
  readonly className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [measurement, setMeasurement] = useState<{
    readonly version: string;
    readonly overflowing: boolean;
  } | null>(null);
  const version = props.version;

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    // The observer reports the initial size too, so a label that starts
    // clipped fades without a separate measurement. A new version can clip
    // without resizing the label, so each version is observed afresh.
    const observer = new ResizeObserver(() => {
      setMeasurement({ version, overflowing: element.scrollWidth > element.clientWidth });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [version]);

  // A measurement of an earlier version says nothing about this one.
  const overflowing = measurement?.version === version ? measurement.overflowing : null;

  return (
    <Tooltip disabled={!overflowing}>
      <TooltipTrigger
        render={
          <code
            ref={ref}
            data-overflowing={overflowing ?? undefined}
            // Only a clipped version hides text, so only it needs a focus stop.
            tabIndex={overflowing ? 0 : undefined}
            className={cn(
              "min-w-0 overflow-hidden whitespace-nowrap",
              overflowing && OVERFLOW_FADE_MASK_CLASS,
              props.className,
            )}
          />
        }
      >
        {props.version}
      </TooltipTrigger>
      <TooltipPopup variant="code">{props.version}</TooltipPopup>
    </Tooltip>
  );
}
