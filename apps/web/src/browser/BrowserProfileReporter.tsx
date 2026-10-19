import { AuthPreviewOperateScope } from "@t3tools/contracts";
import { useEffect } from "react";

import { useClientSettingsHydrated } from "~/hooks/useSettings";
import { useServerConfigs } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { browserProfileReportInput, useBrowserDefaults } from "./browserDefaults";

export function BrowserProfileReporter() {
  const hydrated = useClientSettingsHydrated();
  const defaults = useBrowserDefaults();
  const { profiles, defaultProfileId } = browserProfileReportInput(defaults);
  const { environments } = useEnvironments();
  const serverConfigs = useServerConfigs();
  const operable = useEnvironmentsWithScope(environments, AuthPreviewOperateScope);
  const report = useAtomCommand(previewEnvironment.reportProfiles, { reportFailure: false });

  useEffect(() => {
    if (!hydrated) return;
    for (const [environmentId, config] of serverConfigs) {
      if (!config.environment.capabilities.serverBrowser || !operable.has(environmentId)) continue;
      void report({ environmentId, input: { profiles, defaultProfileId } });
    }
  }, [defaultProfileId, hydrated, operable, profiles, report, serverConfigs]);

  return null;
}
