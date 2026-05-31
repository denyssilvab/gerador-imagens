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

  let input;
  if (cfg.model_name) {
    input = { image: dataUrl, model_name: cfg.model_name, scale };
  } else if (cfg.scaleParam) {
    input = { image: dataUrl, [cfg.scaleParam]: scale };
  } else {
    input = { image: dataUrl };
  }

  try {
    // wait=25 para caber no limite da Edge Function (~30s).
    // Se não terminar a tempo, retorna predictionId para polling no cliente.
    const res = await fetch(`https://api.replicate.com/v1/models/${cfg.slug}/predictions`, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=25',
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

    // Se ainda não terminou, devolve o ID para o cliente fazer polling
    if (prediction.status !== 'succeeded') {
      return new Response(
        JSON.stringify({ predictionId: prediction.id, status: prediction.status }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Terminou dentro do wait=25 — baixa e devolve base64
    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!outputUrl) throw new Error('Replicate não retornou imagem upscalada');

    const imgRes = await fetch(outputUrl, { signal: req.signal });
    if (!imgRes.ok) throw new Error('Falha ao baixar imagem upscalada');
    const buf = await imgRes.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let str = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      str += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
    }
    const b64 = btoa(str);
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
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
