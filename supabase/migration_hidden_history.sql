-- ── Hidden-from-history flag ─────────────────────────────────────────────────
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- Adds a server-side flag so hidden images stay hidden even after cache clear.

ALTER TABLE images ADD COLUMN IF NOT EXISTS hidden_from_history BOOLEAN DEFAULT FALSE;

-- Index for fast filtering in load-images queries
CREATE INDEX IF NOT EXISTS idx_images_hidden ON images (user_id, hidden_from_history);
