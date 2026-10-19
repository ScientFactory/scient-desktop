import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

/**
 * A failed response stays visible on the request it belongs to, so the
 * composer can explain the failure without a global thread error. Upstream
 * reads request state straight off the projection; this layers a local
 * shadow on top.
 */
export function useRequestResponseErrors(input: {
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: ThreadId | null;
}) {
  const { environmentId, activeThreadId } = input;
  const [requestResponseErrors, setRequestResponseErrors] = useState<Record<string, string>>({});
  const setRequestResponseError = (requestId: RuntimeRequestId, message: string) => {
    const key = JSON.stringify([environmentId, activeThreadId, requestId]);
    setRequestResponseErrors((errors) => ({ ...errors, [key]: message }));
  };
  /** The requests with their failed-response message; the same array when none failed. */
  const withResponseErrors = <T extends { readonly requestId: RuntimeRequestId }>(
    requests: T[],
  ): Array<T & { readonly responseError?: string }> => {
    const errorFor = (request: T) =>
      requestResponseErrors[JSON.stringify([environmentId, activeThreadId, request.requestId])];
    if (!requests.some((request) => errorFor(request) !== undefined)) return requests;
    return requests.map((request) => {
      const responseError = errorFor(request);
      return responseError ? { ...request, responseError } : request;
    });
  };
  return { setRequestResponseError, withResponseErrors };
}
