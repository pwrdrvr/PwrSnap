# Recording restart: late events from a retired child

Restart in the installed 1.1.0 build failed after its second countdown with
`recorder exited before start ack (code=0)`.

The September 8 log establishes the ordering: the first recorder acknowledged
stop, cancellation reset the service, the replacement entered countdown, and
then the first process exited successfully. The replacement failed when the
countdown finished and awaited its already-rejected start promise. Its later
SIGTERM was cleanup following that rejection.

`NativeRecorderService` keeps start/stop promises and the stdout buffer on the
service. The exit callback closed over the old session ID, but its first branch
rejected `this.startReject` without checking that ID. Restart had already
replaced the field. Stdout callbacks had the same ownership problem: a delayed
started/error event or partial JSON line could affect the new session.

Every native child callback that changes service state now checks its captured
session ID before touching shared fields. Stderr and exit logs carry the session
ID so overlapping process lifetimes are distinguishable. Cancellation still
uses its bounded stop grace; correctness does not depend on waiting for exit.

The regression tests hold the old child's exit until after the replacement
spawns, inject delayed exit/started/error/partial stdout events, and require the
replacement to wait for its own acknowledgement and reach recording. The old
exit test failed with the same error as the installed-app log before the fix.

The failure HUD also used `renderer:revealLogFile`, a Finder/Explorer action,
instead of the existing `logs:openWindow` viewer command. It now says **Open
Logs** and invokes the viewer. Renderer tests pin that action and require both
command errors and transport rejections to leave recovery controls usable.
The provided log does not establish why the former Finder action appeared to
do nothing. The separate native fallback for a crashed HUD retains its
process-local file reveal, which does not depend on a working renderer.
