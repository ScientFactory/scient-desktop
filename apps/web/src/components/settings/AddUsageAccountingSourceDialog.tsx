import { type EnvironmentId, UsageAccountingSourceId } from "@t3tools/contracts";
import { ExternalLinkIcon, InfoIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const OPENROUTER_MANAGEMENT_KEYS_URL = "https://openrouter.ai/settings/management-keys";

export function AddUsageAccountingSourceDialog({
  open,
  onOpenChange,
  environmentId,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [managementKey, setManagementKey] = useState("");
  const canSave = managementKey.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    const id = UsageAccountingSourceId.make(`openrouter-${Date.now().toString(36)}`);
    updateSettings({
      usageAccountingSources: {
        [id]: {
          kind: "openrouter",
          managementKey: managementKey.trim(),
          enabled: true,
        },
      },
    });
    setManagementKey("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add OpenRouter billing</DialogTitle>
          <DialogDescription>
            Use a management key to import spend, tokens, and model usage.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <div className="flex items-center gap-1">
                <Label htmlFor="usage-accounting-key">Management key</Label>
                <Tooltip>
                  <TooltipTrigger
                    delay={200}
                    render={
                      <Button
                        type="button"
                        size="icon-micro"
                        variant="ghost-muted"
                        aria-label="About OpenRouter management keys"
                      >
                        <InfoIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top" className="max-w-72">
                    A management key is an administrative credential. Scient stores it on this
                    device and uses it only for read-only billing requests.
                  </TooltipPopup>
                </Tooltip>
              </div>
              <Input
                id="usage-accounting-key"
                type="password"
                autoComplete="off"
                value={managementKey}
                onChange={(event) => setManagementKey(event.target.value)}
                autoFocus
              />
              <a
                aria-label="Create a management key in OpenRouter (opens in browser)"
                className="inline-flex w-fit items-center gap-1 text-xs text-foreground/80 underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
                href={OPENROUTER_MANAGEMENT_KEYS_URL}
                rel="noreferrer noopener"
                target="_blank"
              >
                Create a management key in OpenRouter
                <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
              </a>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            size="sm"
            variant="outline"
            className="text-[15px] sm:text-[15px]"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="text-[15px] sm:text-[15px]"
            onClick={save}
            disabled={!canSave}
          >
            Add billing
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
