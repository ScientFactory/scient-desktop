# Windows file layer — group C

Branch: `claude/overleaf-xplatwin-20261026`, based on Foundation `e223a52980`.
Code head: `d58fc791296f594b96911b2af3c1e72b55489fd9`.
Worktree: `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-desktop-xplatwin-20261026`.

The Windows file layer is implemented and pushed. Focused native qualification passes on GitHub Windows, and the shared coordinator, sync and crash suites have passed at the revisions below. This is implementation evidence, not installed-application or combined-build release qualification. Shared cloud-root selection remains an integration dependency owned by the Linux builder.

## What is implemented

- Shared/exclusive `LockFileEx` leases on private lock files named with the normalized volume GUID and complete 128-bit folder ID. Lock-state ancestors are pinned without traversing reparse points. Native transactions retire before their leases release.
- Replacement opens A with read/delete/permission access and sharing only read. S receives A's owner, group, DACL and attribute flags before content is written. A's descriptor is saved privately and journaled before A is restricted through its handle, then moved without replacement into retained storage. S is installed by handle without replacement. Create inherits its destination folder's security; delete captures the original object. Empty-directory pruning also uses held handles.
- Separate `windows-move-install`, `windows-stage-create` and `windows-capture` records live beside the existing record definitions. Recovery checks object IDs and planned content revisions, restores A's journaled descriptor when A was never moved, and preserves foreign/unknown outcomes. Capturing A alone requires settlement; it does not prove successful publication. `WorkspaceApplier` recognizes these records. macOS journal schemas are unchanged.
- New private directories and lock/security/payload files receive protected current-user plus SYSTEM DACLs at birth. Existing private folders are validated on each reuse and refused without repair. A is restricted before its namespace changes. Replacement preserves explicit permissions and automatic-inheritance flags.
- Admission requires Windows build 17763 or later and NTFS on a local fixed/removable disk. Volume qualification precedes file-ID queries, so FAT32 gives the specific filesystem refusal. Persistent identity uses mount-manager-normalized volume GUIDs and all 128 bits of `FILE_ID_INFO`. UNC admission is classified before network I/O; mapped/network and unsupported volumes refuse.
- Cloud Files checks reject registered sync roots and descendants for actual private state/kept-copy locations. A cold-volume `ERROR_INVALID_FUNCTION` activates Cloud Files using an empty, private, temporary sync-root registration, unregisters it, and re-queries the actual folder. Unknown query or cleanup results refuse. The temporary directory is created relative to the held folder, denies delete sharing, and is delete-on-close; its process-death cleanup is tested. Production requires no privileged filter enumeration.
- Online-only checks batch directory enumeration and recognize OFFLINE, RECALL_ON_OPEN and RECALL_ON_DATA_ACCESS. RECALL_ON_OPEN is interpreted only from enumeration; the same bit on a handle/root attribute query means EA. Availability checks precede mutation-layer payload/peer reads.
- DF-044 removals open the single child relative to its pinned parent with reparse traversal disabled and delete through that handle. Extended disposition supports read-only retained files and deletes a junction itself rather than its target.
- ADS, EFS and multiple hard links have specific refusal reasons. Foreign-owned objects and null DACLs also refuse: preserving another owner's object while making retained storage private requires a separate owner/privilege design.

## Commits

All commits carry the required co-author trailer. Integrate the complete range after Foundation; diagnostic commits remain in history, while their superseded production mechanisms are removed by later fixes.

