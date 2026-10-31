import type { ScientAnalyticsConsent, ScientAnalyticsStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readPreparedConnection } from "../../state/session";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "../../components/ui/dialog";
import { Switch } from "../../components/ui/switch";
import { toastManager } from "../../components/ui/toast";
import { AnalyticsSharingInfo } from "./AnalyticsSharingInfo";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import {
  deleteScientAnalyticsData,
  readScientAnalyticsStatus,
  setScientAnalyticsConsent,
  useRecordScientAnalytics,
} from "./client";

export function AnalyticsPrivacySettings() {
  const environmentId = usePrimaryEnvironmentId();
  const record = useRecordScientAnalytics();
  const [status, setStatus] = useState<ScientAnalyticsStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const clearStatus = useStableCallback(() => setStatus(null));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads analytics consent status over the environment RPC connection while mounted, ignoring replies that land after unmount
  useEffect(() => {
    if (environmentId === null) {
      clearStatus();
      return;
    }
    const prepared = readPreparedConnection(environmentId);
    if (prepared === null) {
      clearStatus();
      return;
    }
    let active = true;
    void readScientAnalyticsStatus(prepared)
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setStatus(null);
      });
    return () => {
      active = false;
    };
  }, [environmentId, clearStatus]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports the settings surface.opened event to the imperative analytics recorder once consent status is available
  useEffect(() => {
    if (status?.available !== true) return;
    record({ name: "surface.opened", properties: { surface: "settings" } });
  }, [record, status?.available]);

  if (environmentId === null || status?.available !== true) return null;

  const updateConsent = async (consent: ScientAnalyticsConsent) => {
    const prepared = readPreparedConnection(environmentId);
    if (prepared === null || pending) return;
    const previous = status;
    setPending(true);
    setStatus({ available: true, consent });
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        setStatus(await setScientAnalyticsConsent(prepared, consent));
      } catch {
        setStatus(previous);
        toastManager.add({
          type: "error",
          title: "Analytics preference was not saved",
          description: "Your new choice could not be confirmed. Please try again.",
        });
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPending(false);
    if (actionFailure) throw actionFailure.cause;
  };

  const deleteData = async () => {
    if (pending) return;
    const prepared = readPreparedConnection(environmentId);
    if (prepared === null) return;
    setConfirmDelete(false);
    setPending(true);
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await deleteScientAnalyticsData(prepared);
        toastManager.add({
          type: "success",
          title: "Analytics deletion requested",
          description:
            "Local analytics data was cleared and the analytics identifier was replaced.",
        });
      } catch {
        toastManager.add({
          type: "error",
          title: "Analytics data was not deleted",
          description:
            "Deletion could not be confirmed. Please try again; an accepted request may still be processing.",
        });
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPending(false);
    if (actionFailure) throw actionFailure.cause;
  };

  return (
    <SettingsSection id="scient-analytics" title="Privacy and analytics">
      <SettingsRow
        description="Help improve Scient. Analytics never collects your conversations, files, or credentials."
        title={
          <span className="inline-flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span>Share usage and reliability</span>
            <AnalyticsSharingInfo consent={status.consent} />
          </span>
        }
        control={
          <Switch
            aria-label="Share usage and reliability"
            checked={status.consent !== "off"}
            disabled={pending}
            onCheckedChange={(checked) => void updateConsent(checked ? "diagnostic" : "off")}
          />
        }
      />
      <SettingsRow
        title="Delete analytics data"
        description="Request deletion for this installation and reset its local analytics identifier."
        control={
          <Dialog modal={false} open={confirmDelete} onOpenChange={setConfirmDelete}>
            <DialogTrigger render={<Button size="xs" variant="outline" disabled={pending} />}>
              Delete data
            </DialogTrigger>
            <DialogPopup
              className="max-w-sm"
              bottomStickOnMobile={false}
              showBackdrop={false}
              showCloseButton={false}
            >
              <DialogHeader size="compact" className="text-left">
                <DialogTitle size="compact">Delete analytics data?</DialogTitle>
                <DialogDescription size="compact">
                  Request deletion of this installation’s analytics data and reset its random
                  analytics identifier.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter variant="bare" padding="compact" className="flex-row justify-end">
                <DialogClose render={<Button size="sm" variant="outline" />}>Cancel</DialogClose>
                <Button size="sm" disabled={pending} onClick={() => void deleteData()}>
                  Delete data
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        }
      />
    </SettingsSection>
  );
}
