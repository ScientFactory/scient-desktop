import type { Node as DocumentNode } from "@tiptap/pm/model";
import { randomUUID } from "~/lib/utils";
import {
  indexedDbDocumentInputs,
  type DocumentInputCheckpoint,
} from "../markdownEditor/persistence/documentInputCheckpoint";
import { serializedVisualDocumentParts } from "./visualDocumentJson";
import { parkVisualTypingSnapshot } from "./visualRecovery";
import { parseTypingDraft, typingDraftIdentity } from "./visualTyping";

const keyFor = (key: string) => `latex-visual:${key}`;
const notify = (key: string) =>
  window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));

/** Import once at opening into the existing recovery review flow. Retire the
 * journal only after the snapshot is durably installed or parked, never before.
 */
export async function prepareVisualTypingRecovery(key: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const retained = await indexedDbDocumentInputs.read(keyFor(key));
  if (!retained) return;
  if (retained.checkpoint.pending) {
    if (!parseTypingDraft(retained.snapshot))
      throw new Error("Retained writing could not be decoded.");
    const existing = typingDraftIdentity(key);
    if (existing === null)
      localStorage.setItem(`scient:latex-visual-draft:typing:${key}`, retained.snapshot);
    else if (existing !== retained.snapshot && !parkVisualTypingSnapshot(key, retained.snapshot))
      throw new Error("Retained writing could not be parked; its original is preserved.");
  }
  // A competing writer can replace the token while the snapshot is imported.
  // Leave that version untouched; its own opening/recovery path will read it.
  await indexedDbDocumentInputs.replace(keyFor(key), retained.checkpoint.token);
}

/** A single writer, serialized ownership transactions, immutable block identities.
 * Accepted source marks input clean while keeping its blocks warm for the next
 * edit. Explicit exit still retains the existing synchronous fallback snapshot.
 */
export function createVisualTypingJournal(key: string) {
  let owned: DocumentInputCheckpoint | undefined;
  let baseline: string | undefined;
  let document: DocumentNode | undefined;
  let tail = Promise.resolve(true);
  let sequence = 0;
  const identity = randomUUID();
  const ids = new WeakMap<DocumentNode, string>();
  const enqueue = (work: () => Promise<boolean>) => {
    const result = tail.then(work).catch(() => {
      notify(key);
      return false;
    });
    tail = result;
    return result;
  };
  return {
    checkpoint(baseSource: string, doc: DocumentNode): Promise<boolean> {
      return enqueue(async () => {
        if (document === doc && baseline === baseSource && owned?.pending) return true;
        const { envelope, content } = serializedVisualDocumentParts(doc);
        const blocks: string[] = [],
          changed = new Map<string, string>();
        const retained = new Set(owned?.blocks ?? []);
        doc.forEach((node, _offset, index) => {
          let id = ids.get(node);
          if (!id) {
            id = `${identity}:${++sequence}`;
            ids.set(node, id);
          }
          blocks.push(id);
          if (!retained.has(id)) changed.set(id, content[index]!);
        });
        const checkpoint: DocumentInputCheckpoint = {
          token: randomUUID(),
          envelope,
          blocks,
          pending: true,
          bytes:
            2 *
            (baseSource.length +
              envelope.length +
              content.reduce((sum, block) => sum + block.length, 0)),
        };
        const accepted = await indexedDbDocumentInputs.replace(keyFor(key), owned?.token, {
          checkpoint,
          changed,
          ...(baseline !== baseSource ? { baseSource } : {}),
        });
        if (!accepted) {
          notify(key);
          return false;
        }
        owned = checkpoint;
        baseline = baseSource;
        document = doc;
        return true;
      });
    },
    confirm(): Promise<boolean> {
      return enqueue(async () => {
        // The durable accepted source also supersedes older checkpoints from
        // this writer (for example, Enter flushes typing before its quiet timer).
        // Queue order keeps checkpoints authored after this confirmation pending.
        if (!owned) return true;
        const checkpoint = { ...owned, token: randomUUID(), pending: false };
        const accepted = await indexedDbDocumentInputs.replace(keyFor(key), owned.token, {
          checkpoint,
          changed: new Map(),
        });
        if (accepted) owned = checkpoint;
        else notify(key);
        return accepted;
      });
    },
    discard(): Promise<boolean> {
      return enqueue(async () => {
        if (!owned) return true;
        const accepted = await indexedDbDocumentInputs.replace(keyFor(key), owned.token);
        if (accepted) {
          owned = undefined;
          baseline = undefined;
          document = undefined;
        } else notify(key);
        return accepted;
      });
    },
    release(): Promise<boolean> {
      return enqueue(async () => {
        // Closing/renaming releases warm clean data. Unconverted input remains
        // recoverable even when the editor can no longer finish its conversion.
        if (!owned || owned.pending) return true;
        const accepted = await indexedDbDocumentInputs.replace(keyFor(key), owned.token);
        if (accepted) {
          owned = undefined;
          baseline = undefined;
          document = undefined;
        } else notify(key);
        return accepted;
      });
    },
  };
}
