export const config = { runtime: 'edge' };

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    str += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(str);
}

async function pollUntilDone(token, predictionId, signal) {
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      signal,
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.status === 'succeeded') return data;
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(data.error || `Upscale ${data.status}`);
    }
  }
  throw new Error('Timeout: upscale levou mais de 4 minutos');
}

// Model slugs and their input schemas
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

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 }); }

  const { dataUrl, scale, token, upscaleModel = 'nightmareai/real-esrgan' } = body;
  if (!dataUrl || !scale || !token) {
    return new Response(JSON.stringify({ error: 'Parâmetros incompletos' }), { status: 400 });
  }

  const cfg = MODELS[upscaleModel];
  if (!cfg) {
    return new Response(JSON.stringify({ error: `Modelo desconhecido: ${upscaleModel}` }), { status: 400 });
  }

  const signal = req.signal;

  let input;
  if (cfg.model_name) {
    // Topaz: usa model_name para selecionar sub-modelo
    input = { image: dataUrl, model_name: cfg.model_name, scale };
  } else if (cfg.scaleParam) {
    input = { image: dataUrl, [cfg.scaleParam]: scale };
  } else {
    // Modelos sem parâmetro de escala (ex: Recraft)
    input = { image: dataUrl };
  }

  try {
    const res = await fetch(`https://api.replicate.com/v1/models/${cfg.slug}/predictions`, {
      method: 'POST',
      signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=60',
      },
      body: JSON.stringify({ input }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return new Response(
        JSON.stringify({ error: err.detail || `Replicate HTTP ${res.status}` }),
        { status: res.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let prediction = await res.json();
    if (prediction.status !== 'succeeded') {
      prediction = await pollUntilDone(token, prediction.id, signal);
    }

    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!outputUrl) throw new Error('Replicate não retornou imagem upscalada');

    // Baixa e converte para base64 (URLs do Replicate expiram)
    const imgRes = await fetch(outputUrl, { signal });
    if (!imgRes.ok) throw new Error('Falha ao baixar imagem upscalada');
    const buf = await imgRes.arrayBuffer();
    const b64 = toBase64(buf);
    const mime = (imgRes.headers.get('content-type') || 'image/png').split(';')[0].trim();

    return new Response(
      JSON.stringify({ dataUrl: `data:${mime};base64,${b64}` }),
      { headers: { 'Content-Type': 'application/json' } }
    );

  } catch (e) {
    if (e.name === 'AbortError') {
      return new Response(JSON.stringify({ error: 'Cancelado' }), { status: 499 });
    }
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
