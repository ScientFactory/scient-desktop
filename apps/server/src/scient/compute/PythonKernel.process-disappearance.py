"""Test-only passive process-reaping observer, armed before kernel termination."""

import os
import select
import sys
from contextlib import closing


def observe(pid):
    if sys.platform == "darwin":
        # Python omits Darwin's NOTE_REAP constant. NOTE_EXIT alone still leaves
        # a zombie visible to kill(pid, 0); attach while the process is alive.
        note_reap = 0x10000000
        with closing(select.kqueue()) as queue:
            event = select.kevent(
                pid,
                filter=select.KQ_FILTER_PROC,
                flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                fflags=note_reap,
            )
            queue.control([event], 0, 0)
            print("ready", flush=True)
            events = queue.control(None, 1, None)
            if len(events) != 1 or not events[0].fflags & note_reap:
                raise RuntimeError("Missing process reaping event")
    elif sys.platform == "linux":
        descriptor = os.pidfd_open(pid)
        try:
            queue = select.poll()
            # POLLIN means zombie, not gone. Only the reap hangup is decisive.
            queue.register(descriptor, select.POLLHUP)
            print("ready", flush=True)
            events = queue.poll()
            if not any(flags & select.POLLHUP for _, flags in events):
                raise RuntimeError("Missing process reaping hangup")
        finally:
            os.close(descriptor)
    elif sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            error = ctypes.get_last_error()
            if error == 87:  # ERROR_INVALID_PARAMETER, as in libuv's kill0 probe
                raise ProcessLookupError(pid)
            raise ctypes.WinError(error)
        try:
            print("ready", flush=True)
            if kernel.WaitForSingleObject(handle, 0xFFFFFFFF) != 0:  # INFINITE
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            kernel.CloseHandle(handle)
    else:
        raise RuntimeError("No native disappearance observer for this platform")


if __name__ == "__main__":
    pid = int(sys.argv[1])
    if pid <= 0:
        raise ValueError("Expected a positive process ID")
    try:
        observe(pid)
    except ProcessLookupError:
        # The TypeScript caller still requires its original kill0 predicate.
        print("gone", flush=True)