| Commit       | Change                                                                               |
| ------------ | ------------------------------------------------------------------------------------ |
| `25ef3ce829` | Windows capture/install mechanism, identity, leases and journal adapter.             |
| `195e9dc0a9` | Windows retention qualification and private state creation.                          |
| `a73060ccd3` | Windows process-death and competing-writer tests.                                    |
| `560f6354e3` | Structured refusal propagation and recovery evidence.                                |
| `65b4e32e59` | Batched placeholder metadata and native diagnostics.                                 |
| `a43b94b069` | Initial cold Cloud Files handling; superseded by `ee68d45850`.                       |
| `03ef2183e1` | Native retirement and separate Windows capability.                                   |
| `b8c6248d7f` | Pin directory names while permitting journal-child writes.                           |
| `a9cde10273` | Folder capture/prune recovery and extended paths.                                    |
| `c3ee8f3442` | User-owned Windows fixtures and native failure evidence.                             |
| `636d26d68e` | Native relative no-replace rename and descriptor restoration.                        |
| `05a00871b1` | Stage security before payload writes; explicit create owner.                         |
| `404233d9b0` | Kill the actual lease process and adapt shared recovery fixtures.                    |
| `f95c16b62d` | Preserve automatic-inheritance flags in the recorded DACL.                           |
| `4a0444d161` | Await journal settlement before release; pin lock ancestors; typed admission errors. |
| `f0203763ce` | Encryption, attribute, lock containment and read-only removal tests.                 |
| `2b75e1dd9c` | Second-account privacy probes request only read access.                              |
| `97adb6ff45` | Availability check before rename payload reads.                                      |
| `679258a4a2` | Unpublished-create fence; restore policy despite foreign kept-name collision.        |
| `3271f11371` | Classify UNC admission before native I/O.                                            |
| `e3789a909b` | Validate existing private directories in one fresh native query.                     |
| `cb1adb3f6b` | Structural recovery from durable object evidence; blocked-path handling.             |
| `0a79b7667c` | Publication-boundary crash hooks and portable crash payload/path fixtures.           |
| `74fc357879` | Native parent change-time fence for create recovery; fresh content timestamps.       |
| `c486854907` | Writable mapping after handle closure and timestamp regression tests.                |
| `32dc43c844` | Interpret recall-on-open only from directory enumeration.                            |
| `6cdf31b93a` | Ordinary-account Cloud Files qualification probe.                                    |
| `314b2ccedc` | Expose unprivileged query diagnostics.                                               |
| `6e8462cf9c` | Qualify volumes before IDs; real FAT32 virtual-disk refusal.                         |
| `d0980aab90` | Probe alternate filter enumeration; production fallback later removed.               |
| `1cecb821c6` | Exercise a real interactive standard-user token.                                     |
| `8ee7cc5f31` | Process-death test for temporary Cloud Files registration.                           |
| `ee68d45850` | Unprivileged cold-volume activation; remove privileged enumeration fallback.         |
| `cec0c91211` | Cold NTFS test in a separate standard-user process; strict cleanup evidence.         |
| `d58fc79129` | Pass the documented volume-name form to test-only filter detachment.                 |

## Local verification

Commands ran in the designated worktree with `/tmp/claude-toolchain-20261024/env.sh` sourced and the brief's Scient/Electron environment variables unset. Final checks below passed at code head `d58fc79129`.

| Command                                                                                                                                                      | Result                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm --dir apps/server exec tsc --noEmit`                                                                                                                   | Exit 0; existing Effect suggestions remain.                                                                       |
| `pnpm --dir packages/contracts exec tsc --noEmit`                                                                                                            | Exit 0.                                                                                                           |
| `git diff --name-only e223a52980 HEAD \| rg '\.ts$' \| xargs pnpm exec vp lint`                                                                              | Exit 0; 11 existing warnings, no errors.                                                                          |
| Same touched-file list through `pnpm exec vp fmt`                                                                                                            | 26 files formatted; no resulting source changes.                                                                  |
| `node scripts/scient-seam-check.mjs --base 3941da243d --head HEAD`                                                                                           | All seven seams passed. This checks seam placement, not runtime safety.                                           |
| `pnpm exec vp run knip:check`                                                                                                                                | `2/2 successful`.                                                                                                 |
| `pnpm exec vp test run` with `PlatformFileIdentity.test.ts`, `overleafFileAvailability.test.ts`, `overleafHostPaths.test.ts`, `RetainedFileMutation.test.ts` | `4 passed`, `33 passed`.                                                                                          |
| macOS coordinator, sync and `NativeFilePublication.test.ts` focused run after shared admission/fixture changes                                               | `3 passed`, `86 passed`; 100.7 seconds. Subsequent production changes are Windows-only.                           |
| Admission error-channel mutation                                                                                                                             | Replacing the native reason with `identity-unavailable` failed the targeted test; restored implementation passed. |
| `git diff --check`                                                                                                                                           | Passed.                                                                                                           |

The focused-test command uses the full paths under `apps/server/src/scient/{workspace,overleaf}`. Local final logs are `/tmp/scient-xplatwin-handoff-{server,contracts,lint,seam,knip,focused}.log`; earlier Mac integration output is `/tmp/scient-xplatwin-final-mac-integration.log`.

## Windows verification

The test kit builds production and probe helpers with MSVC `/W4 /WX`. Account creation, token-default-owner changes, volume/filter fixtures and `TerminateProcess` commands are test-only. Synthetic account credentials travel through environment variables, never command arguments or logs.

Invocation:

```sh
gh workflow run windows-tests.yml --repo ScientFactory/scient-desktop \
  --ref claude/overleaf-xplatwin-20261026 -f package=apps/server \
  -f files='<focused files and optional -t filter>'
