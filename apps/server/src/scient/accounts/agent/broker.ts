import type { PreviewAutomationError, PreviewTabId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type {
  PreviewAutomationBroker,
  PreviewAutomationInvokeInput,
} from "../../../mcp/PreviewAutomationBroker.ts";
import { fail } from "../AccountsService.ts";

type Invoke<E> = <A>(
  operation: PreviewAutomationInvokeInput["operation"],
  input: unknown,
  tabId?: PreviewTabId,
) => Effect.Effect<A, E>;

interface InvokeOptions {
  /** False for reads in the background, which must not change the agent's current tab. */
  readonly updateCurrentTab?: boolean;
}

/** Calls the preview browser for one invocation, optionally turning its errors into `E`. */
export function previewInvoker(
  broker: PreviewAutomationBroker["Service"],
  scope: PreviewAutomationInvokeInput["scope"],
  options?: InvokeOptions,
): Invoke<PreviewAutomationError>;
export function previewInvoker<E>(
  broker: PreviewAutomationBroker["Service"],
  scope: PreviewAutomationInvokeInput["scope"],
  options: InvokeOptions & { readonly mapError: (error: PreviewAutomationError) => E },
): Invoke<E>;
export function previewInvoker<E>(
  broker: PreviewAutomationBroker["Service"],
  scope: PreviewAutomationInvokeInput["scope"],
  {
    mapError,
    ...request
  }: InvokeOptions & { readonly mapError?: (error: PreviewAutomationError) => E } = {},
): Invoke<E | PreviewAutomationError> {
  return <A>(
    operation: PreviewAutomationInvokeInput["operation"],
    input: unknown,
    tabId?: PreviewTabId,
  ) => {
    const call = broker.invoke<A>({
      scope,
      operation,
      input,
      ...(tabId === undefined ? {} : { tabId }),
      ...request,
    });
    return mapError ? call.pipe(Effect.mapError(mapError)) : call;
  };
}

/** Browser errors are written for agents (a full tab limit, a closed tab); keep them. */
export const browserFailure = (fallback: string) => (error: PreviewAutomationError) =>
  fail("unavailable", error.message || fallback);
