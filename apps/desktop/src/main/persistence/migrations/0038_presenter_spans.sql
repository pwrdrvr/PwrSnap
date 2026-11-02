-- Stretches of a recording with their own presenter (PresenterSpan[]), in
-- source seconds. NULL: the recording's presenter shows throughout.
ALTER TABLE video_captures ADD COLUMN avatar_spans_json TEXT;
