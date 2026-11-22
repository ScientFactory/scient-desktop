# Prove a connector works

Before saving, check startup, the listed schemas and their agreement with the manifest. Startup must survive a missing key; for a newly required key this is the pre-save check, and setup and real authenticated calls follow the save.

Give `scient_connector_check` calls as `{tool, arguments}`, at most ten per check. `ok: true` proves only transport and startup. Read each `isError`, result text, `missing`, error and log; a clean setup error for absent credentials is not a data read.

Test the real task, a next page with different records, an empty result and invalid input. Include the largest realistic result and a cap boundary, and verify counts, dates and time zones, non-Latin names, optional fields, stable IDs and explicit truncation. Spot-check returned fields against their source. Keep calls few and read-only, unless the user authorized a specific write on chosen data.

For sessions, test linked and unlinked reads and the observed signed-out or forbidden shapes. Use synthetic credentials and responses for expiry replay, timeouts, custom-header redirects and secret-disclosure checks. Test idempotency on synthetic responses, never by repeating a live write; a write's unknown outcome stays unknown until independently read back.

After save and setup, make one installed read with `connector`; the folder alone doesn't prove installed paths and credentials. Keep two or three task questions and their checked answers in the connector README. A fresh-agent evaluation is optional and happens only on request; claim it only after running it.

Done when the report gives saved, configured and working status separately, one inspected real result, the calls tested, remaining caps, write paths left untested, and the runtime and host actually exercised. Node portability alone doesn't qualify Windows, Linux, or Intel and Apple Silicon Macs. State any account or service blockers. Tell the user to open the connector's page in Extensions and choose **Remove** to remove it; after a repair, mention **Undo last change**.
