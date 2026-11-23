import { T, useGT } from "gt-react";

import { Button } from "~/components/ui/button";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import type { NotebookState } from "./notebookController";

type Heading = NotebookState["sections"]["headings"][number];

export function NotebookOutline(props: {
  readonly headings: ReadonlyArray<Heading>;
  readonly current: Heading | undefined;
  readonly docked: boolean;
  readonly onSelect: (heading: Heading, index: number) => void;
}) {
  const gt = useGT();
  if (props.headings.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-muted-foreground">
        <T>No headings</T>
      </p>
    );
  }
  return (
    <ul>
      {props.headings.map((heading, index) => {
        const label = heading.text || gt("Untitled heading");
        const item = (
          <Button
            variant={props.current === heading ? "selected" : "ghost"}
            size="row"
            focus="edge"
            aria-current={props.current === heading ? "location" : undefined}
            onClick={() => props.onSelect(heading, index)}
          >
            <span
              dir="auto"
              className={props.docked ? "min-w-0 truncate text-start" : "wrap-anywhere text-start"}
            >
              {label}
            </span>
          </Button>
        );
        return (
          <li
            key={`${heading.cellId}:${heading.line}`}
            style={{ paddingInlineStart: (heading.level - 1) * 8 }}
          >
            {props.docked ? <ScientTooltip content={label}>{item}</ScientTooltip> : item}
          </li>
        );
      })}
    </ul>
  );
}
