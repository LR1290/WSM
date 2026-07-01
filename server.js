import http from 'node:http';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';

const PORT            = Number(process.env.PORT) || 3000;
const MONGO_URI       = process.env.MONGO_URI || '';
const WT_ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'ffce211a-7b07-4d91-ba5d-c40bb4034a83';
const ADMIN_USER      = process.env.ADMIN_EMAIL || 'admin@watidy.local';
const ADMIN_PASS      = process.env.ADMIN_PASS  || 'admin123';
const APP_SECRET      = process.env.APP_SECRET  || crypto.randomBytes(32).toString('hex');
const NODE_ENV        = process.env.NODE_ENV    || 'development';
const BASE_URL        = (process.env.BASE_URL   || `http://localhost:${PORT}`).replace(/\/$/, '');
const LOG_RETENTION_D = Number(process.env.LOG_RETENTION_DAYS) || 90;

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const WT_COOKIE      = 'wt_sess';
const WT_WL_ID       = 'watidy';

const COL = {
  licenses : 'licenses',
  sessions : 'sessions',
  logs     : 'logs',
  settings : 'settings',
};

const hmacSlug = (tag) =>
  crypto.createHmac('sha256', APP_SECRET).update(tag).digest('hex').slice(0, 12);

let _adminSlug = null;
let _modSlug   = null;
const R_ADMIN = () => (_adminSlug ??= '/wt-' + hmacSlug('admin'));
const R_MOD   = () => (_modSlug   ??= '/wt-' + hmacSlug('mod'));

const DOM_DEFAULTS = {
  version      : '7.4.3.58',
  dom_selector : { version: '7.4.3.58', selector: [], model: 'watidy' },
  remote_code  : BASE_URL + '/',
};

let _db     = null;
let _client = null;
let _cbOpen = false;
let _cbFails = 0;
const CB_THRESHOLD = 5;
const CB_RESET_MS  = 30_000;
let _cbResetTimer  = null;

async function getDb() {
  if (_cbOpen) throw new Error('MongoDB circuit open');
  if (_db) return _db;
  _client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await _client.connect();
  _db = _client.db('watidy');
  _cbFails = 0;
  return _db;
}

function recordDbFail() {
  _cbFails++;
  _db = null;
  if (_cbFails >= CB_THRESHOLD) {
    _cbOpen = true;
    clearTimeout(_cbResetTimer);
    _cbResetTimer = setTimeout(() => { _cbOpen = false; _cbFails = 0; }, CB_RESET_MS);
  }
}

async function ensureIndexes(db) {
  const lic = db.collection(COL.licenses);
  const ses = db.collection(COL.sessions);
  const log = db.collection(COL.logs);
  await lic.createIndex({ code: 1 }, { unique: true, sparse: true });
  await lic.createIndex({ bearer_token: 1 }, { sparse: true });
  await lic.createIndex({ email: 1 }, { sparse: true });
  await ses.createIndex({ sid: 1 }, { unique: true });
  await ses.createIndex({ createdAt: 1 }, { expireAfterSeconds: Math.floor(SESSION_TTL_MS / 1000) });
  await log.createIndex({ createdAt: 1 }, { expireAfterSeconds: LOG_RETENTION_D * 86400 });
  await log.createIndex({ action: 1, ip: 1, createdAt: 1 });
}

async function initSeed(db) {
  const col = db.collection(COL.settings);
  if (await col.findOne({ _id: 'admin' })) return;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await pbkdf2(ADMIN_PASS, salt);
  await col.insertOne({ _id: 'admin', user: ADMIN_USER, hash, salt, createdAt: new Date() });
}

function pbkdf2(pass, salt) {
  return new Promise((res, rej) =>
    crypto.pbkdf2(pass, salt, 310_000, 32, 'sha256', (e, k) => (e ? rej(e) : res(k.toString('hex'))))
  );
}

async function verifyAdminCredentials(user, pass) {
  const db  = await getDb();
  const doc = await db.collection(COL.settings).findOne({ _id: 'admin' });
  if (!doc || doc.user !== user) return false;
  const hash = await pbkdf2(pass, doc.salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(doc.hash));
}

function sanitizeDoc(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sanitizeDoc);
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => !k.startsWith('$') && !k.includes('.'))
      .map(([k, val]) => [k, sanitizeDoc(val)])
  );
}

const _rateLimits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let entry = _rateLimits.get(key);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + windowMs };
    _rateLimits.set(key, entry);
  }
  entry.count++;
  return entry.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateLimits) if (now > v.reset) _rateLimits.delete(k);
}, 60_000);

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, Buffer.alloc(ba.length));
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';').map(s => s.trim().split('=')).filter(p => p.length >= 2).map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join('=').trim())])
  );
}

