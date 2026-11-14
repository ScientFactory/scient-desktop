/**
 * A share made for a thread is created after that thread. An older one was copied into a fork
 * from the thread it was made for, and must not open the fork.
 */
export const isOwnGuestShare = (input: {
  readonly threadCreatedAtMs: number;
  readonly shareCreatedAt: string;
}): boolean => Date.parse(input.shareCreatedAt) >= input.threadCreatedAtMs;
