export const config = { runtime: 'edge' };

export default function handler() {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/login.html',
      'Set-Cookie': 'auth=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
    },
  });
}
