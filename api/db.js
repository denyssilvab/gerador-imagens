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

  if (action === 'ping') return res.json({ ok: true, version: 'v4-folders', ts: Date.now(), method: req.method, bodyType: typeof req.body, bodyKeys: Object.keys(req.body || {}) });

  // Quick action echo outside try (diagnostic)
  if (action === 'echo') return res.json({ action, method: req.method, body: req.body, headers: { ct: req.headers['content-type'], auth: req.headers.authorization ? 'present' : 'absent' } });

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

      const { key, dataUrl, filename, pageNum, title, docType, originalUrl, folderId } = req.body;

      let storagePath = null;
      let publicUrl   = dataUrl;

      if (dataUrl?.startsWith('data:')) {
        const base64 = dataUrl.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');
        const mime   = dataUrl.split(';')[0].split(':')[1];
        const ext    = mime === 'image/jpeg' ? 'jpg' : mime === 'application/pdf' ? 'pdf' : 'png';
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
          folder_id:    folderId    || null,
          // hidden_from_history intentionally omitted:
          // – on INSERT the column DEFAULT (false) applies → image is visible
          // – on UPDATE (upsert conflict) the existing value is preserved →
          //   a user-hidden image never gets accidentally un-hidden by a re-save
        }, { onConflict: 'key' })
        .select()
        .single();

      if (error) throw error;
      return res.json({ ok: true, id: data.id, url: publicUrl });
    }

    if (action === 'create-upload-url') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });
      const rawName  = req.query.filename || 'image.png';
      const safeName = rawName.replace(/[^a-z0-9_.-]/gi, '_');
      const path     = `${userId}/${safeName}_${Date.now()}`;
      const { data, error } = await sb.storage.from('images').createSignedUploadUrl(path);
      if (error) throw error;
      const { data: pubData } = sb.storage.from('images').getPublicUrl(path);
      return res.json({ ok: true, signedUrl: data.signedUrl, token: data.token, path, publicUrl: pubData.publicUrl });
    }

    if (action === 'load-images') {
      const userId = await getUserId();
      if (!userId) return res.json({ ok: true, images: [], hasMore: false });

      const page  = Math.max(0, parseInt(req.query.page  || '0'));
      const limit = Math.max(0, parseInt(req.query.limit || '0')); // 0 = all

      let query = sb
        .from('images')
        .select('id, key, url, filename, page_num, title, custom_title, doc_type, folder_id, created_at')
        .eq('user_id', userId)
        .eq('hidden_from_history', false)  // never return images hidden by the user
        .order('created_at', { ascending: false }); // newest first — first page always has the latest images

      if (limit > 0) query = query.range(page * limit, page * limit + limit - 1);

      const { data, error } = await query;
      if (error) throw error;
      return res.json({ ok: true, images: data, hasMore: limit > 0 && data.length === limit });
    }

    if (action === 'hide-from-history') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });
      const { keys } = req.body;
      if (!Array.isArray(keys) || !keys.length) return res.json({ ok: true });

      // Keys arrive in two formats:
      //   • plain string  → match images.key  column  (e.g. "img_0_p1_1234567")
      //   • "id:N"        → match images.id   column  (e.g. "id:42")
      const strKeys = keys.filter(k => !String(k).startsWith('id:'));
      const numIds  = keys
        .filter(k => String(k).startsWith('id:'))
        .map(k => parseInt(k.slice(3)))
        .filter(n => Number.isFinite(n) && n > 0);

      if (strKeys.length) {
        const { error } = await sb.from('images')
          .update({ hidden_from_history: true })
          .eq('user_id', userId)
          .in('key', strKeys);
        if (error) throw error;
      }
      if (numIds.length) {
        const { error } = await sb.from('images')
          .update({ hidden_from_history: true })
          .eq('user_id', userId)
          .in('id', numIds);
        if (error) throw error;
      }
      return res.json({ ok: true });
    }

    if (action === 'delete-image') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { key, id } = req.body;
      // Support deletion by numeric id (from db_N keys) or original key string
      const { data: row } = id
        ? await sb.from('images').select('storage_path').eq('id', id).eq('user_id', userId).single()
        : await sb.from('images').select('storage_path').eq('key', key).eq('user_id', userId).single();
      if (row?.storage_path) await sb.storage.from('images').remove([row.storage_path]);
      const { error } = id
        ? await sb.from('images').delete().eq('id', id).eq('user_id', userId)
        : await sb.from('images').delete().eq('key', key).eq('user_id', userId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (action === 'bulk-delete-images') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { keys = [], ids = [] } = req.body;

      // Collect storage paths before deleting
      const strKeys = keys.filter(Boolean);
      const numIds  = ids.map(Number).filter(n => Number.isFinite(n) && n > 0);

      const paths = [];
      if (strKeys.length) {
        const { data: rows } = await sb.from('images').select('storage_path').eq('user_id', userId).in('key', strKeys);
        (rows || []).forEach(r => r.storage_path && paths.push(r.storage_path));
      }
      if (numIds.length) {
        const { data: rows } = await sb.from('images').select('storage_path').eq('user_id', userId).in('id', numIds);
        (rows || []).forEach(r => r.storage_path && paths.push(r.storage_path));
      }

      if (paths.length) await sb.storage.from('images').remove(paths);

      if (strKeys.length) {
        const { error } = await sb.from('images').delete().eq('user_id', userId).in('key', strKeys);
        if (error) throw error;
      }
      if (numIds.length) {
        const { error } = await sb.from('images').delete().eq('user_id', userId).in('id', numIds);
        if (error) throw error;
      }

      return res.json({ ok: true, deleted: strKeys.length + numIds.length });
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

    // ── Folders ───────────────────────────────────────────────────────────────

    if (action === 'load-folders') {
      const userId = await getUserId();
      if (!userId) return res.json({ ok: true, folders: [] });
      const { data, error } = await sb.from('folders').select('*').eq('user_id', userId).order('created_at');
      if (error) throw error;
      return res.json({ ok: true, folders: data });
    }

    if (action === 'create-folder') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });
      const { name, parentId } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
      const { data, error } = await sb.from('folders')
        .insert({ user_id: userId, name: name.trim(), parent_id: parentId || null })
        .select().single();
      if (error) throw error;
      return res.json({ ok: true, folder: data });
    }

    if (action === 'rename-folder') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });
      const { folderId, name } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
      const { error } = await sb.from('folders').update({ name: name.trim() }).eq('id', folderId).eq('user_id', userId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (action === 'delete-folder') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });
      const { folderId } = req.body;
      const { error } = await sb.from('folders').delete().eq('id', folderId).eq('user_id', userId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (action === 'rename-image') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });
      const { key, id, title } = req.body;
      const { error } = id
        ? await sb.from('images').update({ custom_title: title, title }).eq('id', id).eq('user_id', userId)
        : await sb.from('images').update({ custom_title: title, title }).eq('key', key).eq('user_id', userId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (action === 'duplicate-image') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });
      const { key } = req.body;
      const { data: orig } = await sb.from('images').select('*').eq('key', key).eq('user_id', userId).single();
      if (!orig) return res.status(404).json({ error: 'Imagem não encontrada' });
      const newKey = `${key}_copy_${Date.now()}`;
      const { data, error } = await sb.from('images').insert({
        user_id:      userId,
        key:          newKey,
        url:          orig.url,
        storage_path: orig.storage_path,
        filename:     orig.filename?.replace(/(\.\w+)$/, '_cópia$1') || orig.filename,
        page_num:     orig.page_num,
        title:        orig.title ? `${orig.title} (cópia)` : null,
        custom_title: orig.custom_title ? `${orig.custom_title} (cópia)` : null,
        doc_type:     orig.doc_type,
        folder_id:    orig.folder_id,
        original_url: orig.original_url,
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, image: data });
    }

    if (action === 'assign-folder') {
      const userId = await getUserId();
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });
      const { key, id, folderId } = req.body;
      const { error } = id
        ? await sb.from('images').update({ folder_id: folderId || null }).eq('id', id).eq('user_id', userId)
        : await sb.from('images').update({ folder_id: folderId || null }).eq('key', key).eq('user_id', userId);
      if (error) throw error;
      return res.json({ ok: true });
    }

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
