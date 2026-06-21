'use strict';

// =============================================================================
// WaSpeed Server v2 — estrutura ZapVoice (http nativo + chaves) + API WaSpeed
// =============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const FALLBACK_DATA = path.join(ROOT, 'data');
const WPP_VERSION = '1.11';
const REMOTE_CODE_VERSION = '1.0.41';

// --- Config ------------------------------------------------------------------

const config = {
  port: Number(process.env.PORT) || 3000,
  baseUrl: (process.env.BASE_URL || '').replace(/\/$/, ''),
  dataDir: process.env.DATA_DIR || FALLBACK_DATA,
  criptKey: process.env.ACCESS_TOKEN || 'ffce211a-7b07-4d91-ba5d-c40bb4034a83',
  chromeStoreId: process.env.CHROME_STORE_ID || 'balkfdkhbcjjmhndnblgmlmcabnapogp',
  wlId: process.env.WL_ID || 'waspeed',
  wlName: process.env.WL_NAME || 'WaSpeed',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'waspeed-admin-change-me',
  adminPath: process.env.ADMIN_PATH || 'admin-waspeed',
  modPath: process.env.MOD_PATH || 'mod-waspeed',
  sessionSecret: process.env.SESSION_SECRET || 'change-me-waspeed-2026',
  installUrl: process.env.INSTALL_URL || 'https://web.whatsapp.com',
  notesRedirect: process.env.NOTES_REDIRECT === 'true',
  persistMode: process.env.PERSIST_MODE || (process.env.RENDER ? 'debounced' : 'sync'),
  saveDebounceMs: Number(process.env.SAVE_DEBOUNCE_MS) || 1500,
  logMax: Math.min(Number(process.env.LOG_MAX) || 500, 2000),
};

function resolveDataDir() {
  for (const dir of [config.dataDir, FALLBACK_DATA]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      if (dir !== config.dataDir) {
        console.warn(`[WaSpeed] DATA_DIR indisponivel — usando ${dir}`);
      }
      return dir;
    } catch (e) {
      console.warn(`[WaSpeed] Sem gravacao em ${dir}: ${e.message}`);
    }
  }
  throw new Error('Nenhum diretorio gravavel');
}

config.dataDir = resolveDataDir();
config.ephemeral = path.resolve(config.dataDir) === path.resolve(FALLBACK_DATA);

if (!config.baseUrl) {
  console.error('[WaSpeed] ERRO: defina BASE_URL nas variaveis de ambiente (URL publica do Render).');
  process.exit(1);
}

const R_ADMIN = `/${config.adminPath}`;
const R_MOD = `/${config.modPath}`;
const STORE_FILE = path.join(config.dataDir, 'store.json');

// --- DOM defaults (code.wascript.com.br/config.json) -------------------------

function loadDomDefaults() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'dom-defaults.json'), 'utf8'));
  } catch {
    return { version: WPP_VERSION, update_path_active: 'true', app: { model: 'querySelector', selector: ['#app'] } };
  }
}

function buildDomConfig(overrides = {}) {
  const base = loadDomDefaults();
  const clean = { ...overrides };
  delete clean.remote_code;
  delete clean.dom_selector;
  const merged = { ...base, ...clean };
  merged.update_path = `${config.baseUrl}/api/urls/update`;
  merged.update_path_new = `${config.baseUrl}/api/services/update`;
  merged.update_path_active = String(merged.update_path_active ?? 'true');
  if (merged.version === 1 || merged.selectors) {
    delete merged.selectors;
    merged.version = base.version || WPP_VERSION;
  }
  return merged;
}

/** Formato code.wascript.com.br/config.json — exigido pelo background após login */
function buildConfigJson(overrides = {}) {
  return {
    remote_code: {
      version: REMOTE_CODE_VERSION,
      ambiente: 'production',
      url: `${config.baseUrl}/api/code?version=${REMOTE_CODE_VERSION}`,
    },
    dom_selector: buildDomConfig(overrides),
  };
}

// --- Store -------------------------------------------------------------------

