export const config = { runtime: 'edge' };

const MODELS = {
  'topaz:Standard V2':        { slug: 'topazlabs/image-upscale', model_name: 'Standard V2' },
  'topaz:Low Resolution V2':  { slug: 'topazlabs/image-upscale', model_name: 'Low Resolution V2' },
  'topaz:CGI':                { slug: 'topazlabs/image-upscale', model_name: 'CGI' },
  'topaz:High Fidelity V2':   { slug: 'topazlabs/image-upscale', model_name: 'High Fidelity V2' },
  'topaz:Text Refine':        { slug: 'topazlabs/image-upscale', model_name: 'Text Refine' },
  'google/upscaler':                     { slug: 'google/upscaler',                     scaleParam: 'upscale_factor' },
  'nightmareai/real-esrgan':             { slug: 'nightmareai/real-esrgan',             scaleParam: 'scale' },
  'philz1337x/clarity-upscaler':         { slug: 'philz1337x/clarity-upscaler',         scaleParam: 'scale_factor' },
  'recraft-ai/recraft-crisp-upscale':    { slug: 'recraft-ai/recraft-crisp-upscale',    scaleParam: null },
  'afiaka87/crystal-upscaler':           { slug: 'afiaka87/crystal-upscaler',           scaleParam: 'scale' },
  'recraft-ai/recraft-creative-upscale': { slug: 'recraft-ai/recraft-creative-upscale', scaleParam: null },
  'prunaai/image-upscale':               { slug: 'prunaai/image-upscale',               scaleParam: 'scale' },
};

// Upload a data: URL to Supabase Storage on behalf of the authenticated user.
// Uses the user's JWT (passed in Authorization header) so RLS policies are respected.
// Returns the public URL, or throws on failure.
async function uploadToSupabase(dataUrl, sbJwt) {
  const SB_URL = process.env.SUPABASE_URL || 'https://ztbvmkmfaqpfzuohvsbe.supabase.co';

  // Decode JWT payload to get user ID (no verification needed — Supabase validates it)
  const payload = JSON.parse(atob(sbJwt.split('.')[1]));
  const userId  = payload.sub;
  if (!userId) throw new Error('JWT inválido: sem user ID');

  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) throw new Error('data URL inválida');
  const mimeType = (dataUrl.slice(0, commaIdx).match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const ext      = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : 'jpg';

  const binaryStr = atob(dataUrl.slice(commaIdx + 1));
  const bytes     = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  const path = `${userId}/upscale_input_${Date.now()}.${ext}`;

  const res = await fetch(`${SB_URL}/storage/v1/object/images/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sbJwt}`,
      'Content-Type': mimeType,
      'x-upsert': 'true',
    },
    body: bytes.buffer,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.error || `Supabase upload HTTP ${res.status}`);
  }

  return `${SB_URL}/storage/v1/object/public/images/${path}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 }); }

  let { dataUrl, scale, token, upscaleModel = 'nightmareai/real-esrgan' } = body;
  if (!dataUrl || !scale || !token) {
    return new Response(JSON.stringify({ error: 'Parâmetros incompletos' }), { status: 400 });
  }

  // Local images (data: URLs) must be uploaded to Supabase Storage first to get a
  // public HTTPS URL that Replicate can fetch. Uses the user's Supabase JWT from
  // the Authorization header.
  if (dataUrl.startsWith('data:')) {
    const authHeader = req.headers.get('Authorization') || '';
    const sbJwt      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!sbJwt) {
      return new Response(
        JSON.stringify({ error: 'Faça login para fazer upscale de imagens locais.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    try {
      dataUrl = await uploadToSupabase(dataUrl, sbJwt);
    } catch (e) {
      return new Response(
        JSON.stringify({ error: `Falha ao preparar imagem: ${e.message}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  const cfg = MODELS[upscaleModel];
  if (!cfg) {
    return new Response(JSON.stringify({ error: `Modelo desconhecido: ${upscaleModel}` }), { status: 400 });
  }

  let input;
  if (cfg.model_name) {
    input = { image: dataUrl, model_name: cfg.model_name, scale };
  } else if (cfg.scaleParam) {
    input = { image: dataUrl, [cfg.scaleParam]: scale };
  } else {
    input = { image: dataUrl };
  }

  try {
    const res = await fetch(`https://api.replicate.com/v1/models/${cfg.slug}/predictions`, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return new Response(
        JSON.stringify({ error: err.detail || err.error || `Replicate HTTP ${res.status}` }),
        { status: res.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const prediction = await res.json();
    return new Response(
      JSON.stringify({ predictionId: prediction.id, status: prediction.status }),
      { headers: { 'Content-Type': 'application/json' } }
    );

  } catch (e) {
    if (e.name === 'AbortError') {
      return new Response(JSON.stringify({ error: 'Cancelado' }), { status: 499 });
    }
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
