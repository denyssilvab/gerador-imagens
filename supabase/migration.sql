-- ── Images table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS images (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,           -- app-side key (e.g. "db_1", "gen_1_0")
  storage_path TEXT,                          -- path in Supabase Storage bucket
  url         TEXT,                           -- public URL (or data URL fallback)
  filename    TEXT,
  page_num    INTEGER,
  title       TEXT,
  doc_type    TEXT,                           -- lesson | practice | lessonplan
  upscaled_url TEXT,
  original_url TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Contents table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contents (
  id          BIGSERIAL PRIMARY KEY,
  doc_type    TEXT NOT NULL,                  -- lesson | practice | lessonplan
  unit        TEXT,
  lesson      TEXT,
  lesson_name TEXT,
  ccss        TEXT,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── RLS (Row Level Security) ──────────────────────────────────────────────────
ALTER TABLE images   ENABLE ROW LEVEL SECURITY;
ALTER TABLE contents ENABLE ROW LEVEL SECURITY;

-- Allow all operations with anon key (single-user app, no auth)
CREATE POLICY "anon_all_images"   ON images   FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_contents" ON contents FOR ALL TO anon USING (true) WITH CHECK (true);
