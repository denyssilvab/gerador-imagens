-- ── Raw page content for Refazer ─────────────────────────────────────────────
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- Persists the original (pre-layout-wrapping) page text so the "Refazer"
-- modal can auto-fill it even after a page reload — today it only survives
-- in memory for the current browser session.

ALTER TABLE images ADD COLUMN IF NOT EXISTS raw_content TEXT;