```

Exact `files` inputs:

- Native: `src/scient/workspace/WindowsRetainedFileMutation.test.ts src/scient/workspace/PlatformFileIdentity.test.ts src/scient/overleaf/overleafHostPaths.test.ts`.
- Coordinator: `src/scient/overleaf/OverleafCoordinator.test.ts`.
- Full sync: `src/scient/overleaf/OverleafSync.test.ts`.
- Final sync smoke: `src/scient/overleaf/OverleafSync.test.ts -t brings.a.project|syncs.both.ways`.
- Crash: `src/scient/overleaf/WorkspaceApplier.crash.test.ts -t <one filter from the list below>`.

| Run                                                                                     | Tested revision / scope                                                      | Result                                                                                                                                  |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [40356524177](https://github.com/ScientFactory/scient-desktop/actions/runs/40356524177) | `d58fc79129`; Windows native mutation, identity and host paths               | **52 passed, 1 macOS-only case skipped**, 3 files passed. Includes FAT32 VHD and cold NTFS VHD in a separate non-administrator process. |
| [40356530324](https://github.com/ScientFactory/scient-desktop/actions/runs/40356530324) | `d58fc79129`; first-import and two-way sync smoke                            | **2 passed**, 40 excluded by the explicit smoke filter; 23546 ms and 49440 ms.                                                          |
| [40340963070](https://github.com/ScientFactory/scient-desktop/actions/runs/40340963070) | `74fc357879`; complete coordinator file                                      | **36 passed**; 1102.52 seconds.                                                                                                         |
| [40337837106](https://github.com/ScientFactory/scient-desktop/actions/runs/40337837106) | `e3789a909b`; complete sync file                                             | **42 passed**; 1709.63 seconds.                                                                                                         |
| [40338585202](https://github.com/ScientFactory/scient-desktop/actions/runs/40338585202) | `cb1adb3f6b`; crash matrix at prepared                                       | **18 passed**.                                                                                                                          |
| [40338590410](https://github.com/ScientFactory/scient-desktop/actions/runs/40338590410) | `cb1adb3f6b`; crash matrix at checked                                        | **18 passed**.                                                                                                                          |
| [40340955883](https://github.com/ScientFactory/scient-desktop/actions/runs/40340955883) | `74fc357879`; crash matrix at called                                         | **18 passed**.                                                                                                                          |
| [40340944768](https://github.com/ScientFactory/scient-desktop/actions/runs/40340944768) | `74fc357879`; other crash cases matching publishes                           | **13 passed**.                                                                                                                          |
| [40340950596](https://github.com/ScientFactory/scient-desktop/actions/runs/40340950596) | `74fc357879`; remaining crash cases                                          | **47 passed**; 1359.71 seconds.                                                                                                         |
| [40350070060](https://github.com/ScientFactory/scient-desktop/actions/runs/40350070060) | `8ee7cc5f31`; actual process death during temporary Cloud Files registration | **1 passed**; also covered by the final native run.                                                                                     |
| [40346683775](https://github.com/ScientFactory/scient-desktop/actions/runs/40346683775) | `6e8462cf9c`; FAT32 virtual disk                                             | **1 passed**; also covered by the final native run.                                                                                     |

The five crash filters exhaust the **114 Windows cases** in the shared file without overlap: `killed.at.prepared`, `killed.at.checked`, `killed.at.called`, `^(?!.*killed.at.(prepared|checked|called)).*publishes`, and `^(?!.*killed.at.(prepared|checked|called))(?!.*publishes).*$`. POSIX FIFO fixture rows are inapplicable; the Windows coordinator/sync/crash suites are enabled. No per-test timeout was increased and no sleep/poll loop was added. CI must budget or partition these slow native-process suites; a combined run exceeded the workflow's 45-minute limit.

Native tests additionally cover killing the lease process at each journal boundary, especially between restricting and moving A; competing replacement/creation between capture and install; open writers and writable mapped sections; exact permission preservation; private-folder rejection without repair; shared/exclusive process leases; junction and read-only anchored removal; EFS, ADS and hard-link refusals; and foreign-object recovery. The cold NTFS test detaches CldFlt only from its own disposable VHD and requires the standard-user child to perform exactly one real bootstrap.

### Iteration evidence

Failures were corrected and rerun, rather than weakening safety assertions. Every run below belongs to this branch. The workflow URL is `https://github.com/ScientFactory/scient-desktop/actions/runs/<ID>`.

