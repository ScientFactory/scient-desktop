import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { useAtomCommand } from "../../state/use-atom-command";
import { ActionError, commandFailureMessage } from "./ExtensionsFeedback";
import { useExtensionsEnvironment } from "./ExtensionsPage";
import { installScientPlugin } from "./extensionsState";

/** Installs a Scient plugin bundle from a folder on the environment's computer. */
export function InstallBundleDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { environmentId, canWrite } = useExtensionsEnvironment();
  const install = useAtomCommand(installScientPlugin, { reportFailure: true });
  const [path, setPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = path.trim();

  const submit = async () => {
    if (!canWrite || installing || trimmed.length === 0) return;
    setInstalling(true);
    setError(null);
    const result = await install({ environmentId, input: { path: trimmed } }).finally(() =>
      setInstalling(false),
    );
    const message = commandFailureMessage(result);
    setError(message);
    if (result._tag === "Success") onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Install from folder</DialogTitle>
          <DialogDescription>
            A folder with scient.plugin.json on the computer running this environment. Nothing in it
            runs.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Label htmlFor="extensions-bundle-path">Folder</Label>
            <Input
              id="extensions-bundle-path"
              placeholder="/path/to/bundle"
              value={path}
              autoFocus
              disabled={!canWrite || installing}
              onChange={(event) => setPath(event.target.value)}
            />
            <ActionError message={error} />
            <button type="submit" hidden />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canWrite || installing || trimmed.length === 0}
            onClick={() => void submit()}
          >
            {installing ? "Installing…" : "Install"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
