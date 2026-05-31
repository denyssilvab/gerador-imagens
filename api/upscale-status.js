export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const id    = url.searchParams.get('id');
  const token = url.searchParams.get('token');
  if (!id || !token) {
    return new Response(JSON.stringify({ error: 'Missing id or token' }), { status: 400 });
  }

  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const data = await res.json().catch(() => ({}));

  if (data.status === 'succeeded') {
    const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
    return new Response(
      JSON.stringify({ status: 'succeeded', outputUrl }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (data.status === 'failed' || data.status === 'canceled') {
    return new Response(
      JSON.stringify({ status: data.status, error: data.error || `Replicate: ${data.status}` }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ status: data.status || 'processing' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
