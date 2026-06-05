-- ── Supabase Storage — bucket + RLS policies ─────────────────────────────────
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- 1. Ensure the bucket exists and is public (public read = public URLs work)
INSERT INTO storage.buckets (id, name, public)
VALUES ('images', 'images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 2. Authenticated users can upload to their own folder (path starts with uid)
CREATE POLICY "auth_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 3. Authenticated users can read their own files
CREATE POLICY "auth_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 4. Public anonymous read so generated public URLs work in the browser
CREATE POLICY "public_read" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'images');

-- 5. Authenticated users can update their own files (upsert support)
CREATE POLICY "auth_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING  ((storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (
    bucket_id = 'images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 6. Authenticated users can delete their own files
CREATE POLICY "auth_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
