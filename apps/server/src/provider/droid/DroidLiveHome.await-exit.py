"""Test-only: returns once every given process has exited. macOS kqueue, Linux pidfd.

The processes are not this observer's children, so it can't wait on them; the kernel
still reports their exit. A process already gone when it is registered counts as exited.
"""

import os
import select
import sys


def wait_for_exits(pids):
    if sys.platform == "darwin":
        queue = select.kqueue()
        pending = set()
        for pid in pids:
            try:
                queue.control(
                    [
                        select.kevent(
                            pid,
                            filter=select.KQ_FILTER_PROC,
                            flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                            fflags=select.KQ_NOTE_EXIT,
                        )
                    ],
                    0,
                    0,
                )
                pending.add(pid)
            except ProcessLookupError:
                pass
        while pending:
            for event in queue.control(None, len(pending), None):
                pending.discard(event.ident)
    elif sys.platform.startswith("linux"):
        descriptors = {}
        for pid in pids:
            try:
                descriptors[os.pidfd_open(pid)] = pid
            except ProcessLookupError:
                pass
        poller = select.poll()
        for descriptor in descriptors:
            # POLLIN is exit (still a zombie); the process no longer runs either way.
            poller.register(descriptor, select.POLLIN | select.POLLHUP)
        while descriptors:
            for descriptor, _ in poller.poll():
                poller.unregister(descriptor)
                os.close(descriptor)
                descriptors.pop(descriptor)
    else:
        raise RuntimeError(f"No process exit notification on {sys.platform}")


if __name__ == "__main__":
    wait_for_exits([int(argument) for argument in sys.argv[1:]])
