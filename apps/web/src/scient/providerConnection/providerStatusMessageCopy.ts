import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/**
 * Provider status lines the server writes in English, keyed by their exact text, so a status
 * Scient knows reads in the app's language. Any other status stays as the server sent it.
 */
const KNOWN_PROVIDER_MESSAGES: Readonly<Record<string, string>> = {
  "Scient Agent has no models yet. Sign in to a model account, add a custom model in Settings, or start a local model server such as Ollama.":
    msg(
      "Scient Agent has no models yet. Sign in to a model account, add a custom model in Settings, or start a local model server such as Ollama.",
    ),
  "Oh My Pi has no models yet. Add a custom model, or sign in to a model provider in Oh My Pi.":
    msg(
      "Oh My Pi has no models yet. Add a custom model, or sign in to a model provider in Oh My Pi.",
    ),
};

/** A provider's status line in the app's language when Scient knows it. */
export function providerStatusMessageText(message: string, resolve: MessageResolver = m): string {
  const known = Object.hasOwn(KNOWN_PROVIDER_MESSAGES, message)
    ? KNOWN_PROVIDER_MESSAGES[message]
    : undefined;
  return known === undefined ? message : resolve(known);
}
