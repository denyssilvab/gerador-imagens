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

// Upload a base64 data: URL to Replicate's Files API and return the HTTPS URL.
// Replicate models require a valid URI — they reject data: URLs with "format 'uri'" error.
async function uploadToReplicateFiles(dataUrl, token) {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) throw new Error('Invalid data URL format');
  const mimeType = (dataUrl.slice(0, commaIdx).match(/:(.*?);/) || [])[1] || 'image/png';
  const binaryStr = atob(dataUrl.slice(commaIdx + 1));
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  const res = await fetch('https://api.replicate.com/v1/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': mimeType,
      'Content-Disposition': 'attachment; filename="image.png"',
    },
    body: bytes.buffer,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Replicate file upload failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.urls?.get || null;
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

  // Convert data: URL to a Replicate-hosted HTTPS URL before building the prediction input
  if (dataUrl.startsWith('data:')) {
    try {
      const fileUrl = await uploadToReplicateFiles(dataUrl, token);
      if (fileUrl) dataUrl = fileUrl;
      else throw new Error('Replicate Files API returned no URL');
    } catch (e) {
      return new Response(JSON.stringify({ error: `Falha ao enviar imagem: ${e.message}` }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
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
    // Cria prediction SEM wait — retorna predictionId imediatamente.
    // O cliente faz polling GET direto no Replicate (sem CORS issue, sem timeout).
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
    // Retorna predictionId para o cliente fazer polling diretamente no Replicate
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
