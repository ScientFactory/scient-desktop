// @effect-diagnostics globalTimers:off -- Electron's request events arrive as plain callbacks, outside any Effect.
import type { DesktopSubmitAnswer } from "@t3tools/contracts";
import { getDomain } from "tldts";

/**
 * A filled new password's answer, per submit: the tab's request whose body holds it (compared in
 * this main process, never logged or sent on) is the change, and its response and the page it
 * leaves are that submit's answer. None, two, an opaque body, or another page between: no answer.
 */
interface RequestDetails {
  readonly id: number;
  readonly url: string;
  readonly method: string;
  readonly webContentsId?: number | undefined;
  readonly resourceType?: string;
  readonly statusCode?: number;
  readonly uploadData?: ReadonlyArray<{
    readonly bytes?: Uint8Array;
    readonly file?: string;
    readonly blobUUID?: string;
  }>;
}
type Listener = (details: RequestDetails) => void;
/** A session's request events, as Electron's `webRequest` gives them. */
export interface SubmitWatchSession {
  readonly webRequest: {
    onCompleted(filter: { urls: string[] }, listener: Listener): void;
    onErrorOccurred(filter: { urls: string[] }, listener: Listener): void;
  };
}
/** Looks at the session's requests to `urls` before they leave, until the returned stop. */
export type WatchBodies = (urls: string[], look: Listener) => () => void;
/** The page right after the response, as the desktop reads it in the tab. */
export interface SubmitLook {
  readonly formGone: boolean;
  readonly refusal: boolean;
  readonly origin: string | null;
  readonly documentId: string | null;
}
/** The tab, narrowed to what the watch uses. */
export interface SubmitTab {
  readonly id: number;
  isLoading(): boolean;
  look(): Promise<SubmitLook | null>;
  /** Each main-frame navigation to another document, with its URL. */
  onNavigated(listener: (url: string) => void): () => void;
  onDestroyed(listener: () => void): () => void;
}

/** How long after the fill its submits are watched for. */
const ARM_FOR_MS = 15 * 60_000;
/** A submit seen with no request carrying the password by then: no answer. */
const MATCH_WITHIN_MS = 10_000;
/** The response must come this soon after its request left. */
const ANSWER_WITHIN_MS = 30_000;
/** The page is read this long after the response and its load, to let it show the outcome. */
const SETTLE_MS = 1_500;
const LOOK_EVERY_MS = 250;

/** One submit of the filled form: its own request, and what came of it. */
interface Attempt {
  /** The requests whose body held the password: one is the change; more, no telling which. */
  readonly carriers: Set<number>;
  mainFrame?: boolean;
  /** A body Scient can't read (a file, a blob) went to the site: no telling either. */
  opaque?: boolean;
  /** Main-frame navigations since the change's request left. */
  readonly navigated: string[];
  /** Opened by its request (the next submit's, before its capture): that capture is its own. */
  awaitsCapture?: boolean;
  answer?: DesktopSubmitAnswer;
}
interface Armed {
  readonly tab: SubmitTab;
  readonly origin: string;
  readonly documentId: string;
  readonly password: string;
  attempt: Attempt;
  readonly stops: Array<() => void>;
}

const watched = new WeakSet<object>();
const armed = new Map<number, Armed>();
const freshAttempt = (): Attempt => ({ carriers: new Set(), navigated: [] });

const hostOf = (url: string) => URL.parse(url)?.hostname ?? "";
/** An IP literal: its own host only (a wildcard over one is no pattern). */
const isIp = (host: string) => host.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(host);
const siteOf = (url: string) => {
  const host = hostOf(url);
  return isIp(host) ? host : (getDomain(host) ?? host);
};
/** Where the change can go: the form's site and its subdomains (an IP: itself), over HTTPS. */
const siteUrls = (origin: string) => {
  const host = hostOf(origin);
  if (isIp(host)) return [`https://${host}/*`];
  const site = siteOf(origin);
  return [`https://${site}/*`, `https://*.${site}/*`];
};
const toSite = (entry: Armed, url: string) =>
  url.startsWith("https://") && siteOf(url) === siteOf(entry.origin);
/** Whether a request's body holds the password, as forms, JSON and multipart parts write it. */
function carriesPassword(uploadData: RequestDetails["uploadData"], password: string): boolean {
  if (!uploadData?.length || !password) return false;
  const needles = [
    password,
    encodeURIComponent(password),
    new URLSearchParams({ p: password }).toString().slice(2),
    JSON.stringify(password).slice(1, -1),
  ].map((text) => Buffer.from(text, "utf8"));
  return uploadData.some(
    (part) =>
      part.bytes !== undefined &&
      needles.some((needle) => Buffer.from(part.bytes!).includes(needle)),
  );
}

const clear = (entry: Armed) => {
  for (const stop of entry.stops.splice(0)) stop();
  if (armed.get(entry.tab.id) === entry) armed.delete(entry.tab.id);
};
/** No telling for this submit: the person says. */
const noAnswer = (entry: Armed) => {
  entry.attempt.answer = {
    documentId: entry.documentId,
    status: 0,
    formGone: false,
    refusal: false,
    leftOrigin: false,
  };
};

