import { useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";

export function ComputeTruncatedText(props: {
  readonly text: string;
  readonly className?: string | undefined;
}) {
  const [overflowingText, setOverflowingText] = useState<string | null>(null);
  const observe = (element: HTMLSpanElement | null) => {
    if (!element) return;
    return observeResize(element, () => {
      setOverflowingText(element.scrollWidth > element.clientWidth ? props.text : null);
    });
  };

  return (
    <ScientTooltip content={props.text} disabled={overflowingText !== props.text}>
      <span key={props.text} ref={observe} className={cn("block truncate", props.className)}>
        {props.text}
      </span>
    </ScientTooltip>
  );
}

export function ComputeRunParameters(props: {
  readonly parameters: Readonly<Record<string, string>> | undefined;
  readonly className?: string | undefined;
}) {
  const text = Object.entries(props.parameters ?? {})
    .map(([name, value]) => `${name} = ${value}`)
    .join(" · ");
  if (text === "") return null;
  return (
    <ComputeTruncatedText
      text={text}
      className={cn("text-xs text-muted-foreground tabular-nums", props.className)}
    />
  );
}