| Runs                                                                      | Result / correction                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `40319538490`, `40320002949`                                              | Failed MSVC diagnostics/initialization; corrected.                                                                                                                                                  |
| `40320447545`, `40321136030`, `40321734097`, `40322525307`                | Failed initial cold-volume handling and filter compilation; the filter fallback was ultimately removed.                                                                                             |
| `40322992202`                                                             | Failed journal rename because ancestor sharing denied child writes.                                                                                                                                 |
| `40323754971`                                                             | Canceled superseded run; retained probe child handles blocked cleanup.                                                                                                                              |
| `40325526577`, `40326576028`                                              | Failed elevated default-owner and relative rename assumptions.                                                                                                                                      |
| `40327957683`, `40328845083`, `40332816369`                               | Failed descriptor-inheritance preservation and shared fixture assumptions.                                                                                                                          |
| `40328848909`                                                             | Canceled at the 45-minute job limit; sync had 41/42 passed. Crash output exposed unpublished-create classification.                                                                                 |
| `40332821046`                                                             | Coordinator: 36 passed.                                                                                                                                                                             |
| `40333617076`                                                             | 28 passed, 1 failed; prune exposed asynchronous lease release, then fixed.                                                                                                                          |
| `40334249191`, `40334462590`, `40334892693`, `40335671460`, `40336174384` | Native/host-path iterations passed (33, 36, 36, 37 and 40 tests respectively).                                                                                                                      |
| `40334467200`, `40336201165`                                              | Sync Undo hit the existing 120-second test deadline; fresh private-directory queries reduced work. `40337831451` then passed the focused Undo case in 112197 ms; complete sync subsequently passed. |
| `40334472425`                                                             | Superseded full crash run canceled in favor of bounded partitions.                                                                                                                                  |
| `40336179625`, `40336184982`, `40336189025`, `40336195811`                | Failed shared crash fixture/capture-boundary assumptions and parent namespace recovery; fixed before the green partitions.                                                                          |
| `40337826810`, `40338580178`, `40340938173`, `40342764603`, `40344455047` | Native/identity/host-path iterations passed: 45, 47, 48, 49 and 49 tests, each with one macOS-only skip.                                                                                            |
| `40338595516`                                                             | Earlier called-boundary partition: 18 passed; repeated at `74fc357879` above.                                                                                                                       |
| `40345069869`, `40346113225`, `40348056051`, `40348252261`                | Failed ordinary-account cloud placement: both filter enumeration APIs require privileges. This evidence caused removal of that production fallback.                                                 |
| `40352478994`                                                             | New unprivileged bootstrap native run passed (51 tests, one macOS-only skip).                                                                                                                       |
| `40355009460`                                                             | 51 passed, 1 failed, 1 skipped: cold-VHD setup passed an extended path to FilterDetach. Corrected in `d58fc79129`; final native run green.                                                          |

## Plan corrections and integration boundaries

- Windows ancestor directories must share read/write while denying delete sharing. Denying write sharing blocks safe journal-child renames. A and S retain the plan's read-only sharing.
- Win32 `FileRenameInfoEx` returned error 87 on the runner. `NtSetInformationFile(FileRenameInformationEx)` relative to a held directory with flags zero provides the required no-replace rename. Windows 1809 remains the admission floor; no replacement flag is enabled.
- Restoring an automatically inherited DACL requires `SE_DACL_AUTO_INHERIT_REQ` alongside `SE_DACL_AUTO_INHERITED`. Exact SDDL and second-account access probes guard the restored semantics.
- Copy attribute flags while keeping fresh stage content timestamps. Copying A's old write time onto S risks making Git's stat cache miss changed content.
- A cold NTFS volume can return `ERROR_INVALID_FUNCTION` from the Cloud Files query. Filter enumeration cannot safely admit it for ordinary accounts. The empty private registration activates the volume, and only the subsequent authoritative query admits the actual folder. `TerminateProcess` proves temporary-root cleanup, and a standard-user process on a freshly detached NTFS VHD proves the unprivileged path.
- Elevated Windows Server fixtures default to an Administrators-group owner. The test kit changes only its own process's token default owner. Production explicitly chooses the current account as create owner and inherits the folder DACL. Existing foreign ownership refuses.
- Windows directory flush returns the existing not-applicable value only for expected unsupported/denied directory results. Other flush failures remain unknown. Files and journals are flushed; power-loss durability is not qualified.
- `publication-posix.c`, Linux identity/staged-create code, `OverleafGitExecutor.ts`, askpass and `ci.yml` were not changed. Windows Git/CI integration remains with its assigned builder.
- The Windows journal schema is beside the old decoder in `RetainedFileMutation.ts`; macOS records are untouched. Shared overlap is Windows dispatch/capability/error reasons, Windows recovery evidence in `WorkspaceApplier.ts`, and Windows private-state/vault branches. The Linux staged-create builder must merge its own record union and corresponding recovery evidence without replacing these Windows variants.
- This branch validates actual private locations and recorded folders, but does not choose an outside-provider sibling or implement shared configured-provider-root detection/relocation and its `sync-managed-folder` status surface. That placement work belongs to the Linux builder. Integration must preserve the Windows native check for every actual state/kept-copy location.
- Real OneDrive/Dropbox/Google Drive providers, physical removable NTFS, ReFS/exFAT/network mounts, Windows 10 1809 itself, installed-app helper packaging, and disposable real Overleaf acceptance sync were not exercised. FAT32 and NTFS virtual disks, registered synthetic Cloud Files roots, Windows Server standard-user execution, native process death and macOS regression suites were exercised. Final native and smoke runs do not claim that every earlier full suite was rerun at the final code head.