function setCookie(res, name, value, maxAgeMs) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}`);
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

async function createSession(db, meta) {
  const sid = crypto.randomBytes(32).toString('hex');
  await db.collection(COL.sessions).insertOne({ sid, ...meta, createdAt: new Date() });
  return sid;
}

async function validateSession(db, sid) {
  if (!sid) return null;
  return db.collection(COL.sessions).findOne({ sid });
}

async function destroySession(db, sid) {
  if (!sid) return;
  await db.collection(COL.sessions).deleteOne({ sid });
}

async function findKey(db, code) {
  if (!code) return null;
  return db.collection(COL.licenses).findOne({ $or: [{ code }, { access_token_plugin: code }] });
}

async function findKeyByBearer(db, bearer) {
  if (!bearer) return null;
  return db.collection(COL.licenses).findOne({ bearer_token: bearer });
}

async function findKeyByEmail(db, email) {
  if (!email) return null;
  return db.collection(COL.licenses).findOne({ email: email.toLowerCase() });
}

function keyStatus(rec) {
  if (!rec) return 'not_found';
  if (rec.blocked) return 'blocked';
  if (rec.expiresAt && new Date(rec.expiresAt) < new Date()) return 'expired';
  if (rec.maxUses != null && rec.maxUses !== -1 && (rec.usedCount || 0) >= rec.maxUses) return 'expired';
  if (!rec.active) return 'pending';
  return 'active';
}

function userStatus(rec) {
  const st = keyStatus(rec);
  if (st === 'active')  return 'active';
  if (st === 'expired') return 'overdue';
  if (st === 'blocked') return 'suspended';
  if (st === 'pending') return 'active';
  return 'suspended';
}

function buildUserPremium(code, rec) {
  if (!rec || keyStatus(rec) !== 'active') return null;
  return {
    id_assinatura  : String(rec.user_id || code),
    data_liberacao : (rec.createdAt ? new Date(rec.createdAt) : new Date()).toISOString().slice(0, 10),
    teste          : rec.trial ? '1' : '0',
    plan           : rec.plan || 'pro',
    active         : true,
    features       : rec.features || ['all'],
    expiresAt      : rec.expiresAt || null,
    maxUses        : rec.maxUses != null ? rec.maxUses : -1,
  };
}

function keyToUser(code, rec) {
  return {
    user_id             : String(rec.user_id || code),
    name                : rec.label || 'Usuario',
    email               : rec.email || '',
    wl_id               : WT_WL_ID,
    bearer_token        : rec.bearer_token || code,
    access_token_plugin : rec.access_token_plugin || code,
    user_premium        : buildUserPremium(code, rec),
    dataCadastro        : (rec.createdAt ? new Date(rec.createdAt) : new Date()).toISOString(),
    whatsapp_registro   : rec.lastPhone || '',
    whatsapp_plugin     : rec.lastPhone || '',
    path                : '',
    afiliado            : '',
    campanhaID          : '',
    start_form          : true,
    cookies             : { _fbc: '', _fbp: '', _ga: '', _ttclid: '', _ttp: '' },
  };
}

function authSuccess(rec, code) {
  const st = keyStatus(rec);
  if (st === 'blocked')   return { ok: false, msg_id: 'user_blocked' };
  if (st === 'expired')   return { ok: false, msg_id: 'license_expired' };
  if (st === 'not_found') return { ok: false, msg_id: 'key_not_found' };
  return { ok: true, user: keyToUser(code, rec), us: userStatus(rec) };
}

async function logEvent(db, action, ip, meta) {
  try {
    await db.collection(COL.logs).insertOne({ action, ip, ...meta, createdAt: new Date() });
  } catch (_) {}
}

async function buildConfigJson(db) {
  try {
    const doc = await db.collection(COL.settings).findOne({ _id: 'config' });
    if (doc) {
      const { _id, ...cfg } = doc;
      return cfg;
    }
  } catch (_) {}
  return {
    dom_selector : DOM_DEFAULTS.dom_selector,
    remote_code  : DOM_DEFAULTS.remote_code,
    version      : DOM_DEFAULTS.version,
    updatedAt    : new Date().toISOString(),
  };
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); return reject(new Error('body_too_large')); }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function secureHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');
}

function corsHeaders(res, origin) {
  const allowed = ['chrome-extension://gjlfpggiddcminhebiejofeglfjmleli'];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, access-token, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, html, status = 200) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function send404(res) { sendJson(res, { error: 'not_found' }, 404); }

function checkAccessToken(req) {
  const t = req.headers['access-token'] || req.headers['x-access-token'] || '';
  return timingSafeEqualStr(t, WT_ACCESS_TOKEN);
}

function extractBearer(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

const PANEL_CSS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}.sidebar{position:fixed;top:0;left:0;width:220px;height:100vh;background:#161b22;border-right:1px solid #30363d;display:flex;flex-direction:column;padding:16px 0;z-index:100}.sidebar-logo{padding:12px 20px 20px;font-size:18px;font-weight:700;color:#58a6ff;border-bottom:1px solid #30363d;margin-bottom:8px}.sidebar a{display:block;padding:10px 20px;color:#8b949e;font-size:14px;border-left:3px solid transparent;transition:all .15s}.sidebar a:hover,.sidebar a.active{color:#e6edf3;border-left-color:#58a6ff;background:#1c2128;text-decoration:none}.main{margin-left:220px;padding:24px}.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #30363d}.topbar h1{font-size:20px;font-weight:600}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;margin-bottom:20px}.card h2{font-size:14px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:16px}.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px}.stat{background:#1c2128;border:1px solid #30363d;border-radius:8px;padding:16px;text-align:center}.stat-num{font-size:28px;font-weight:700;color:#58a6ff}.stat-lbl{font-size:12px;color:#8b949e;margin-top:4px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:8px 12px;color:#8b949e;border-bottom:1px solid #30363d;font-weight:500}td{padding:8px 12px;border-bottom:1px solid #21262d}tr:hover td{background:#1c2128}.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}.badge-green{background:#1a3a1a;color:#3fb950}.badge-red{background:#3a1a1a;color:#f85149}.badge-yellow{background:#3a2a1a;color:#d29922}.badge-gray{background:#21262d;color:#8b949e}.form-group{margin-bottom:16px}.form-group label{display:block;font-size:13px;color:#8b949e;margin-bottom:6px}.form-group input,.form-group select,.form-group textarea{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 12px;color:#e6edf3;font-size:14px}.form-group input:focus{outline:none;border-color:#58a6ff}.btn{display:inline-block;padding:8px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:500;transition:opacity .15s}.btn-primary{background:#238636;color:#fff}.btn-primary:hover{opacity:.85}.btn-danger{background:#da3633;color:#fff}.btn-danger:hover{opacity:.85}.btn-secondary{background:#21262d;color:#e6edf3;border:1px solid #30363d}.btn-secondary:hover{opacity:.85}.alert{padding:12px 16px;border-radius:6px;margin-bottom:16px;font-size:13px}.alert-error{background:#3a1a1a;border:1px solid #f85149;color:#f85149}.alert-success{background:#1a3a1a;border:1px solid #3fb950;color:#3fb950}input[type=checkbox]{width:auto;margin-right:8px}.modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;align-items:center;justify-content:center}.modal-backdrop.open{display:flex}.modal{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:24px;width:460px;max-width:95vw}.modal h3{font-size:16px;margin-bottom:16px}.modal-footer{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}.pagination{display:flex;gap:4px;margin-top:16px;align-items:center;font-size:13px}.pagination a{padding:4px 10px;border:1px solid #30363d;border-radius:4px;color:#8b949e}.pagination a.active,.pagination a:hover{border-color:#58a6ff;color:#58a6ff}`;