const DEFAULT_STORE = {
  keys: {},
  settings: {
    installUrl: config.installUrl,
    notesHtml: '<h1>WaSpeed</h1><p>Servidor proprio ativo.</p>',
    webhooks: [],
    meet: {},
    urls: {},
    migration: {},
    domConfig: buildDomConfig(),
  },
  mods: [],
  logs: [],
  nextUserId: 1000,
  _seeded: false,
};

let store = null;
let saveTimer = null;
let saveDirty = false;

function readStoreFile() {
  if (!fs.existsSync(STORE_FILE)) return structuredClone(DEFAULT_STORE);
  try {
    return { ...structuredClone(DEFAULT_STORE), ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
  } catch {
    return structuredClone(DEFAULT_STORE);
  }
}

function writeStoreFile() {
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_FILE);
  saveDirty = false;
}

function saveStoreNow() {
  if (!store) return;
  writeStoreFile();
}

function saveStore() {
  if (config.persistMode === 'sync') {
    saveStoreNow();
    return;
  }
  saveDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStoreNow, config.saveDebounceMs);
}

function flushStore() {
  clearTimeout(saveTimer);
  if (saveDirty) saveStoreNow();
}

function loadStore() {
  store = readStoreFile();
  store.settings.domConfig = buildDomConfig(store.settings.domConfig || {});
  return store;
}

// --- Chaves ------------------------------------------------------------------

const AUTH_MSG = {
  NOT_FOUND: 'Chave nao encontrada',
  BLOCKED: 'Chave bloqueada',
  EXPIRED: 'Chave expirada',
};

function normKey(raw) {
  return String(raw || '').trim().toLowerCase().slice(0, 48);
}

