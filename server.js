'use strict';

// =============================================================================
// WaSpeed Server — arquivo único (API + painéis Admin/Mod + persistência JSON)
// =============================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Config ------------------------------------------------------------------

const ROOT = __dirname;
const config = {
  port: Number(process.env.PORT) || 3000,
  baseUrl: (process.env.BASE_URL || 'https://ws.onrender.com').replace(/\/$/, ''),
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  criptKey: process.env.ACCESS_TOKEN || 'ffce211a-7b07-4d91-ba5d-c40bb4034a83',
  chromeStoreId: process.env.CHROME_STORE_ID || 'balkfdkhbcjjmhndnblgmlmcabnapogp',
  wlId: process.env.WL_ID || 'waspeed',
  wlName: process.env.WL_NAME || 'WaSpeed',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'waspeed-admin-change-me',
  adminPath: process.env.ADMIN_PATH || 'admin-waspeed',
  modPath: process.env.MOD_PATH || 'mod-waspeed',
  sessionSecret: process.env.SESSION_SECRET || 'change-me-in-production-waspeed-2026',
  installRedirectUrl: process.env.INSTALL_URL || 'https://web.whatsapp.com',
  notesRedirect: process.env.NOTES_REDIRECT === 'true',
};


// --- Store -------------------------------------------------------------------

const FILES = {
  db: 'db.json',
  logs: 'logs.json',
};

function ensureDir() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
}

function filePath(name) {
  return path.join(config.dataDir, FILES[name] || name);
}

