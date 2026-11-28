/**
 * Round 6f: each jar's writes take turns, so an operation's check and its write never interleave
 * with another write there. Keyed by the Electron session; no imports, so any writer can use it.
 */
const jarTurns = new WeakMap<object, Promise<unknown>>();
export const inJarTurn = <A>(jars: ReadonlyArray<object>, run: () => Promise<A>): Promise<A> => {
  const before = Promise.all(
    jars.map((jar) => (jarTurns.get(jar) ?? Promise.resolve()).catch(() => undefined)),
  );
  const turn = before.then(run);
  for (const jar of jars)
    jarTurns.set(
      jar,
      turn.catch(() => undefined),
    );
  return turn;
};
/**
 * The jar's turn, held until `release` (round 6h): for a write whose check, reads and write span
 * calls of their own, such as a refresh's import.
 */
export const enterJarTurn = (jars: ReadonlyArray<object>) =>
  new Promise<() => void>((entered) => {
    void inJarTurn(jars, () => new Promise<void>((release) => entered(() => release())));
  });
