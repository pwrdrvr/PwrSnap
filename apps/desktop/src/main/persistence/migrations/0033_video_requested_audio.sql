-- Record what the user ASKED for, alongside what the recorder produced.
--
-- `has_system_audio` / `has_microphone_audio` (migration 0005) are
-- written from the recorder's own sample counters — they mean "a track
-- with samples in it landed in the file". That is the right input for
-- the exporter, but it cannot answer the question the post-capture
-- receipt needs to answer: was this source REQUESTED and silent, or
-- simply not requested? Both cases store 0.
--
-- Those two states need opposite UI. "Not requested" is unremarkable.
-- "Requested and silent" is the failure the whole pre-flight design
-- exists to prevent: a muted input, a mic that was grabbed by another
-- app, a Bluetooth device that drifted away mid-take. The user needs to
-- learn it now, while the take can still be repeated cheaply.
--
-- Defaults are deliberately 0 rather than mirroring the `has_*`
-- columns. Backfilling "requested = whatever landed" would invent a
-- fact we never recorded and would mark every historical recording as
-- having requested exactly what it got, permanently hiding any past
-- silent take. 0 means "unknown for this row", which the renderer reads
-- as "nothing to flag" — the same thing it showed before this column
-- existed.
ALTER TABLE video_captures
  ADD COLUMN requested_system_audio INTEGER NOT NULL DEFAULT 0
  CHECK (requested_system_audio IN (0, 1));

ALTER TABLE video_captures
  ADD COLUMN requested_microphone INTEGER NOT NULL DEFAULT 0
  CHECK (requested_microphone IN (0, 1));
