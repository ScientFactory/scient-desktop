import * as Dialog from "../../components/ui/Dialog";
import * as Linking from "expo-linking";
import { type LinkedPrompt } from "@t3tools/shared/promptLinks";
// SCIENT-FORK:START — registered app identity and local draft-link policy.
import { buildScientNewThreadLink as buildNewThreadLink } from "@t3tools/shared/scientPromptLinks";
// SCIENT-FORK:END

import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { linkedThreadDraftAction } from "./prompt-link-model";

export function showPromptLinkNotice(notice: string): void {
  Dialog.alert("Prompt from a link", notice);
}

export async function applyLinkedPromptToThreadDraft(
  draftKey: string,
  prompt: LinkedPrompt,
  notice: string,
): Promise<void> {
  try {
    await waitForComposerDraftsLoaded();
  } catch {
    Dialog.alert("Could not open link", "Drafts could not be loaded, so the prompt was not added.");
    return;
  }
  const action = linkedThreadDraftAction(getComposerDraftSnapshot(draftKey).text, prompt.text);
  if (action !== "ask") {
    if (action === "fill") setComposerDraftText(draftKey, prompt.text);
    showPromptLinkNotice(notice);
    return;
  }
  Dialog.alert("Linked prompt ready. Replace draft?", notice, [
    { text: "Keep mine", style: "cancel" },
    { text: "Replace", onPress: () => setComposerDraftText(draftKey, prompt.text) },
  ]);
}

export async function copyPromptLink(prompt: string): Promise<void> {
  // SCIENT-FORK:START — preserve this binary's registered scheme; never publish draft text to a hosted URL.
  const params = new URL(buildNewThreadLink({ prompt })).searchParams;
  const link = Linking.createURL("new", { queryParams: Object.fromEntries(params) });
  // SCIENT-FORK:END
  if (!(await tryCopyTextWithHaptic(link, { target: "prompt link" }))) {
    Dialog.alert("Could not copy", "Try again.");
  }
}
