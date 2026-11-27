"""Close a launcher-owned Python service if its parent disappears."""

import os
import sys
from threading import Thread


def watch_launcher():
    if not os.environ.get("NEIGHBORLENS_AI_INSTANCE"):
        return
    parent_pipe = sys.stdin.fileno()

    def wait_for_exit():
        # Windows can close the Node console process before its signal handler runs.
        # The private stdin pipe closes in either case, including through the venv shim.
        try:
            os.read(parent_pipe, 1)
        except OSError:
            return
        os._exit(0)

    Thread(target=wait_for_exit, daemon=True).start()
