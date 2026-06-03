const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Auth (dev local) ──────────────────────────────────────────────────────

const AUTH_USER   = process.env.AUTH_USERNAME;
const AUTH_PASS   = process.env.AUTH_PASSWORD;
const AUTH_SECRET = process.env.AUTH_SECRET;

function createToken(secret) {
  const expiry  = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(String(expiry)).toString('base64');
  const sig     = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  return `${payload}.${sig}`;
}

function verifyToken(token, secret) {
  try {
    const dot     = token.lastIndexOf('.');
    if (dot === -1) return false;
    const payload = token.slice(0, dot);
    const sig     = token.slice(dot + 1);
    const expiry  = parseInt(Buffer.from(payload, 'base64').toString(), 10);
    if (isNaN(expiry) || Date.now() > expiry) return false;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { return false; }
}

function parseCookie(header = '') {
  return Object.fromEntries(
    header.split(';').map(p => p.trim().split('=').map(decodeURIComponent))
  );
}

// Endpoints de auth
app.post('/api/login', (req, res) => {
  if (!AUTH_USER || !AUTH_PASS || !AUTH_SECRET) {
    return res.status(500).json({ error: 'AUTH_USERNAME, AUTH_PASSWORD e AUTH_SECRET não configurados no .env' });
  }
  const { username, password } = req.body;
  if (username !== AUTH_USER || password !== AUTH_PASS) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  const token = createToken(AUTH_SECRET);
  res.setHeader('Set-Cookie', `auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
  res.json({ ok: true });
});

app.get('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.redirect('/login.html');
});

app.post('/api/register', (req, res) => {
  const registerHandler = require('./api/register');
  return registerHandler(req, res);
});

// Middleware de proteção — só ativo se AUTH_SECRET estiver configurado
app.use((req, res, next) => {
  if (!AUTH_SECRET) return next(); // dev sem .env: passa direto
  if (req.path === '/login.html' || req.path.startsWith('/api/login') || req.path.startsWith('/api/logout') || req.path.startsWith('/api/register')) {
    return next();
  }
  const cookies = parseCookie(req.headers.cookie);
  if (cookies.auth && verifyToken(cookies.auth, AUTH_SECRET)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  res.redirect('/login.html');
});

app.use(express.static('public', { etag: false, maxAge: 0 }));

const GENERATED_DIR = path.join(__dirname, 'public', 'generated');
fs.mkdirSync(GENERATED_DIR, { recursive: true });

const sessions = new Map(); // requestId -> AbortController[]

// ── OpenAI ────────────────────────────────────────────────────────────────

async function generateOpenAI(apiKey, model, quality, prompt, controller) {
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
    // gpt-image-1, gpt-image-2
    params.size = '1024x1536';
    params.quality = quality || 'high';
  }

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(params),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);

  const item = data.data?.[0];
  if (!item) throw new Error('Nenhuma imagem retornada pela API OpenAI');

  if (item.b64_json) return { kind: 'b64', data: item.b64_json };
  if (item.url)      return { kind: 'url', data: item.url };
  throw new Error('Formato de resposta inesperado da API OpenAI');
}

// ── Replicate ─────────────────────────────────────────────────────────────

function replicateInput(model, prompt) {
  if (model.includes('ideogram')) {
    return { prompt, resolution: '1024x1536', rendering_quality: 'QUALITY', style_type: 'DESIGN' };
  }
  if (model.includes('recraft')) {
    return { prompt, size: '1024x1536', output_format: 'png' };
  }
  // FLUX and others
  return { prompt, aspect_ratio: '2:3', output_format: 'png', output_quality: 100 };
}

async function pollReplicate(apiKey, predictionId, controller) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await res.json();
    if (data.status === 'succeeded') return data;
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(data.error || `Replicate: ${data.status}`);
    }
  }
  throw new Error('Timeout: geração levou mais de 3 minutos');
}

async function generateReplicate(apiKey, model, prompt, controller) {
  const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait=60',
    },
    body: JSON.stringify({ input: replicateInput(model, prompt) }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || err.error || `Replicate HTTP ${res.status}`);
  }

  let prediction = await res.json();
  if (prediction.status !== 'succeeded') {
    prediction = await pollReplicate(apiKey, prediction.id, controller);
  }

  const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!output) throw new Error('Replicate não retornou imagem');
  return { kind: 'url', data: output };
}

// ── Save image ────────────────────────────────────────────────────────────

async function saveImage(imgData, filepath, controller) {
  let buf;
  if (imgData.kind === 'b64') {
    buf = Buffer.from(imgData.data, 'base64');
  } else {
    const res = await fetch(imgData.data, { signal: controller.signal });
    if (!res.ok) throw new Error(`Falha ao baixar imagem: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  await fs.promises.writeFile(filepath, buf);
}

// ── Batch endpoint ────────────────────────────────────────────────────────

app.post('/api/gerar-lote', async (req, res) => {
  const { apiKey, provider, model, quality, pages } = req.body;

  if (!apiKey || !Array.isArray(pages) || pages.length === 0) {
    return res.status(400).json({ error: 'Chave de API e páginas são obrigatórios' });
  }

  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const controllers = [];
  sessions.set(requestId, controllers);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let closed = false;
  req.on('close', () => { closed = true; });

  const send = (data) => {
    if (!res.writableEnded && !closed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ type: 'start', requestId, total: pages.length });

  const generatePage = async (page, index) => {
    const controller = new AbortController();
    controllers.push(controller);

    try {
      const imgData = provider === 'replicate'
        ? await generateReplicate(apiKey, model, page.content, controller)
        : await generateOpenAI(apiKey, model || 'gpt-image-2', quality, page.content, controller);

      const filename = `${requestId}_p${String(page.num).padStart(2, '0')}.png`;
      await saveImage(imgData, path.join(GENERATED_DIR, filename), controller);

      send({ type: 'image', index, pageNum: page.num, title: page.title, url: `/generated/${filename}`, filename, docType: page.docType });

    } catch (e) {
      if (e.name === 'AbortError') {
        send({ type: 'cancelled', index, pageNum: page.num, title: page.title });
      } else {
        send({ type: 'error', index, pageNum: page.num, title: page.title, error: e.message });
      }
    }
  };

  try {
    await Promise.allSettled(pages.map((page, i) => generatePage(page, i)));
  } finally {
    sessions.delete(requestId);
    send({ type: 'done' });
    if (!res.writableEnded) res.end();
  }
});

app.post('/api/cancelar/:id', (req, res) => {
  const controllers = sessions.get(req.params.id);
  if (controllers) {
    controllers.forEach(c => { try { c.abort(); } catch (_) {} });
    sessions.delete(req.params.id);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Sessão não encontrada' });
  }
});

app.delete('/api/limpar', (_req, res) => {
  try {
    const files = fs.readdirSync(GENERATED_DIR);
    files.forEach(f => fs.unlinkSync(path.join(GENERATED_DIR, f)));
    res.json({ ok: true, removed: files.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`✅ Servidor rodando em http://localhost:${PORT}`));
