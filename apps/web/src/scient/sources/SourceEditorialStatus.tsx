import type { ScientSourceDetailResult } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";
import { readLocalApi } from "../../localApi";
import { editorialStatusLine } from "./sourceLifecycleLabels";

/** One quiet line when the registry reported a retraction, withdrawal, concern or correction. */
export function SourceEditorialStatus(props: {
  readonly status: ScientSourceDetailResult["editorialStatus"];
}) {
  const line = props.status ? editorialStatusLine(props.status) : null;
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
            Notice
          </Button>
        </>
      ) : null}
    </p>
  );
}
