/**
 * The clock the chat's scripted motion reads (the send follow and the answer
 * reveal): milliseconds, like `performance.now()`. Tests substitute a
 * controlled clock so motion advances by known amounts per frame.
 */
export const motionClock = {
  now: (): number => performance.now(),
};
