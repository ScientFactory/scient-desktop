/** The sentence measured in the N7 test; the agent's standing Library rules say the same. */
export const ASK_LIBRARY_PROMPT =
  "Answer from the papers in my Library: search their full text, cite the paper and page for each claim, check any quotes, and say so if my Library does not answer it.";

/** The text to put before the draft, or null when the draft already starts with the sentence. */
export function askLibraryInsertion(prompt: string): string | null {
  return prompt.trimStart().startsWith(ASK_LIBRARY_PROMPT) ? null : `${ASK_LIBRARY_PROMPT} `;
}
