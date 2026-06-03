-- ── Add user_id to existing tables ───────────────────────────────────────────
ALTER TABLE images   ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE contents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- ── Drop the open anon policies ───────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_all_images"   ON images;
DROP POLICY IF EXISTS "anon_all_contents" ON contents;

-- ── Authenticated-user-only policies ─────────────────────────────────────────
CREATE POLICY "user_images"
  ON images FOR ALL TO authenticated
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_contents"
  ON contents FOR ALL TO authenticated
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
