import { lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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

import { ModelPickerOverlayContext } from "./ModelPickerOverlayContext";

const CustomModelsContent = lazy(() =>
  import("../../components/settings/CustomModelsPanel").then((module) => ({
    default: module.CustomModelsContent,
  })),
);

type ConnectModelsButtonProps = {
  /**
   * `setup-action` is an assisted setup frame's one primary action;
   * `setup-secondary` sits quietly under another primary action.
   */
  appearance?: "outline" | "setup-action" | "setup-secondary";
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  /** Provider-owned sign-in flow; absent for agents without account capabilities. */
  accountContent?: ReactNode;
};

export function ConnectModelsButton(props: ConnectModelsButtonProps) {
  return <ConnectModelsDialog key={`${props.environmentId}:${props.instanceId}`} {...props} />;
}

function ConnectModelsDialog({
  appearance = "outline",
  environmentId,
  instanceId,
  accountContent,
}: ConnectModelsButtonProps) {
  const [open, setOpen] = useState(false);
  const overlay = useContext(ModelPickerOverlayContext);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const setOverlayInstanceId = overlay?.setInstanceId;
  const setDialogOpen = (next: boolean) => {
    setOverlayInstanceId?.(next ? instanceId : null);
    setOpen(next);
  };
  useEffect(
    () => () => {
      if (open) setOverlayInstanceId?.(null);
    },
    [open, setOverlayInstanceId],
  );
  return (
    <>
      {appearance === "outline" ? (
        <Button size="sm" variant="outline" ref={triggerRef} onClick={() => setDialogOpen(true)}>
          Connect models
        </Button>
      ) : (
        <Button
          size="sm"
          type="button"
          variant={appearance === "setup-action" ? "ghost-primary" : "ghost-muted"}
          ref={triggerRef}
          onClick={() => setDialogOpen(true)}
        >
          <PlugIcon aria-hidden />
          Connect models
        </Button>
      )}
      <Dialog open={open} onOpenChange={setDialogOpen}>
        <DialogPopup
          className="max-w-xl"
          onSubmit={(event) => event.stopPropagation()}
          finalFocus={() =>
            triggerRef.current?.isConnected
              ? triggerRef.current
              : (overlay?.pickerTriggerRef.current ?? false)
          }
        >
          <DialogHeader>
            <DialogTitle>{accountContent ? "Connect models" : "Custom models"}</DialogTitle>
            <DialogDescription className="sr-only">Connect models to this agent.</DialogDescription>
          </DialogHeader>
          {open ? (
            <DialogPanel>
              {accountContent ? <div className="mb-6">{accountContent}</div> : null}
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
