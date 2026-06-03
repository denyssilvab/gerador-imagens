// Vercel Edge Middleware — protege todas as rotas exceto login
export const config = {
  matcher: ['/((?!login.html|api/login|api/logout|api/register|_vercel).*)'],
};

async function verifyToken(token, secret) {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return false;
    const payload = token.slice(0, dot);
    const sigB64  = token.slice(dot + 1);

    const expiry = parseInt(atob(payload), 10);
    if (isNaN(expiry) || Date.now() > expiry) return false;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    return await crypto.subtle.verify(
      'HMAC', key, sigBytes, new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

export default async function middleware(request) {
  const secret = process.env.AUTH_SECRET;

  // Se não há secret configurado, passa direto (dev sem .env)
  if (!secret) return;

  const cookie = request.headers.get('cookie') || '';
  const token  = cookie.match(/(?:^|;\s*)auth=([^;]+)/)?.[1];

  if (token && await verifyToken(token, secret)) return;

  const loginUrl = new URL('/login.html', request.url);
  return Response.redirect(loginUrl, 302);
}
