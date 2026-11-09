import type { ReactNode } from "react";

/** A small label above its control, shared by both editors' Document settings cards. */
export function DocumentSettingsField(props: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      {props.children}
    </div>
  );
}