function spaShell(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — WaTiDy</title><style>${PANEL_CSS}</style></head><body>${bodyHtml}</body></html>`;
}

function renderLoginShell(error = '') {
  const errHtml = error ? `<div class="alert alert-error">${error}</div>` : '';
  return spaShell('Login', `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="width:360px"><div style="text-align:center;margin-bottom:32px"><div style="font-size:32px;font-weight:700;color:#58a6ff">WaTiDy</div><div style="color:#8b949e;font-size:14px;margin-top:4px">Painel Administrativo</div></div>${errHtml}<form method="POST" style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:28px"><div class="form-group"><label>Email</label><input name="user" type="text" autocomplete="username" required></div><div class="form-group"><label>Senha</label><input name="pass" type="password" autocomplete="current-password" required></div><button class="btn btn-primary" style="width:100%">Entrar</button></form></div></div>`);
}

function adminSidebar(active, base) {
  const links = [['/', 'Dashboard'], ['/licenses', 'Licenças'], ['/logs', 'Logs'], ['/settings', 'Configurações']];
  const items = links.map(([p, l]) => `<a href="${base}${p}" class="${active === l ? 'active' : ''}">${l}</a>`).join('');
  return `<div class="sidebar"><div class="sidebar-logo">WaTiDy</div>${items}<a href="${base}/logout" style="margin-top:auto;color:#f85149">Sair</a></div>`;
}

function buildLicenseRows(docs) {
  if (!docs.length) return '<tr><td colspan="7" style="text-align:center;color:#8b949e;padding:32px">Nenhuma licença encontrada</td></tr>';
  return docs.map(d => {
    const st = keyStatus(d);
    const bm = { active: 'badge-green', expired: 'badge-yellow', blocked: 'badge-red', pending: 'badge-gray' };
    const exp = d.expiresAt ? new Date(d.expiresAt).toLocaleDateString('pt-BR') : '—';
    const code = (d.code || d.access_token_plugin || '').slice(0, 20) + '…';
    return `<tr><td style="font-family:monospace;font-size:11px">${code}</td><td>${d.email || '—'}</td><td>${d.label || '—'}</td><td><span class="badge ${bm[st] || 'badge-gray'}">${st}</span></td><td>${exp}</td><td>${d.usedCount || 0}${d.maxUses != null && d.maxUses !== -1 ? '/' + d.maxUses : ''}</td><td><button class="btn btn-secondary" style="font-size:11px" onclick="editLic(${JSON.stringify(JSON.stringify(d))})">Editar</button> <button class="btn btn-danger" style="font-size:11px" onclick="delLic('${d._id}')">Del</button></td></tr>`;
  }).join('');
}

