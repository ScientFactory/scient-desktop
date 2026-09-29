import type { EnvironmentId } from "@t3tools/contracts";
import { mergeWithDefaultKeybindings } from "@t3tools/shared/keybindings";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useMemo, useState } from "react";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { AuthoringKeybindingsSettings } from "./AuthoringKeybindingsSettings";
import type { KeyboardScope } from "./catalog";

/** The editor opens the same settings component without navigating away from the document. */
export function WritingShortcutsDialog({
  open,
  onOpenChange,
  initialScope = "writing",
  environmentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialScope?: KeyboardScope | "writing";
  environmentId?: EnvironmentId | undefined;
}) {
  const primaryId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId ?? primaryId);
  const appBindings = useMemo(
    () => mergeWithDefaultKeybindings(environment?.serverConfig?.keybindings ?? []),
    [environment?.serverConfig?.keybindings],
  );
  const [scope, setScope] = useState<KeyboardScope | "writing">(initialScope);
  const [query, setQuery] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-4xl" data-keybinding-capture="">
        <DialogTitle>Writing shortcuts</DialogTitle>
        <div className="flex items-center gap-3 py-3">
          <Select
            value={scope}
            onValueChange={(value) => {
              if (value) setScope(value as KeyboardScope | "writing");
            }}
          >
            <SelectTrigger aria-label="Shortcut section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                [
                  ["writing", "All writing shortcuts"],
                  ["latex", "Write"],
                  ["math", "Math"],
                  ["table", "Tables"],
                  ["markdown", "Markdown"],
                  ["pdf", "PDF"],
                ] as const
              ).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Search shortcuts"
            placeholder="Search actions, LaTeX commands or keys"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="max-h-[65vh] overflow-y-auto">
          <AuthoringKeybindingsSettings scope={scope} query={query} appBindings={appBindings} />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
