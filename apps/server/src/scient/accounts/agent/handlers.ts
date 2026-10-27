import { accountAgentOperations } from "./AccountAgentService.ts";
import { ScientAccountsToolkit } from "./tools.ts";

export const ScientAccountsToolkitHandlersLive =
  ScientAccountsToolkit.toLayer(accountAgentOperations);