function buildLogRows(docs) {
  if (!docs.length) return '<tr><td colspan="4" style="text-align:center;color:#8b949e;padding:32px">Nenhum log</td></tr>';
  return docs.map(d => {
    const ts = d.createdAt ? new Date(d.createdAt).toLocaleString('pt-BR') : '—';
    const detail = d.key ? d.key.slice(0, 20) + '…' : (d.detail || '—');
    return `<tr><td>${ts}</td><td><span class="badge badge-gray">${d.action || '—'}</span></td><td>${d.ip || '—'}</td><td style="font-size:11px;color:#8b949e">${detail}</td></tr>`;
  }).join('');
}

async function renderAdminDash(db, relPath, query, session, base) {
  const page  = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const limit = 30;
  const skip  = (page - 1) * limit;

  if (relPath === '/') {
    const [total, active, blocked] = await Promise.all([
      db.collection(COL.licenses).countDocuments({}),
      db.collection(COL.licenses).countDocuments({ active: true, blocked: { $ne: true } }),
      db.collection(COL.licenses).countDocuments({ blocked: true }),
    ]);
    const recentLogs = await db.collection(COL.logs).find({}).sort({ createdAt: -1 }).limit(10).toArray();
    return spaShell('Dashboard', `${adminSidebar('Dashboard', base)}<div class="main"><div class="topbar"><h1>Dashboard</h1><span style="color:#8b949e;font-size:13px">${session.user}</span></div><div class="stats-grid"><div class="stat"><div class="stat-num">${total}</div><div class="stat-lbl">Total Licenças</div></div><div class="stat"><div class="stat-num">${active}</div><div class="stat-lbl">Ativas</div></div><div class="stat"><div class="stat-num">${blocked}</div><div class="stat-lbl">Bloqueadas</div></div></div><div class="card"><h2>Atividade Recente</h2><table><thead><tr><th>Data</th><th>Ação</th><th>IP</th><th>Detalhe</th></tr></thead><tbody>${buildLogRows(recentLogs)}</tbody></table></div></div>`);
  }

  if (relPath === '/licenses') {
    const search = query.q || '';
    const filter = search ? { $or: [{ code: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }, { label: { $regex: search, $options: 'i' } }] } : {};
    const [docs, total] = await Promise.all([
      db.collection(COL.licenses).find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      db.collection(COL.licenses).countDocuments(filter),
    ]);
    const pages = Math.ceil(total / limit);
    const pag = pages > 1 ? Array.from({ length: pages }, (_, i) => i + 1).map(p =>
      `<a href="${base}/licenses?page=${p}&q=${encodeURIComponent(search)}" class="${p === page ? 'active' : ''}">${p}</a>`
    ).join('') : '';
    return spaShell('Licenças', `${adminSidebar('Licenças', base)}<div class="main"><div class="topbar"><h1>Licenças</h1><button class="btn btn-primary" onclick="openCreate()">+ Nova Licença</button></div><div class="card"><form method="GET" style="display:flex;gap:8px;margin-bottom:16px"><input name="q" value="${search}" placeholder="Buscar por código, email, label…" style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 12px;color:#e6edf3;font-size:13px"><button class="btn btn-secondary">Buscar</button></form><table><thead><tr><th>Código</th><th>Email</th><th>Label</th><th>Status</th><th>Expira</th><th>Usos</th><th>Ações</th></tr></thead><tbody>${buildLicenseRows(docs)}</tbody></table><div class="pagination">${pag}</div></div></div>
<div class="modal-backdrop" id="modal-create"><div class="modal"><h3>Nova Licença</h3><div class="form-group"><label>Código</label><input id="lic-code" placeholder="vazio = automático"></div><div class="form-group"><label>Email</label><input id="lic-email" type="email"></div><div class="form-group"><label>Label</label><input id="lic-label"></div><div class="form-group"><label>Plano</label><select id="lic-plan"><option value="pro">Pro</option><option value="basic">Basic</option></select></div><div class="form-group"><label>Max Usos (-1 = ilimitado)</label><input id="lic-maxuses" type="number" value="-1"></div><div class="form-group"><label>Expira em (dias, 0 = nunca)</label><input id="lic-days" type="number" value="30"></div><div class="form-group"><label><input type="checkbox" id="lic-active" checked>Ativa imediatamente</label></div><div class="form-group"><label><input type="checkbox" id="lic-trial">Período de teste</label></div><div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal('modal-create')">Cancelar</button><button class="btn btn-primary" onclick="submitCreate()">Criar</button></div></div></div>
<div class="modal-backdrop" id="modal-edit"><div class="modal"><h3>Editar Licença</h3><input type="hidden" id="edit-id"><div class="form-group"><label>Email</label><input id="edit-email" type="email"></div><div class="form-group"><label>Label</label><input id="edit-label"></div><div class="form-group"><label>Plano</label><select id="edit-plan"><option value="pro">Pro</option><option value="basic">Basic</option></select></div><div class="form-group"><label>Max Usos (-1 = ilimitado)</label><input id="edit-maxuses" type="number"></div><div class="form-group"><label>Expira em</label><input id="edit-expiry" type="date"></div><div class="form-group"><label><input type="checkbox" id="edit-active">Ativa</label></div><div class="form-group"><label><input type="checkbox" id="edit-blocked">Bloqueada</label></div><div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal('modal-edit')">Cancelar</button><button class="btn btn-primary" onclick="submitEdit()">Salvar</button></div></div></div>
<script>
const api=async(u,o={})=>{const r=await fetch(u,o);return r.json()};
function openCreate(){document.getElementById('modal-create').classList.add('open')}
function closeModal(id){document.getElementById(id).classList.remove('open')}
async function submitCreate(){
  const days=parseInt(document.getElementById('lic-days').value)||0;
  const p={code:document.getElementById('lic-code').value,email:document.getElementById('lic-email').value,label:document.getElementById('lic-label').value,plan:document.getElementById('lic-plan').value,maxUses:parseInt(document.getElementById('lic-maxuses').value),expiresInDays:days,active:document.getElementById('lic-active').checked,trial:document.getElementById('lic-trial').checked};
  const r=await api('/api/admin/licenses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
  if(r.success)location.reload();else alert(r.error||'Erro');
}
function editLic(j){
  const d=JSON.parse(j);
  document.getElementById('edit-id').value=d._id;
  document.getElementById('edit-email').value=d.email||'';
  document.getElementById('edit-label').value=d.label||'';
  document.getElementById('edit-plan').value=d.plan||'pro';
  document.getElementById('edit-maxuses').value=d.maxUses!=null?d.maxUses:-1;
  document.getElementById('edit-expiry').value=d.expiresAt?new Date(d.expiresAt).toISOString().slice(0,10):'';
  document.getElementById('edit-active').checked=!!d.active;
  document.getElementById('edit-blocked').checked=!!d.blocked;
  document.getElementById('modal-edit').classList.add('open');
}
async function submitEdit(){
  const id=document.getElementById('edit-id').value;
  const ev=document.getElementById('edit-expiry').value;
  const p={email:document.getElementById('edit-email').value,label:document.getElementById('edit-label').value,plan:document.getElementById('edit-plan').value,maxUses:parseInt(document.getElementById('edit-maxuses').value),expiresAt:ev?new Date(ev).toISOString():null,active:document.getElementById('edit-active').checked,blocked:document.getElementById('edit-blocked').checked};
  const r=await api('/api/admin/licenses/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
  if(r.success)location.reload();else alert(r.error||'Erro');
}
async function delLic(id){
  if(!confirm('Deletar esta licença?'))return;
  const r=await api('/api/admin/licenses/'+id,{method:'DELETE'});
  if(r.success)location.reload();else alert(r.error||'Erro');
}
</script>`);
  }

  if (relPath === '/logs') {
    const [docs, total] = await Promise.all([
      db.collection(COL.logs).find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      db.collection(COL.logs).countDocuments({}),
    ]);
    const pages = Math.ceil(total / limit);
    const pag = pages > 1 ? Array.from({ length: pages }, (_, i) => i + 1).map(p =>
      `<a href="${base}/logs?page=${p}" class="${p === page ? 'active' : ''}">${p}</a>`
    ).join('') : '';
    return spaShell('Logs', `${adminSidebar('Logs', base)}<div class="main"><div class="topbar"><h1>Logs de Auditoria</h1></div><div class="card"><table><thead><tr><th>Data</th><th>Ação</th><th>IP</th><th>Detalhe</th></tr></thead><tbody>${buildLogRows(docs)}</tbody></table><div class="pagination">${pag}</div></div></div>`);
  }

  if (relPath === '/settings') {
    const cfg = await db.collection(COL.settings).findOne({ _id: 'config' }) || {};
    const { _id, ...cfgData } = cfg;
    return spaShell('Configurações', `${adminSidebar('Configurações', base)}<div class="main"><div class="topbar"><h1>Configurações</h1></div><div class="card"><h2>config.json (DOM Selector)</h2><div id="cfg-msg"></div><div class="form-group"><label>JSON</label><textarea id="cfg-json" style="height:320px;font-family:monospace">${JSON.stringify(cfgData, null, 2)}</textarea></div><button class="btn btn-primary" onclick="saveConfig()">Salvar</button></div><div class="card" style="margin-top:16px"><h2>Alterar Senha Admin</h2><div id="pass-msg"></div><div class="form-group"><label>Nova Senha</label><input id="new-pass" type="password"></div><button class="btn btn-secondary" onclick="changePass()">Alterar</button></div></div>
<script>
async function saveConfig(){
  let p;try{p=JSON.parse(document.getElementById('cfg-json').value)}catch(e){document.getElementById('cfg-msg').innerHTML='<div class="alert alert-error">JSON inválido</div>';return}
  const r=await fetch('/api/admin/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
  const d=await r.json();
  document.getElementById('cfg-msg').innerHTML=d.success?'<div class="alert alert-success">Salvo!</div>':'<div class="alert alert-error">'+(d.error||'Erro')+'</div>';
}
async function changePass(){
  const p=document.getElementById('new-pass').value;if(!p)return;
  const r=await fetch('/api/admin/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pass:p})});
  const d=await r.json();
  document.getElementById('pass-msg').innerHTML=d.success?'<div class="alert alert-success">Senha alterada!</div>':'<div class="alert alert-error">'+(d.error||'Erro')+'</div>';
}
</script>`);
  }

  return null;
}

