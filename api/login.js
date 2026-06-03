export const config = { runtime: 'edge' };

async function createToken(secret) {
  const expiry  = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 dias
  const payload = btoa(String(expiry));

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(payload),
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return `${payload}.${sigB64}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 }); }

  const { username, password } = body;
  const validUser = process.env.AUTH_USERNAME;
  const validPass = process.env.AUTH_PASSWORD;
  const secret    = process.env.AUTH_SECRET;

  if (!validUser || !validPass || !secret) {
    return new Response(
      JSON.stringify({ error: 'Servidor não configurado. Defina AUTH_USERNAME, AUTH_PASSWORD e AUTH_SECRET.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (username !== validUser || password !== validPass) {
    return new Response(
      JSON.stringify({ error: 'Usuário ou senha incorretos.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const token = await createToken(secret);
  const cookie = `auth=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`;

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
  });
}
