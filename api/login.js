const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const USERS_FILE = path.join(process.cwd(), 'data', 'users.json');

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function createToken(secret) {
  const expiry  = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(String(expiry)).toString('base64');
  const sig     = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  return `${payload}.${sig}`;
}

function verifyPassword(input, storedHash, storedSalt) {
  const hash = crypto.pbkdf2Sync(input, storedSalt, 100000, 64, 'sha512').toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
  }

  const secret = process.env.AUTH_SECRET;
  if (!secret) return res.status(500).json({ error: 'AUTH_SECRET não configurado.' });

  // 1. Verifica env var (admin primário)
  const envUser = process.env.AUTH_USERNAME;
  const envPass = process.env.AUTH_PASSWORD;
  const envMatch = envUser && envPass && username === envUser && password === envPass;

  // 2. Verifica users.json
  let fileMatch = false;
  if (!envMatch) {
    const users = readUsers();
    const user  = users.find(u => u.username === username);
    if (user) fileMatch = verifyPassword(password, user.hash, user.salt);
  }

  if (!envMatch && !fileMatch) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }

  const token  = createToken(secret);
  const cookie = `auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`;
  res.setHeader('Set-Cookie', cookie);
  res.json({ ok: true });
};