async function handleAdminApi(req, res, db, pathname, ip) {
  if (pathname === '/api/admin/licenses' && req.method === 'GET') {
    const docs = await db.collection(COL.licenses).find({}).sort({ createdAt: -1 }).limit(200).toArray();
    return sendJson(res, { success: true, data: docs });
  }

  if (pathname === '/api/admin/licenses' && req.method === 'POST') {
    const raw  = await readBody(req);
    const body = sanitizeDoc(parseJson(raw) || {});
    const code = body.code || crypto.randomUUID();
    const expiresAt = (body.expiresInDays > 0)
      ? new Date(Date.now() + body.expiresInDays * 86400_000).toISOString()
      : null;
    const doc = {
      code,
      access_token_plugin : code,
      bearer_token        : crypto.randomBytes(32).toString('hex'),
      email               : (body.email || '').toLowerCase(),
      label               : body.label || '',
      plan                : body.plan || 'pro',
      active              : body.active !== false,
      blocked             : false,
      trial               : !!body.trial,
      maxUses             : body.maxUses != null ? Number(body.maxUses) : -1,
      usedCount           : 0,
      expiresAt,
      createdAt           : new Date().toISOString(),
    };
    await db.collection(COL.licenses).insertOne(doc);
    await logEvent(db, 'admin_create_license', ip, { code });
    return sendJson(res, { success: true, data: doc });
  }

  const licMatch = pathname.match(/^\/api\/admin\/licenses\/([^/]+)$/);
  if (licMatch) {
    const { ObjectId } = await import('mongodb');
    let id;
    try { id = new ObjectId(licMatch[1]); } catch (_) { return sendJson(res, { error: 'invalid_id' }, 400); }

    if (req.method === 'PUT') {
      const raw  = await readBody(req);
      const body = sanitizeDoc(parseJson(raw) || {});
      const upd  = {};
      if (body.email     !== undefined) upd.email     = body.email.toLowerCase();
      if (body.label     !== undefined) upd.label     = body.label;
      if (body.plan      !== undefined) upd.plan      = body.plan;
      if (body.maxUses   !== undefined) upd.maxUses   = Number(body.maxUses);
      if (body.expiresAt !== undefined) upd.expiresAt = body.expiresAt;
      if (body.active    !== undefined) upd.active    = !!body.active;
      if (body.blocked   !== undefined) upd.blocked   = !!body.blocked;
      await db.collection(COL.licenses).updateOne({ _id: id }, { $set: upd });
      await logEvent(db, 'admin_update_license', ip, { id: licMatch[1] });
      return sendJson(res, { success: true });
    }

    if (req.method === 'DELETE') {
      await db.collection(COL.licenses).deleteOne({ _id: id });
      await logEvent(db, 'admin_delete_license', ip, { id: licMatch[1] });
      return sendJson(res, { success: true });
    }
  }

  if (pathname === '/api/admin/config' && req.method === 'POST') {
    const raw  = await readBody(req);
    const body = sanitizeDoc(parseJson(raw) || {});
    await db.collection(COL.settings).replaceOne({ _id: 'config' }, { _id: 'config', ...body, updatedAt: new Date() }, { upsert: true });
    return sendJson(res, { success: true });
  }

  if (pathname === '/api/admin/password' && req.method === 'POST') {
    const raw  = await readBody(req);
    const body = parseJson(raw) || {};
    if (!body.pass || body.pass.length < 8) return sendJson(res, { error: 'password_too_short' }, 400);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await pbkdf2(body.pass, salt);
    const doc  = await db.collection(COL.settings).findOne({ _id: 'admin' });
    await db.collection(COL.settings).updateOne({ _id: 'admin' }, { $set: { hash, salt, user: doc?.user || ADMIN_USER } });
    await logEvent(db, 'admin_change_password', ip, {});
    return sendJson(res, { success: true });
  }

  return send404(res);
}