function generateKeyCode() {
  const p = () => crypto.randomBytes(3).toString('hex');
  return `ws-${p()}-${p()}-${p()}`.slice(0, 24);
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

function isKeyExpired(rec) {
  if (!rec.expiresAt) return false;
  return new Date(rec.expiresAt).getTime() < Date.now();
}

function keyStatus(rec) {
  if (!rec.active) return 'blocked';
  if (isKeyExpired(rec)) return 'expired';
  return rec.premium ? 'active' : 'free';
}

function findKey(code) {
  const k = normKey(code);
  if (!k) return null;
  return store.keys[k] || null;
}

function findKeyByBearer(bearer) {
  const b = String(bearer || '').trim();
  if (!b) return null;
  if (store.keys[b]) return store.keys[b];
  for (const rec of Object.values(store.keys)) {
    if (rec.bearer_token === b || rec.access_token_plugin === b) return rec;
  }
  return null;
}

const EMPTY_AUTH_GOOGLE = {
  user_id: '', name: '', picture: '', email_auth: '', access_token: '',
  expires_in: NaN, id_token: '', refresh_token: '', scope: '', token_type: '', updated_at: NaN,
};

function keyToUser(code, rec) {
  const st = keyStatus(rec);
  const premium = st === 'active';
  return {
    user_id: String(rec.user_id),
    name: rec.label || 'Usuario',
    email: rec.email || `${code}@waspeed.local`,
    wl_id: config.wlId,
    bearer_token: rec.bearer_token || code,
    access_token_plugin: rec.access_token_plugin || code,
    user_premium: premium,
    dataCadastro: rec.createdAt || new Date().toISOString(),
    whatsapp_registro: rec.lastPhone || '',
    whatsapp_plugin: rec.lastPhone || '',
    path: '',
    afiliado: '',
    campanhaID: '',
    start_form: true,
    cookies: { _fbc: '', _fbp: '', _ga: '', _ttclid: '', _ttp: '' },
  };
}

function authSuccess(code, rec) {
  const st = keyStatus(rec);
  if (st === 'blocked') return { ok: false, msg_id: 'user_blocked' };
  if (st === 'expired') return { ok: false, msg_id: 'license_expired' };
  rec.lastUsed = new Date().toISOString();
  saveStore();
  return {
    ok: true,
    body: {
      success: true,
      user: keyToUser(code, rec),
      auth_google: EMPTY_AUTH_GOOGLE,
      user_status: st === 'active' ? 'active' : 'free',
    },
  };
}

function createKey(input = {}, modName = null) {
  const code = normKey(input.code) || generateKeyCode();
  if (store.keys[code]) throw new Error('Chave ja existe');
  const userId = store.nextUserId++;
  const rec = {
    code,
    user_id: userId,
    label: input.label || 'Cliente',
    email: input.email || `${code}@waspeed.local`,
    active: input.active !== false,
    premium: input.premium !== false,
    expiresAt: input.expiresAt || null,
    expireDays: input.expireDays || 0,
    maxUses: input.maxUses ?? -1,
    phones: Array.isArray(input.phones) ? input.phones : [],
    uses: 0,
    note: input.note || '',
    modName: modName || input.modName || null,
    bearer_token: code,
    access_token_plugin: code,
    createdAt: new Date().toISOString(),
    lastUsed: null,
    lastIp: null,
    lastPhone: null,
  };
  if (input.expireDays > 0) {
    rec.expiresAt = new Date(Date.now() + input.expireDays * 86400000).toISOString();
  }
  store.keys[code] = rec;
  addLog('key_create', `Chave ${code} criada`, { code, modName });
  saveStore();
  return rec;
}

function addLog(type, message, meta = {}) {
  store.logs.unshift({ id: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString(), type, message, meta });
  if (store.logs.length > config.logMax) store.logs.length = config.logMax;
  saveStore();
}

function initSeed() {
  if (store._seeded) return;
  if (!store.mods.length) {
    store.mods.push({
      id: crypto.randomBytes(8).toString('hex'),
      username: 'mod',
      password: hashPassword('mod123'),
      name: 'Moderador',
      active: true,
    });
  }
  if (!Object.keys(store.keys).length) {
    createKey({ code: 'ws-demo-premium', label: 'Demo Premium', premium: true, note: 'Chave demo — troque em producao' });
    console.log('[WaSpeed] Chave demo: ws-demo-premium');
  }
  store._seeded = true;
  saveStore();
}

// --- Rate limit --------------------------------------------------------------

const RL = {
  login: { max: 10, windowMs: 60000, blockMs: 300000 },
  api: { max: 60, windowMs: 60000, blockMs: 120000 },
};
const rateMap = new Map();

function checkRate(ip, type = 'api') {
  const cfg = RL[type] || RL.api;
  const key = `${ip}:${type}`;
  const now = Date.now();
  let e = rateMap.get(key);
  if (!e || now > e.reset) e = { count: 0, reset: now + cfg.windowMs, blockedUntil: 0 };
  if (now < e.blockedUntil) return false;
  e.count++;
  if (e.count > cfg.max) e.blockedUntil = now + cfg.blockMs;
  rateMap.set(key, e);
  return e.count <= cfg.max;
}

// --- HTTP helpers ------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function corsHeaders(req, pathname) {
  const panel = pathname.startsWith(R_ADMIN) || pathname.startsWith(R_MOD);
  return {
    'Access-Control-Allow-Origin': panel ? 'null' : (req.headers.origin || '*'),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, access-token, accept',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
  };
}

function applyCors(req, res, pathname) {
  for (const [k, v] of Object.entries(corsHeaders(req, pathname))) res.setHeader(k, v);
}

