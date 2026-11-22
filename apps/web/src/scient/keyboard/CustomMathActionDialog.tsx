import { randomUUID } from "~/lib/utils";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";
import { getKeyboardPreferences, saveKeyboardPreferences } from "./preferences";
import type { CustomMathCommand } from "./customMath";

export function CustomMathActionDialog({
  action,
  onClose,
}: {
  action: CustomMathCommand | null;
  onClose: () => void;
}) {
  const gt = useGT();
  const [original] = useState(getKeyboardPreferences);
  const [label, setLabel] = useState(action?.label ?? "");
  const [latex, setLatex] = useState(action?.latex ?? "");
  const [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup data-keybinding-capture="">
        <DialogTitle>{action ? gt("Edit math action") : gt("New math action")}</DialogTitle>
        <form
          className="space-y-4 pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const command = {
                id: action?.id ?? `math.custom.${randomUUID()}`,
                label,
                latex,
              };
              const commands = [
                ...(original.preferences.customMath ?? []).filter(
                  (entry) => entry.id !== command.id,
                ),
                command,
              ];
              saveKeyboardPreferences({ ...original.preferences, customMath: commands }, original);
              onClose();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : gt("Could not save the action."));
            }
          }}
        >
          <label className="block space-y-1 text-sm">
            <span>
              <T context="name of a math action">Name</T>
            </span>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              autoFocus
              required
              maxLength={100}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>
              <T>LaTeX expression</T>
            </span>
            <Textarea
              value={latex}
              onChange={(event) => setLatex(event.target.value)}
              required
              rows={4}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            <T>
              Use{" "}
              <code>
                <Var>{"${selection}"}</Var>
              </code>{" "}
              for selected math and{" "}
              <code>
                <Var>{"${cursor}"}</Var>
              </code>{" "}
              for an empty editing position. For example:{" "}
              <code>
                <Var>{"\\frac{${selection}}{${cursor}}"}</Var>
              </code>
              . Macro definitions stay in the document preamble. Add a shortcut to the action after
              saving.
            </T>
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit">
              <T>Save action</T>
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
