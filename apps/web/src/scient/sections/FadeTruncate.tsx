import { useCallback, useState } from "react";

import { cn } from "../../lib/utils";

/**
 * Single-line text that fades out at its trailing edge instead of showing an
 * ellipsis. The fade appears only while the text overflows, and follows the
 * container as it resizes.
 */
export function FadeTruncate(props: { readonly text: string; readonly className?: string }) {
  const [overflowing, setOverflowing] = useState(false);
  // The observer reports once on attach and again on every resize.
  const observe = useCallback((element: HTMLSpanElement | null) => {
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      setOverflowing(element.scrollWidth > element.clientWidth + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <span
      // New text can overflow without resizing the box; remounting re-measures.
      key={props.text}
      ref={observe}
      className={cn(
        "min-w-0 overflow-hidden whitespace-nowrap",
        overflowing && "[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]",
        props.className,
      )}
    >
      {props.text}
    </span>
  );
}
