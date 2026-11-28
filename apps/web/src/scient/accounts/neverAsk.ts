import type { EnvironmentId } from "@t3tools/contracts";

const NEVER_KEY = "scient.accounts.never-save.v1";
const UPLOADED_KEY = "scient.accounts.never-save.uploaded.v1";

const readList = (key: string): ReadonlyArray<string> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value)
      ? value.filter((site): site is string => typeof site === "string").slice(-500)
      : [];
  } catch {
    return [];
  }
};

/** "Don't ask for this site" as this browser kept it before the server kept it. */
export const localNeverAsk = () => readList(NEVER_KEY);

export function keepLocalNeverAsk(origin: string) {
  try {
    localStorage.setItem(NEVER_KEY, JSON.stringify([...new Set([...readList(NEVER_KEY), origin])]));
  } catch {
    /* Storage may be disabled in the browser. */
  }
}

export function forgetLocalNeverAsk(origin: string) {
  try {
    localStorage.setItem(
      NEVER_KEY,
      JSON.stringify(readList(NEVER_KEY).filter((site) => site !== origin)),
    );
  } catch {
    /* Storage may be disabled in the browser. */
  }
}

/** This browser's own choices still count on a server until they reached it. */
export const unsentNeverAsk = (environmentId: EnvironmentId) =>
  readList(UPLOADED_KEY).includes(environmentId) ? [] : readList(NEVER_KEY);

/**
 * This browser's list goes to a server that keeps it, once per server; afterwards only the
 * server's copy is read, so a site asked again elsewhere is asked again here.
 */
export async function uploadLocalNeverAsk(
  environmentId: EnvironmentId,
  send: (origins: ReadonlyArray<string>) => Promise<boolean>,
) {
  const sites = readList(NEVER_KEY);
  const uploaded = readList(UPLOADED_KEY);
  if (sites.length === 0 || uploaded.includes(environmentId)) return;
  if (!(await send(sites))) return;
  try {
    localStorage.setItem(UPLOADED_KEY, JSON.stringify([...uploaded, environmentId]));
  } catch {
    /* Storage may be disabled; the upload repeats, which changes nothing. */
  }
}