async function handleWaTiDyApi(req, res, db, pathname, ip) {
  if (!checkAccessToken(req)) {
    await logEvent(db, 'invalid_access_token', ip, { path: pathname });
    return sendJson(res, { success: false, error: 'unauthorized' }, 401);
  }

  const installMatch = pathname.match(/^\/api\/urls\/install\/([^/]+)$/);
  if (installMatch && req.method === 'GET') {
    return sendJson(res, { success: true, url: BASE_URL + '/bem-vindo', extensionId: installMatch[1] });
  }

  const activeNotesMatch = pathname.match(/^\/api\/urls\/active-notes\/([^/]+)$/);
  if (activeNotesMatch && req.method === 'GET') {
    return sendJson(res, { success: true, path_note_update: { redirect: false }, notes: [] });
  }

  const notesMatch = pathname.match(/^\/api\/urls\/notes\/([^/]+)$/);
  if (notesMatch) {
    res.writeHead(302, { Location: BASE_URL + '/notas' });
    return res.end();
  }

  const uninstallMatch = pathname.match(/^\/api\/urls\/uninstall\/([^/]+)$/);
  if (uninstallMatch) {
    return sendHtml(res, spaShell('Obrigado', `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px"><div style="font-size:48px">👋</div><h1 style="font-size:24px">WaTiDy foi desinstalado</h1><p style="color:#8b949e">Sentiremos sua falta. Se precisar voltar, é só reinstalar.</p></div>`));
  }

  const validationMatch = pathname.match(/^\/api\/auth\/validation\/([^/]+)$/);
  if (validationMatch && req.method === 'POST') {
    if (rateLimit(ip + ':val', 15, 60_000)) return sendJson(res, { success: false, error: 'rate_limited' }, 429);
    const raw  = await readBody(req);
    const body = sanitizeDoc(parseJson(raw) || {});
    const keyRaw = body.access_token_plugin || body.key || body.email || '';
    const cleanKey = keyRaw.replace(/@watidy\.local$/, '').replace(/@waspeed\.local$/, '').trim();
    if (!cleanKey) return sendJson(res, { success: false, error: 'key_required' }, 400);
    const rec  = await findKey(db, cleanKey) || (body.email ? await findKeyByEmail(db, body.email) : null);
    const code = rec?.code || rec?.access_token_plugin || cleanKey;
    const result = authSuccess(rec, code);
    if (!result.ok) {
      await logEvent(db, 'auth_fail', ip, { key: cleanKey.slice(0, 20), reason: result.msg_id });
      return sendJson(res, { success: false, user_status: result.msg_id, user: null, auth_google: null });
    }
    await db.collection(COL.licenses).updateOne({ _id: rec._id }, { $inc: { usedCount: 1 }, $set: { lastIp: ip, lastUsedAt: new Date().toISOString() } });
    await logEvent(db, 'auth_success', ip, { key: cleanKey.slice(0, 20) });
    return sendJson(res, { success: true, user_status: result.us, user: result.user, auth_google: null });
  }

  const bearerMatch = pathname.match(/^\/api\/auth\/login-bearer\/([^/]+)$/);
  if (bearerMatch && (req.method === 'GET' || req.method === 'POST')) {
    if (rateLimit(ip + ':bearer', 15, 60_000)) return sendJson(res, { success: false, error: 'rate_limited' }, 429);
    const bearer = extractBearer(req);
    if (!bearer) return sendJson(res, { success: false, error: 'bearer_required' }, 400);
    const rec    = await findKeyByBearer(db, bearer);
    const code   = rec?.code || rec?.access_token_plugin || bearer;
    const result = authSuccess(rec, code);
    if (!result.ok) {
      await logEvent(db, 'bearer_fail', ip, { reason: result.msg_id });
      return sendJson(res, { success: false, user_status: result.msg_id, user: null, auth_google: null });
    }
    await logEvent(db, 'bearer_success', ip, { key: code.slice(0, 20) });
    return sendJson(res, { success: true, user_status: result.us, user: result.user, auth_google: null });
  }

  return send404(res);
}

