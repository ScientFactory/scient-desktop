import type { EnvironmentId } from "@t3tools/contracts";

import { useServerConfigs } from "../../state/entities";

/** Whether the server's Trash is the Windows Recycle Bin, which is what people call it there. */
export function useRecycleBin(environmentId: EnvironmentId | null) {
  const configs = useServerConfigs();
  return (
    environmentId !== null && configs.get(environmentId)?.environment.platform.os === "windows"
  );
}
