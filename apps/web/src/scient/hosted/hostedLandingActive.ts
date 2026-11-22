import { useEnvironments } from "~/state/environments";

/**
 * Whether the hosted home shows the landing instead of the app: on `/` of the hosted app (or a
 * desktop window with its own computer off) until one of the person's computers is open.
 */
export function useHostedLandingActive(hostedStatic: boolean, pathname: string): boolean {
  const { isReady, environments } = useEnvironments();
  if (!hostedStatic || pathname !== "/") return false;
  return !isReady || !environments.some(({ connection }) => connection.phase === "connected");
}
