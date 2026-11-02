-- Original camera bytes live with the capture; these columns index its manifest
-- and the default non-destructive presenter appearance.
ALTER TABLE video_captures ADD COLUMN camera_json TEXT;
ALTER TABLE video_captures ADD COLUMN avatar_json TEXT;
