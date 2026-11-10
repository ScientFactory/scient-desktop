import type { EnvironmentId } from "@t3tools/contracts";
import { ListChecks } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { ReferenceCheckDialog } from "./ReferenceCheckDialog";

/** The Library header's entry to the reference check; it opens on the Library. */
export function ReferenceCheckButton(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly onOpenSource: (sourceId: string) => void;
  readonly onOpenFile?: (path: string, line: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ScientTooltip content="Check references">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Check references"
          onClick={() => setOpen(true)}
        >
          <ListChecks />
        </Button>
      </ScientTooltip>
      {open ? (
        <ReferenceCheckDialog
          environmentId={props.environmentId}
          root={props.root}
          initialTarget={{ kind: "library" }}
          onOpenSource={(sourceId) => {
            setOpen(false);
            props.onOpenSource(sourceId);
          }}
          {...(props.onOpenFile
            ? {
                onOpenFile: (path: string, line: number) => {
                  setOpen(false);
                  props.onOpenFile?.(path, line);
                },
              }
            : {})}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
