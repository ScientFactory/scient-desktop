import type { EnvironmentId, OrchestrationMessageContext } from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";

/** Called at submission, after uploads, including separately for each fan-out target. */
export function prepareComposerContextMessage(input: {
  environmentId: EnvironmentId;
  text: string;
  context: OrchestrationMessageContext | undefined;
}) {
  const { environmentId, text, context } = input;
  if (context === undefined) return { text };
  // A render's capability snapshot can be stale by the time an upload finishes.
  const supportsInlineContext =
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .inlineMessageContext === true;
  return supportsInlineContext
    ? { text, context }
    : { text: serializeLegacyContextMessage({ text, records: context.records }) };
}
