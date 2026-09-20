/** Unqualified input must survive a mode/tab switch without masquerading as saved LaTeX. */
const drafts = new Map<string, string>();

export function readVisualDraft(key: string): string | null {
  return drafts.get(key) ?? null;
}

export function retainVisualDraft(key: string, text: string): void {
  drafts.set(key, text);
}

export function clearVisualDraft(key: string): void {
  drafts.delete(key);
}
