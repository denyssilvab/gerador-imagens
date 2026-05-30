export const config = { runtime: 'edge' };

// ── Util ──────────────────────────────────────────────────────────────────

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    str += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(str);
}

async function urlToDataUrl(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Falha ao baixar imagem: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
  return `data:${mime};base64,${toBase64(buf)}`;
}

// ── OpenAI ────────────────────────────────────────────────────────────────

async function generateOpenAI(apiKey, model, quality, size, prompt, signal) {
  const params = { model, prompt, n: 1 };

  if (model === 'dall-e-2') {
    params.size = '1024x1024';
    params.response_format = 'b64_json';
  } else if (model === 'dall-e-3') {
    params.size = '1024x1792';
    params.quality = quality === 'high' ? 'hd' : 'standard';
    params.response_format = 'b64_json';
    params.style = 'vivid';
  } else {
    // gpt-image-2 / gpt-image-1
    params.size = size || '1024x1536';
    params.quality = quality || 'medium';
  }

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(params),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI HTTP ${res.status}`);

  const item = data.data?.[0];
  if (!item) throw new Error('Nenhuma imagem retornada pela API OpenAI');

  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.url)      return urlToDataUrl(item.url, signal);
  throw new Error('Formato de resposta inesperado da API OpenAI');
}

// ── Replicate ─────────────────────────────────────────────────────────────

function replicateInput(model, prompt, size) {
  const ar = size || '2:3';
  if (model.includes('nano-banana')) {
    // Gemini 2.5 Flash Image — aceita prompt e aspect_ratio
    return { prompt, aspect_ratio: ar };
  }
  if (model.includes('ideogram')) {
    return { prompt, resolution: '1024x1536', rendering_quality: 'QUALITY', style_type: 'DESIGN' };
  }
  if (model.includes('recraft')) {
    return { prompt, size: '1024x1536', output_format: 'png' };
  }
  // FLUX e outros
  return { prompt, aspect_ratio: ar, output_format: 'png', output_quality: 100 };
}

async function pollReplicate(apiKey, predictionId, signal) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      signal,
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await res.json();
    if (data.status === 'succeeded') return data;
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(data.error || `Replicate: ${data.status}`);
    }
  }
  throw new Error('Timeout após 3 minutos');
}

async function generateReplicate(apiKey, model, size, prompt, signal) {
  const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait=60',
    },
    body: JSON.stringify({ input: replicateInput(model, prompt, size) }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || err.error || `Replicate HTTP ${res.status}`);
  }

  let prediction = await res.json();
  if (prediction.status !== 'succeeded') {
    prediction = await pollReplicate(apiKey, prediction.id, signal);
  }

  const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!output) throw new Error('Replicate não retornou imagem');
  return urlToDataUrl(output, signal);
}

// ── Handler ───────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'JSON inválido' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { apiKey, provider, model, quality, size, pages } = body;

  if (!apiKey || !Array.isArray(pages) || !pages.length) {
    return new Response(JSON.stringify({ error: 'Chave de API e páginas são obrigatórios' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const reqSignal = req.signal;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch (_) {}
      };

      const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      send({ type: 'start', requestId, total: pages.length });

      const generatePage = async (page, index) => {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        reqSignal.addEventListener('abort', onAbort);

        try {
          const dataUrl = provider === 'replicate'
            ? await generateReplicate(apiKey, model, size, page.content, ctrl.signal)
            : await generateOpenAI(apiKey, model, quality, size, page.content, ctrl.signal);

          send({ type: 'image', index, pageNum: page.num, title: page.title, dataUrl });
        } catch (e) {
          if (ctrl.signal.aborted) {
            send({ type: 'cancelled', index, pageNum: page.num, title: page.title });
          } else {
            send({ type: 'error', index, pageNum: page.num, title: page.title, error: e.message });
          }
        } finally {
          reqSignal.removeEventListener('abort', onAbort);
        }
      };

      await Promise.allSettled(pages.map((page, i) => generatePage(page, i)));
      send({ type: 'done' });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