function readJson(name, fallback) {
  ensureDir();
  const fp = filePath(name);
  if (!fs.existsSync(fp)) {
    writeJson(name, fallback);
    return structuredClone(fallback);
  }
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(name, data) {
  ensureDir();
  const fp = filePath(name);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

const DEFAULT_DB = {
  settings: {
    installUrl: config.installRedirectUrl,
    notesHtml: '<h1>WaSpeed</h1><p>Servidor próprio ativo.</p>',
    webhooks: [],
    meet: {},
    urls: {},
    migration: {},
    domConfig: { selectors: {}, version: 1 },
  },
  mods: [],
  licenses: [],
  nextUserId: 1000,
};

let cache = null;

function getDb() {
  if (!cache) cache = readJson('db', DEFAULT_DB);
  return cache;
}

function saveDb() {
  writeJson('db', cache);
}

function resetCache() {
  cache = null;
}

function uid() {
  return crypto.randomBytes(16).toString('hex');
}

function token(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function appendLog(type, message, meta = {}) {
  const logs = readJson('logs', []);
  logs.unshift({
    id: uid(),
    at: new Date().toISOString(),
    type,
    message,
    meta,
  });
  if (logs.length > 2000) logs.length = 2000;
  writeJson('logs', logs);
}

function isExpired(lic) {
  if (!lic.expires_at) return false;
  return new Date(lic.expires_at).getTime() < Date.now();
}

function effectiveStatus(lic) {
  if (lic.blocked) return 'blocked';
  if (isExpired(lic)) return 'expired';
  return lic.user_status || 'free';
}

function toApiUser(lic) {
  const status = effectiveStatus(lic);
  const active = status === 'active';
  return {
    user_id: String(lic.user_id),
    name: lic.name || 'Usuário',
    email: lic.email || '',
    wl_id: lic.wl_id || config.wlId,
    bearer_token: lic.bearer_token,
    access_token_plugin: lic.access_token_plugin,
    user_premium: active,
    dataCadastro: lic.created_at || new Date().toISOString(),
    whatsapp_registro: lic.whatsapp_registro || '',
    whatsapp_plugin: lic.whatsapp_plugin || '',
    path: lic.path || '',
    afiliado: lic.afiliado || '',
    campanhaID: lic.campanhaID || '',
    start_form: lic.start_form !== false,
    cookies: lic.cookies || { _fbc: '', _fbp: '', _ga: '', _ttclid: '', _ttp: '' },
  };
}

function userStatusForClient(lic) {
  const s = effectiveStatus(lic);
  if (s === 'blocked' || s === 'expired') return 'free';
  return lic.user_status === 'active' ? 'active' : 'free';
}

function findByBearer(bearer) {
  if (!bearer) return null;
  return getDb().licenses.find((l) => l.bearer_token === bearer) || null;
}

function findByEmailPlugin(email, accessToken) {
  return (
    getDb().licenses.find(
      (l) =>
        l.email === email &&
        l.access_token_plugin === accessToken
    ) || null
  );
}

function findMod(username) {
  return getDb().mods.find((m) => m.username === username && m.active !== false) || null;
}

function createLicense(input = {}, modId = null) {
  const db = getDb();
  const id = uid();
  const userId = db.nextUserId++;
  const lic = {
    id,
    user_id: userId,
    name: input.name || 'Cliente',
    email: input.email || `user${userId}@waspeed.local`,
    bearer_token: input.bearer_token || token(24),
    access_token_plugin: input.access_token_plugin || token(16),
    user_status: input.user_status === 'active' ? 'active' : 'free',
    blocked: !!input.blocked,
    expires_at: input.expires_at || null,
    mod_id: modId || input.mod_id || null,
    note: input.note || '',
    phones: Array.isArray(input.phones) ? input.phones : [],
    wl_id: config.wlId,
    created_at: new Date().toISOString(),
    label: input.label || '',
  };
  db.licenses.push(lic);
  saveDb();
  appendLog('license_create', `Licença ${userId} criada`, { id, modId });
  return lic;
}

function updateLicense(id, patch) {
  const db = getDb();
  const lic = db.licenses.find((l) => l.id === id);
  if (!lic) return null;
  const allowed = [
    'name', 'email', 'user_status', 'blocked', 'expires_at', 'note', 'label', 'phones', 'mod_id',
    'bearer_token', 'access_token_plugin',
  ];
  for (const k of allowed) {
    if (patch[k] !== undefined) lic[k] = patch[k];
  }
  saveDb();
  appendLog('license_update', `Licença ${lic.user_id} atualizada`, { id });
  return lic;
}

function deleteLicense(id) {
  const db = getDb();
  const idx = db.licenses.findIndex((l) => l.id === id);
  if (idx < 0) return false;
  const lic = db.licenses[idx];
  db.licenses.splice(idx, 1);
  saveDb();
  appendLog('license_delete', `Licença ${lic.user_id} removida`, { id });
  return true;
}

function stats() {
  const db = getDb();
  const licenses = db.licenses;
  const now = Date.now();
  const in48h = now + 48 * 3600000;
  let active = 0, expired = 0, expiring = 0, blocked = 0, free = 0;
  for (const l of licenses) {
    const st = effectiveStatus(l);
    if (st === 'blocked') blocked++;
    else if (st === 'expired') expired++;
    else if (l.user_status === 'active') {
      active++;
      if (l.expires_at) {
        const t = new Date(l.expires_at).getTime();
        if (t > now && t <= in48h) expiring++;
      }
    } else free++;
  }
  return {
    total: licenses.length,
    active,
    free,
    expired,
    expiring,
    blocked,
    mods: db.mods.length,
    logs: readJson('logs', []).length,
  };
}

function initSeed() {
  const db = getDb();
  if (db._seeded) return;
  if (!db.mods.length) {
    db.mods.push({
      id: uid(),
      username: 'mod',
      password: hashPassword('mod123'),
      name: 'Moderador',
      active: true,
      created_at: new Date().toISOString(),
    });
  }
  if (!db.licenses.length) {
    createLicense({
      name: 'Demo Premium',
      email: 'demo@waspeed.local',
      user_status: 'active',
      note: 'Licença de demonstração — troque o bearer antes de produção',
    });
  }
  db._seeded = true;
  saveDb();
}

// --- API -------------------------------------------------------------------

const EMPTY_AUTH_GOOGLE = {
  user_id: '',
  name: '',
  picture: '',
  email_auth: '',
  access_token: '',
  expires_in: NaN,
  id_token: '',
  refresh_token: '',
  scope: '',
  token_type: '',
  updated_at: NaN,
};

function requireAccessToken(req, res, next) {
  const key = req.headers['access-token'];
  if (key !== config.criptKey) {
    return res.status(403).json({ success: false, msg_id: 'invalid_access_token' });
  }
  next();
}

function parseBearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

function fail(res, msgId, extra = {}) {
  return res.json({ success: false, msg_id: msgId, ...extra });
}

function registerWaSpeedApi(app) {
  const api = express.Router();

  api.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, access-token, accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  api.use(requireAccessToken);

  // GET /api/auth/login-bearer/:chromeStoreId
  api.get('/auth/login-bearer/:chromeStoreId', (req, res) => {
    const bearer = parseBearer(req);
    const lic = store.findByBearer(bearer);
    if (!lic) {
      store.appendLog('auth_fail', 'Bearer inválido', { ip: req.ip });
      return fail(res, 'invalid_token');
    }
    if (lic.blocked) return fail(res, 'user_blocked');
    if (store.isExpired(lic)) return fail(res, 'license_expired');

    const user = store.toApiUser(lic);
    const user_status = store.userStatusForClient(lic);
    store.appendLog('auth_ok', `Login bearer ${lic.user_id}`, { email: lic.email });

    return res.json({
      success: true,
      user,
      auth_google: EMPTY_AUTH_GOOGLE,
      user_status,
    });
  });

  // POST /api/auth/validation/:chromeStoreId
  api.post('/auth/validation/:chromeStoreId', express.json(), (req, res) => {
    const { email, access_token_plugin } = req.body || {};
    const lic = store.findByEmailPlugin(email, access_token_plugin);
    if (!lic) return fail(res, 'invalid_token_in_validation');
    if (lic.blocked) return fail(res, 'user_blocked');
    if (store.isExpired(lic)) return fail(res, 'license_expired');

    const user = store.toApiUser(lic);
    const user_status = store.userStatusForClient(lic);
    store.appendLog('validation_ok', `Validação ${lic.user_id}`, { email });

    return res.json({
      success: true,
      user,
      auth_google: EMPTY_AUTH_GOOGLE,
      user_status,
    });
  });

  // POST /api/user/update
  api.post('/user/update', express.json(), (req, res) => {
    const body = req.body || {};
    const bearer = parseBearer(req) || body.bearer_token;
    const lic = store.findByBearer(bearer);
    if (!lic) return fail(res, 'invalid_token');

    const patch = {};
    if (body.whatsapp_plugin) patch.whatsapp_registro = body.whatsapp_plugin;
    if (body.whatsapp_registro) patch.whatsapp_registro = body.whatsapp_registro;
    if (body.name) patch.name = body.name;
    if (body.path) patch.path = body.path;
    store.updateLicense(lic.id, patch);

    return res.json({ success: true, user: store.toApiUser(store.findByBearer(bearer)) });
  });

  // GET /api/services/initial-data/:chromeStoreId
  api.get('/services/initial-data/:chromeStoreId', (req, res) => {
    const db = store.getDb();
    const s = db.settings;
    return res.json({
      webhooks: s.webhooks || [],
      meet: s.meet || {},
      urls: s.urls || {},
      migration: s.migration || {},
    });
  });

  // GET /api/services/update — WPP module update check
  api.get('/services/update', (req, res) => {
    return res.json({
      success: true,
      version: '1.11',
      update: false,
      message: 'WaSpeed server — módulo atualizado',
    });
  });

  api.post('/services/update', express.json(), (req, res) => {
    return res.json({ success: true, version: '1.11', update: false });
  });

  // Install / uninstall / notes
  api.get('/urls/install/:extensionId', (req, res) => {
    const db = store.getDb();
    const url = db.settings.installUrl || config.installRedirectUrl;
    store.appendLog('install', 'Redirect install', { extensionId: req.params.extensionId });
    return res.json({ success: true, url });
  });

  api.get('/urls/uninstall/:extensionId', (req, res) => {
    return res.json({
      success: true,
      url: `${config.baseUrl}/obrigado`,
    });
  });

  api.get('/urls/active-notes/:extensionId', (req, res) => {
  const redirect = config.notesRedirect;
    return res.json({
      success: true,
      path_note_update: { redirect },
    });
  });

  api.get('/urls/notes/:extensionId', (req, res) => {
    const db = store.getDb();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(db.settings.notesHtml || '<h1>WaSpeed</h1>');
  });

  // Stub imagem
  api.post('/image/url-to-base64', express.json(), (req, res) => {
    return res.json({ success: false, msg_id: 'not_implemented' });
  });

  app.use('/api', api);

  // Remote DOM config (substitui code.wascript.com.br/config.json)
  app.get('/config.json', (req, res) => {
    const db = store.getDb();
    res.json(db.settings.domConfig || { selectors: {}, version: 1 });
  });

  // Painel cliente — externally_connectable handshake
  app.post('/api/external/is_instaled', (req, res) => res.json({ success: true }));
  app.get('/api/external/ping', (req, res) => res.json({ success: true, server: 'waspeed', version: '1.0.0' }));

  // Utils stubs (backend-utils)
  const utils = express.Router();
  utils.use(express.json({ limit: '10mb' }));
  utils.post('/XLSX/exportFunil', (req, res) => {
    return res.status(501).json({ success: false, message: 'Export XLSX — implemente conforme necessidade' });
  });
  utils.post('/XLSX/exporttab', (req, res) => {
    return res.status(501).json({ success: false, message: 'Export XLSX — implemente conforme necessidade' });
  });
  utils.post('/audio/convert-ptt-file', (req, res) => {
    return res.status(501).json({ success: false, message: 'Conversão PTT não configurada neste servidor' });
  });
  utils.post('/transcription', express.json(), (req, res) => {
    return res.status(501).json({ success: false, message: 'Transcrição de áudio não configurada neste servidor' });
  });
  app.use('/utils/api', utils);

  // Página pós-desinstalação
  app.get('/obrigado', (req, res) => {
    res.send('<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>WaSpeed</h1><p>Extensão removida. Obrigado por usar!</p></body></html>');
  });
}

// --- Painéis ---------------------------------------------------------------

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function layout(title, body, nav = '') {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — WaSpeed Server</title>
<style>
:root{--bg:#0f1419;--card:#1a2332;--border:#2d3a4d;--text:#e7ecf3;--muted:#8b9cb3;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--accent:#3b82f6}
*{box-sizing:border-box}body{margin:0;font-family:Segoe UI,system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
a{color:var(--accent)}.wrap{max-width:1200px;margin:0 auto;padding:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
h1,h2{margin:0 0 12px}h1{font-size:1.5rem}.muted{color:var(--muted);font-size:.9rem}
nav{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid var(--border)}
nav a{text-decoration:none;padding:6px 12px;border-radius:8px;background:#243044}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px}
.stat{background:#121a26;border-radius:10px;padding:14px;text-align:center}.stat .n{font-size:1.8rem;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{padding:10px 8px;border-bottom:1px solid var(--border);text-align:left}
th{color:var(--muted);font-weight:600}tr:hover td{background:#1f2a3d}
input,select,textarea{width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:#121a26;color:var(--text);margin:6px 0 12px}
button,.btn{display:inline-block;padding:10px 16px;border:none;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;font-size:.9rem;text-decoration:none}
.btn-red{background:var(--red)}.btn-green{background:var(--green)}.btn-sm{padding:6px 10px;font-size:.8rem}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:600}
.badge-active{background:#14532d;color:#86efac}.badge-free{background:#422006;color:#fde68a}
.badge-blocked{background:#450a0a;color:#fca5a5}.badge-expired{background:#3f3f46;color:#d4d4d8}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1;min-width:200px}
.alert{padding:12px;border-radius:8px;margin-bottom:12px;background:#1e3a5f}
.token{font-family:monospace;font-size:.8rem;word-break:break-all;background:#121a26;padding:8px;border-radius:6px}
.login{max-width:400px;margin:80px auto}
</style></head><body><div class="wrap">${nav}<h1>${esc(title)}</h1>${body}</div></body></html>`;
}

function statusBadge(lic) {
  const st = store.effectiveStatus(lic);
  if (st === 'active' || (st !== 'blocked' && st !== 'expired' && lic.user_status === 'active')) {
    return '<span class="badge badge-active">ATIVO</span>';
  }
  if (st === 'blocked') return '<span class="badge badge-blocked">BLOQUEADO</span>';
  if (st === 'expired') return '<span class="badge badge-expired">EXPIRADO</span>';
  return '<span class="badge badge-free">FREE</span>';
}

function requirePanel(role) {
  return (req, res, next) => {
    const cookies = parseCookies(req);
    const sess = verifySession(cookies.ws_session);
    if (!sess || sess.role !== role) {
      return res.redirect(req.baseUrl + '/login');
    }
    req.panelUser = sess;
    next();
  };
}

function registerPanels(app) {
  const adminBase = `/${config.adminPath}`;
  const modBase = `/${config.modPath}`;

  const adminRouter = express.Router();
  const modRouter = express.Router();

  function loginPage(base, role, err = '') {
    return layout(
      'Login',
      `<div class="login card"><p class="muted">Painel ${role === 'admin' ? 'Administrador' : 'Moderador'}</p>
      ${err ? `<div class="alert">${esc(err)}</div>` : ''}
      <form method="post" action="${base}/login">
        <label>Usuário</label><input name="user" required autocomplete="username">
        <label>Senha</label><input name="pass" type="password" required autocomplete="current-password">
        <button type="submit">Entrar</button>
      </form></div>`,
    );
  }

  function setSession(res, payload) {
    const token = signSession({ ...payload, exp: Date.now() + 7 * 86400000 });
    res.setHeader('Set-Cookie', `ws_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
  }

  adminRouter.get('/login', (req, res) => res.send(loginPage(adminBase, 'admin')));
  modRouter.get('/login', (req, res) => res.send(loginPage(modBase, 'mod')));

  adminRouter.post('/login', express.urlencoded({ extended: true }), (req, res) => {
    const { user, pass } = req.body || {};
    if (user === config.adminUser && pass === config.adminPass) {
      setSession(res, { role: 'admin', user });
      return res.redirect(adminBase);
    }
    return res.send(loginPage(adminBase, 'admin', 'Credenciais inválidas'));
  });

  modRouter.post('/login', express.urlencoded({ extended: true }), (req, res) => {
    const { user, pass } = req.body || {};
    const mod = store.findMod(user);
    if (mod && store.verifyPassword(pass, mod.password)) {
      setSession(res, { role: 'mod', user, modId: mod.id, name: mod.name });
      return res.redirect(modBase);
    }
    return res.send(loginPage(modBase, 'mod', 'Credenciais inválidas'));
  });

  function logoutHandler(base) {
    return (req, res) => {
      res.setHeader('Set-Cookie', 'ws_session=; Path=/; Max-Age=0');
      res.redirect(base + '/login');
    };
  }

  adminRouter.get('/logout', logoutHandler(adminBase));
  modRouter.get('/logout', logoutHandler(modBase));

  adminRouter.get('/', requirePanel('admin'), (req, res) => {
    const st = store.stats();
    const nav = `<nav><a href="${adminBase}">Dashboard</a><a href="${adminBase}/licenses">Licenças</a><a href="${adminBase}/mods">Moderadores</a><a href="${adminBase}/settings">Config</a><a href="${adminBase}/logs">Logs</a><a href="${adminBase}/logout">Sair</a></nav>`;
    res.send(
      layout(
        'Admin — Dashboard',
        `<div class="stats">
          <div class="stat"><div class="n">${st.total}</div><div class="muted">Total</div></div>
          <div class="stat"><div class="n" style="color:var(--green)">${st.active}</div><div class="muted">Ativas</div></div>
          <div class="stat"><div class="n" style="color:var(--red)">${st.expired}</div><div class="muted">Expiradas</div></div>
          <div class="stat"><div class="n" style="color:var(--yellow)">${st.expiring}</div><div class="muted">Expirando 48h</div></div>
          <div class="stat"><div class="n">${st.blocked}</div><div class="muted">Bloqueadas</div></div>
          <div class="stat"><div class="n">${st.mods}</div><div class="muted">Mods</div></div>
        </div>
        <div class="card"><p class="muted">API base</p><p class="token">${esc(config.baseUrl)}/api/</p>
        <p class="muted">access-token (cript_key)</p><p class="token">${esc(config.criptKey)}</p></div>`,
        nav,
      ),
    );
  });

  function licensesTable(licenses, base, canDelete) {
    const rows = licenses
      .map((l) => {
        const exp = l.expires_at ? new Date(l.expires_at).toLocaleString('pt-BR') : '—';
        return `<tr>
          <td>${l.user_id}</td><td>${esc(l.name)}</td><td>${esc(l.email)}</td><td>${statusBadge(l)}</td>
          <td>${exp}</td><td>${esc(l.note)}</td>
          <td><a class="btn btn-sm" href="${base}/licenses/${l.id}">Editar</a>
          ${canDelete ? `<a class="btn btn-sm btn-red" href="${base}/licenses/${l.id}/delete" onclick="return confirm('Remover?')">Excluir</a>` : ''}</td>
        </tr>`;
      })
      .join('');
    return `<table><thead><tr><th>ID</th><th>Nome</th><th>Email</th><th>Status</th><th>Validade</th><th>Notas</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">Nenhuma licença</td></tr>'}</tbody></table>`;
  }

  adminRouter.get('/licenses', requirePanel('admin'), (req, res) => {
    const db = store.getDb();
    const nav = `<nav><a href="${adminBase}">Dashboard</a><a href="${adminBase}/licenses">Licenças</a><a href="${adminBase}/mods">Moderadores</a><a href="${adminBase}/settings">Config</a><a href="${adminBase}/logout">Sair</a></nav>`;
    res.send(
      layout(
        'Licenças',
        `<div class="card"><a class="btn btn-green" href="${adminBase}/licenses/new">+ Nova licença</a></div>
        <div class="card">${licensesTable(db.licenses, adminBase, true)}</div>`,
        nav,
      ),
    );
  });

  modRouter.get('/', requirePanel('mod'), (req, res) => {
    const db = store.getDb();
    const list = db.licenses.filter((l) => l.mod_id === req.panelUser.modId);
    const nav = `<nav><a href="${modBase}">Minhas licenças</a><a href="${modBase}/licenses/new">Nova</a><a href="${modBase}/logout">Sair (${esc(req.panelUser.name)})</a></nav>`;
    res.send(
      layout('Moderador', `<div class="card">${licensesTable(list, modBase, false)}</div>`, nav),
    );
  });

  function licenseForm(base, lic, mods, title) {
    const modOpts = mods
      .map((m) => `<option value="${m.id}" ${lic.mod_id === m.id ? 'selected' : ''}>${esc(m.name)} (${esc(m.username)})</option>`)
      .join('');
    return layout(
      title,
      `<div class="card"><form method="post">
        <div class="row">
          <div><label>Nome</label><input name="name" value="${esc(lic.name)}" required></div>
          <div><label>Email</label><input name="email" type="email" value="${esc(lic.email)}" required></div>
        </div>
        <div class="row">
          <div><label>Status</label><select name="user_status">
            <option value="active" ${lic.user_status === 'active' ? 'selected' : ''}>Premium (active)</option>
            <option value="free" ${lic.user_status !== 'active' ? 'selected' : ''}>Free</option>
          </select></div>
          <div><label>Validade (opcional)</label><input name="expires_at" type="datetime-local" value="${lic.expires_at ? lic.expires_at.slice(0, 16) : ''}"></div>
        </div>
        <label><input type="checkbox" name="blocked" value="1" ${lic.blocked ? 'checked' : ''}> Bloqueado</label>
        ${mods.length ? `<label>Moderador</label><select name="mod_id"><option value="">—</option>${modOpts}</select>` : ''}
        <label>Notas</label><textarea name="note" rows="2">${esc(lic.note)}</textarea>
        ${lic.bearer_token ? `<label>Bearer token (instalação / painel)</label><div class="token">${esc(lic.bearer_token)}</div>
        <label>access_token_plugin (validação)</label><div class="token">${esc(lic.access_token_plugin)}</div>
        <p class="muted">URL WhatsApp: <span class="token">https://web.whatsapp.com/?bearer_token=${esc(lic.bearer_token)}</span></p>` : ''}
        <button type="submit">Salvar</button> <a href="${base}">Cancelar</a>
      </form></div>`,
    );
  }

  adminRouter.get('/licenses/new', requirePanel('admin'), (req, res) => {
    const nav = '';
    res.send(
      licenseForm(
        adminBase + '/licenses',
        { name: '', email: '', user_status: 'active', blocked: false, note: '', mod_id: '' },
        store.getDb().mods,
        'Nova licença',
      ).replace('<div class="wrap">', `<div class="wrap">${nav}`),
    );
  });

  adminRouter.post('/licenses/new', requirePanel('admin'), express.urlencoded({ extended: true }), (req, res) => {
    const b = req.body || {};
    store.createLicense({
      name: b.name,
      email: b.email,
      user_status: b.user_status,
      blocked: !!b.blocked,
      expires_at: b.expires_at ? new Date(b.expires_at).toISOString() : null,
      note: b.note,
      mod_id: b.mod_id || null,
    });
    res.redirect(adminBase + '/licenses');
  });

  modRouter.get('/licenses/new', requirePanel('mod'), (req, res) => {
    res.send(
      licenseForm(
        modBase,
        { name: '', email: '', user_status: 'free', blocked: false, note: '' },
        [],
        'Nova licença (mod)',
      ),
    );
  });

  modRouter.post('/licenses/new', requirePanel('mod'), express.urlencoded({ extended: true }), (req, res) => {
    const b = req.body || {};
    store.createLicense(
      {
        name: b.name,
        email: b.email,
        user_status: b.user_status,
        blocked: !!b.blocked,
        expires_at: b.expires_at ? new Date(b.expires_at).toISOString() : null,
        note: b.note,
      },
      req.panelUser.modId,
    );
    res.redirect(modBase);
  });

  adminRouter.get('/licenses/:id', requirePanel('admin'), (req, res) => {
    const lic = store.getDb().licenses.find((l) => l.id === req.params.id);
    if (!lic) return res.status(404).send('Não encontrado');
    res.send(licenseForm(adminBase + '/licenses/' + lic.id, lic, store.getDb().mods, 'Editar licença'));
  });

  adminRouter.post('/licenses/:id', requirePanel('admin'), express.urlencoded({ extended: true }), (req, res) => {
    const b = req.body || {};
    store.updateLicense(req.params.id, {
      name: b.name,
      email: b.email,
      user_status: b.user_status,
      blocked: !!b.blocked,
      expires_at: b.expires_at ? new Date(b.expires_at).toISOString() : null,
      note: b.note,
      mod_id: b.mod_id || null,
    });
    res.redirect(adminBase + '/licenses');
  });

  adminRouter.get('/licenses/:id/delete', requirePanel('admin'), (req, res) => {
    store.deleteLicense(req.params.id);
    res.redirect(adminBase + '/licenses');
  });

  modRouter.get('/licenses/:id', requirePanel('mod'), (req, res) => {
    const lic = store.getDb().licenses.find((l) => l.id === req.params.id && l.mod_id === req.panelUser.modId);
    if (!lic) return res.status(404).send('Não encontrado');
    res.send(licenseForm(modBase + '/licenses/' + lic.id, lic, [], 'Editar licença'));
  });

  modRouter.post('/licenses/:id', requirePanel('mod'), express.urlencoded({ extended: true }), (req, res) => {
    const lic = store.getDb().licenses.find((l) => l.id === req.params.id && l.mod_id === req.panelUser.modId);
    if (!lic) return res.status(404).send('Não encontrado');
    const b = req.body || {};
    store.updateLicense(req.params.id, {
      name: b.name,
      email: b.email,
      user_status: b.user_status,
      blocked: !!b.blocked,
      expires_at: b.expires_at ? new Date(b.expires_at).toISOString() : null,
      note: b.note,
    });
    res.redirect(modBase);
  });

  adminRouter.get('/mods', requirePanel('admin'), (req, res) => {
    const db = store.getDb();
    const nav = `<nav><a href="${adminBase}">Dashboard</a><a href="${adminBase}/licenses">Licenças</a><a href="${adminBase}/mods">Moderadores</a><a href="${adminBase}/logout">Sair</a></nav>`;
    const rows = db.mods
      .map(
        (m) =>
          `<tr><td>${esc(m.username)}</td><td>${esc(m.name)}</td><td>${m.active === false ? 'Inativo' : 'Ativo'}</td><td>${new Date(m.created_at).toLocaleDateString('pt-BR')}</td></tr>`,
      )
      .join('');
    res.send(
      layout(
        'Moderadores',
        `<div class="card"><h2>Novo moderador</h2>
        <form method="post" action="${adminBase}/mods" class="row">
          <div><input name="username" placeholder="usuário" required></div>
          <div><input name="password" type="password" placeholder="senha" required></div>
          <div><input name="name" placeholder="nome exibido" required></div>
          <div><button type="submit">Criar</button></div>
        </form></div>
        <div class="card"><table><thead><tr><th>Usuário</th><th>Nome</th><th>Status</th><th>Criado</th></tr></thead><tbody>${rows}</tbody></table></div>`,
        nav,
      ),
    );
  });

  adminRouter.post('/mods', requirePanel('admin'), express.urlencoded({ extended: true }), (req, res) => {
    const { username, password, name } = req.body || {};
    const db = store.getDb();
    if (username && password && !db.mods.find((m) => m.username === username)) {
      db.mods.push({
        id: store.uid(),
        username,
        password: store.hashPassword(password),
        name: name || username,
        active: true,
        created_at: new Date().toISOString(),
      });
      store.saveDb();
    }
    res.redirect(adminBase + '/mods');
  });

  adminRouter.get('/settings', requirePanel('admin'), (req, res) => {
    const s = store.getDb().settings;
    const nav = `<nav><a href="${adminBase}">Dashboard</a><a href="${adminBase}/licenses">Licenças</a><a href="${adminBase}/settings">Config</a><a href="${adminBase}/logout">Sair</a></nav>`;
    res.send(
      layout(
        'Configurações',
        `<div class="card"><form method="post">
          <label>URL redirect pós-install</label><input name="installUrl" value="${esc(s.installUrl)}">
          <label>HTML notas de release</label><textarea name="notesHtml" rows="4">${esc(s.notesHtml)}</textarea>
          <label><input type="checkbox" name="notesRedirect" value="1" ${config.notesRedirect ? 'checked' : ''}> Redirecionar para notas no update</label>
          <button type="submit">Salvar</button>
        </form></div>`,
        nav,
      ),
    );
  });

  adminRouter.post('/settings', requirePanel('admin'), express.urlencoded({ extended: true }), (req, res) => {
    const db = store.getDb();
    db.settings.installUrl = req.body.installUrl || config.installRedirectUrl;
    db.settings.notesHtml = req.body.notesHtml || '';
    store.saveDb();
    res.redirect(adminBase + '/settings');
  });

  adminRouter.get('/logs', requirePanel('admin'), (req, res) => {
    const logs = store.readJson('logs', []).slice(0, 200);
    const nav = `<nav><a href="${adminBase}">Dashboard</a><a href="${adminBase}/logs">Logs</a><a href="${adminBase}/logout">Sair</a></nav>`;
    const rows = logs
      .map((l) => `<tr><td>${new Date(l.at).toLocaleString('pt-BR')}</td><td>${esc(l.type)}</td><td>${esc(l.message)}</td></tr>`)
      .join('');
    res.send(
      layout('Logs', `<div class="card"><table><thead><tr><th>Data</th><th>Tipo</th><th>Mensagem</th></tr></thead><tbody>${rows}</tbody></table></div>`, nav),
    );
  });

  app.use(adminBase, adminRouter);
  app.use(modBase, modRouter);

  app.get('/', (req, res) => {
    res.send(
      layout(
        'WaSpeed Server',
        `<div class="card"><p>Backend ativo em <strong>${esc(config.baseUrl)}</strong></p>
        <p><a class="btn" href="${adminBase}">Painel Admin</a> <a class="btn" href="${modBase}">Painel Mod</a></p>
        <p class="muted">API: /api/auth/login-bearer/:chromeStoreId · /api/auth/validation/:chromeStoreId</p></div>`,
      ),
    );
  });
}

// --- Bootstrap ---------------------------------------------------------------

initSeed();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

registerWaSpeedApi(app);
registerPanels(app);

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, msg_id: 'server_error' });
});

app.listen(config.port, () => {
  console.log(`WaSpeed Server em http://localhost:${config.port}`);
  console.log(`Admin: ${config.baseUrl}/${config.adminPath}`);
  console.log(`Mod:   ${config.baseUrl}/${config.modPath}`);
  console.log(`API:   ${config.baseUrl}/api/`);
});
