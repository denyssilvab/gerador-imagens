const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const USERS_FILE = path.join(process.cwd(), 'data', 'users.json');

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function writeUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyToken(token, secret) {
  try {
    const dot     = token.lastIndexOf('.');
    if (dot === -1) return false;
    const payload  = token.slice(0, dot);
    const sig      = token.slice(dot + 1);
    const expiry   = parseInt(Buffer.from(payload, 'base64').toString(), 10);
    if (isNaN(expiry) || Date.now() > expiry) return false;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Usuário deve ter pelo menos 3 caracteres.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
  }

  const users    = readUsers();
  const hasAdmin = !!process.env.AUTH_USERNAME || users.length > 0;

  // Se já existe algum usuário: exige cookie de admin válido
  if (hasAdmin) {
    const secret = process.env.AUTH_SECRET;
    const cookie = Object.fromEntries(
      (req.headers.cookie || '').split(';')
        .map(c => c.trim().split('=').map(s => decodeURIComponent(s.trim())))
        .filter(p => p.length === 2)
    );
    if (!secret || !cookie.auth || !verifyToken(cookie.auth, secret)) {
      return res.status(403).json({ error: 'Apenas administradores podem criar novos usuários.' });
    }
  }

  // Verifica duplicata
  const exists = users.some(u => u.username === username)
    || process.env.AUTH_USERNAME === username;
  if (exists) return res.status(400).json({ error: 'Usuário já existe.' });

  const { salt, hash } = hashPassword(password);
  users.push({ username, hash, salt, createdAt: new Date().toISOString() });
  writeUsers(users);

  res.json({ ok: true });
};
