// FILE: SidebarThreadFamilyDisclosure.tsx
// Purpose: Shared accessible disclosure control and animated region for sidebar sub-agent families.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { cn } from "../lib/utils";

const DISCLOSURE_EXIT_RETENTION_MS = 220;

export type SidebarThreadFamilyScope = "chat" | "pinned" | "project" | "studio";

export function sidebarThreadFamilyRegionId(
  scope: SidebarThreadFamilyScope,
  threadId: string,
): string {
  return `${scope}-thread-family-${threadId}`;
}

export function SidebarThreadFamilyDisclosureButton(props: {
  readonly childCount: number;
  readonly className?: string;
  readonly controls: string;
  readonly open: boolean;
  readonly threadTitle: string;
  readonly onToggle: () => void;
}) {
  const childLabel = props.childCount === 1 ? "1 subagent" : `${props.childCount} subagents`;
  const action = props.open ? "Collapse" : "Expand";
  const accessibleLabel = `${action} ${childLabel} under “${props.threadTitle}”`;
  return (
    <button
      type="button"
      data-thread-selection-safe
      aria-controls={props.controls}
      aria-expanded={props.open}
      aria-label={accessibleLabel}
      title={childLabel}
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-0.5 rounded-full border px-[5px] transition-colors",
        props.className,
      )}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onToggle();
      }}
    >
      <span className="text-[9px] font-medium leading-none tabular-nums">{props.childCount}</span>
      <DisclosureChevron open={props.open} />
    </button>
  );
}

export function SidebarThreadFamilyDisclosureRegion(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly id: string;
  readonly open: boolean;
  readonly threadTitle: string;
}) {
  const [retainClosedContent, setRetainClosedContent] = useState(props.open);
  const retainedChildrenRef = useRef(props.children);
  if (props.open) retainedChildrenRef.current = props.children;

  useEffect(() => {
    if (props.open) {
      setRetainClosedContent(true);
      return;
    }
    const timeout = window.setTimeout(
      () => setRetainClosedContent(false),
      DISCLOSURE_EXIT_RETENTION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [props.open]);

  const content = props.open
    ? props.children
    : retainClosedContent
      ? retainedChildrenRef.current
      : null;

  return (
    <DisclosureRegion
      open={props.open}
      {...(props.className ? { className: props.className } : {})}
    >
      <div id={props.id} role="region" aria-label={`Subagents under “${props.threadTitle}”`}>
        {content}
      </div>
    </DisclosureRegion>
  );
}
