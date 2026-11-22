import type * as Electron from "electron";
import type * as NodeEvents from "node:events";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const Receipt = Schema.Struct({ version: Schema.String, nativeUpdateUrl: Schema.String });
const decodeReceipt = Schema.decodeUnknownOption(Receipt);
type NativeUpdater = Pick<NodeEvents.EventEmitter, "on" | "removeListener"> &
  Pick<Electron.AutoUpdater, "checkForUpdates" | "quitAndInstall">;
type Receipt = typeof Receipt.Type;
interface Preparation {
  readonly receipt: Receipt;
  readonly promise: Promise<void>;
  status: "pending" | "ready" | "failed";
}

/** Electron's native preparation arms install-on-quit, so prepare is called only after consent. */
export class MacUpdatePreparation {
  readonly #native: NativeUpdater;
  #receipt: Receipt | undefined;
  #preparation: Preparation | undefined;

  constructor(native: NativeUpdater) {
    this.#native = native;
  }

  get authorizedVersion(): string | null {
    return this.#preparation !== undefined && this.#preparation.status !== "failed"
      ? this.#preparation.receipt.version
      : null;
  }

  recordDownloaded(raw: unknown): void {
    const decoded = decodeReceipt(raw);
    if (Option.isNone(decoded) || !URL.canParse(decoded.value.nativeUpdateUrl)) {
      this.#receipt = undefined;
      return;
    }
    const receipt = decoded.value;
    const url = new URL(receipt.nativeUpdateUrl);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      !/^\/[a-f0-9]{128}\.zip$/.test(url.pathname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      this.#receipt = undefined;
      return;
    }
    if (this.#preparation?.status !== "failed" && this.#preparation !== undefined) {
      if (this.#preparation.receipt.nativeUpdateUrl !== receipt.nativeUpdateUrl) return;
    }
    this.#receipt = receipt;
  }

  assertCanDownload(): void {
    if (this.#preparation !== undefined && this.#preparation.status !== "failed") {
      throw new Error(
        "A native update was already authorized. Retry that update or restart Scient before downloading another release.",
      );
    }
    this.#receipt = undefined;
    this.#preparation = undefined;
  }

  prepare(expectedVersion: string): Promise<void> {
    const receipt = this.#receipt;
    if (receipt === undefined || receipt.version !== expectedVersion) {
      return Promise.reject(
        new Error(
          "The downloaded update has no matching native preparation receipt. Download it again.",
        ),
      );
    }
    const retained = this.#preparation;
    if (retained !== undefined && retained.status !== "failed") {
      if (retained.receipt.nativeUpdateUrl !== receipt.nativeUpdateUrl) {
        return Promise.reject(new Error("Another native update is already being prepared."));
      }
      return retained.promise;
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const preparation: Preparation = { receipt, promise, status: "pending" };
    this.#preparation = preparation;
    const cleanup = () => {
      this.#native.removeListener("update-downloaded", downloaded);
      this.#native.removeListener("error", failed);
      this.#native.removeListener("update-not-available", unavailable);
    };
    const failed = (error: unknown) => {
      if (preparation.status !== "pending") return;
      preparation.status = "failed";
      cleanup();
      reject(error);
    };
    const unavailable = () =>
      failed(new Error("The native updater did not prepare the authorized update."));
    const downloaded = (
      _event: Electron.Event,
      _notes: string,
      _name: string,
      _date: Date,
      updateURL: string,
    ) => {
      if (updateURL !== receipt.nativeUpdateUrl || this.#preparation !== preparation) return;
      preparation.status = "ready";
      cleanup();
      resolve();
    };
    this.#native.on("update-downloaded", downloaded);
    this.#native.on("error", failed);
    this.#native.on("update-not-available", unavailable);
    try {
      this.#native.checkForUpdates();
    } catch (error) {
      failed(error);
    }
    return promise;
  }

  quitAndInstall(expectedVersion: string): void {
    const preparation = this.#preparation;
    if (
      preparation?.status !== "ready" ||
      preparation.receipt.version !== expectedVersion ||
      this.#receipt?.nativeUpdateUrl !== preparation.receipt.nativeUpdateUrl
    ) {
      throw new Error("The authorized update is not natively ready to install.");
    }
    this.#native.quitAndInstall();
  }
}
