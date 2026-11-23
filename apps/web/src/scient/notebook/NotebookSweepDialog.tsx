import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";
import { validNotebookParameter } from "./NotebookParameters";
import { sweepValues } from "./reader/notebookReaderModel";

export function NotebookSweepDialog(props: {
  readonly parameter: Parameters<typeof validNotebookParameter>[0];
  readonly onClose: () => void;
  readonly onRun: (values: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  const { parameter } = props;
  const [draft, setDraft] = useState(() => sweepValues(parameter.control).join("\n"));
  const lines = draft
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const parsed = lines.map((value) => validNotebookParameter(parameter, value));
  const values = [...new Set(parsed.filter((value) => value !== null))];
  const invalid = parsed.includes(null);
  const count = values.length;
  const canRun = count > 0 && count <= 20 && !invalid;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {gt("Run for each {parameter} value", { parameter: parameter.name })}
          </DialogTitle>
          <DialogDescription>
            <T>Enter up to 20 values, one per line. Each run saves an alternative.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Textarea
            aria-label={gt("Values")}
            aria-invalid={invalid || count > 20}
            value={draft}
            rows={5}
            onChange={(event) => setDraft(event.target.value)}
          />
          {invalid ? (
            <p role="status" className="mt-2 text-xs text-destructive">
              <T>Enter a valid value on each line.</T>
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            <T>Cancel</T>
          </Button>
          <Button disabled={!canRun} onClick={() => props.onRun(values)}>
            {count === 1 ? (
              <T>Start 1 run</T>
            ) : (
              <T>
                Start <Var>{count}</Var> runs
              </T>
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
