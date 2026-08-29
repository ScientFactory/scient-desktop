/**
 * Temporary product compatibility gates for upstream capabilities that are
 * not yet supported by every Scient client. Keep enforcement at both the
 * advertised capability and command boundary; remove this gate only after
 * desktop, web, and mobile can all preserve and send generic files safely.
 */
export const SCIENT_GENERIC_FILE_ATTACHMENTS_ENABLED = false;
