import {
  CLOUD_ERROR_STATUS,
  CloudErrorCode,
  type CloudErrorBody,
} from "@scientfactory/scient-cloud/api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class CloudError extends Schema.TaggedError<CloudError>()("CloudError", {
  code: CloudErrorCode,
  message: Schema.String,
  movedTo: Schema.optionalKey(Schema.String),
}) {}

export const cloudError = (code: CloudErrorCode, message: string, movedTo?: string | null) =>
  new CloudError(movedTo ? { code, message, movedTo } : { code, message });

export const failWith = (code: CloudErrorCode, message: string, movedTo?: string | null) =>
  Effect.fail(cloudError(code, message, movedTo));

export const errorStatus = (error: CloudError) => CLOUD_ERROR_STATUS[error.code];

export const errorBody = (error: CloudError): CloudErrorBody =>
  error.movedTo === undefined
    ? { error: error.code, message: error.message }
    : {
        error: error.code,
        message: error.message,
        movedTo: error.movedTo as NonNullable<CloudErrorBody["movedTo"]>,
      };
