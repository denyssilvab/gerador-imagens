require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function sbForRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    auth: { persistSession: false },
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb     = sbForRequest(req);
  const action = req.query.action;

  // Resolve authenticated user_id from the JWT
  async function getUserId() {
    const { data } = await sb.auth.getUser();
    return data?.user?.id || null;
  }

  try {
    // ── Images ───────────────────────────────────────────────────────────────

    if (action === 'save-image') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { key, dataUrl, filename, pageNum, title, docType, originalUrl } = req.body;

      let storagePath = null;
      let publicUrl   = dataUrl;

      if (dataUrl?.startsWith('data:')) {
        const base64 = dataUrl.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');
        const mime   = dataUrl.split(';')[0].split(':')[1];
        const ext    = mime === 'image/jpeg' ? 'jpg' : 'png';
        const path   = `${userId}/${key.replace(/[^a-z0-9_-]/gi, '_')}_${Date.now()}.${ext}`;

        const { data: upData, error: upErr } = await sb.storage
          .from('images')
          .upload(path, buffer, { contentType: mime, upsert: true });

        if (!upErr) {
          storagePath = upData.path;
          const { data: urlData } = sb.storage.from('images').getPublicUrl(upData.path);
          publicUrl = urlData.publicUrl;
        }
      }

      const { data, error } = await sb
        .from('images')
        .upsert({
          key,
          user_id:      userId,
          storage_path: storagePath,
          url:          publicUrl,
          filename,
          page_num:     pageNum,
          title,
          doc_type:     docType,
          original_url: originalUrl || null,
        }, { onConflict: 'key' })
        .select()
        .single();

      if (error) throw error;
      return res.json({ ok: true, id: data.id, url: publicUrl });
    }

    if (action === 'load-images') {
      const userId = await getUserId();
      if (!userId) return res.json({ ok: true, images: [] });

      const { data, error } = await sb
        .from('images')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return res.json({ ok: true, images: data });
    }

    if (action === 'delete-image') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { key } = req.body;
      const { data: row } = await sb.from('images').select('storage_path').eq('key', key).eq('user_id', userId).single();
      if (row?.storage_path) await sb.storage.from('images').remove([row.storage_path]);
      const { error } = await sb.from('images').delete().eq('key', key).eq('user_id', userId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (action === 'clear-images') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { data: rows } = await sb.from('images').select('storage_path').eq('user_id', userId);
      const paths = (rows || []).map(r => r.storage_path).filter(Boolean);
      if (paths.length) await sb.storage.from('images').remove(paths);
      const { error } = await sb.from('images').delete().eq('user_id', userId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ── Contents ─────────────────────────────────────────────────────────────

    if (action === 'save-content') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { docType, unit, lesson, lessonName, ccss, content } = req.body;
      const { data, error } = await sb
        .from('contents')
        .insert({ user_id: userId, doc_type: docType, unit, lesson, lesson_name: lessonName, ccss, content })
        .select()
        .single();
      if (error) throw error;
      return res.json({ ok: true, id: data.id });
    }

    if (action === 'load-contents') {
      const userId = await getUserId();
      if (!userId) return res.json({ ok: true, contents: [] });

      const { data, error } = await sb
        .from('contents')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return res.json({ ok: true, contents: data });
    }

    // ── API Keys ──────────────────────────────────────────────────────────────

    if (action === 'load-api-keys') {
      const userId = await getUserId();
      if (!userId) return res.json({ ok: true, keys: [] });
      const { data, error } = await sb.from('api_keys').select('*').eq('user_id', userId).order('created_at');
      if (error) throw error;
      return res.json({ ok: true, keys: data });
    }

    if (action === 'save-api-key') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });
      const { keyId, name, provider, keyValue } = req.body;
      const { data, error } = await sb.from('api_keys')
        .upsert({ user_id: userId, key_id: keyId, name, provider, key_value: keyValue }, { onConflict: 'user_id,key_id' })
        .select().single();
      if (error) throw error;
      return res.json({ ok: true, id: data.id });
    }

    if (action === 'delete-api-key') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });
      const { keyId } = req.body;
      const { error } = await sb.from('api_keys').delete().eq('user_id', userId).eq('key_id', keyId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('[db]', e);
    return res.status(500).json({ error: e.message });
  }
};
