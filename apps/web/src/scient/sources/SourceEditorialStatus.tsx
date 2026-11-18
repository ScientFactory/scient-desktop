import { T, useMessages } from "gt-react";
import type { ScientSourceDetailResult } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";
import { readLocalApi } from "../../localApi";
import { editorialStatusLine } from "./sourceLifecycleLabels";

/** One quiet line when the registry reported a retraction, withdrawal, concern or correction. */
export function SourceEditorialStatus(props: {
  readonly status: ScientSourceDetailResult["editorialStatus"];
}) {
  const m = useMessages();
  const line = props.status ? editorialStatusLine(props.status, m) : null;
  if (!line) return null;
  return (
    <p className={line.serious ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
      {line.text}
      {line.noticeDoi ? (
        <>
          {" · "}
          <Button
            variant="link"
            size="micro"
            onClick={() =>
              void readLocalApi()?.shell.openExternal(`https://doi.org/${line.noticeDoi}`)
            }
          >
            <T context="a retraction or correction notice">Notice</T>
          </Button>
        </>
      ) : null}
    </p>
  );
}
