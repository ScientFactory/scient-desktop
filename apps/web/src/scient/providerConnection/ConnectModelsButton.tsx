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
  /** `setup-action` matches the primary action of an assisted setup frame. */
  appearance?: "outline" | "setup-action";
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {appearance === "setup-action" ? (
        <Button size="sm" type="button" variant="ghost-primary" onClick={() => setOpen(true)}>
          <PlugIcon aria-hidden />
          Connect models
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
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
