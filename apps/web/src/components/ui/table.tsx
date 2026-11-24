import * as React from "react";

import { cn } from "~/lib/utils";

// SCIENT-FORK:START — let table consumers name and bound the shared scroll area.
function Table({
  className,
  containerProps,
  ...props
}: React.ComponentProps<"table"> & { containerProps?: React.ComponentProps<"div"> }) {
  return (
    <div
      {...containerProps}
      data-slot="table-container"
      className={cn("relative w-full overflow-x-auto", containerProps?.className)}
    >
      {/* SCIENT-FORK:END */}
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-xs", className)}
        {...props}
      />
    </div>
  );
}

// SCIENT-FORK:START — scrollable profile tables keep their heading visible.
function TableHeader({
  className,
  sticky = false,
  ...props
}: React.ComponentProps<"thead"> & { sticky?: boolean }) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", sticky && "sticky top-0 z-10 bg-popover", className)}
      {...props}
    />
  );
}
// SCIENT-FORK:END

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

// SCIENT-FORK:START — align numeric results and style semantic row headings consistently.
function TableHead({
  className,
  numeric = false,
  scope,
  ...props
}: React.ComponentProps<"th"> & { numeric?: boolean }) {
  return (
    <th
      data-slot="table-head"
      scope={scope}
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        scope === "row" && "h-auto py-2 align-top",
        numeric && "text-end tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({
  className,
  numeric = false,
  ...props
}: React.ComponentProps<"td"> & { numeric?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        numeric && "text-end tabular-nums",
        className,
      )}
      {...props}
    />
  );
}
// SCIENT-FORK:END

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };
