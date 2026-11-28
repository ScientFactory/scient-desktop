/**
 * Electron allows one `webRequest.onBeforeRequest` listener per session. The loopback tunnel's
 * redirect and Scient Accounts' watch for a made password's own request share it here: the
 * tunnel answers its own addresses, watchers only look, and the session listens only while
 * either needs it.
 */
type Details = Electron.OnBeforeRequestListenerDetails;
type Respond = (response: Electron.CallbackResponse) => void;

export type BeforeRequestSession = Pick<Electron.Session, "webRequest">;

interface Tunnel {
  readonly urls: ReadonlyArray<string>;
  readonly handle: (details: Details, respond: Respond) => void;
}
interface Watch {
  readonly urls: ReadonlyArray<string>;
  readonly look: (details: Details) => void;
}

const tunnels = new WeakMap<object, Tunnel>();
const watches = new WeakMap<object, Set<Watch>>();

const unspecified = (url: string) => {
  const host = URL.parse(url)?.hostname;
  return host === "0.0.0.0" || host === "[::]";
};

function listen(session: BeforeRequestSession) {
  const tunnel = tunnels.get(session);
  const looking = [...(watches.get(session) ?? [])];
  if (!tunnel && looking.length === 0) {
    session.webRequest.onBeforeRequest(null);
    return;
  }
  session.webRequest.onBeforeRequest(
    { urls: [...new Set([...(tunnel?.urls ?? []), ...looking.flatMap((watch) => watch.urls)])] },
    (details, respond) => {
      for (const watch of looking) {
        try {
          watch.look(details);
        } catch {
          // A watcher only looks; its failure never holds a request up.
        }
      }
      if (tunnel && unspecified(details.url)) tunnel.handle(details, respond);
      else respond({});
    },
  );
}

/**
 * Re-registers the session's listener after a change; one Electron refuses (a pattern it can't
 * parse) is undone, and the listener as it was is registered again before the error goes on.
 */
function change(session: BeforeRequestSession, apply: () => void, undo: () => void) {
  apply();
  try {
    listen(session);
  } catch (error) {
    undo();
    listen(session);
    throw error;
  }
}

/** The loopback tunnel's redirect for a session, or none. */
export function setTunnelBeforeRequest(session: BeforeRequestSession, tunnel: Tunnel | null) {
  const before = tunnels.get(session);
  const set = (next: Tunnel | null | undefined) =>
    next ? tunnels.set(session, next) : tunnels.delete(session);
  change(
    session,
    () => set(tunnel),
    () => set(before),
  );
}

/**
 * Looks at the session's requests to `urls` (never answers them) until the returned stop. The
 * listener is shared: a watcher sees others' requests too, and checks each one's destination.
 * Throws, registering nothing, when Electron refuses one of `urls`.
 */
export function watchBeforeRequest(
  session: BeforeRequestSession,
  urls: ReadonlyArray<string>,
  look: (details: Details) => void,
) {
  const watch: Watch = { urls, look };
  const set = () => watches.get(session) ?? new Set<Watch>();
  change(
    session,
    () => watches.set(session, set().add(watch)),
    () => set().delete(watch),
  );
  return () => {
    set().delete(watch);
    listen(session);
  };
}
