import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ started: [] as string[], stopped: [] as string[] }));
const primary = vi.hoisted(() => ({ atom: undefined as unknown, ids: undefined as unknown }));
vi.mock("~/state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  primary.atom = Atom.make<string | null>(null);
  return { primaryEnvironmentIdAtom: primary.atom };
});
vi.mock("~/state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  primary.ids = Atom.make<ReadonlyArray<string>>([]);
  return { environmentSummaries: { environmentIdsAtom: primary.ids } };
});
const watcher = (name: string) => (_registry: unknown, environmentId: string) => {
  state.started.push(`${name}:${environmentId}`);
  return () => state.stopped.push(`${name}:${environmentId}`);
};
vi.mock("./accountAutofill", () => ({ watchAccountAutofill: watcher("autofill") }));
vi.mock("./googleSessions", () => ({ watchGoogleSessions: watcher("google") }));
vi.mock("./keepSignedIn", () => ({ watchKeepSignedIn: watcher("keep") }));
vi.mock("./mainFill", () => ({ watchMainFill: watcher("main") }));
vi.mock("./signInKeeps", () => ({ watchSignInKeeps: watcher("typed") }));
vi.mock("./remoteSessions", () => ({ watchRemoteSessions: watcher("deliver") }));
vi.mock("./qualifyRemoteSessions", () => ({ offerRemoteQualification: () => undefined }));

const { startAccountWatchers } = await import("./accountWatchers");

it("reads only the desktop's own jars: nothing starts for another computer", () => {
  const registry = AtomRegistry.make();
  const primaryAtom = primary.atom as Atom.Writable<string | null>;
  const stop = startAccountWatchers(registry);
  expect(state.started).toEqual([]);

  registry.set(primaryAtom, EnvironmentId.make("desktop"));
  registry.set(primary.ids as Atom.Writable<ReadonlyArray<string>>, ["desktop", "lab-server"]);
  expect(state.started).toEqual([
    "autofill:desktop",
    "google:desktop",
    "keep:desktop",
    "main:desktop",
    "typed:desktop",
    "typed:lab-server",
    "deliver:lab-server",
  ]);
  // That computer gets typing for its own sign-ins and this desktop's sign-ins; no watcher reads a
  // jar named after it.
  expect(state.started.filter((started) => started.endsWith(":lab-server"))).toEqual([
    "typed:lab-server",
    "deliver:lab-server",
  ]);

  stop();
  expect([...state.stopped].sort()).toEqual([...state.started].sort());
});
