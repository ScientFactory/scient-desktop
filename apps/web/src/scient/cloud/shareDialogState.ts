import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/** Which thread has the Share link dialog open; the app root renders it once. */
export const cloudShareDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("scient-cloud:share-dialog-thread"),
);

export function openShareLinkDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(cloudShareDialogThreadAtom, threadRef);
}
