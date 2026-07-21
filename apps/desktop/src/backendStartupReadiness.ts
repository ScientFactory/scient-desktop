import { isBackendReadinessAborted } from "./backendReadiness";

export interface WaitForBackendStartupReadyOptions {
  readonly listeningPromise?: Promise<void> | null;
  readonly waitForHttpReady: () => Promise<void>;
  readonly onHttpReady?: () => void;
  readonly onHttpFailure?: (error: unknown) => void;
}

export async function waitForBackendStartupReady(
  options: WaitForBackendStartupReadyOptions,
): Promise<"listening" | "http"> {
  const httpReadyPromise = options.waitForHttpReady();
  const listeningPromise = options.listeningPromise;

  if (!listeningPromise) {
    try {
      await httpReadyPromise;
      options.onHttpReady?.();
      return "http";
    } catch (error) {
      if (!isBackendReadinessAborted(error)) options.onHttpFailure?.(error);
      throw error;
    }
  }

  return await new Promise<"listening" | "http">((resolve, reject) => {
    let settled = false;

    const settleResolve = (source: "listening" | "http") => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(source);
    };

    const settleReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    listeningPromise.then(
      () => settleResolve("listening"),
      (error) => settleReject(error),
    );
    httpReadyPromise.then(
      () => {
        options.onHttpReady?.();
        settleResolve("http");
      },
      (error) => {
        if (!isBackendReadinessAborted(error)) options.onHttpFailure?.(error);
        settleReject(error);
      },
    );
  });
}
