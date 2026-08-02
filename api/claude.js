export const config = { runtime: 'edge' };

function buildUserPrompt(docType, userInput, unit, lesson, ccss) {
  return `Unit ${unit || '?'} | Lesson ${lesson || '?'} | CCSS: ${ccss || 'N/A'}\n\n${userInput}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 }); }

  const {
    apiKey,
    model = 'claude-sonnet-4-6',
    docType = 'all',
    userInput,
    unit, lesson, ccss,
    systemPrompt: customSystemPrompt,
  } = body;

  if (!apiKey)         return json({ error: 'Claude API key obrigatória.' }, 400);
  if (!userInput?.trim()) return json({ error: 'Descrição da aula obrigatória.' }, 400);

  const systemPrompt = customSystemPrompt?.trim() || '';
  const userPrompt   = buildUserPrompt(docType, userInput, unit, lesson, ccss);

  // ── Chama Anthropic com streaming ──────────────────────────────────────
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      stream: true,
    }),
  });

  // Se erro antes do streaming começar, retorna JSON de erro
  if (!anthropicRes.ok) {
    const raw = await anthropicRes.text();
    let msg;
    try { msg = JSON.parse(raw).error?.message; } catch { msg = raw; }
    return json({ error: msg || `Claude API error ${anthropicRes.status}` }, anthropicRes.status);
  }

  // ── Transforma SSE do Anthropic → SSE simplificado para o frontend ──────
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const anthropicReader = anthropicRes.body.getReader();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = '';
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      try {
        while (true) {
          const { done, value } = await anthropicReader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const parsed = JSON.parse(raw);
              if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
                send({ text: parsed.delta.text });
              }
            } catch {}
          }
        }
        send({ done: true });
      } catch (e) {
        send({ error: e.message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
