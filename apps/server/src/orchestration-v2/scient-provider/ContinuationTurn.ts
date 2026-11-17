import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

/**
 * Continue after Stop or a usage limit, on an agent whose protocol has no message-less
 * continuation (Pi, Droid, Antigravity and the other ACP agents): the agent keeps the conversation,
 * so an ordinary turn with this prompt picks it up. OMP's RPC sends the same prompt itself.
 */
export const continuationTurnInput = (
  input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput,
): ProviderAdapter.ProviderAdapterV2TurnInput => {
  const turn = ProviderAdapter.resumeTurnInput(input);
  return { ...turn, message: { ...turn.message, text: "Continue where you left off." } };
};
