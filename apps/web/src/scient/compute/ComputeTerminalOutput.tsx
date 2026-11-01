import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

import type { TerminalRun, TerminalText } from "./computeTerminalText";

// Normal then bright ANSI colours, legible on both themes.
const FOREGROUND = [
  "text-neutral-900 dark:text-neutral-400",
  "text-red-600 dark:text-red-400",
  "text-green-700 dark:text-green-400",
  "text-amber-700 dark:text-amber-300",
  "text-blue-600 dark:text-blue-400",
  "text-fuchsia-600 dark:text-fuchsia-400",
  "text-cyan-700 dark:text-cyan-400",
  "text-neutral-500 dark:text-neutral-200",
  "text-neutral-500 dark:text-neutral-500",
  "text-red-500 dark:text-red-300",
  "text-green-600 dark:text-green-300",
  "text-amber-600 dark:text-amber-200",
  "text-blue-500 dark:text-blue-300",
  "text-fuchsia-500 dark:text-fuchsia-300",
  "text-cyan-600 dark:text-cyan-300",
  "text-neutral-400 dark:text-white",
] as const;
const BACKGROUND = [
  "bg-neutral-900/15",
  "bg-red-500/20",
  "bg-green-500/20",
  "bg-amber-500/20",
  "bg-blue-500/20",
  "bg-fuchsia-500/20",
  "bg-cyan-500/20",
  "bg-neutral-500/15",
] as const;

function runPresentation(run: TerminalRun): { className?: string; style?: CSSProperties } {
  const style = run.style;
  if (style === null) return {};
  const inline: CSSProperties = {};
  if (typeof style.fg === "string") inline.color = style.fg;
  if (typeof style.bg === "string") inline.backgroundColor = style.bg;
  return {
    className: cn(
      typeof style.fg === "number" && FOREGROUND[style.fg],
      typeof style.bg === "number" && BACKGROUND[style.bg % 8],
      style.bold && "font-semibold",
      style.dim && "opacity-70",
      style.italic && "italic",
      style.underline && "underline",
    ),
    ...(Object.keys(inline).length === 0 ? {} : { style: inline }),
  };
}

export function ComputeTerminalOutput(props: {
  readonly terminal: TerminalText;
  readonly stream?: "stdout" | "stderr";
}) {
  return (
    <pre
      className={cn(
        "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed",
        props.stream === "stderr" && "text-muted-foreground",
      )}
    >
      {props.terminal.runs.map((run) =>
        run.style === null ? (
          run.text
        ) : (
          <span key={run.offset} {...runPresentation(run)}>
            {run.text}
          </span>
        ),
      )}
    </pre>
  );
}
