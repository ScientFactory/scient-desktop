import { lazy, Suspense, useState } from "react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
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
  environmentId,
  instanceId,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Connect models
      </Button>
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
