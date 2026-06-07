-- 0024_chat_threads_backend_config — per-thread chat backend config.
--
-- Chat moved from "one backend per surface" to "each thread picks its own
-- Provider / Model / Reasoning at New-Chat time, locked on the first message".
-- We persist that choice on the thread so (a) the surface routes each thread to
-- the right backend across relaunch, and (b) the locked chips can render the
-- thread's actual config.
--
-- All three are nullable: a NULL means "fall back to the surface's Settings
-- default" (older threads created before this migration, and the transitional
-- period before the chip UI lands). `provider` is the BACKEND selector
-- ("codex" / "acp:<id>"); for ACP threads it's also derivable from the
-- thread id (acp:<id>:<uuid>), but storing it covers Codex threads uniformly.
-- `reasoning` is the effort/mode token ("low"/"medium"/"high"); NULL = default.

ALTER TABLE chat_threads ADD COLUMN provider TEXT;
ALTER TABLE chat_threads ADD COLUMN model TEXT;
ALTER TABLE chat_threads ADD COLUMN reasoning TEXT;
