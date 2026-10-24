import type { PreviewStreamControl } from "@t3tools/client-runtime/preview/server-browser-stream";
import { useState } from "react";

import { cn } from "~/lib/utils";

export type BrowserControlChipState = {
  readonly label: string;
  readonly action: { readonly label: string; readonly kind: "take" | "release" } | null;
} | null;

/**
 * What the chip says, if anything. A page you browse on your own shows
 * nothing; the chip appears while an agent uses it, when nobody drives it
 * (Take control), when another window drives it, when this view cannot operate
 * it, and while you drive it with an agent around or another window watching
 * (so you can hand it back).
 */
export function browserControlChipState(
  control: PreviewStreamControl | null,
  agentSeen: boolean,
): BrowserControlChipState {
  if (!control) return null;
  if (!control.canOperate) return { label: "View only", action: null };
  switch (control.controller) {
    case "agent":
      return { label: "Agent is using this page", action: { label: "Take over", kind: "take" } };
    case "unclaimed":
      return { label: "Watching this page", action: { label: "Take control", kind: "take" } };
    case "another-viewer":
      return { label: "In use in another window", action: null };
    case "you":
      if (agentSeen) {
        return { label: "You're in control", action: { label: "Hand back", kind: "release" } };
      }
      return (control.otherViewers ?? 0) > 0
        ? { label: "You're in control", action: { label: "Release", kind: "release" } }
        : null;
  }
}

/** Who is driving a shared browser page, shown only when it matters. */
export function BrowserControlChip(props: {
  readonly control: PreviewStreamControl | null;
  readonly position: "top" | "bottom";
  readonly onTake: () => void;
  readonly onRelease: () => void;
}) {
  const { control } = props;
  // The server names the agent only while no person drives, so remember once
  // it has appeared: handing back must stay possible after taking over.
  const [agentSeen, setAgentSeen] = useState(false);
  if (control?.controller === "agent" && !agentSeen) setAgentSeen(true);

  const state = browserControlChipState(control, agentSeen);
  if (!state) return null;
  const action = state.action;

  return (
    <div
      role="status"
      className={cn(
        "absolute right-2 z-20 flex items-center gap-2 rounded-full border border-border/70 bg-background/95 py-1 ps-2.5 pe-1 text-xs text-muted-foreground shadow-sm",
        props.position === "bottom" ? "bottom-2" : "top-2",
        !action && "pe-2.5",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          control?.controller === "agent" ? "bg-info" : "bg-muted-foreground/50",
        )}
      />
      <span>{state.label}</span>
      {action ? (
        <button
          type="button"
          onClick={action.kind === "take" ? props.onTake : props.onRelease}
          className="cursor-pointer rounded-full px-2 py-0.5 font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
