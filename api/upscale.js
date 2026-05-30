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

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 }); }

  const { dataUrl, scale, token } = body;
  if (!dataUrl || !scale || !token) {
    return new Response(JSON.stringify({ error: 'Parâmetros incompletos' }), { status: 400 });
  }

  const signal = req.signal;

  try {
    // cjwbw/real-esrgan com variante anime — treinado para ilustrações/design limpo,
    // preserva bordas e texto muito melhor que a variante padrão de fotos
    const res = await fetch('https://api.replicate.com/v1/models/cjwbw/real-esrgan/predictions', {
      method: 'POST',
      signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=60',
      },
      body: JSON.stringify({
        input: {
          image: dataUrl,
          model_name: 'RealESRGAN_x4plus_anime_6B',
          scale,
        },
      }),
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

    // Baixa e converte para base64 para persistência (URLs do Replicate expiram)
    const imgRes = await fetch(outputUrl, { signal });
    if (!imgRes.ok) throw new Error('Falha ao baixar imagem upscalada');
    const buf = await imgRes.arrayBuffer();
    const b64 = toBase64(buf);

    return new Response(
      JSON.stringify({ dataUrl: `data:image/png;base64,${b64}` }),
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
