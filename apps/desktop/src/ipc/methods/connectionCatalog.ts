import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConnectionCatalogStore from "../../app/DesktopConnectionCatalogStore.ts";
// SCIENT-FORK:START — several app windows share one desktop process.
import { notifyOtherWindows } from "../../scient/multiWindow/notifyOtherWindows.ts";
// SCIENT-FORK:END
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.connectionCatalog.get")(function* () {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    return Option.getOrNull(yield* store.get);
  }),
});

export const setConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  // SCIENT-FORK:START — other windows drop their cached catalog; it holds credentials, so
  // the message carries none.
  handler: Effect.fn("desktop.ipc.connectionCatalog.set")(function* (catalog, event) {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    const stored = yield* store.set(catalog);
    if (stored) yield* notifyOtherWindows(event, IpcChannels.CONNECTION_CATALOG_CHANGED_CHANNEL);
    return stored;
  }),
  // SCIENT-FORK:END
});
