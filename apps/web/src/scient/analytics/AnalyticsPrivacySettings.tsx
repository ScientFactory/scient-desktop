import type { ScientAnalyticsConsent, ScientAnalyticsStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { ensureLocalApi, readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readPreparedConnection } from "../../state/session";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { toastManager } from "../../components/ui/toast";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import {
  deleteScientAnalyticsData,
  readScientAnalyticsStatus,
  setScientAnalyticsConsent,
  useRecordScientAnalytics,
} from "./client";

const CONSENT_LABELS: Readonly<Record<ScientAnalyticsConsent, string>> = {
  off: "Off",
  essential: "Essential reliability",
  product: "Product improvement",
  diagnostic: "Diagnostics",
};

export function AnalyticsPrivacySettings() {
  const environmentId = usePrimaryEnvironmentId();
  const record = useRecordScientAnalytics();
  const [status, setStatus] = useState<ScientAnalyticsStatus | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (environmentId === null) {
      setStatus(null);
      return;
    }
    const prepared = readPreparedConnection(environmentId);
    if (prepared === null) {
      setStatus(null);
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
  }, [environmentId]);

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
    try {
      setStatus(await setScientAnalyticsConsent(prepared, consent));
    } catch {
      setStatus(previous);
      toastManager.add({
        type: "error",
        title: "Analytics preference was not saved",
        description: "Your previous privacy setting is still active.",
      });
    } finally {
      setPending(false);
    }
  };

  const deleteData = async () => {
    if (pending) return;
    const prepared = readPreparedConnection(environmentId);
    if (prepared === null) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      [
        "Delete Scient analytics data?",
        "Scient will request deletion of this installation's analytics data and replace its anonymous identifier.",
      ].join("\n"),
    );
    if (!confirmed) return;
    setPending(true);
    try {
      await deleteScientAnalyticsData(prepared);
      toastManager.add({
        type: "success",
        title: "Analytics deletion requested",
        description: "Local analytics data was cleared and the anonymous identifier was replaced.",
      });
    } catch {
      toastManager.add({
        type: "error",
        title: "Analytics data was not deleted",
        description:
          "Nothing was cleared locally because the deletion gateway did not acknowledge the request.",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <SettingsSection id="scient-analytics" title="Privacy and analytics">
      <SettingsRow
        title="Share anonymous usage data"
        description="Choose whether Scient may send bounded product and reliability events. Prompts, responses, files, paths, URLs, credentials, and provider account identities are never collected."
        control={
          <Select
            value={status.consent}
            onValueChange={(value) => void updateConsent(value as ScientAnalyticsConsent)}
          >
            <SelectTrigger
              className="w-full sm:w-52"
              aria-label="Analytics sharing level"
              disabled={pending}
            >
              <SelectValue>{CONSENT_LABELS[status.consent]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(CONSENT_LABELS) as ScientAnalyticsConsent[]).map((consent) => (
                <SelectItem key={consent} hideIndicator value={consent}>
                  {CONSENT_LABELS[consent]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Delete analytics data"
        description="Request deletion for this anonymous installation and rotate its local analytics identity."
        control={
          <Button size="xs" variant="outline" disabled={pending} onClick={() => void deleteData()}>
            Delete data
          </Button>
        }
      />
    </SettingsSection>
  );
}
