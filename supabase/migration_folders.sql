CREATE TABLE IF NOT EXISTS folders (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

ALTER TABLE folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_folders"
  ON folders FOR ALL TO authenticated
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

ALTER TABLE images ADD COLUMN IF NOT EXISTS folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL;
