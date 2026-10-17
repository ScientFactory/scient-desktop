import * as Linking from "expo-linking";
import { type LinkedPrompt } from "@t3tools/shared/promptLinks";
// SCIENT-FORK:START — registered app identity and local draft-link policy.
import { buildScientNewThreadLink as buildNewThreadLink } from "@t3tools/shared/scientPromptLinks";
// SCIENT-FORK:END
import { Alert } from "react-native";

import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { linkedThreadDraftAction } from "./prompt-link-model";

/** Shows the one notice a prompt link owes the user, built with `promptLinkNotice`. */
export function showPromptLinkNotice(notice: string): void {
  Alert.alert("Prompt from a link", notice);
}

/**
 * Puts a linked prompt into an existing thread's composer draft. An empty composer is filled;
 * typed text is replaced only when the user says so. The notice rides in the same alert, so a
 * link never stacks two dialogs.
 */
export async function applyLinkedPromptToThreadDraft(
  draftKey: string,
  prompt: LinkedPrompt,
  notice: string,
): Promise<void> {
  try {
    await waitForComposerDraftsLoaded();
  } catch {
    Alert.alert("Could not open link", "Drafts could not be loaded, so the prompt was not added.");
    return;
  }
  const action = linkedThreadDraftAction(getComposerDraftSnapshot(draftKey).text, prompt.text);
  if (action !== "ask") {
    if (action === "fill") setComposerDraftText(draftKey, prompt.text);
    showPromptLinkNotice(notice);
    return;
  }
  Alert.alert("Linked prompt ready. Replace draft?", notice, [
    { text: "Keep mine", style: "cancel" },
    { text: "Replace", onPress: () => setComposerDraftText(draftKey, prompt.text) },
  ]);
}

/** Copies a shareable link that opens a new task with this prompt. Used by sent user messages. */
export async function copyPromptLink(prompt: string): Promise<void> {
  // SCIENT-FORK:START — preserve this binary's registered scheme; never publish draft text to a hosted URL.
  const params = new URL(buildNewThreadLink({ prompt })).searchParams;
  const link = Linking.createURL("new", { queryParams: Object.fromEntries(params) });
  // SCIENT-FORK:END
  if (!(await tryCopyTextWithHaptic(link, { target: "prompt link" }))) {
    Alert.alert("Could not copy", "Try again.");
  }
}
