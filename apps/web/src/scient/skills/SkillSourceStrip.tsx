import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

export function SkillSourceStrip(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div
      aria-label={props.label}
      className="skill-source-strip flex items-center overflow-x-auto py-1"
      role="group"
    >
      {props.children}
    </div>
  );
}

export function SkillSourceStripItem(props: {
  readonly controls: string;
  readonly detail?: ReactNode;
  readonly expanded: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly separated: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center">
      {props.separated ? <span aria-hidden className="mx-2 h-7 w-px bg-border/65" /> : null}
      <button
        type="button"
        aria-controls={props.controls}
        aria-expanded={props.expanded}
        className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.035] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-expanded:bg-foreground/[0.035]"
        onClick={props.onToggle}
      >
        {props.icon}
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="max-w-52 truncate text-sm font-medium text-foreground">
              {props.label}
            </span>
            <ChevronDownIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-180"
            />
          </span>
          {props.detail ? (
            <span className="block text-xs text-muted-foreground">{props.detail}</span>
          ) : null}
        </span>
      </button>
    </div>
  );
}