async function readBody(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

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

function setCookie(res, name, value, maxAge = 604800) {
  res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function requireAccessToken(req) {
  return req.headers['access-token'] === config.criptKey;
}

function parseBearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : '';
}

function wppUpdate() {
  return { success: true, version: WPP_VERSION, update: false, message: 'WaSpeed server — modulo atualizado' };
}

// --- Painel HTML (estilo ZapVoice, tema WaSpeed) -----------------------------

const PANEL_CSS = `
:root{--bg:#0a0e14;--card:#121a24;--border:#243044;--text:#e8edf4;--muted:#8b9cb3;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--accent:#3b82f6}
*{box-sizing:border-box}body{margin:0;font-family:Segoe UI,system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
.wrap{max-width:1100px;margin:0 auto;padding:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
h1{font-size:1.4rem;margin:0 0 16px}
.muted{color:var(--muted);font-size:.9rem}
nav{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid var(--border)}
nav a{color:var(--accent);text-decoration:none;padding:6px 12px;border-radius:8px;background:#1a2535}
input,select,textarea{width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:#0d1219;color:var(--text);margin:6px 0 12px}
button,.btn{display:inline-block;padding:10px 16px;border:none;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;font-size:.9rem;text-decoration:none}
.btn-red{background:var(--red)}.btn-green{background:var(--green)}.btn-sm{padding:6px 10px;font-size:.8rem}
table{width:100%;border-collapse:collapse;font-size:.85rem}th,td{padding:10px 8px;border-bottom:1px solid var(--border);text-align:left}
th{color:var(--muted)}tr:hover td{background:#1a2332}
.badge{padding:2px 8px;border-radius:999px;font-size:.72rem;font-weight:600}
.badge-ok{background:#14532d;color:#86efac}.badge-off{background:#450a0a;color:#fca5a5}.badge-free{background:#422006;color:#fde68a}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:16px}
.stat{background:#0d1219;border-radius:10px;padding:14px;text-align:center}.stat .n{font-size:1.6rem;font-weight:700}
.key-mono{font-family:monospace;font-size:.85rem;word-break:break-all;background:#0d1219;padding:6px 8px;border-radius:6px}
.alert{padding:12px;border-radius:8px;margin-bottom:12px;background:#422006;color:#fde68a;border:1px solid #854d0e}
.login{max-width:380px;margin:80px auto}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1;min-width:160px}
`;

function panelLayout(title, body, nav = '') {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — WaSpeed</title><style>${PANEL_CSS}</style></head>
<body><div class="wrap">${nav}<h1>${esc(title)}</h1>${body}</div></body></html>`;
}

function freeBanner() {
  if (!config.ephemeral) return '';
  return `<div class="alert"><strong>Render Free Tier</strong> — dados em <code>${esc(config.dataDir)}</code> sao efemeros. Faca backup das chaves.</div>`;
}

function keysTable(keysList, base, canDelete) {
  const rows = keysList.map(({ code, rec }) => {
    const st = keyStatus(rec);
    const badge = st === 'active' ? '<span class="badge badge-ok">PRO</span>'
      : st === 'blocked' ? '<span class="badge badge-off">BLOQ</span>'
      : st === 'expired' ? '<span class="badge badge-off">EXP</span>'
      : '<span class="badge badge-free">FREE</span>';
    const exp = rec.expiresAt ? new Date(rec.expiresAt).toLocaleString('pt-BR') : '—';
    return `<tr>
      <td><span class="key-mono">${esc(code)}</span></td>
      <td>${esc(rec.label)}</td><td>${badge}</td><td>${exp}</td><td>${esc(rec.note)}</td>
      <td>
        <a class="btn btn-sm" href="${base}/keys/${encodeURIComponent(code)}">Editar</a>
        <form method="post" action="${base}/keys/${encodeURIComponent(code)}/toggle" style="display:inline"><button class="btn btn-sm" type="submit">${rec.active ? 'Bloquear' : 'Liberar'}</button></form>
        ${canDelete ? `<form method="post" action="${base}/keys/${encodeURIComponent(code)}/delete" style="display:inline" onsubmit="return confirm('Excluir?')"><button class="btn btn-sm btn-red" type="submit">X</button></form>` : ''}
      </td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Chave</th><th>Cliente</th><th>Status</th><th>Validade</th><th>Nota</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">Nenhuma chave</td></tr>'}</tbody></table>`;
}

function renderAdminDashboard() {
  const keys = Object.entries(store.keys);
  const active = keys.filter(([, r]) => keyStatus(r) === 'active').length;
  const nav = `<nav><a href="${R_ADMIN}">Dashboard</a><a href="${R_ADMIN}/keys">Chaves</a><a href="${R_ADMIN}/logs">Logs</a><a href="${R_ADMIN}/logout">Sair</a></nav>`;
  return panelLayout('Admin', `${freeBanner()}
    <div class="stats">
      <div class="stat"><div class="n">${keys.length}</div><div class="muted">Chaves</div></div>
      <div class="stat"><div class="n" style="color:var(--green)">${active}</div><div class="muted">Ativas PRO</div></div>
      <div class="stat"><div class="n">${store.logs.length}</div><div class="muted">Logs</div></div>
    </div>
    <div class="card"><p class="muted">API</p><p class="key-mono">${esc(config.baseUrl)}/api/</p>
    <p class="muted">access-token</p><p class="key-mono">${esc(config.criptKey)}</p>
    <p class="muted">Login extensao: somente chave (access_token_plugin)</p></div>
    <div class="card"><a class="btn btn-green" href="${R_ADMIN}/keys/new">+ Nova chave</a></div>`, nav);
}

function renderAdminKeys() {
  const list = Object.entries(store.keys).map(([code, rec]) => ({ code, rec }));
  const nav = `<nav><a href="${R_ADMIN}">Dashboard</a><a href="${R_ADMIN}/keys">Chaves</a><a href="${R_ADMIN}/logout">Sair</a></nav>`;
  return panelLayout('Chaves', `${freeBanner()}
    <div class="card"><a class="btn btn-green" href="${R_ADMIN}/keys/new">+ Nova chave</a></div>
    <div class="card">${keysTable(list, R_ADMIN, true)}</div>`, nav);
}

function renderKeyForm(base, rec, title) {
  const code = rec?.code || '';
  return panelLayout(title, `<div class="card"><form method="post">
    ${code ? `<p class="muted">Chave</p><p class="key-mono">${esc(code)}</p>` : ''}
    <label>Nome do cliente</label><input name="label" value="${esc(rec?.label || '')}" required>
    <div class="row">
      <div><label>Premium (PRO)</label><select name="premium"><option value="1" ${rec?.premium !== false ? 'selected' : ''}>Sim</option><option value="0" ${rec?.premium === false ? 'selected' : ''}>Free</option></select></div>
      <div><label>Dias validade (0=sem)</label><input name="expireDays" type="number" min="0" value="${rec?.expireDays || 0}"></div>
    </div>
    <label>Nota</label><textarea name="note" rows="2">${esc(rec?.note || '')}</textarea>
    <button type="submit">Salvar</button>
  </form></div>`, `<nav><a href="${base}/keys">Voltar</a></nav>`);
}

function renderLogin(base, role, err = '') {
  return panelLayout('Login', `<div class="login card">
    <p class="muted">Painel ${role}</p>
    ${err ? `<div class="alert">${esc(err)}</div>` : ''}
    <form method="post" action="${base}/login">
      <label>Usuario</label><input name="user" required autocomplete="username">
      <label>Senha</label><input name="pass" type="password" required autocomplete="current-password">
      <button type="submit">Entrar</button>
    </form></div>`);
}

// --- Router ------------------------------------------------------------------

async function handleWaSpeedApi(req, res, pathname, ip) {
  const chromeId = config.chromeStoreId;

  // Publicas
  if (pathname === '/api/urls/install/' + chromeId || pathname.match(/^\/api\/urls\/install\//)) {
    addLog('install', 'Redirect install', { ip });
    return sendJson(res, { success: true, url: store.settings.installUrl || config.installUrl });
  }
  if (pathname.match(/^\/api\/urls\/uninstall\//)) {
    return sendJson(res, { success: true, url: `${config.baseUrl}/obrigado` });
  }
  if (pathname.match(/^\/api\/urls\/active-notes\//)) {
    return sendJson(res, { success: true, path_note_update: { redirect: config.notesRedirect } });
  }
  if (pathname.match(/^\/api\/urls\/notes\//)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(req, pathname) });
    return res.end(store.settings.notesHtml || '<h1>WaSpeed</h1>');
  }
  if (pathname === '/api/urls/update' && (req.method === 'GET' || req.method === 'POST')) {
    return sendJson(res, wppUpdate());
  }
  if (pathname === '/api/services/update' && (req.method === 'GET' || req.method === 'POST')) {
    return sendJson(res, wppUpdate());
  }
  if (pathname === '/api/external/is_instaled' && req.method === 'POST') {
    return sendJson(res, { success: true });
  }
  if (pathname === '/api/external/ping') {
    return sendJson(res, { success: true, server: 'waspeed', version: '2.0.0', keys: Object.keys(store.keys).length, ephemeral: config.ephemeral });
  }

  if (!requireAccessToken(req)) {
    return sendJson(res, { success: false, msg_id: 'invalid_access_token' }, 403);
  }

  // Auth por chave
  if (pathname === `/api/auth/login-bearer/${chromeId}` && req.method === 'GET') {
    if (!checkRate(ip, 'login')) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const bearer = parseBearer(req);
    const rec = findKeyByBearer(bearer);
    const code = rec ? (rec.code || bearer) : null;
    if (!rec) {
      addLog('auth_fail', 'Bearer invalido', { ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token' });
    }
    const result = authSuccess(code, rec);
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    addLog('auth_ok', `Login bearer ${code}`, { ip });
    return sendJson(res, result.body);
  }

  if (pathname === `/api/auth/validation/${chromeId}` && req.method === 'POST') {
    if (!checkRate(ip, 'login')) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const body = await readJson(req);
    const key = normKey(body.access_token_plugin || body.chave || body.senha || body.email);
    const rec = findKey(key);
    if (!rec) {
      addLog('auth_fail', 'Chave invalida validation', { ip, key });
      return sendJson(res, { success: false, msg_id: 'invalid_token_in_validation' });
    }
    const result = authSuccess(key, rec);
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    addLog('validation_ok', `Validacao ${key}`, { ip });
    return sendJson(res, result.body);
  }

  if (pathname === `/api/auth/login/${chromeId}` && req.method === 'POST') {
    if (!checkRate(ip, 'login')) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const body = await readJson(req);
    const key = normKey(body.senha || body.chave || body.email || body.access_token_plugin);
    const rec = findKey(key);
    if (!rec) {
      addLog('auth_fail', 'Login chave invalida', { ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token' });
    }
    const result = authSuccess(key, rec);
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    addLog('auth_ok', `Login ${key}`, { ip });
    return sendJson(res, result.body);
  }

  if (pathname === '/api/user/update' && req.method === 'POST') {
    const body = await readJson(req);
    const bearer = parseBearer(req) || body.bearer_token;
    const rec = findKeyByBearer(bearer);
    if (!rec) return sendJson(res, { success: false, msg_id: 'invalid_token' });
    if (body.whatsapp_plugin || body.whatsapp_registro) {
      rec.lastPhone = body.whatsapp_plugin || body.whatsapp_registro;
    }
    if (body.name) rec.label = body.name;
    saveStore();
    const code = rec.code || bearer;
    return sendJson(res, { success: true, user: keyToUser(code, rec) });
  }

  if (pathname === `/api/services/initial-data/${chromeId}`) {
    const s = store.settings;
    return sendJson(res, { webhooks: s.webhooks || [], meet: s.meet || {}, urls: s.urls || {}, migration: s.migration || {} });
  }

  if (pathname === '/api/image/url-to-base64' && req.method === 'POST') {
    return sendJson(res, { success: false, msg_id: 'not_implemented' });
  }

  return false;
}

function isAdmin(req) {
  const s = verifySession(parseCookies(req).ws_session);
  return s && s.role === 'admin';
}

function isMod(req) {
  const s = verifySession(parseCookies(req).ws_session);
  return s && s.role === 'mod';
}

async function handleAdmin(req, res, pathname) {
  if (pathname === R_ADMIN + '/login') {
    if (req.method === 'GET') return sendHtml(res, renderLogin(R_ADMIN, 'Admin'));
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const user = params.get('user') || '';
    const pass = params.get('pass') || '';
    if (user === config.adminUser && pass === config.adminPass) {
      setCookie(res, 'ws_session', signSession({ role: 'admin', user, exp: Date.now() + 7 * 86400000 }));
      res.writeHead(302, { Location: R_ADMIN });
      return res.end();
    }
    return sendHtml(res, renderLogin(R_ADMIN, 'Admin', 'Credenciais invalidas'), 401);
  }
  if (pathname === R_ADMIN + '/logout') {
    setCookie(res, 'ws_session', '', 0);
    res.writeHead(302, { Location: R_ADMIN + '/login' });
    return res.end();
  }
  if (!isAdmin(req)) {
    res.writeHead(302, { Location: R_ADMIN + '/login' });
    return res.end();
  }

  if (pathname === R_ADMIN || pathname === R_ADMIN + '/') return sendHtml(res, renderAdminDashboard());
  if (pathname === R_ADMIN + '/keys') return sendHtml(res, renderAdminKeys());

  if (pathname === R_ADMIN + '/keys/new') {
    if (req.method === 'GET') return sendHtml(res, renderKeyForm(R_ADMIN, null, 'Nova chave'));
    const body = await readBody(req);
    const p = new URLSearchParams(body);
    const rec = createKey({
      label: p.get('label'),
      premium: p.get('premium') !== '0',
      expireDays: Number(p.get('expireDays') || 0),
      note: p.get('note') || '',
    });
    res.writeHead(302, { Location: `${R_ADMIN}/keys/${encodeURIComponent(rec.code)}` });
    return res.end();
  }

  const keyEdit = pathname.match(new RegExp(`^${R_ADMIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/keys/([^/]+)$`));
  if (keyEdit) {
    const code = decodeURIComponent(keyEdit[1]);
    const rec = findKey(code);
    if (!rec) {
      res.writeHead(404);
      return res.end('Not found');
    }
    if (req.method === 'GET') return sendHtml(res, renderKeyForm(R_ADMIN, rec, 'Editar chave'));
    const body = await readBody(req);
    const p = new URLSearchParams(body);
    rec.label = p.get('label') || rec.label;
    rec.premium = p.get('premium') !== '0';
    rec.note = p.get('note') || '';
    const days = Number(p.get('expireDays') || 0);
    if (days > 0) rec.expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    saveStore();
    res.writeHead(302, { Location: R_ADMIN + '/keys' });
    return res.end();
  }

  const keyToggle = pathname.match(new RegExp(`^${R_ADMIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/keys/([^/]+)/toggle$`));
  if (keyToggle && req.method === 'POST') {
    const code = decodeURIComponent(keyToggle[1]);
    const rec = findKey(code);
    if (rec) {
      rec.active = !rec.active;
      saveStore();
    }
    res.writeHead(302, { Location: R_ADMIN + '/keys' });
    return res.end();
  }

  const keyDel = pathname.match(new RegExp(`^${R_ADMIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/keys/([^/]+)/delete$`));
  if (keyDel && req.method === 'POST') {
    const code = decodeURIComponent(keyDel[1]);
    delete store.keys[code];
    saveStore();
    res.writeHead(302, { Location: R_ADMIN + '/keys' });
    return res.end();
  }

  if (pathname === R_ADMIN + '/logs') {
    const rows = store.logs.slice(0, 200).map((l) =>
      `<tr><td>${new Date(l.at).toLocaleString('pt-BR')}</td><td>${esc(l.type)}</td><td>${esc(l.message)}</td></tr>`).join('');
    const nav = `<nav><a href="${R_ADMIN}">Dashboard</a><a href="${R_ADMIN}/logs">Logs</a><a href="${R_ADMIN}/logout">Sair</a></nav>`;
    return sendHtml(res, panelLayout('Logs', `<div class="card"><table><thead><tr><th>Data</th><th>Tipo</th><th>Msg</th></tr></thead><tbody>${rows}</tbody></table></div>`, nav));
  }

  res.writeHead(404);
  return res.end('Not found');
}

async function handleMod(req, res, pathname) {
  if (pathname === R_MOD + '/login') {
    if (req.method === 'GET') return sendHtml(res, renderLogin(R_MOD, 'Moderador'));
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const user = params.get('user') || '';
    const pass = params.get('pass') || '';
    const mod = store.mods.find((m) => m.username === user && m.active !== false);
    if (mod && verifyPassword(pass, mod.password)) {
      setCookie(res, 'ws_session', signSession({ role: 'mod', user, modId: mod.id, name: mod.name, exp: Date.now() + 7 * 86400000 }));
      res.writeHead(302, { Location: R_MOD });
      return res.end();
    }
    return sendHtml(res, renderLogin(R_MOD, 'Moderador', 'Credenciais invalidas'), 401);
  }
  if (pathname === R_MOD + '/logout') {
    setCookie(res, 'ws_session', '', 0);
    res.writeHead(302, { Location: R_MOD + '/login' });
    return res.end();
  }
  if (!isMod(req)) {
    res.writeHead(302, { Location: R_MOD + '/login' });
    return res.end();
  }

  const sess = verifySession(parseCookies(req).ws_session);
  const modName = sess.name;
  const list = Object.entries(store.keys).filter(([, r]) => r.modName === modName).map(([code, rec]) => ({ code, rec }));

  if (pathname === R_MOD || pathname === R_MOD + '/') {
    const nav = `<nav><a href="${R_MOD}">Chaves</a><a href="${R_MOD}/keys/new">Nova</a><a href="${R_MOD}/logout">Sair (${esc(modName)})</a></nav>`;
    return sendHtml(res, panelLayout('Moderador', `<div class="card">${keysTable(list, R_MOD, false)}</div>`, nav));
  }

  if (pathname === R_MOD + '/keys/new' && req.method === 'POST') {
    const body = await readBody(req);
    const p = new URLSearchParams(body);
    createKey({ label: p.get('label'), premium: p.get('premium') !== '0', note: p.get('note') || '' }, modName);
    res.writeHead(302, { Location: R_MOD });
    return res.end();
  }

  if (pathname === R_MOD + '/keys/new' && req.method === 'GET') {
    return sendHtml(res, renderKeyForm(R_MOD, null, 'Nova chave (mod)'));
  }

  res.writeHead(404);
  return res.end('Not found');
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
  const pathname = url.pathname;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';

  applyCors(req, res, pathname);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (pathname === '/health') {
      return sendJson(res, {
        ok: true, service: 'waspeed-server', version: '2.0.0',
        keys: Object.keys(store.keys).length, dataDir: config.dataDir, ephemeral: config.ephemeral,
      });
    }

    if (pathname === '/') {
      return sendHtml(res, panelLayout('WaSpeed Server', `${freeBanner()}
        <div class="card"><p>Backend: <strong>${esc(config.baseUrl)}</strong></p>
        <p><a class="btn" href="${R_ADMIN}">Admin</a> <a class="btn" href="${R_MOD}">Mod</a></p>
        <p class="muted">Login extensao: somente chave · API: /api/auth/validation/:id</p></div>`));
    }

    if (pathname === '/config.json') {
      res.setHeader('Cache-Control', 'public, max-age=300');
      return sendJson(res, buildConfigJson(store.settings.domConfig || {}));
    }

    if (pathname === '/api/code') {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.writeHead(200);
      res.end('/* WaSpeed remote code stub — WPP injetado localmente pela extensao */\n');
      return;
    }

    if (pathname === '/obrigado') {
      return sendHtml(res, '<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>WaSpeed</h1><p>Obrigado!</p></body></html>');
    }

    // Utils stubs
    if (pathname.startsWith('/utils/')) {
      return sendJson(res, { success: false, msg_id: 'not_configured', message: 'Nao configurado neste servidor' }, 501);
    }

    if (pathname.startsWith('/api/')) {
      const handled = await handleWaSpeedApi(req, res, pathname, ip);
      if (handled !== false) return;
      return sendJson(res, { success: false, msg_id: 'not_found' }, 404);
    }

    if (pathname.startsWith(R_ADMIN)) return handleAdmin(req, res, pathname);
    if (pathname.startsWith(R_MOD)) return handleMod(req, res, pathname);

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error('[WaSpeed]', err);
    sendJson(res, { success: false, msg_id: 'server_error' }, 500);
  }
}

// --- Bootstrap ---------------------------------------------------------------

loadStore();
initSeed();

const startedAt = new Date().toISOString();
const server = http.createServer(handleRequest);

server.listen(config.port, () => {
  console.log(`WaSpeed Server v2 em http://localhost:${config.port}`);
  console.log(`Dados: ${config.dataDir}${config.ephemeral ? ' (efemero)' : ''}`);
  console.log(`Chaves: ${Object.keys(store.keys).length}`);
  console.log(`Admin: ${config.baseUrl}${R_ADMIN}`);
  console.log(`Mod:   ${config.baseUrl}${R_MOD}`);
  console.log(`Health: ${config.baseUrl}/health`);
  if (store.keys['ws-demo-premium']) console.log('Demo: ws-demo-premium');
});

function shutdown(sig) {
  console.log(`[WaSpeed] ${sig} — encerrando`);
  flushStore();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
