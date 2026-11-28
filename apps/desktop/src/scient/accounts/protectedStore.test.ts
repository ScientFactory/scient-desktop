// @effect-diagnostics nodeBuiltinImport:off -- A temporary folder stands in for the app's state.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

const storage = vi.hoisted(() => ({
  available: true,
  backend: "basic_text" as string | Error,
}));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => storage.available,
    getSelectedStorageBackend: () => {
      if (storage.backend instanceof Error) throw storage.backend;
      return storage.backend;
    },
    encryptString: (plain: string) => Buffer.from(`sealed:${plain}`),
    decryptString: (sealed: Buffer) => sealed.toString().replace(/^sealed:/, ""),
  },
}));

const { undoEncryption } = await import("./protectedStore.ts");
const { sealSignOut } = await import("./profileData.ts");

it.each([
  { backend: "basic_text", available: true, kept: false },
  { backend: "gnome_libsecret", available: true, kept: true },
  { backend: "kwallet6", available: true, kept: true },
  // macOS and Windows have no backend to choose: the keychain and DPAPI.
  { backend: new Error("Linux only"), available: true, kept: true },
  { backend: "gnome_libsecret", available: false, kept: false },
])(
  "keeps an Undo's cookies only with a protected store: $backend",
  ({ backend, available, kept }) => {
    storage.backend = backend;
    storage.available = available;
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-protected-"));
    const cookies = [
      {
        name: "sid",
        value: "synthetic",
        domain: ".example.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax" as const,
      },
    ];
    // Not kept, the receipt says so: the cookies count as not restorable.
    expect(sealSignOut(dir, "op-out", cookies, undoEncryption()?.encrypt)).toEqual(
      kept ? { saved: 1, notRestorable: 0 } : { saved: 0, notRestorable: 1 },
    );
    expect(NodeFS.existsSync(NodePath.join(dir, "scient-sign-outs"))).toBe(kept);
  },
);