async function handleRequest(req, res) {
  secureHeaders(res);
  corsHeaders(res, req.headers.origin || '');

  const fullUrl  = new URL(req.url || '/', `http://localhost`);
  const pathname = fullUrl.pathname.replace(/\/+$/, '') || '/';
  const query    = Object.fromEntries(fullUrl.searchParams.entries());
  const ip       = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (pathname === '/health' || pathname === '/ping') {
    return sendJson(res, { ok: true, ts: Date.now() });
  }

  if (pathname === '/bem-vindo' || pathname === '/notas') {
    return sendHtml(res, spaShell('WaTiDy', `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:12px"><div style="font-size:32px;font-weight:700;color:#58a6ff">WaTiDy</div><p style="color:#8b949e">${pathname === '/bem-vindo' ? 'Bem-vindo!' : 'Notas de atualização.'}</p></div>`));
  }

  if (pathname === '/config.json') {
    try {
      const db  = await getDb();
      const cfg = await buildConfigJson(db);
      return sendJson(res, cfg);
    } catch (_) {
      return sendJson(res, { dom_selector: DOM_DEFAULTS.dom_selector, remote_code: DOM_DEFAULTS.remote_code, version: DOM_DEFAULTS.version, updatedAt: new Date().toISOString() });
    }
  }

  if (pathname.startsWith('/api/urls/') || pathname.startsWith('/api/auth/')) {
    try {
      const db = await getDb();
      return await handleWaTiDyApi(req, res, db, pathname, ip);
    } catch (e) {
      return sendJson(res, { success: false, error: 'server_error' }, 500);
    }
  }

  const adminBase = R_ADMIN();
  const modBase   = R_MOD();

  if (pathname.startsWith(adminBase) || pathname === '/api/admin/licenses' || pathname.startsWith('/api/admin/')) {
    try {
      const db = await getDb();

      if (pathname.startsWith('/api/admin/')) {
        const cookies = parseCookies(req);
        const session = await validateSession(db, cookies[WT_COOKIE]);
        if (!session || session.role !== 'admin') return sendJson(res, { error: 'unauthorized' }, 401);
        return await handleAdminApi(req, res, db, pathname, ip);
      }

      const relPath = pathname.slice(adminBase.length) || '/';

      if (relPath === '/login') {
        if (req.method === 'POST') {
          if (rateLimit(ip + ':admin-login', 5, 60_000)) return sendHtml(res, renderLoginShell('Muitas tentativas.'), 429);
          const raw    = await readBody(req);
          const params = Object.fromEntries(new URLSearchParams(raw).entries());
          const ok     = await verifyAdminCredentials(params.user || '', params.pass || '');
          if (!ok) {
            await logEvent(db, 'admin_login_fail', ip, { user: (params.user || '').slice(0, 40) });
            return sendHtml(res, renderLoginShell('Credenciais inválidas.'), 401);
          }
          const sid = await createSession(db, { user: params.user, role: 'admin' });
          setCookie(res, WT_COOKIE, sid, SESSION_TTL_MS);
          await logEvent(db, 'admin_login', ip, { user: params.user });
          res.writeHead(302, { Location: adminBase + '/' });
          return res.end();
        }
        return sendHtml(res, renderLoginShell());
      }

      if (relPath === '/logout') {
        const cookies = parseCookies(req);
        await destroySession(db, cookies[WT_COOKIE]);
        clearCookie(res, WT_COOKIE);
        res.writeHead(302, { Location: adminBase + '/login' });
        return res.end();
      }

      const cookies = parseCookies(req);
      const session = await validateSession(db, cookies[WT_COOKIE]);
      if (!session || session.role !== 'admin') {
        res.writeHead(302, { Location: adminBase + '/login' });
        return res.end();
      }

      const html = await renderAdminDash(db, relPath, query, session, adminBase);
      if (!html) return send404(res);
      return sendHtml(res, html);
    } catch (e) {
      return sendJson(res, { error: 'server_error' }, 500);
    }
  }

  if (pathname.startsWith(modBase)) {
    try {
      const db      = await getDb();
      const relPath = pathname.slice(modBase.length) || '/';

      if (relPath === '/login') {
        if (req.method === 'POST') {
          const raw    = await readBody(req);
          const params = Object.fromEntries(new URLSearchParams(raw).entries());
          const ok     = await verifyAdminCredentials(params.user || '', params.pass || '');
          if (!ok) return sendHtml(res, renderLoginShell('Credenciais inválidas.'), 401);
          const sid = await createSession(db, { user: params.user, role: 'mod' });
          setCookie(res, WT_COOKIE + '_m', sid, SESSION_TTL_MS);
          res.writeHead(302, { Location: modBase + '/' });
          return res.end();
        }
        return sendHtml(res, renderLoginShell());
      }

      if (relPath === '/logout') {
        const cookies = parseCookies(req);
        await destroySession(db, cookies[WT_COOKIE + '_m']);
        clearCookie(res, WT_COOKIE + '_m');
        res.writeHead(302, { Location: modBase + '/login' });
        return res.end();
      }

      const cookies = parseCookies(req);
      const session = await validateSession(db, cookies[WT_COOKIE + '_m']);
      if (!session || (session.role !== 'mod' && session.role !== 'admin')) {
        res.writeHead(302, { Location: modBase + '/login' });
        return res.end();
      }

      const html = await renderAdminDash(db, relPath, query, session, modBase);
      if (!html) return send404(res);
      return sendHtml(res, html);
    } catch (e) {
      return sendJson(res, { error: 'server_error' }, 500);
    }
  }

  return send404(res);
}

async function boot() {
  try {
    const db = await getDb();
    await ensureIndexes(db);
    await initSeed(db);
    console.log('[wt] MongoDB conectado — db: watidy');
    console.log('[wt] Admin:', `http://localhost:${PORT}${R_ADMIN()}/login`);
    console.log('[wt] Mod:  ', `http://localhost:${PORT}${R_MOD()}/login`);
  } catch (e) {
    console.warn('[wt] MongoDB indisponível na inicialização:', e.message);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(e => {
      console.error('[wt] unhandled:', e.message);
      if (!res.headersSent) sendJson(res, { error: 'internal_error' }, 500);
    });
  });

  server.listen(PORT, () => console.log(`[wt] porta ${PORT} (${NODE_ENV})`));

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      server.close();
      if (_client) await _client.close().catch(() => {});
      process.exit(0);
    });
  }
}

boot();
