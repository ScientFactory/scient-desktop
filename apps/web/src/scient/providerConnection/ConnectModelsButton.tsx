import { lazy, Suspense, useState } from "react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { PlugIcon } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "../../components/ui/dialog";

const CustomModelsContent = lazy(() =>
  import("../../components/settings/CustomModelsPanel").then((module) => ({
    default: module.CustomModelsContent,
  })),
);

export function ConnectModelsButton({
  appearance = "outline",
  environmentId,
  instanceId,
}: {
  /**
   * `setup-action` is an assisted setup frame's one primary action;
   * `setup-secondary` sits quietly under another primary action.
   */
  appearance?: "outline" | "setup-action" | "setup-secondary";
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {appearance === "outline" ? (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Connect models
        </Button>
      ) : (
        <Button
          size="sm"
          type="button"
          variant={appearance === "setup-action" ? "ghost-primary" : "ghost-muted"}
          onClick={() => setOpen(true)}
        >
          <PlugIcon aria-hidden />
          Connect models
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Custom models</DialogTitle>
            <DialogDescription className="sr-only">Connect models to this agent.</DialogDescription>
          </DialogHeader>
          {open ? (
            <DialogPanel>
              <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
                <CustomModelsContent environmentId={environmentId} instanceId={instanceId} />
              </Suspense>
            </DialogPanel>
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}
