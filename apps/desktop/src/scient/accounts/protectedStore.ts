import * as Electron from "electron";

/**
 * Whether cookies may be kept on disk: the system's keychain, DPAPI or a Linux keyring. Linux's
 * basic_text "encrypts" with a fixed key, no better than plain text, so it counts as none.
 */
export function protectedStore() {
  try {
    if (!Electron.safeStorage.isEncryptionAvailable()) return false;
  } catch {
    return false;
  }
  try {
    return Electron.safeStorage.getSelectedStorageBackend() !== "basic_text";
  } catch {
    // Not Linux: the keychain or DPAPI.
    return true;
  }
}

/** Encryption for the cookies an Undo keeps; none without a protected store, so none are kept. */
export const undoEncryption = () =>
  protectedStore()
    ? {
        encrypt: (plain: string) => Electron.safeStorage.encryptString(plain),
        decrypt: (encrypted: Buffer) => Electron.safeStorage.decryptString(encrypted),
      }
    : undefined;
