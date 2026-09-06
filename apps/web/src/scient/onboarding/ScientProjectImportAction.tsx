import type { ScopedProjectRef } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useState } from "react";

import { resolvePrimaryOperateAccess } from "../../providerOperateAccess";
import { usePrimarySessionState } from "../../environments/primary";
import { usePrimaryEnvironment } from "../../state/environments";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { Button } from "../../components/ui/button";
import { Dialog, DialogPanel, DialogPopup, DialogTitle } from "../../components/ui/dialog";
import { toastManager } from "../../components/ui/toast";

// Merely visiting Settings or onboarding must not load or scan CLI history.
const ProjectImportStep = lazy(() =>
  import("../../components/onboarding/ProjectImportStep").then((module) => ({
    default: module.ProjectImportStep,
  })),
);

export function ScientProjectImportAction({ onImported }: { readonly onImported?: () => void }) {
  const environment = usePrimaryEnvironment();
  const session = usePrimarySessionState();
  const openNewThread = useNewThreadHandler();
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const access = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: typeof window !== "undefined" && Boolean(window.desktopBridge),
    session: session.data,
    isPending: session.isPending,
    hasError: session.error !== null,
  });
  const canImport = environment !== null && access === "granted";

  const busy = canImport && importing;

  const finish = useCallback(
    async (projectRef?: ScopedProjectRef) => {
      if (projectRef !== undefined) {
        try {
          const opened = await openNewThread(projectRef);
          if (opened === null) return false;
          onImported?.();
        } catch {
          toastManager.add({
            type: "error",
            title: "Could not open the imported project",
            description: "Your imported projects are still available in the sidebar.",
          });
          return false;
        }
      }
      setOpen(false);
      return true;
    },
    [openNewThread, onImported],
  );

  return (
    <>
      <Button
        disabled={!canImport}
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="ghost-muted"
      >
        Import projects and conversations
        <ArrowRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
      </Button>
      {open ? (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            if (!busy) setOpen(nextOpen);
          }}
        >
          <DialogPopup className="max-w-xl" showCloseButton={!busy}>
            <DialogTitle className="sr-only">Import projects and conversations</DialogTitle>
            <DialogPanel aria-busy={busy}>
              {canImport ? (
                <Suspense fallback={<p role="status">Loading import…</p>}>
                  <ProjectImportStep
                    key={environment.environmentId}
                    environmentId={environment.environmentId}
                    machineLabel={environment.label}
                    onBack={() => setOpen(false)}
                    onDone={finish}
                    onImportingChange={setImporting}
                  />
                </Suspense>
              ) : (
                <p role="status">Connect to a machine with permission to import projects.</p>
              )}
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}
