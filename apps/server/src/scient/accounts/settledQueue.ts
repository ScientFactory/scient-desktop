/**
 * Runs each job only after every earlier one has settled, success or failure. A caller that gives
 * up waiting (a time limit) doesn't let the next job start early: the queue waits for the job
 * itself, so read-modify-write jobs on one store never overlap.
 */
export const makeSettledQueue = () => {
  let last: Promise<unknown> = Promise.resolve();
  return <A>(job: () => Promise<A>): Promise<A> => {
    const next = last.then(job, job);
    last = next.catch(() => undefined);
    return next;
  };
};