/** Hears the session's request outcomes, once per session. */
function hearOutcomes(session: SubmitWatchSession) {
  if (watched.has(session)) return;
  watched.add(session);
  const done = (status: (request: RequestDetails) => number) => (request: RequestDetails) => {
    const entry =
      request.webContentsId === undefined ? undefined : armed.get(request.webContentsId);
    const attempt = entry?.attempt;
    if (!entry || !attempt || attempt.answer || attempt.carriers.size !== 1) return;
    if (!attempt.carriers.has(request.id)) return;
    void settle(entry, attempt, status(request), request.url);
  };
  session.webRequest.onCompleted(
    { urls: ["https://*/*"] },
    done((request) => request.statusCode ?? 0),
  );
  session.webRequest.onErrorOccurred(
    { urls: ["https://*/*"] },
    done(() => 0),
  );
}

/**
 * The desktop filled `password` into the form in `documentId`: from now on the tab's requests to
 * the form's site are looked at, each submit with its own answer, until the tab's end or
 * ARM_FOR_MS. A new fill in the tab replaces this one. A watch Electron refuses leaves no answer.
 */
export function armFill(
  tab: SubmitTab,
  session: SubmitWatchSession,
  watchBodies: WatchBodies,
  fill: { readonly origin: string; readonly documentId: string; readonly password: string },
) {
  const before = armed.get(tab.id);
  if (before) clear(before);
  hearOutcomes(session);
  const entry: Armed = { tab, ...fill, attempt: freshAttempt(), stops: [] };
  armed.set(tab.id, entry);
  const deadline = setTimeout(() => clear(entry), ARM_FOR_MS);
  entry.stops.push(
    () => clearTimeout(deadline),
    tab.onDestroyed(() => clear(entry)),
    tab.onNavigated((url) => {
      if (entry.attempt.carriers.size > 0) entry.attempt.navigated.push(url);
    }),
  );
  try {
    entry.stops.push(
      watchBodies(siteUrls(fill.origin), (request) => {
        // The listener is the session's: other tabs' and other watches' requests come here too.
        if (
          request.webContentsId !== tab.id ||
          request.method === "GET" ||
          request.method === "HEAD" ||
          !toSite(entry, request.url)
        )
          return;
        const opaque = request.uploadData?.some((part) => part.bytes === undefined) === true;
        const carries = !opaque && carriesPassword(request.uploadData, entry.password);
        let attempt = entry.attempt;
        if (attempt.answer) {
          // After an answer, the password sent again is the next submit's (its capture may come
          // later); never after "no answer", which may be this same submit's other request.
          if (!carries || attempt.answer.status === 0) return;
          attempt = entry.attempt = { ...freshAttempt(), awaitsCapture: true };
        }
        if (opaque) {
          attempt.opaque = true;
          return;
        }
        if (!carries) return;
        attempt.carriers.add(request.id);
        if (attempt.carriers.size === 1) attempt.mainFrame = request.resourceType === "mainFrame";
        // Two requests carrying the password: no telling which was the change.
        else noAnswer(entry);
      }),
    );
  } catch {
    noAnswer(entry);
  }
}

/**
 * The form was submitted (its capture reached the desktop). A submit after an answered one is its
 * own attempt, unless its request opened that attempt already (answered or not). With no request
 * carrying the password by MATCH_WITHIN_MS (a hashed or encrypted body, a socket), no answer.
 */
export function submitSeen(tabId: number) {
  const entry = armed.get(tabId);
  if (!entry) return;
  if (entry.attempt.answer && !entry.attempt.awaitsCapture) entry.attempt = freshAttempt();
  const attempt = entry.attempt;
  attempt.awaitsCapture = false;
  const check = setTimeout(() => {
    if (entry.attempt === attempt && !attempt.answer && attempt.carriers.size === 0)
      noAnswer(entry);
  }, MATCH_WITHIN_MS);
  entry.stops.push(() => clearTimeout(check));
}

/** The answer to the tab's last submit of a filled password, once its page right after was read. */
export function submitAnswer(tabId: number) {
  return armed.get(tabId)?.attempt.answer;
}

async function settle(entry: Armed, attempt: Attempt, status: number, finalUrl: string) {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const current = () => armed.get(entry.tab.id) === entry && entry.attempt === attempt;
  for (let waited = 0; entry.tab.isLoading() && waited < ANSWER_WITHIN_MS; waited += LOOK_EVERY_MS)
    await wait(LOOK_EVERY_MS);
  await wait(SETTLE_MS);
  if (!current() || attempt.answer) return;
  const moves = attempt.navigated.length;
  const look = await entry.tab.look().catch(() => null);
  // Read while nothing else happened: the same watch and submit, no navigation during the read.
  if (!current() || attempt.answer) return;
  if (look === null || attempt.navigated.length !== moves || attempt.opaque) return noAnswer(entry);
  // A form post's answer is the one document its response loaded; a page's own request leaves
  // the page where it was. Any other page in between, and this isn't the change's answer.
  const ownPage = attempt.mainFrame
    ? moves === 1 && attempt.navigated[0] === finalUrl
    : moves === 0 && look.documentId === entry.documentId;
  if (!ownPage) return noAnswer(entry);
  attempt.answer = {
    documentId: entry.documentId,
    status,
    formGone: look.formGone,
    refusal: look.refusal,
    leftOrigin: look.origin !== entry.origin,
  };
}
