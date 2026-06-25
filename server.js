'use strict';

// =============================================================================
// WaSpeed Server v4.0 — Refatoração Total (Pilares 1-6)
// Node.js nativo + MongoDB + Segurança OWASP + UI Cyberpunk
// =============================================================================

const http    = require('http');
const https   = require('https');
const crypto  = require('crypto');
const zlib    = require('zlib');
const { URL } = require('url');
const { MongoClient } = require('mongodb');

// --- Constantes globais originais (preservadas) ------------------------------

const SESSION_TTL_MS       = 24 * 60 * 60 * 1000;
const ANTI_SLEEP_MS        = 5  * 60 * 1000;

const COL = {
  settings : 'settings',
  licenses : 'licenses',
  logs     : 'logs',
  sessions : 'sessions',
};

// --- Logger estruturado ------------------------------------------------------

const LOG_LEVELS = { INFO: 'INFO', WARN: 'WARN', SECURITY: 'SECURITY', CRITICAL: 'CRITICAL' };
const _logBuffer = [];
const LOG_BUFFER_MAX = 500;

function slog(level, msg, meta = {}) {
  const entry = {
    ts   : new Date().toISOString(),
    level,
    msg,
    ...( Object.keys(meta).length ? { meta } : {} ),
  };
  const line = JSON.stringify(entry);
  if (level === LOG_LEVELS.CRITICAL || level === LOG_LEVELS.SECURITY) {
    console.error(line);
  } else if (level === LOG_LEVELS.WARN) {
    console.warn(line);
  } else {
    console.log(line);
  }
  _logBuffer.push(entry);
  if (_logBuffer.length > LOG_BUFFER_MAX) _logBuffer.shift();
}

// --- Helpers de ambiente -----------------------------------------------------

function envStr(key, fallback = '') {
  return String(process.env[key] ?? fallback).trim().replace(/^["']|["']$/g, '');
}

function dbNameFromMongoUri(uri) {
  const m = String(uri || '').match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/);
  return m?.[1] || 'waspeed';
}

// --- Validação Fail-Fast de variáveis de ambiente (Pilar 5) -----------------

(function validateEnv() {
  const missing = [];
  if (!envStr('MONGODB_URI'))         missing.push('MONGODB_URI');
  if (!envStr('BASE_URL') && !envStr('PUBLIC_URL') && !envStr('RENDER_EXTERNAL_URL'))
    missing.push('BASE_URL / PUBLIC_URL / RENDER_EXTERNAL_URL');

  if (missing.length) {
    slog(LOG_LEVELS.CRITICAL, 'Variáveis de ambiente obrigatórias ausentes', { missing });
    process.exit(1);
  }

  const uri = envStr('MONGODB_URI');
  if (/xxxxx|USUARIO|SENHA|<password>|YOUR_CLUSTER/i.test(uri)) {
    slog(LOG_LEVELS.CRITICAL, 'MONGODB_URI contém placeholders do template. Forneça a URI real do Atlas.');
    process.exit(1);
  }

  if (!envStr('JWT_SECRET') && !envStr('ACCESS_TOKEN')) {
    slog(LOG_LEVELS.WARN, 'JWT_SECRET / ACCESS_TOKEN não definido — usando fallback inseguro');
  }
})();

// --- Configuração ------------------------------------------------------------

const config = {
  port             : Number(process.env.PORT) || 3000,
  baseUrl          : (envStr('BASE_URL') || envStr('PUBLIC_URL') || envStr('RENDER_EXTERNAL_URL')).replace(/\/$/, ''),
  publicUrl        : (envStr('PUBLIC_URL') || envStr('BASE_URL') || envStr('RENDER_EXTERNAL_URL')).replace(/\/$/, ''),
  mongoUri         : envStr('MONGODB_URI'),
  dbName           : envStr('MONGODB_DB') || dbNameFromMongoUri(envStr('MONGODB_URI')),
  criptKey         : envStr('ACCESS_TOKEN', envStr('JWT_SECRET', 'ffce211a-7b07-4d91-ba5d-c40bb4034a83')),
  chromeStoreId    : envStr('CHROME_STORE_ID', 'balkfdkhbcjjmhndnblgmlmcabnapogp'),
  wlId             : envStr('WL_ID', 'watidy'),
  adminUser        : envStr('ADMIN_USER', 'admin'),
  adminPass        : envStr('ADMIN_PASS', 'waspeed-admin-change-me'),
  adminPath        : envStr('ADMIN_PATH', 'admin-waspeed'),
  modPath          : envStr('MOD_PATH', 'mod-waspeed'),
  installUrl       : envStr('INSTALL_URL', 'https://web.whatsapp.com'),
  notesRedirect    : envStr('NOTES_REDIRECT').toLowerCase() === 'true',
  logMax           : Math.min(Number(process.env.LOG_MAX) || 500, 2000),
  expiryWarnHours  : Math.max(1, Math.min(720, Number(process.env.EXPIRY_WARN_HOURS) || 48)),
  webhookUrl       : envStr('SECURITY_WEBHOOK_URL'),
  // Cookie name aleatório por instância (Anti-OSINT fingerprinting)
  cookieName       : 'ws_' + crypto.createHash('sha256')
                       .update(envStr('ACCESS_TOKEN', 'waspeed-static'))
                       .digest('hex').slice(0, 8),
};

if (config.adminPass === 'waspeed-admin-change-me') {
  slog(LOG_LEVELS.WARN, 'ADMIN_PASS ainda é o default — altere no Render');
}

slog(LOG_LEVELS.INFO, 'WaSpeed config carregado', {
  port   : config.port,
  db     : config.dbName,
  url    : config.baseUrl,
  cookie : config.cookieName,
});

const R_ADMIN = `/${config.adminPath}`;
const R_MOD   = `/${config.modPath}`;

// --- Estado global -----------------------------------------------------------

let mongoClient     = null;
let db              = null;
let mongoReady      = false;
let cachedSettings  = null;
let configJsonBody  = null;
let server          = null;

// Circuit breaker (Pilar 5)
let cbFailCount     = 0;
const CB_THRESHOLD  = 5;
const CB_RESET_MS   = 60000;
let cbOpenUntil     = 0;

function cbIsOpen() {
  if (Date.now() < cbOpenUntil) return true;
  return false;
}

function cbRecordFailure() {
  cbFailCount++;
  if (cbFailCount >= CB_THRESHOLD) {
    cbOpenUntil = Date.now() + CB_RESET_MS;
    slog(LOG_LEVELS.CRITICAL, 'Circuit breaker ABERTO — MongoDB indisponível', { until: new Date(cbOpenUntil).toISOString() });
    dispatchWebhookAlert('circuit_breaker_open', { cbOpenUntil });
  }
}

function cbRecordSuccess() {
  cbFailCount = 0;
  cbOpenUntil = 0;
}

// --- DOM defaults ------------------------------------------------------------

const DOM_DEFAULTS = {"version":"1.11","update_path_active":"true","disabled_wait_sync":false,"wpp_mensagens":{"timer":"60000","enable_two_send":false},"newModel":{"model":"taghtml","parm":"body.color-refresh"},"app":{"model":"querySelector","selector":["#app"]},"afiliadoMain":{"model":"querySelector","selector":["body > div"]},"paneSide":{"model":"Element","selector":"#pane-side"},"waPage":{"model":"querySelector","selector":["div.two"]},"two":{"model":"Element","selector":"two"},"menuLateral":{"model":"querySelector","selector":["div.two > div:nth-child(5)"]},"closeChat":{"model":"Element","selector":"x10l6tqk"},"chatListInput":{"model":"querySelector","selector":[".lexical-rich-text-input > div"]},"searchInput":{"model":"querySelector","selector":["[data-icon='search']"]},"downAba":{"model":"querySelector","selector":["header > div > div > div > div > span > div > div:nth-child(1)","header > div._ak0w"]},"chatListHeader":{"model":"querySelector","selector":["header > header > div > span > div"]},"searchCamp":{"model":"querySelector","selector":["#side div[data-testid='chat-list-search-container']"]},"chatName":{"model":"querySelector","selector":["#main header span[title]","#main header div[role=\"button\"] span","#main header h1","#main > header div.x78zum5 > div > div > div > div","#main header [data-testid=\"conversation-info-header-chat-title\"]","#main header"]},"menuVertical":{"model":"querySelector","selector":["#main ._amm9","#main .x1n2onr6.x1vjfegm.x1cqoux5.x14yy4lh"]},"menuHorizontal":{"model":"querySelector","selector":["#main > header > div.x1c4vz4f > div"]},"menuFooter":{"model":"querySelector","selector":["footer ._ak1m"]},"respostaRapida":{"model":"querySelector","selector":["footer > div"]},"footerTextArea":{"model":"querySelector","selector":["footer div[contenteditable=true]"]},"mainAudio":{"model":"querySelector","selector":["footer > div.copyable-area > div"]},"assChat":{"model":"querySelector","selector":["#main > div.x1n2onr6.x1vjfegm.x1cqoux5.x14yy4lh"]},"assInput":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div"]},"assBtn":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div > div:nth-child(6)"]},"assEmoji":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div._ak1m > div > button[tabindex='-1']"]},"assCitacao":{"model":"querySelector","selector":["footer div.x9f619.x1okw0bk > button > div > div > div:nth-child(1)"]},"listMensages":{"model":"querySelector","selector":["div[data-scrolltracepolicy='wa.web.conversation.messages']"]},"allMensages":{"model":"querySelectorAll","selector":["#main div > div[data-id]"]},"assistenteChat":{"model":"querySelector","selector":["#main > footer"]},"trasferidos":{"model":"querySelector","selector":["#side div[tabindex='-1']"]},"notification":{"model":"querySelector","selector":["#side > div:nth-child(2)"]},"quotedMsg":{"model":"querySelector","selector":["#main > footer > div.x10l6tqk.x13vifvy.x1o0tod.xh8yej3 > div > div > div > span > div"]},"listChats":{"model":"querySelector","selector":["#pane-side > div > div > div"]},"listChatsUsers":{"model":"querySelectorAll","selector":["#pane-side > div > div > div > div  div[aria-selected]","#pane-side > div > div > div div[role='button'] > div"]},"listChatAtendimento":{"model":"Element","selector":"div div[data-testid='cell-frame-secondary'] div[role='gridcell']"},"insertAtendente":{"model":"Element","selector":"x10l6tqk xh8yej3 x1g42fcv"},"reactFiberContainer":{"model":"listElement","list":{"reactFiber":"__reactFiber","reactFiberIndex":0,"path_user_id":".child.memoizedProps[1].props.id._serialized","path_key_message":".child.memoizedProps.children[0].key"}},"updateChatList":{"model":"querySelector","selector":["#side div._ai04 > button"]},"useTradutor":{"model":"listElement","list":{"main_audio_1":"div.x121pien.x9f619","main_audio_2":"div.x121pien.x9f619","camp_text_1":"row-translate","camp_text_2":"div > span","add_btn_tradutor":"div.x1c4vz4f.x1q0g3np.x6s0dn4","camp_audio_1":"div[role=\"slider\"] > canvas","camp_audio_2":"div.x1e4oeot.x1ui04y5[role=\"slider\"] > div"}},"chatList":{"model":"querySelector","selector":["#pane-side","#side","div.two > div:first-child","div.two > div._aigw"]},"observerFooter":{"model":"querySelector","selector":["#main > span:nth-child(8)","#main > :last-child"]},"observerFooterNewModel":{"model":"querySelector","selector":["#main > span:nth-child(7)","#main > span:nth-child(8)","#main > span:nth-child(9)"]},"whatsModal":{"model":"querySelector","selector":["#app > div > div > span:nth-child(3)"]},"menu_whats":{"model":"querySelector","selector":["#app > div > div.x78zum5.xdt5ytf.x5yr21d > div > header > div > div:nth-child(2) > div","header > div > div:nth-child(2) > div"]},"actionMonitor":{"model":"querySelector","selector":["#main header"]},"footerIconsLeft":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div"]},"side":{"model":"querySelector","selector":["#side"]},"chatFiltersContainer":{"model":"listElement","list":{"div_filters":"_akap _akan _arj9"}},"chatFilters":{"model":"querySelectorAll","selector":["#side > div:nth-of-type(3) button"]},"selector_theme":{"model":"querySelector","selector":[".os-win"]}};

function loadDomDefaults() {
  return structuredClone(DOM_DEFAULTS);
}

// Proteção contra Prototype Pollution (Pilar 2)
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeMerge(base, overrides) {
  const result = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (DANGEROUS_KEYS.has(k)) {
      slog(LOG_LEVELS.SECURITY, 'Prototype pollution bloqueado', { key: k });
      continue;
    }
    result[k] = v;
  }
  return result;
}

function buildDomConfig(overrides = {}) {
  const base  = loadDomDefaults();
  const clean = { ...overrides };
  delete clean.remote_code;
  delete clean.dom_selector;
  const merged = safeMerge(base, clean);
  merged.update_path        = `${config.baseUrl}/api/urls/update`;
  merged.update_path_new    = `${config.baseUrl}/api/services/update`;
  merged.update_path_active = String(merged.update_path_active ?? 'true');
  if (merged.version === 1 || merged.selectors) {
    delete merged.selectors;
    merged.version = base.version || '1.11';
  }
  return merged;
}

function buildConfigJson(overrides) {
  if (overrides === undefined) overrides = {};
  return {
    remote_code  : {
      version  : '1.0.41',
      ambiente : 'production',
      url      : `${config.baseUrl}/api/code`,
    },
    dom_selector : buildDomConfig(overrides),
  };
}

// Cache em RAM para /config.json (Pilar 3)
async function refreshSettingsCache() {
  if (!db) return;
  try {
    cachedSettings = await db.collection(COL.settings).findOne({ _id: 'global' });
    configJsonBody = JSON.stringify(buildConfigJson(cachedSettings?.domConfig || {}));
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'refreshSettingsCache falhou', { err: err.message });
  }
}

function sendCachedConfigJson(res) {
  if (res.headersSent) return;
  if (!configJsonBody) {
    sendJson(res, buildConfigJson());
    return;
  }
  const body = configJsonBody;
  res.writeHead(200, {
    'Content-Type'  : 'application/json; charset=utf-8',
    'Cache-Control' : 'public, max-age=300',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// --- MongoDB + Circuit Breaker (Pilares 4 e 5) --------------------------------

async function connectMongo() {
  if (db && mongoReady) return db;
  try {
    mongoClient = new MongoClient(config.mongoUri, {
      maxPoolSize             : 20,
      minPoolSize             : 2,
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS        : 15000,
    });
    await mongoClient.connect();
    db = mongoClient.db(config.dbName);
    mongoClient.on('serverHeartbeatFailed', () => {
      slog(LOG_LEVELS.WARN, 'MongoDB heartbeat falhou');
      cbRecordFailure();
      if (cbIsOpen()) { mongoReady = false; }
    });
    mongoClient.on('serverHeartbeatSucceeded', () => {
      cbRecordSuccess();
      if (!mongoReady) {
        mongoReady = true;
        slog(LOG_LEVELS.INFO, 'MongoDB reconectado — circuit breaker fechado');
      }
    });
    await ensureIndexes();
    cbRecordSuccess();
    return db;
  } catch (err) {
    db          = null;
    mongoReady  = false;
    cbRecordFailure();
    slog(LOG_LEVELS.CRITICAL, 'connectMongo falhou', { err: err.message });
    throw err;
  }
}

async function ensureIndexes() {
  if (!db) return;
  const specs = [
    { col: COL.licenses, key: { bearer: 1 },        opts: { unique: true } },
    { col: COL.licenses, key: { code: 1 },           opts: { unique: true } },
    { col: COL.licenses, key: { licenseToken: 1 },   opts: { sparse: true } },
    { col: COL.sessions, key: { token: 1 },          opts: { unique: true } },
    { col: COL.sessions, key: { expiresAt: 1 },      opts: { expireAfterSeconds: 0 } },
    { col: COL.logs,     key: { at: -1 },            opts: {} },
  ];
  for (const { col, key, opts } of specs) {
    try {
      await db.collection(col).createIndex(key, opts);
    } catch (err) {
      if (err.code === 85 || err.code === 86) continue;
      slog(LOG_LEVELS.WARN, `ensureIndexes ${col}`, { err: err.message });
    }
  }
}

async function initSeed() {
  if (!db) throw new Error('MongoDB não conectado');
  try {
    const settingsCol = db.collection(COL.settings);
    let doc = await settingsCol.findOne({ _id: 'global' });
    if (!doc) {
      doc = {
        _id         : 'global',
        installUrl  : config.installUrl,
        notesHtml   : '<h1>WaSpeed</h1><p>Servidor MongoDB ativo.</p>',
        webhooks    : [],
        meet        : {},
        urls        : {},
        migration   : {},
        domConfig   : buildDomConfig(),
        nextUserId  : 1000,
        mods        : buildModsFromEnv(),
        admin       : {
          username : config.adminUser,
          password : hashPassword(config.adminPass),
        },
      };
      await settingsCol.insertOne(doc);
      slog(LOG_LEVELS.INFO, 'Settings inicializados');
    }
    await syncCredentialsFromEnv();
    const count = await db.collection(COL.licenses).countDocuments();
    if (count === 0) {
      await createKey({
        code    : 'ws-demo-premium',
        label   : 'Demo Premium',
        premium : true,
        note    : 'Chave demo — troque em produção',
      });
      slog(LOG_LEVELS.INFO, 'Chave demo criada: ws-demo-premium');
    }
    await refreshSettingsCache();
  } catch (err) {
    slog(LOG_LEVELS.CRITICAL, 'initSeed falhou', { err: err.message });
    throw err;
  }
}

function buildModsFromEnv() {
  const prefixes = ['MOD', 'MOD2', 'MOD3', 'MOD4', 'MOD5', 'MOD6'];
  const mods = [];
  for (const prefix of prefixes) {
    const user = envStr(`${prefix}_USER`);
    const pass = envStr(`${prefix}_PASS`);
    if (!user || !pass) continue;
    mods.push({
      id       : crypto.createHash('sha256').update(`waspeed-mod:${user}`).digest('hex').slice(0, 16),
      username : user,
      password : hashPassword(pass),
      name     : user,
      active   : true,
    });
  }
  if (mods.length) return mods;
  return [{
    id       : crypto.randomBytes(8).toString('hex'),
    username : 'mod',
    password : hashPassword('mod123'),
    name     : 'Moderador',
    active   : true,
  }];
}

async function syncCredentialsFromEnv() {
  if (!db) return;
  try {
    const patch = {
      admin : { username: config.adminUser, password: hashPassword(config.adminPass) },
      mods  : buildModsFromEnv(),
    };
    await db.collection(COL.settings).updateOne({ _id: 'global' }, { $set: patch }, { upsert: true });
    slog(LOG_LEVELS.INFO, 'Admin/mods sincronizados do .env');
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'syncCredentialsFromEnv', { err: err.message });
  }
}

// --- Segurança: senhas + sessões (Pilar 2) ------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return `pbkdf2:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored?.startsWith('pbkdf2:')) return false;
  const rest = stored.slice(7);
  const sep  = rest.indexOf(':');
  if (sep < 0) return false;
  const salt  = rest.slice(0, sep);
  const hash  = rest.slice(sep + 1);
  const check = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

// Constant-time para evitar timing attacks (Pilar 2)
async function verifyAdminCredentials(user, pass) {
  const u = String(user || '').trim();
  const p = String(pass || '');
  // Executa busca independente de u/p para uniformizar latência
  const admin = await getSettingsAdmin().catch(() => null);
  const _dummy = crypto.pbkdf2Sync('dummy', 'salt', 120000, 64, 'sha512');

  if (!u || !p) return false;

  // Comparação plaintext com .env (fallback rápido)
  if (u.toLowerCase() === config.adminUser.toLowerCase() && p === config.adminPass) {
    await syncCredentialsFromEnv();
    await refreshSettingsCache();
    return true;
  }
  // Comparação pbkdf2 do banco
  if (admin && u.toLowerCase() === String(admin.username || '').toLowerCase()) {
    return verifyPassword(p, admin.password);
  }
  // Consumir tempo equivalente mesmo quando user não existe
  void _dummy;
  return false;
}

async function getSettingsAdmin() {
  if (!db) return cachedSettings?.admin || null;
  try {
    const doc = await db.collection(COL.settings).findOne({ _id: 'global' }, { projection: { admin: 1 } });
    return doc?.admin || null;
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'getSettingsAdmin', { err: err.message });
    return cachedSettings?.admin || null;
  }
}

async function verifyModCredentials(user, pass) {
  const u = String(user || '').trim();
  const p = String(pass || '');
  if (!u || !p) return null;

  for (const prefix of ['MOD', 'MOD2', 'MOD3', 'MOD4', 'MOD5', 'MOD6']) {
    const mu = envStr(`${prefix}_USER`);
    const mp = envStr(`${prefix}_PASS`);
    if (mu && mp && u.toLowerCase() === mu.toLowerCase() && p === mp) {
      await syncCredentialsFromEnv();
      await refreshSettingsCache();
      return {
        name  : mu,
        modId : crypto.createHash('sha256').update(`waspeed-mod:${mu}`).digest('hex').slice(0, 16),
      };
    }
  }
  try {
    const doc = await db.collection(COL.settings).findOne({ _id: 'global' }, { projection: { mods: 1 } });
    const mod = (doc?.mods || []).find(
      (m) => m.active !== false && u.toLowerCase() === String(m.username || '').toLowerCase(),
    );
    if (mod && verifyPassword(p, mod.password)) {
      return { name: mod.name || mod.username, modId: mod.id };
    }
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'verifyModCredentials', { err: err.message });
  }
  return null;
}

async function createSession(role, meta = {}) {
  if (!db) return null;
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  try {
    await db.collection(COL.sessions).insertOne({
      token, role, ...meta, createdAt: new Date(), expiresAt,
    });
    return { token, expiresAt };
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'createSession', { err: err.message });
    return null;
  }
}

async function validateSession(token) {
  if (!token || !db) return null;
  try {
    return await db.collection(COL.sessions).findOne({
      token, expiresAt: { $gt: new Date() },
    });
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'validateSession', { err: err.message });
    return null;
  }
}

async function destroySession(token) {
  if (!token || !db) return;
  try { await db.collection(COL.sessions).deleteOne({ token }); }
  catch (err) { slog(LOG_LEVELS.WARN, 'destroySession', { err: err.message }); }
}

// Cookie com nome customizado/aleatório (Anti-OSINT, Pilar 2)
function setSessionCookie(res, token, maxAgeSec = 86400) {
  const secure = config.baseUrl.startsWith('https');
  const parts  = [
    `${config.cookieName}=${token}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const secure = config.baseUrl.startsWith('https');
  const parts  = [`${config.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  }
  return out;
}
// --- Sanitização NoSQL Injection (Pilar 2) ------------------------------------

const NOSQL_OP_RE = /\$(?:gt|gte|lt|lte|ne|eq|in|nin|or|and|not|nor|exists|type|regex|where|expr|elemMatch|size|all|rename|set|unset|push|pull|addToSet|pop)\b/gi;

function sanitizeString(s) {
  if (typeof s !== 'string') return s;
  const clean = s.replace(/\u0000/g, '').replace(NOSQL_OP_RE, '');
  return clean;
}

function sanitizeObject(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 10 || obj === null || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : Object.create(null);
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (DANGEROUS_KEYS.has(k)) continue;
    const ks = sanitizeString(String(k));
    const v  = obj[k];
    if (typeof v === 'string') {
      out[ks] = sanitizeString(v);
    } else if (typeof v === 'object' && v !== null) {
      out[ks] = sanitizeObject(v, depth + 1);
    } else {
      out[ks] = v;
    }
  }
  return out;
}

function detectInjection(input) {
  const s = typeof input === 'string' ? input : JSON.stringify(input);
  return NOSQL_OP_RE.test(s);
}

// --- Licenças ----------------------------------------------------------------

function normKey(raw) {
  return sanitizeString(String(raw || '')).trim().toLowerCase().slice(0, 48);
}

function generateKeyCode() {
  const p = () => crypto.randomBytes(3).toString('hex');
  return `ws-${p()}-${p()}-${p()}`.slice(0, 24);
}

function isKeyExpired(rec) {
  if (!rec?.expiresAt) return false;
  return new Date(rec.expiresAt).getTime() < Date.now();
}

function keyStatus(rec) {
  if (!rec?.active) return 'blocked';
  // Ativar no primeiro uso: pending até ser utilizada
  if (rec.ativarNoPrimeiroUso && !rec.primeiroUsoAt) return 'pending';
  if (isKeyExpired(rec)) return 'expired';
  return rec.premium ? 'active' : 'free';
}

async function findKey(code) {
  const k = normKey(code);
  if (!k || !db) return null;
  if (detectInjection(k)) {
    slog(LOG_LEVELS.SECURITY, 'NoSQL injection detectado em findKey', { input: String(code).slice(0, 80) });
    dispatchWebhookAlert('nosql_injection', { fn: 'findKey', input: String(code).slice(0, 80) });
    return null;
  }
  try {
    return await db.collection(COL.licenses).findOne({ code: k });
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'findKey', { err: err.message });
    return null;
  }
}

async function findKeyByBearer(bearer) {
  const b = sanitizeString(String(bearer || '').trim());
  if (!b || !db) return null;
  if (detectInjection(b)) {
    slog(LOG_LEVELS.SECURITY, 'NoSQL injection detectado em findKeyByBearer', { input: b.slice(0, 80) });
    dispatchWebhookAlert('nosql_injection', { fn: 'findKeyByBearer', input: b.slice(0, 80) });
    return null;
  }
  try {
    return await db.collection(COL.licenses).findOne({
      $or: [{ bearer: b }, { code: normKey(b) }, { access_token_plugin: b }, { bearer_token: b }],
    });
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'findKeyByBearer', { err: err.message });
    return null;
  }
}

async function listLicenses(filter = {}) {
  if (!db) return [];
  try {
    return await db.collection(COL.licenses).find(sanitizeObject(filter)).sort({ createdAt: -1 }).toArray();
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'listLicenses', { err: err.message });
    return [];
  }
}

async function createKey(input = {}, modName = null) {
  if (!db) throw new Error('MongoDB indisponível');
  const code     = normKey(input.code) || generateKeyCode();
  const existing = await findKey(code);
  if (existing) throw new Error('Chave já existe');

  let userId;
  try {
    const upd = await db.collection(COL.settings).findOneAndUpdate(
      { _id: 'global' },
      { $inc: { nextUserId: 1 } },
      { returnDocument: 'after' },
    );
    userId = upd?.nextUserId ? upd.nextUserId - 1 : 1000;
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'createKey nextUserId', { err: err.message });
    throw err;
  }

  const rec = {
    code,
    bearer              : code,
    user_id             : userId,
    label               : input.label || 'Cliente',
    email               : input.email || '',
    active              : input.active !== false,
    premium             : input.premium !== false,
    expiresAt           : input.expiresAt || null,
    expireDays          : input.expireDays || 0,
    maxUses             : input.maxUses ?? -1,
    phones              : Array.isArray(input.phones) ? input.phones : [],
    uses                : 0,
    note                : input.note || '',
    modName             : modName || input.modName || null,
    bearer_token        : code,
    access_token_plugin : code,
    createdAt           : new Date().toISOString(),
    lastUsed            : null,
    lastIp              : null,
    lastPhone           : null,
    ativarNoPrimeiroUso : input.ativarNoPrimeiroUso === true,
    primeiroUsoAt       : null,
  };
  if (input.expiresAt) {
    rec.expiresAt = input.expiresAt;
  } else if (input.expireDays > 0) {
    rec.expiresAt = new Date(Date.now() + input.expireDays * 86400000).toISOString();
  }

  try {
    await db.collection(COL.licenses).insertOne(rec);
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'createKey insert', { err: err.message });
    throw err;
  }
  await addLog('key_create', `Chave ${code} criada`, { code, modName });
  return rec;
}

async function updateLicense(code, patch) {
  if (!db) return false;
  try {
    await db.collection(COL.licenses).updateOne({ code: normKey(code) }, { $set: sanitizeObject(patch) });
      return true;
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'updateLicense', { err: err.message });
    return false;
  }
}

async function deleteLicense(code) {
  if (!db) return false;
  try {
    await db.collection(COL.licenses).deleteOne({ code: normKey(code) });
      return true;
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'deleteLicense', { err: err.message });
    return false;
  }
}

async function getOrCreateFreeKey(extensionId, ip) {
  const seed = String(extensionId || ip || 'anonymous');
  const code = normKey(`ws-free-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}`);
  const existing = await findKey(code);
  if (existing) return { code, rec: existing };
  const rec = await createKey({
    code,
    label     : 'Usuario Gratuito',
    premium   : false,
    note      : 'Registro free automático',
    expireDays: 0,
  });
  return { code, rec };
}

const EMPTY_AUTH_GOOGLE = {
  user_id: '', name: '', picture: '', email_auth: '', access_token: '',
  expires_in: NaN, id_token: '', refresh_token: '', scope: '', token_type: '', updated_at: NaN,
};

function formatDateYMD(value) {
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return formatDateYMD(new Date());
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function buildUserPremium(code, rec) {
  if (keyStatus(rec) !== 'active') return null;
  let dataLiberacao;
  if (rec.expiresAt) {
    const exp = new Date(rec.expiresAt);
    if (!Number.isNaN(exp.getTime())) {
      exp.setFullYear(exp.getFullYear() - 1);
      dataLiberacao = formatDateYMD(exp);
    }
  }
  if (!dataLiberacao) dataLiberacao = formatDateYMD(rec.createdAt || new Date());
  return { id_assinatura: String(rec.user_id || code), data_liberacao: dataLiberacao, teste: '0' };
}

function keyToUser(code, rec) {
  return {
    user_id             : String(rec.user_id),
    name                : rec.label || 'Usuario',
    email               : rec.email || '',
    wl_id               : config.wlId,
    bearer_token        : rec.bearer_token || code,
    access_token_plugin : rec.access_token_plugin || code,
    user_premium        : buildUserPremium(code, rec),
    dataCadastro        : rec.createdAt || new Date().toISOString(),
    whatsapp_registro   : rec.lastPhone || '',
    whatsapp_plugin     : rec.lastPhone || '',
    path                : '',
    afiliado            : '',
    campanhaID          : '',
    start_form          : true,
    cookies             : { _fbc: '', _fbp: '', _ga: '', _ttclid: '', _ttp: '' },
  };
}

async function authSuccess(code, rec, meta) {
  const st = keyStatus(rec);
  if (st === 'blocked') return { ok: false, msg_id: 'user_blocked' };
  if (st === 'expired') return { ok: false, msg_id: 'license_expired' };
  if (st === 'pending' && rec.ativarNoPrimeiroUso && !rec.primeiroUsoAt) {
    await updateLicense(code, { primeiroUsoAt: new Date().toISOString() });
    rec.primeiroUsoAt = new Date().toISOString();
    await addLog('key_activated', 'Chave ' + code + ' ativada no primeiro uso', { code });
  }
  const now   = new Date().toISOString();
  const phone = sanitizeString(String((meta && meta.phone) || rec.lastPhone || '').slice(0, 40));
  const ip    = sanitizeString(String((meta && meta.ip)    || rec.lastIp   || '').slice(0, 64));
  const atomicPatch = { lastUsed: now };
  if (phone) atomicPatch.lastPhone = phone;
  if (ip)    atomicPatch.lastIp    = ip;
  const maxU = (rec.maxUses != null) ? rec.maxUses : -1;
  const isUnlimited = maxU <= 0 || maxU === -1;
  const phoneAlreadyLinked = phone && (rec.phones || []).includes(phone);
  if (!db) return { ok: false, msg_id: 'db_unavailable' };
  try {
    const updateOp = { $set: atomicPatch, $inc: { uses: 1 } };
    if (phone && !phoneAlreadyLinked) {
      if (!isUnlimited && (rec.phones || []).length >= maxU) {
        return { ok: false, msg_id: 'max_devices_reached' };
      }
      updateOp.$addToSet = { phones: phone };
    }
    await db.collection(COL.licenses).updateOne({ code: normKey(code) }, updateOp);
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'authSuccess atomic update', { err: err.message });
  }
  rec.lastUsed  = now;
  rec.lastPhone = phone || rec.lastPhone;
  rec.lastIp    = ip    || rec.lastIp;
  if (phone && !phoneAlreadyLinked) {
    rec.phones = (rec.phones || []).concat([phone]);
    rec.uses   = (rec.uses || 0) + 1;
  }
  const finalSt = keyStatus(rec);
  return {
    ok  : true,
    body: {
      success    : true,
      user       : keyToUser(code, rec),
      auth_google: EMPTY_AUTH_GOOGLE,
      user_status: finalSt === 'active' ? 'active' : 'free',
    },
  };
}

async function addLog(type, message, meta = {}) {
  if (!db) return;
  try {
    await db.collection(COL.logs).insertOne({
      id: crypto.randomBytes(8).toString('hex'),
      at: new Date().toISOString(),
      type,
      message,
      meta,
    });
    const excess = await db.collection(COL.logs).countDocuments() - config.logMax;
    if (excess > 0) {
      const old = await db.collection(COL.logs).find({}).sort({ at: 1 }).limit(excess).project({ _id: 1 }).toArray();
      await db.collection(COL.logs).deleteMany({ _id: { $in: old.map((o) => o._id) } });
    }
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'addLog', { err: err.message });
  }
}

async function getRecentLogs(limit = 200) {
  if (!db) return [];
  try {
    return await db.collection(COL.logs).find({}).sort({ at: -1 }).limit(limit).toArray();
  } catch (err) {
    slog(LOG_LEVELS.WARN, 'getRecentLogs', { err: err.message });
    return [];
  }
}

// --- Webhook de alertas (Pilar 5) --------------------------------------------

function dispatchWebhookAlert(event, data = {}) {
  const url = config.webhookUrl;
  if (!url) return;
  const payload = JSON.stringify({
    service: 'waspeed',
    event,
    ts     : new Date().toISOString(),
    data,
  });
  try {
    const u    = new URL(url);
    const opts = {
      hostname: u.hostname,
      port    : u.port || 443,
      path    : u.pathname + u.search,
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, (r) => r.resume());
    req.on('error', () => {});
    req.setTimeout(5000, () => req.destroy());
    req.write(payload);
    req.end();
  } catch {}
}

// --- Rate limiter (O(1) com Map, Pilar 4) ------------------------------------

const RL         = { login: { max: 10, windowMs: 60000, blockMs: 300000 } };
const rateMap    = new Map();
const bruteCount = new Map(); // contador de brute force por IP

function checkRate(ip, action = 'login') {
  const cfg = RL[action] || RL.login;
  const key = `${ip}:${action}`;
  const now = Date.now();
  let e = rateMap.get(key);
  if (!e || now > e.reset) e = { count: 0, reset: now + cfg.windowMs, blockedUntil: 0 };
  if (now < e.blockedUntil) return false;
  e.count++;
  if (e.count > cfg.max) {
    e.blockedUntil = now + cfg.blockMs;
    const bc = (bruteCount.get(ip) || 0) + 1;
    bruteCount.set(ip, bc);
    if (bc >= 3) {
      slog(LOG_LEVELS.SECURITY, 'Brute force detectado', { ip, action });
      dispatchWebhookAlert('brute_force', { ip, action, count: bc });
    }
  }
  rateMap.set(key, e);
  return e.count <= cfg.max;
}

// Limpeza periódica do rateMap
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of rateMap) {
    if (now > e.reset && now > (e.blockedUntil || 0)) rateMap.delete(k);
  }
}, 300000).unref();

// --- HTTP helpers + Security Headers (Pilar 2) --------------------------------

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=()');
  // Remover X-Powered-By (Anti-OSINT, Pilar 2)
  res.removeHeader('X-Powered-By');
  const secure = config.baseUrl.startsWith('https');
  if (secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
  );
}

function sendJson(res, data, status) {
  if (status === undefined) status = 200;
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type'  : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJsonGzip(req, res, data, status) {
  if (status === undefined) status = 200;
  if (res.headersSent) return;
  const body   = JSON.stringify(data);
  const accept = req.headers['accept-encoding'] || '';
  const useGz  = accept.includes('gzip');
  const useDeflate = !useGz && accept.includes('deflate');
  if (!useGz && !useDeflate) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  const compress = useGz ? zlib.gzip : zlib.deflate;
  compress(body, (err, buf) => {
    if (err || res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); res.end(body); return; }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': useGz ? 'gzip' : 'deflate', 'Content-Length': buf.length });
    res.end(buf);
  });
}

function sendHtml(res, html, status = 200) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendText(res, text, status = 200) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendError(res, status, msgId) {
  if (res.headersSent) return;
  sendJson(res, { success: false, msg_id: msgId }, status);
}

// Erro 500 com hash de auditoria — nunca expõe stack trace (Pilar 4)
function sendInternalError(res, err, context = '') {
  const errorId = crypto.randomBytes(8).toString('hex');
  slog(LOG_LEVELS.CRITICAL, `Internal error [${errorId}] ${context}`, { err: err?.message, stack: err?.stack });
  dispatchWebhookAlert('internal_error_recurring', { errorId, context, msg: err?.message });
  if (!res.headersSent) {
    sendJson(res, { success: false, msg_id: 'server_error', error_id: errorId }, 500);
  }
}

function corsHeaders(req, pathname) {
  const origin = req.headers.origin || '';
  const isPanel = pathname.startsWith(R_ADMIN) || pathname.startsWith(R_MOD);
  const isChromeExt = origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
  const allowOrigin = isPanel ? 'null' : (isChromeExt || origin ? origin : '*');
  return {
    'Access-Control-Allow-Origin'      : allowOrigin,
    'Access-Control-Allow-Methods'     : 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers'     : 'Content-Type, Authorization, access-token, accept, X-Extension-ID',
    'Access-Control-Allow-Credentials' : isChromeExt ? 'true' : 'false',
    'Access-Control-Max-Age'           : '86400',
  };
}

function applyCors(req, res, pathname) {
  for (const [k, v] of Object.entries(corsHeaders(req, pathname))) res.setHeader(k, v);
}

// readBody com proteção contra Promises órfãs e payloads truncados (Pilar 4)
async function readBody(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size     = 0;
    let settled  = false;

    const done = (err, result) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result);
    };

    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        done(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      // Sanitizar nulos
      done(null, raw.replace(/\u0000/g, ''));
    });
    req.on('error', (e) => done(e));
    req.on('aborted', () => done(new Error('request_aborted')));
    // Timeout de segurança
    setTimeout(() => done(new Error('body_read_timeout')), 30000);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return Object.create(null);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Object.create(null);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return Object.create(null);
  return sanitizeObject(parsed);
}

function requireAccessToken(req) {
  return req.headers['access-token'] === config.criptKey;
}

// Validação do X-Extension-ID (Pilar 3)
function requireExtensionId(req) {
  const id = req.headers['x-extension-id'] || '';
  return id === config.chromeStoreId;
}

function parseBearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? sanitizeString(m[1].trim()) : '';
}

function wppUpdate() {
  return { success: true, version: '1.11', update: false, message: 'ok' };
}

// --- UI: CSS Cyberpunk Neon (Pilar 1) ----------------------------------------

const PANEL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');
:root{
  --bg:#020604;--surface:#070f0a;--surface2:#0a1610;--surface-hover:#0d1f13;
  --border:#183326;--border-bright:#26543c;
  --text:#e8fff3;--muted:#5a8a6e;--muted2:#8ab89a;
  --accent:#39ff14;--accent2:#00ff88;--accent3:#00cc66;
  --accent-grad:linear-gradient(135deg,#39ff14 0%,#00ff88 60%,#00cc66 100%);
  --ok-bg:#041f10;--ok-text:#39ff14;
  --warn-bg:#1e1800;--warn-text:#fde047;
  --danger:#ff4466;--danger-bg:#200810;--danger-text:#ff8899;
  --shadow:0 4px 40px rgba(0,0,0,.7);
  --ring:rgba(57,255,20,.3);
  --glow:0 0 18px rgba(57,255,20,.22),0 0 36px rgba(0,255,136,.08);
  --glow-strong:0 0 28px rgba(57,255,20,.4),0 0 56px rgba(0,255,136,.15);
  --mono:'JetBrains Mono',ui-monospace,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;height:100%}
body{
  font-family:'Inter',system-ui,-apple-system,sans-serif;
  background:var(--bg);color:var(--text);line-height:1.6;min-height:100vh;
  background-image:
    radial-gradient(ellipse 80% 60% at 50% -15%,rgba(57,255,20,.07),transparent),
    radial-gradient(ellipse 50% 40% at 85% 105%,rgba(0,255,136,.04),transparent),
    linear-gradient(180deg,rgba(57,255,20,.012) 0%,transparent 60%);
}
a{color:var(--accent);text-decoration:none;transition:color .2s,text-shadow .2s}
a:hover{color:#7fff6e;text-shadow:0 0 10px rgba(57,255,20,.45)}
/* Layout Principal: Sidebar + Conteúdo */
html{font-size:15px}
.layout{display:flex;min-height:100vh;position:relative;z-index:1}
.sidebar{
  width:56px;min-height:100vh;background:var(--surface);
  border-right:1px solid var(--border);display:flex;flex-direction:column;
  position:sticky;top:0;height:100vh;overflow:hidden;z-index:20;
  transition:width .28s cubic-bezier(.4,0,.2,1);flex-shrink:0;
}
.sidebar:hover{width:240px}
.sidebar-brand{
  display:flex;align-items:center;gap:10px;padding:20px 16px 16px;
  font-weight:800;font-size:1.05rem;letter-spacing:-.02em;
  color:var(--accent);border-bottom:1px solid var(--border);
  text-shadow:0 0 18px rgba(57,255,20,.35);white-space:nowrap;
}
.brand-dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:var(--glow);flex-shrink:0;margin-left:5px}
.brand-text{opacity:0;transition:opacity .2s .05s;overflow:hidden}
.sidebar:hover .brand-text{opacity:1}
.sidebar-section{
  padding:12px 10px 4px;font-size:.65rem;font-weight:700;text-transform:uppercase;
  letter-spacing:.1em;color:var(--muted);white-space:nowrap;
  opacity:0;transition:opacity .2s;
}
.sidebar:hover .sidebar-section{opacity:1}
.nav-item{
  display:flex;align-items:center;gap:10px;padding:10px 14px;margin:2px 6px;
  border-radius:9px;cursor:pointer;transition:all .2s ease;font-size:.9rem;font-weight:500;
  color:var(--muted2);text-decoration:none;border:1px solid transparent;
  position:relative;white-space:nowrap;overflow:hidden;
}
.nav-item:hover,.nav-item.active{
  color:var(--accent);background:rgba(57,255,20,.06);
  border-color:rgba(57,255,20,.18);box-shadow:0 0 10px rgba(57,255,20,.08);
}
.nav-item .icon{width:20px;text-align:center;flex-shrink:0;font-size:1rem}
.nav-label{opacity:0;transition:opacity .15s;overflow:hidden}
.sidebar:hover .nav-label{opacity:1}
.nav-badge{
  margin-left:auto;font-size:.68rem;font-weight:700;padding:2px 7px;
  border-radius:999px;background:rgba(57,255,20,.12);color:var(--accent);
  border:1px solid rgba(57,255,20,.25);opacity:0;transition:opacity .15s;flex-shrink:0;
}
.sidebar:hover .nav-badge{opacity:1}
.nav-badge.warn{background:rgba(255,180,55,.12);color:#fbbf24;border-color:rgba(255,180,55,.25)}
.nav-badge.danger{background:rgba(255,68,102,.12);color:var(--danger-text);border-color:rgba(255,68,102,.25)}
.sidebar-footer{margin-top:auto;padding:12px 6px;border-top:1px solid var(--border)}
/* Área principal */
.main-area{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{
  display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;
  padding:14px 24px;background:var(--surface);border-bottom:1px solid var(--border);
  position:sticky;top:0;z-index:10;backdrop-filter:blur(8px);
}
.topbar-title{font-size:1.05rem;font-weight:700;color:var(--text)}
.topbar-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.content{padding:20px 24px 48px;flex:1}
/* Cards */
.card{
  background:var(--surface2);border:1px solid var(--border);border-radius:14px;
  padding:22px 24px;margin-bottom:18px;box-shadow:var(--shadow);
  transition:border-color .25s ease,box-shadow .25s ease;
  contain:layout style;
}
.card:hover{border-color:rgba(57,255,20,.22);box-shadow:var(--shadow),var(--glow)}
.card-title{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:14px}
/* Métricas */
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:20px}
.metric{
  background:var(--surface2);border:1px solid var(--border);border-radius:14px;
  padding:20px;text-align:center;transition:all .25s ease;
  will-change:transform;
}
.metric:hover{transform:translateY(-3px);border-color:rgba(57,255,20,.3);box-shadow:var(--glow)}
.metric-value{font-size:2.1rem;font-weight:800;letter-spacing:-.04em;line-height:1;margin-bottom:6px}
.metric-value.accent{color:var(--accent);text-shadow:0 0 18px rgba(57,255,20,.4)}
.metric-value.warn{color:#fbbf24}
.metric-value.danger{color:var(--danger)}
.metric-label{font-size:.72rem;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:.06em}
/* Badges */
.badge{
  display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;
  font-size:.67rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
}
.badge-ok{background:var(--ok-bg);color:var(--ok-text);border:1px solid rgba(57,255,20,.3);box-shadow:0 0 8px rgba(57,255,20,.12)}
.badge-off{background:var(--danger-bg);color:var(--danger-text);border:1px solid rgba(255,68,102,.22)}
.badge-free{background:var(--warn-bg);color:var(--warn-text);border:1px solid rgba(253,224,71,.18)}
.badge-warn{background:rgba(255,180,55,.08);color:#fbbf24;border:1px solid rgba(255,180,55,.22)}
.badge-pending{background:rgba(100,100,255,.1);color:#a0a0ff;border:1px solid rgba(100,100,255,.25)}
/* Chips de código */
.key-chip,code.key-chip{
  font-family:var(--mono);font-size:.8rem;
  background:#040d06;border:1px solid rgba(57,255,20,.22);color:#7fff6e;
  padding:5px 11px;border-radius:7px;word-break:break-all;display:inline-block;
  box-shadow:0 0 8px rgba(57,255,20,.07);
}
/* Tabela */
.tbl-wrap{overflow-x:auto;contain:content}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th,td{padding:11px 13px;text-align:left;border-bottom:1px solid var(--border)}
th{cursor:pointer;color:var(--muted);font-size:.73rem;text-transform:uppercase;
  user-select:none;white-space:nowrap;position:sticky;top:0;background:var(--surface2)}
th:hover{color:var(--accent)}
tr.kr{will-change:transform;contain:layout style}
tr.kr:hover{background:var(--surface-hover)}
.act{display:flex;flex-wrap:wrap;gap:4px}
.bs{padding:5px 9px;border-radius:6px;border:1px solid var(--border);background:transparent;
  color:var(--text);font-size:.75rem;cursor:pointer;transition:all .2s}
.bs:hover{border-color:var(--accent);color:var(--accent)}
.bs.bg{border-color:rgba(57,255,20,.28);color:var(--accent)}
.bs.bd{border-color:rgba(255,68,102,.25);color:var(--danger-text)}
/* Formulários */
label{display:block;font-size:.8rem;font-weight:600;color:var(--muted);margin:0 0 6px}
.field{margin-bottom:16px}
input,select,textarea{
  width:100%;padding:10px 13px;border-radius:8px;border:1px solid var(--border);
  background:#040d06;color:var(--text);font:inherit;font-size:.93rem;
  transition:border-color .2s ease,box-shadow .2s ease;
}
input:focus,select:focus,textarea:focus{
  outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--ring),0 0 10px rgba(57,255,20,.12);
}
textarea{resize:vertical;min-height:80px}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
/* Botões */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:9px 18px;border:none;border-radius:8px;font:inherit;font-size:.855rem;font-weight:600;
  cursor:pointer;text-decoration:none;color:#020604;background:var(--accent-grad);
  transition:all .2s ease;box-shadow:0 4px 18px rgba(57,255,20,.3);
}
.btn:hover{transform:translateY(-1px);box-shadow:0 6px 26px rgba(57,255,20,.48);color:#020604}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text);box-shadow:none}
.btn-ghost:hover{background:rgba(57,255,20,.05);border-color:rgba(57,255,20,.3);color:var(--accent);box-shadow:0 0 10px rgba(57,255,20,.1)}
.btn-danger{background:linear-gradient(135deg,#aa0022,#ff4466);color:#fff;box-shadow:0 4px 14px rgba(255,68,102,.25)}
.btn-sm{padding:5px 11px;font-size:.75rem;border-radius:6px}
.btn-success{background:var(--accent-grad);color:#020604}
.btn-w{padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:.8rem;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.btn-w:hover{border-color:rgba(57,255,20,.3);color:var(--accent)}
.btn-p{padding:8px 16px;border-radius:8px;border:none;background:var(--accent-grad);color:#020604;font-size:.82rem;font-weight:600;cursor:pointer}
/* Alertas */
.alert{
  padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:.875rem;
  background:rgba(57,255,20,.05);color:#7fff6e;border:1px solid rgba(57,255,20,.18);
}
.alert-danger{background:rgba(255,68,102,.07);color:var(--danger-text);border-color:rgba(255,68,102,.22)}
.alert-warn{background:rgba(255,180,55,.06);color:#fbbf24;border-color:rgba(255,180,55,.2)}
/* Logs */
.log-list{display:flex;flex-direction:column;max-height:68vh;overflow-y:auto;contain:content}
.log-row{
  display:grid;grid-template-columns:150px 110px 1fr;gap:14px;padding:12px 14px;
  border-bottom:1px solid var(--border);font-size:.82rem;transition:background .2s;
  will-change:transform;contain:layout style;
}
.log-row:hover{background:var(--surface-hover)}
.log-type{font-family:var(--mono);font-size:.72rem;color:var(--accent2)}
/* Search bar */
.search-bar{display:flex;flex-wrap:wrap;gap:8px;padding:12px 0;align-items:center}
.search-bar input,.search-bar select{flex:1;min-width:130px;padding:8px 12px;
  border-radius:8px;border:1px solid var(--border);background:#040d06;color:var(--text)}
/* Gerador inline */
.gen-form{display:flex;flex-wrap:wrap;gap:7px;align-items:flex-end}
.gen-form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;padding:14px 18px;background:#020904;border-top:1px solid var(--border)}
.gen-form input,.gen-form select{padding:9px 13px;border-radius:8px;border:1px solid var(--border);background:#040d06;color:var(--text);font-size:.9rem}
.gen-form input[type=text]{min-width:180px;flex:1}
.gen-form input[type=number]{width:80px}
.gen-form select{min-width:90px}
/* Toast */
.toast{position:fixed;bottom:22px;right:22px;padding:12px 18px;border-radius:10px;
  background:var(--surface2);border:1px solid var(--accent);color:var(--accent);
  font-size:.855rem;opacity:0;transition:opacity .3s;z-index:999;pointer-events:none;
  box-shadow:var(--glow)}
.toast.show{opacity:1}
/* Modal */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.75);display:none;
  align-items:center;justify-content:center;z-index:50;backdrop-filter:blur(3px)}
.modal-bg.open{display:flex}
.modal{background:var(--surface2);border:1px solid var(--border-bright);border-radius:14px;
  padding:24px;max-width:400px;width:90%;box-shadow:var(--glow-strong)}
.modal h3{margin-bottom:16px;font-size:1.05rem}
.modal .field{margin-bottom:12px}
.modal .mrow{display:flex;gap:8px;margin-top:16px}
/* Login */
.login-page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.login-inner{width:100%;max-width:420px;display:flex;flex-direction:column;align-items:center;gap:22px}
.login-brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:1.3rem;
  color:var(--accent);text-shadow:0 0 22px rgba(57,255,20,.38)}
.login-card{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:16px;padding:34px 30px;box-shadow:var(--shadow),var(--glow)}
.login-card h1{font-size:1.45rem;margin-bottom:4px;text-align:center}
.login-card .subtitle{color:var(--muted);font-size:.875rem;margin-bottom:22px;text-align:center}
.login-card .btn{width:100%;margin-top:8px;color:#020604}
/* Client panel */
.app{max-width:1100px;margin:0 auto;padding:28px 24px 56px}
.topbar-simple{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:16px;
  padding:14px 24px;margin-bottom:28px;border-radius:14px;
  background:var(--surface2);border:1px solid var(--border);box-shadow:var(--shadow)}
.page-head{margin-bottom:24px;text-align:center}
.page-head h1{font-size:1.8rem;font-weight:800;letter-spacing:-.03em}
.page-head .subtitle{color:var(--muted);font-size:.9rem;margin-top:6px}
.info-grid{display:grid;gap:10px}
.info-row{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;font-size:.88rem}
.info-row .label{color:var(--muted);min-width:110px;font-size:.76rem;font-weight:600}
.steps{counter-reset:step;padding-left:0;list-style:none;text-align:left}
.steps li{counter-increment:step;padding:10px 0 10px 36px;position:relative;color:var(--muted);font-size:.88rem}
.steps li::before{content:counter(step);position:absolute;left:0;top:10px;width:24px;height:24px;border-radius:50%;
  background:var(--surface-hover);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;
  font-size:.72rem;font-weight:700;color:var(--accent)}
.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:16px}
.empty-state{text-align:center;padding:44px 24px;color:var(--muted)}
/* SPA section */
.sec{margin-bottom:20px;background:var(--surface2);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.sh{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)}
.sh-title{font-weight:700;font-size:.92rem}
/* Stats row */
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;padding:16px 0}
.sc{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center}
.sc .n{font-size:1.55rem;font-weight:800}
.sc .l{font-size:.65rem;color:var(--muted);text-transform:uppercase;margin-top:4px;letter-spacing:.06em}
/* Responsive */
@media(max-width:768px){
  .sidebar{width:0;overflow:hidden;position:fixed}
  .sidebar:hover{width:240px}
  .layout.sb-open .sidebar{width:240px}
  .main-area{width:100%}
  .metrics{grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}
  .log-row{grid-template-columns:1fr}
}
`;

const CANVAS_BG = `<canvas id="_cvs" style="position:fixed;inset:0;z-index:0;pointer-events:none"></canvas>
<script>(function(){var c=document.getElementById('_cvs'),ctx=c.getContext('2d');function resize(){c.width=window.innerWidth;c.height=window.innerHeight;}resize();window.addEventListener('resize',resize);var pts=Array.from({length:55},function(){return{x:Math.random()*c.width,y:Math.random()*c.height,vx:(Math.random()-.5)*.35,vy:(Math.random()-.5)*.35,r:Math.random()*1.8+.4};});function draw(){ctx.clearRect(0,0,c.width,c.height);pts.forEach(function(p){p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>c.width)p.vx*=-1;if(p.y<0||p.y>c.height)p.vy*=-1;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle='rgba(57,255,20,0.45)';ctx.fill();});for(var i=0;i<pts.length;i++){for(var j=i+1;j<pts.length;j++){var dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y,d=Math.sqrt(dx*dx+dy*dy);if(d<120){ctx.beginPath();ctx.moveTo(pts[i].x,pts[i].y);ctx.lineTo(pts[j].x,pts[j].y);ctx.strokeStyle='rgba(57,255,20,'+(0.1*(1-d/120))+')';ctx.lineWidth=.6;ctx.stroke();}}}requestAnimationFrame(draw);}draw();})();</script>`;

// --- Funções de renderização de UI (Pilar 1) ----------------------------------


function statusBadgeHtml(st) {
  if (st === 'active')   return '<span class="badge badge-ok">PRO Ativo</span>';
  if (st === 'blocked')  return '<span class="badge badge-off">Bloqueado</span>';
  if (st === 'expired')  return '<span class="badge badge-off">Expirado</span>';
  if (st === 'expirando')return '<span class="badge badge-warn">⏰ Expirando</span>';
  return '<span class="badge badge-free">Free</span>';
}





// Renderiza o SPA principal do admin (Pilar 1)

// Painel Mod SPA



// --- Helpers de status de licença --------------------------------------------






// --- Cache de chaves do painel ------------------------------------------------







// Regex do admin / mod (cached, O(1) por path — Pilar 4)

// --- Painel cliente ----------------------------------------------------------

const CLIENT_PANEL_RE = /^\/([a-z0-9]{16,32})\/(auth-painel|login|recovery|auth-plugin|redirect-plugin-register|register)\/?$/i;

function clientShell(title, body, _unused, subtitle) {
  return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — WaSpeed</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23020604'/%3E%3Ctext x='50%25' y='54%25' dominant-baseline='middle' text-anchor='middle' font-family='monospace' font-weight='700' font-size='14' fill='%2339ff14'%3EWS%3C/text%3E%3C/svg%3E"><style>${PANEL_CSS}</style></head>
<body><div class="app" style="position:relative;z-index:1">
<header class="topbar-simple" style="justify-content:space-between"><div style="display:flex;align-items:center;gap:10px;font-weight:800;font-size:1rem;color:var(--accent)"><span class="brand-dot"></span>WaSpeed</div></header>
<div class="page-head"><h1>${esc(title)}</h1>${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}</div>
${body}
</div>${CANVAS_BG}</body></html>`;
}


const PUB_CSS = `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--g:#39ff14;--g2:#00ff88;--dark:#020604;--card:#080e09;--card2:#0c1410;--bdr:#172a1a;--text:#e2f0e2;--muted:#4a6a4c;--r:14px;--glow:0 0 22px rgba(57,255,20,.18)}body{background:var(--dark);color:var(--text);font-family:'Inter',system-ui,sans-serif;min-height:100vh;overflow-x:hidden;background-image:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(57,255,20,.06),transparent)}a{color:var(--g);text-decoration:none}a:hover{text-shadow:0 0 10px rgba(57,255,20,.5)}.pub-nav{display:flex;align-items:center;justify-content:space-between;padding:13px 28px;border-bottom:1px solid var(--bdr);background:var(--card);position:sticky;top:0;z-index:50}.pub-logo{font-weight:800;font-size:1.1rem;color:var(--g);display:flex;align-items:center;gap:8px;letter-spacing:-.02em;text-shadow:0 0 20px rgba(57,255,20,.35)}.pub-links{display:flex;gap:8px}.pub-links a{font-size:.8rem;color:var(--muted);padding:5px 13px;border:1px solid var(--bdr);border-radius:6px;transition:all .2s;font-weight:600}.pub-links a:hover{color:var(--g);border-color:var(--g)}.pub-footer{text-align:center;padding:24px;font-size:.78rem;color:var(--muted);border-top:1px solid var(--bdr)}.pub-footer a{color:var(--muted)}.pub-footer a:hover{color:var(--g)}.card{background:var(--card);border:1px solid var(--bdr);border-radius:var(--r);padding:24px;transition:border-color .2s}.card:hover{border-color:rgba(57,255,20,.22)}.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 20px;border:none;border-radius:8px;font:inherit;font-size:.88rem;font-weight:700;cursor:pointer;color:#020604;background:linear-gradient(135deg,#39ff14,#00ff88);text-decoration:none;transition:all .2s;box-shadow:0 3px 16px rgba(57,255,20,.28)}.btn:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(57,255,20,.45);color:#020604}.btn-g{background:transparent;border:1px solid var(--bdr);color:var(--text)}.btn-g:hover{border-color:rgba(57,255,20,.3);color:var(--g)}.alert{padding:11px 15px;border-radius:9px;margin-bottom:14px;font-size:.87rem;background:rgba(57,255,20,.05);color:#7fff6e;border:1px solid rgba(57,255,20,.18)}.alert-d{background:rgba(255,68,102,.07);color:#ff8899;border-color:rgba(255,68,102,.22)}.alert-w{background:rgba(255,180,55,.06);color:#fbbf24;border-color:rgba(255,180,55,.2)}.chip{font-family:'JetBrains Mono',monospace;font-size:.8rem;background:#040d06;border:1px solid rgba(57,255,20,.22);color:#7fff6e;padding:4px 10px;border-radius:6px;display:inline-block}.badge-ok{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:.67rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;background:#041f10;color:var(--g);border:1px solid rgba(57,255,20,.28)}.badge-off{background:#200810;color:#ff8899;border:1px solid rgba(255,68,102,.22)}.badge-free{background:#1e1800;color:#fde047;border:1px solid rgba(253,224,71,.18)}.badge-pend{background:rgba(100,100,255,.1);color:#a0a0ff;border:1px solid rgba(100,100,255,.25)}.field{margin-bottom:14px}label{display:block;font-size:.78rem;font-weight:600;color:var(--muted);margin-bottom:5px}input{width:100%;padding:9px 12px;border-radius:7px;border:1px solid var(--bdr);background:#040d06;color:var(--text);font:inherit;font-size:.9rem;transition:border-color .2s,box-shadow .2s}input:focus{outline:none;border-color:var(--g);box-shadow:0 0 0 3px rgba(57,255,20,.18)}@media(max-width:480px){.pub-nav{padding:10px 16px}}`;

const PUB_CANVAS = `<canvas id="_c" style="position:fixed;inset:0;z-index:0;pointer-events:none"></canvas><script>(function(){var c=document.getElementById('_c'),x=c.getContext('2d');function r(){c.width=innerWidth;c.height=innerHeight;}r();addEventListener('resize',r);var p=Array.from({length:40},function(){return{x:Math.random()*c.width,y:Math.random()*c.height,vx:(Math.random()-.5)*.3,vy:(Math.random()-.5)*.3,r:Math.random()*1.5+.4};});function d(){x.clearRect(0,0,c.width,c.height);p.forEach(function(a){a.x+=a.vx;a.y+=a.vy;if(a.x<0||a.x>c.width)a.vx*=-1;if(a.y<0||a.y>c.height)a.vy*=-1;x.beginPath();x.arc(a.x,a.y,a.r,0,Math.PI*2);x.fillStyle='rgba(57,255,20,.4)';x.fill();});for(var i=0;i<p.length;i++)for(var j=i+1;j<p.length;j++){var dx=p[i].x-p[j].x,dy=p[i].y-p[j].y,dd=Math.sqrt(dx*dx+dy*dy);if(dd<110){x.beginPath();x.moveTo(p[i].x,p[i].y);x.lineTo(p[j].x,p[j].y);x.strokeStyle='rgba(57,255,20,'+(0.09*(1-dd/110))+')';x.lineWidth=.5;x.stroke();}}requestAnimationFrame(d);}d();})();</script>`;

function pubShell(title, body, activePath, _storeId) {
  activePath = activePath || '/';
  const nl = (href, label) => {
    const isActive = href === '/' ? activePath === '/' : activePath === href;
    const activeStyle = isActive
      ? 'color:var(--g);border-color:var(--g);background:rgba(57,255,20,.08);text-shadow:0 0 10px rgba(57,255,20,.4)'
      : 'color:var(--muted);border-color:var(--bdr);background:transparent';
    return '<a href="' + href + '" style="font-size:.8rem;padding:5px 13px;border:1px solid;border-radius:6px;transition:all .2s;font-weight:700;text-decoration:none;' + activeStyle + '">' + label + (isActive ? ' <span style="color:var(--g);font-size:.6rem">●</span>' : '') + '</a>';
  };
  const bodyStr = Array.isArray(body) ? body.join('\n') : body;
  return '<!DOCTYPE html><html lang="pt-BR"><head>\n<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>' + esc(title) + ' — WaSpeed</title>\n<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E%3Crect width=\'32\' height=\'32\' rx=\'8\' fill=\'%23020604\'/%3E%3Ctext x=\'50%25\' y=\'54%25\' dominant-baseline=\'middle\' text-anchor=\'middle\' font-family=\'monospace\' font-weight=\'700\' font-size=\'13\' fill=\'%2339ff14\'%3EWS%3C/text%3E%3C/svg%3E">\n<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">\n<style>' + PUB_CSS + '</style></head>\n<body>\n<nav class="pub-nav">\n  <div class="pub-logo">\u26a1 WaSpeed</div>\n  <div class="pub-links">\n    ' + nl('/','Portal') + '\n    ' + nl('/faq','FAQ') + '\n    ' + nl('/privacidade','\uD83D\uDD12 Privacidade') + '\n    ' + nl('/planos','\uD83D\uDCB3 Planos') + '\n    <a href="https://wa.me/5521996771552" target="_blank" style="font-size:.8rem;padding:5px 13px;border:1px solid var(--bdr);border-radius:6px;font-weight:600;color:var(--muted);text-decoration:none;transition:all .2s;background:transparent">\uD83D\uDCAC Suporte</a>\n  </div>\n</nav>\n<div style="position:relative;z-index:1;min-height:calc(100vh - 52px - 54px)">' + bodyStr + '</div>\n<footer class="pub-footer">\n  <p>\u00a9 ' + new Date().getFullYear() + ' WaSpeed \u00b7 <a href="/">Portal</a> \u00b7 <a href="/faq">FAQ</a> \u00b7 <a href="/planos">Planos</a> \u00b7 <a href="/privacidade">Privacidade</a></p>\n</footer>\n' + PUB_CANVAS + '</body></html>';
}

function renderPortal(storeId) {
  return pubShell('Portal do Cliente', [
    '<style>',
    '.portal-bg{min-height:calc(100vh - 52px);display:flex;align-items:center;justify-content:center;padding:32px 16px;background:radial-gradient(ellipse 70% 60% at 50% 40%,rgba(57,255,20,.07),transparent)}',
    '.glass{background:rgba(8,14,9,.78);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(57,255,20,.2);border-radius:18px;padding:44px 40px;width:100%;max-width:480px;box-shadow:0 8px 48px rgba(0,0,0,.6),0 0 60px rgba(57,255,20,.06)}',
    '.p-logo{display:flex;flex-direction:column;align-items:center;margin-bottom:28px}',
    '.p-icon{font-size:2.6rem;margin-bottom:10px}',
    '.p-brand{font-weight:800;font-size:1.45rem;color:#39ff14;letter-spacing:-.02em;text-shadow:0 0 24px rgba(57,255,20,.45)}',
    '.p-sub{font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;color:rgba(57,255,20,.55);margin-top:4px;font-weight:600}',
    '.key-lbl{font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:#39ff14;font-weight:700;margin-bottom:7px;display:block}',
    '.key-in{width:100%;padding:13px 16px;border-radius:10px;border:1px solid rgba(57,255,20,.28);background:rgba(4,13,6,.92);color:#e8fff3;font-family:"JetBrains Mono",monospace;font-size:.92rem;letter-spacing:.04em;transition:border-color .2s,box-shadow .2s;outline:none;box-sizing:border-box}',
    '.key-in:focus{border-color:#39ff14;box-shadow:0 0 0 3px rgba(57,255,20,.15),0 0 18px rgba(57,255,20,.1)}',
    '.btn-main{display:block;width:100%;padding:14px;border-radius:10px;border:none;font:inherit;font-size:1rem;font-weight:800;cursor:pointer;color:#020604;background:linear-gradient(135deg,#39ff14,#00ff88);text-align:center;letter-spacing:.03em;transition:all .2s;box-shadow:0 4px 20px rgba(57,255,20,.35);margin-top:14px}',
    '.btn-main:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(57,255,20,.5)}',
    '.divider{height:1px;background:rgba(57,255,20,.1);margin:22px 0}',
    '.btn-sec{display:flex;align-items:center;gap:10px;width:100%;padding:11px 16px;border-radius:9px;border:1px solid rgba(57,255,20,.12);background:transparent;color:rgba(57,255,20,.55);font:inherit;font-size:.85rem;font-weight:600;cursor:pointer;text-decoration:none;transition:all .2s;margin-bottom:8px;box-sizing:border-box}',
    '.btn-sec:hover{border-color:rgba(57,255,20,.35);color:#39ff14;background:rgba(57,255,20,.04)}',
    '.p-lgpd{font-size:.68rem;color:rgba(57,255,20,.35);text-align:center;line-height:1.7;margin-top:22px;padding-top:18px;border-top:1px solid rgba(57,255,20,.08)}',
    '.p-lgpd a{color:rgba(57,255,20,.5);text-decoration:underline}',
    '.result-card{margin-top:18px;border-radius:12px;border:1px solid rgba(57,255,20,.2);background:rgba(4,13,6,.85);overflow:hidden;display:none}',
    '.rc-header{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0}',
    '.rc-cell{padding:18px 16px;text-align:center;border-bottom:1px solid rgba(57,255,20,.1)}',
    '.rc-cell:not(:last-child){border-right:1px solid rgba(57,255,20,.08)}',
    '.rc-val{font-size:1rem;font-weight:700;margin-bottom:6px;min-height:28px;display:flex;align-items:center;justify-content:center}',
    '.rc-lbl{font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(57,255,20,.4);font-weight:600}',
    '.rc-section{padding:16px 20px;border-bottom:1px solid rgba(57,255,20,.08)}',
    '.rc-section:last-child{border-bottom:none}',
    '.rc-stitle{font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(57,255,20,.4);font-weight:700;margin-bottom:10px}',
    '.rc-row{display:flex;gap:8px;align-items:baseline;margin-bottom:6px}',
    '.rc-row:last-child{margin-bottom:0}',
    '.rc-key{font-size:.75rem;color:rgba(57,255,20,.45);min-width:80px;flex-shrink:0}',
    '.rc-val2{font-size:.85rem;color:#c8e8c8}',
    '.kchip{font-family:"JetBrains Mono",monospace;font-size:.75rem;background:#040d06;border:1px solid rgba(57,255,20,.22);color:#7fff6e;padding:3px 9px;border-radius:6px}',
    '.p-rem-btn{padding:3px 10px;border-radius:5px;border:1px solid rgba(255,68,102,.3);background:transparent;color:#ff8899;font-size:.7rem;font-weight:700;cursor:pointer;transition:all .15s}',
    '.p-rem-btn:hover{background:rgba(255,68,102,.1)}',
    '</style>',
    '<div class="portal-bg">',
    '<div class="glass">',
    '<div class="p-logo"><span class="p-icon">⚡</span><span class="p-brand">WaSpeed</span><span class="p-sub">Portal do Cliente</span></div>',
    '<div style="margin-bottom:16px"><label class="key-lbl">Sua chave de ativação</label>',
    '<input id="ki" class="key-in" type="text" placeholder="WS-XXXXX-XXXXX-XXXXX" autocomplete="off" spellcheck="false" oninput="this.value=this.value.trim().toUpperCase()">',
    '</div>',
    '<button class="btn-main" onclick="consultarChave()">🔍 Consultar Minha Chave</button>',
    '<div id="status-msg" style="display:none;margin-top:14px;padding:10px 14px;border-radius:8px;font-size:.85rem;border:1px solid rgba(57,255,20,.18);background:rgba(57,255,20,.05);color:#7fff6e"></div>',
    '<div id="result-box" class="result-card">',
    '<div class="rc-header">',
    '<div class="rc-cell"><div class="rc-val" id="rc-status">—</div><div class="rc-lbl">Status</div></div>',
    '<div class="rc-cell"><div class="rc-val" id="rc-lib" style="font-size:.88rem">—</div><div class="rc-lbl">Liberação</div></div>',
    '<div class="rc-cell"><div class="rc-val" id="rc-val" style="font-size:.82rem">—</div><div class="rc-lbl">Validade</div></div>',
    '</div>',
    '<div class="rc-section">',
    '<div class="rc-stitle">Conta</div>',
    '<div class="rc-row"><span class="rc-key">Cliente</span><span class="rc-val2" id="rc-label">—</span></div>',
    '<div class="rc-row"><span class="rc-key">Chave</span><code class="kchip" id="rc-code">—</code></div>',
    '<div class="rc-row"><span class="rc-key">Dispositivos</span><span class="rc-val2" id="rc-devices">—</span></div>',
    '</div>',
    '<div class="rc-section" id="rc-phones-section" style="display:none">',
    '<div class="rc-stitle">Dispositivos cadastrados — <small style="color:rgba(57,255,20,.35);font-size:.6rem">Clique em Remover para desvincular</small></div>',
    '<div id="rc-phones-list" style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto"></div>',
    '</div>',
    '</div>',
    '<div class="divider"></div>',
    '<a href="/faq" class="btn-sec">❓ FAQ – Dúvidas Frequentes</a>',
    '<a href="/planos" class="btn-sec">💳 Ver Planos e Preços</a>',
    '<p class="p-lgpd">Ao acessar, você concorda com nossa <a href="/privacidade">Política de Privacidade</a> e com o tratamento de dados conforme a <strong>LGPD – Lei nº 13.709/2018</strong>.</p>',
    '</div></div>',
    '<script>',
    'var _SL={active:"PRO ATIVO",blocked:"BLOQUEADA",expired:"EXPIRADA",free:"FREE",pending:"PENDENTE"};',
    'var _SC={active:"#39ff14",blocked:"#ff8899",expired:"#ff8899",free:"#fde047",pending:"#a0a0ff"};',
    'var _curKey="";',
    'function setStatus(msg,ok){var el=document.getElementById("status-msg");el.style.display="block";el.style.color=ok?"#7fff6e":"#ff8899";el.style.borderColor=ok?"rgba(57,255,20,.18)":"rgba(255,68,102,.22)";el.style.background=ok?"rgba(57,255,20,.05)":"rgba(255,68,102,.07)";el.textContent=msg;}',
    'function renderPhones(phones){',
    '  var sec=document.getElementById("rc-phones-section");',
    '  var list=document.getElementById("rc-phones-list");',
    '  if(!phones||!phones.length){sec.style.display="none";return;}',
    '  sec.style.display="block";',
    '  list.innerHTML=phones.map(function(p){',
    '    var masked=p.length>6?p.slice(0,2)+"••••"+p.slice(-4):p;',
    '    return \'<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:7px;border:1px solid rgba(57,255,20,.12);background:rgba(4,13,6,.7)">\'+',
    '      \'<span style="font-family:monospace;font-size:.82rem;color:#c8e8c8">\'+p+\'</span>\'+',
    '      \'<button class="p-rem-btn" onclick="removePhone(this,\\\'\'+p+\'\\\')">\u2715 Remover</button>\'+',
    '    \'</div>\';',
    '  }).join("");',
    '}',
    'async function removePhone(btn,phone){',
    '  if(!_curKey)return;',
    '  btn.disabled=true;btn.textContent="...";',
    '  try{',
    '    var r=await fetch("/api/portal/remove-phone",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:_curKey.toLowerCase(),phone:phone})});',
    '    var j=await r.json();',
    '    if(j.success){setStatus("N\u00famero removido.",true);consultarChave();}',
    '    else{btn.disabled=false;btn.textContent="\u2715 Remover";setStatus("Erro ao remover.",false);}',
    '  }catch(e){btn.disabled=false;btn.textContent="\u2715 Remover";setStatus("Erro de conex\u00e3o.",false);}',
    '}',
    'async function consultarChave(){',
    '  var k=document.getElementById("ki").value.trim();',
    '  if(!k){setStatus("Digite sua chave de ativa\u00e7\u00e3o.",false);return;}',
    '  _curKey=k;',
    '  setStatus("Consultando...",true);',
    '  document.getElementById("result-box").style.display="none";',
    '  try{',
    '    var r=await fetch("/api/auth/validate-portal",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:k.toLowerCase()})});',
    '    var j=await r.json();',
    '    if(!j.success){setStatus(j.msg_id==="not_found"?"Chave n\u00e3o encontrada. Verifique e tente novamente.":"Chave inv\u00e1lida.",false);return;}',
    '    var sl=_SL[j.status]||j.status.toUpperCase();',
    '    var sc=_SC[j.status]||"#fde047";',
    '    document.getElementById("rc-status").innerHTML=\'<span style="font-size:.72rem;font-weight:800;color:\'+sc+\';background:\'+sc+\'18;border:1px solid \'+sc+\'28;padding:3px 10px;border-radius:999px;letter-spacing:.06em">\'+sl+"</span>";',
    '    document.getElementById("rc-lib").textContent=j.liberacao||"\u2014";',
    '    document.getElementById("rc-val").textContent=j.expiresAt?new Date(j.expiresAt).toLocaleDateString("pt-BR"):"Sem vencimento";',
    '    document.getElementById("rc-label").textContent=j.label||"\u2014";',
    '    document.getElementById("rc-code").textContent=j.code||k;',
    '    document.getElementById("rc-devices").textContent=j.phones+"/"+(j.isUnlimited?"\u221e":String(j.maxUses));',
    '    renderPhones(j.phoneList||[]);',
    '    document.getElementById("result-box").style.display="block";',
    '    setStatus("Chave encontrada.",true);',
    '  }catch(e){setStatus("Erro de conex\u00e3o. Tente novamente.",false);}',
    '}',
    'document.getElementById("ki").addEventListener("keydown",function(e){if(e.key==="Enter")consultarChave();});',
    '</scr' + 'ipt>',
  ].join('\n'), '/', storeId);
}

function renderFaqPage() {
  const faqs = [
    ['🔑 Como ativo minha chave?', 'Instale a extensão WaSpeed no Chrome, abra o WhatsApp Web, clique no ícone da extensão, cole sua chave WS-XXXXX-XXXXX e confirme. O status muda para Ativo imediatamente.'],
    ['📱 Quantos números posso usar?', 'Depende do seu plano: Solo (1), Padrão (3), Pro (5) e Empresarial (10). Ao atingir o limite, novos dispositivos são automaticamente bloqueados.'],
    ['⏱ Como funciona a renovação?', 'A renovação soma os dias ao tempo restante — você nunca perde dias. Renove antes ou depois do vencimento sem perder o acesso acumulado.'],
    ['❌ O que acontece ao vencer?', 'A extensão para de funcionar. Suas configurações são preservadas. Basta renovar o plano para retomar o acesso sem reconfigurar nada.'],
    ['💳 Como pago?', 'Os links de pagamento estão sendo configurados. Enquanto isso, entre em contato com o suporte no WhatsApp para contratar manualmente via PIX.'],
    ['🔄 Posso trocar de dispositivo?', 'Sim. A chave é vinculada ao número do WhatsApp, não ao computador. Instale em outro Chrome e autentique com o mesmo número.'],
    ['⚡ O que está incluso em todos os planos?', 'Disparos em massa, funis, fluxos, agendamentos, CRM, etiquetas, respostas rápidas e suporte via WhatsApp — inclusos em todos os planos.'],
    ['💬 Como aciono o suporte técnico?', 'Via WhatsApp no número +55 21 99677-1552, de segunda a sexta das 9h às 18h. Resposta em até 2h para dúvidas simples.'],
    ['💰 Existe versão gratuita?', 'Sim. Novas instalações recebem automaticamente uma chave gratuita com recursos limitados e sem prazo de expiração.'],
    ['❓ Esqueci minha chave. Como recupero?', 'Digite seu número de WhatsApp vinculado no campo de recuperação do portal, ou entre em contato com o suporte para reenvio imediato.'],
  ];
  const items = faqs.map(([q,a],i) => `<div style="border-bottom:1px solid rgba(57,255,20,.1)">
<button onclick="(function(){var b=document.getElementById('b${i}'),a=document.getElementById('a${i}'),o=b.style.display==='none';b.style.display=o?'block':'none';a.textContent=o?'−':'+';a.style.color=o?'var(--g)':'var(--muted)';})()" style="width:100%;text-align:left;padding:15px 0;background:none;border:none;color:var(--text);font:inherit;font-size:.88rem;font-weight:700;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px">
<span>${q}</span><span id="a${i}" style="color:var(--muted);font-size:1.1rem;flex-shrink:0;transition:color .2s">+</span></button>
<div id="b${i}" style="display:none;padding:0 0 15px;font-size:.83rem;color:#8ab08c;line-height:1.75">${a}</div>
</div>`).join('');
  return pubShell('FAQ — Dúvidas Frequentes', `
<main style="max-width:720px;margin:0 auto;padding:52px 20px 80px">
<div style="text-align:center;margin-bottom:40px">
<p style="font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;font-weight:700">Central de Ajuda</p>
<h1 style="font-size:clamp(1.5rem,4vw,2.2rem);font-weight:800;letter-spacing:-.03em">Perguntas <span style="color:var(--g)">Frequentes</span></h1>
</div>
<div style="background:rgba(8,14,9,.85);backdrop-filter:blur(12px);border:1px solid rgba(57,255,20,.15);border-radius:16px;padding:6px 28px 6px">${items}</div>
<div style="margin-top:28px;background:rgba(57,255,20,.04);border:1px solid rgba(57,255,20,.15);border-radius:12px;padding:26px;text-align:center">
<p style="font-weight:700;margin-bottom:8px">Não encontrou o que procurava?</p>
<p style="color:var(--muted);font-size:.85rem;margin-bottom:16px">Nossa equipe responde pelo WhatsApp em horário comercial.</p>
<a class="btn" href="https://wa.me/5521996771552" target="_blank">💬 Falar com Suporte</a>
</div>
</main>`, '/faq');
}

function renderPlanosPage() {
  const PL = [
    {d:1, n:'Solo',        p:'24,99', o:null,     ic:'👤', dp:'24,99', hl:false},
    {d:3, n:'Padrão',      p:'29,99', o:'44,99',  ic:'⚡', dp:'10,00', hl:true },
    {d:5, n:'Pro',         p:'39,99', o:'79,99',  ic:'🚀', dp:'8,00',  hl:false},
    {d:10,n:'Empresarial', p:'59,99', o:'149,99', ic:'🏢', dp:'6,00',  hl:false},
  ];
  const cards = PL.map(p=>`<div style="background:${p.hl?'linear-gradient(165deg,#0a180a,#0e140e)':'rgba(8,14,9,.85)'};backdrop-filter:blur(10px);border:1px solid ${p.hl?'rgba(57,255,20,.4)':'rgba(57,255,20,.12)'};border-radius:16px;padding:26px 18px 22px;text-align:center;position:relative;display:flex;flex-direction:column;transition:transform .2s,border-color .2s${p.hl?';box-shadow:0 0 32px rgba(57,255,20,.12)':''}">
${p.hl?'<div style="position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#39ff14,#00ff88);color:#020604;font-size:.7rem;font-weight:800;padding:4px 18px;border-radius:20px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap">⚡ Mais popular</div>':''}
<div style="font-size:2.2rem;margin-bottom:10px">${p.ic}</div>
<div style="font-weight:800;font-size:1.1rem;margin-bottom:4px;color:${p.hl?'#e8fff3':'#c8e8c8'}">${p.n}</div>
<div style="font-size:.78rem;color:var(--muted);margin-bottom:18px">${p.d} número${p.d>1?'s':''} de WhatsApp</div>
${p.o?`<div style="font-size:.78rem;color:var(--muted);text-decoration:line-through;margin-bottom:3px">R$ ${p.o}</div>`:''}
<div style="display:flex;align-items:baseline;justify-content:center;gap:3px;margin-bottom:5px">
<span style="font-size:.85rem;color:var(--g);font-weight:700">R$</span>
<span style="font-size:2.2rem;font-weight:800;color:var(--g);line-height:1">${p.p}</span>
<span style="font-size:.8rem;color:var(--muted)">/mês</span>
</div>
<div style="font-size:.75rem;color:#7ab07c;margin-bottom:18px">R$ ${p.dp} por número</div>
<div style="height:1px;background:rgba(57,255,20,.1);margin-bottom:16px"></div>
<ul style="list-style:none;text-align:left;font-size:.78rem;color:#8ab08c;display:flex;flex-direction:column;gap:9px;margin-bottom:20px;flex:1">
<li>✅ ${p.d} número${p.d>1?'s':''} simultâneo${p.d>1?'s':''}</li>
<li>✅ 30 dias de acesso completo</li>
<li>✅ Todos os recursos inclusos</li>
<li>✅ Portal do cliente incluído</li>
<li>✅ Suporte via WhatsApp</li>
<li>✅ Renovação soma ao tempo restante</li>
</ul>
<a href="#" onclick="return false" style="display:block;padding:11px;border-radius:9px;font-size:.8rem;font-weight:700;text-align:center;background:${p.hl?'linear-gradient(135deg,#39ff14,#00ff88)':'rgba(57,255,20,.08)'};color:${p.hl?'#020604':'var(--muted)'};border:1px solid ${p.hl?'transparent':'rgba(57,255,20,.15)'};cursor:not-allowed;opacity:${p.hl?.75:.6}">🔒 Em breve</a>
</div>`).join('');

  const features = [
    ['Números de WhatsApp','1','3','5','10'],
    ['Preço mensal','R$ 24,99','R$ 29,99','R$ 39,99','R$ 59,99'],
    ['Preço por número','R$ 24,99','R$ 10,00','R$ 8,00','R$ 6,00'],
    ['Disparo em massa','✓','✓','✓','✓'],
    ['Funis de atendimento','✓','✓','✓','✓'],
    ['Fluxos automatizados','✓','✓','✓','✓'],
    ['Agendamento de mensagens','✓','✓','✓','✓'],
    ['CRM e etiquetas','✓','✓','✓','✓'],
    ['Respostas rápidas','✓','✓','✓','✓'],
    ['Suporte WhatsApp','✓','✓','✓','✓'],
    ['Portal do cliente','✓','✓','✓','✓'],
    ['Renovação automática','✓','✓','✓','✓'],
  ];

  return pubShell('Planos e Preços', `
<main style="max-width:980px;margin:0 auto;padding:52px 20px 80px">
<div style="text-align:center;margin-bottom:44px">
<p style="font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;font-weight:700">💳 Planos e Preços</p>
<h1 style="font-size:clamp(1.6rem,4vw,2.4rem);font-weight:800;letter-spacing:-.03em;margin-bottom:14px">Simples, <em style="color:var(--g);font-style:normal">transparente</em><br>e sem surpresas</h1>
<p style="color:var(--muted);font-size:.88rem;margin-bottom:20px">Todos os planos incluem acesso completo por 30 dias. Sem fidelidade.</p>
<div style="display:inline-flex;align-items:center;gap:18px;background:rgba(8,14,9,.85);border:1px solid rgba(57,255,20,.15);border-radius:30px;padding:9px 22px;font-size:.8rem;color:var(--muted);flex-wrap:wrap;justify-content:center;backdrop-filter:blur(8px)">
<span>✅ Sem fidelidade</span><span>⚡ Ativação imediata</span><span>💬 Suporte incluso</span><span>🔄 Renovação soma</span>
</div>
</div>
<div style="background:rgba(255,211,42,.04);border:1px solid rgba(255,211,42,.2);border-radius:10px;padding:13px 20px;margin-bottom:36px;display:flex;align-items:center;gap:12px;font-size:.82rem;color:#c9a800">
<span style="font-size:1.3rem">🚧</span>
<span><strong>Links de pagamento chegando em breve!</strong> Os planos e preços já estão definidos. Entre em contato pelo suporte para contratar manualmente.</span>
</div>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:48px">${cards}</div>
<div style="background:rgba(8,14,9,.85);backdrop-filter:blur(12px);border:1px solid rgba(57,255,20,.15);border-radius:16px;overflow:hidden;margin-bottom:36px">
<div style="padding:16px 22px;border-bottom:1px solid rgba(57,255,20,.1);font-size:.78rem;font-weight:700;color:var(--g);letter-spacing:.1em;text-transform:uppercase;background:rgba(57,255,20,.03)">📊 Tabela Comparativa Completa de Recursos</div>
<div style="overflow-x:auto">
<table style="width:100%;border-collapse:collapse;font-size:.8rem">
<thead><tr style="background:rgba(57,255,20,.03)">
<th style="padding:11px 18px;text-align:left;color:var(--muted);font-weight:600;border-bottom:1px solid rgba(57,255,20,.08);white-space:nowrap">Recurso / Limite</th>
${['👤 Solo','⚡ Padrão','🚀 Pro','🏢 Empresarial'].map(n=>`<th style="padding:11px 14px;text-align:center;color:var(--muted);font-weight:600;border-bottom:1px solid rgba(57,255,20,.08);white-space:nowrap">${n}</th>`).join('')}
</tr></thead>
<tbody>
${features.map((row,ri)=>`<tr style="border-bottom:1px solid rgba(57,255,20,.06)${ri%2===0?';background:rgba(57,255,20,.015)':''}">
<td style="padding:10px 18px;color:var(--muted);font-size:.78rem">${row[0]}</td>
${[row[1],row[2],row[3],row[4]].map((v,ci)=>`<td style="padding:10px 14px;text-align:center;color:${ri>=3?'#39ff14':ri<=1?'#c8e8c8':'#7af07a'};font-weight:${ri>=3?'700':'400'}">${v}</td>`).join('')}
</tr>`).join('')}
</tbody>
</table>
</div>
</div>
<div style="background:linear-gradient(135deg,rgba(10,26,10,.9),rgba(14,20,14,.9));backdrop-filter:blur(12px);border:1px solid rgba(57,255,20,.25);border-radius:16px;padding:36px;text-align:center">
<h3 style="font-weight:800;margin-bottom:10px;font-size:1.2rem">Precisa de ajuda para escolher?</h3>
<p style="color:var(--muted);font-size:.87rem;margin-bottom:22px;line-height:1.8">Nossa equipe analisa seu volume de mensagens e recomenda o plano ideal gratuitamente.</p>
<a class="btn" href="https://wa.me/5521996771552" target="_blank">💬 Falar com o Suporte</a>
</div>
</main>
<style>@media(max-width:720px){main>div:nth-child(4){grid-template-columns:1fr 1fr}}@media(max-width:440px){main>div:nth-child(4){grid-template-columns:1fr}}</style>`, '/planos');
}

function renderPrivacyPage() {
  const now = new Date().toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'});
  const sections = [
    ['📋','1. Visão Geral e Identificação do Controlador',`Esta Política de Privacidade descreve como o <strong>WaSpeed</strong> ("Nós", "Nosso Serviço"), desenvolvido e operado como serviço independente de licenciamento de software, coleta, processa, armazena e protege os dados pessoais dos Usuários ("Você", "Titular") em conformidade com a <strong>Lei Geral de Proteção de Dados Pessoais — LGPD (Lei Federal nº 13.709, de 14 de agosto de 2018)</strong> e demais normas aplicáveis. Ao instalar a extensão WaSpeed, ativar uma chave de licença ou utilizar o portal, você declara ter lido, compreendido e concordado com todos os termos desta Política.`],
    ['🗂','2. Dados Pessoais Coletados',`Coletamos exclusivamente os dados estritamente necessários para a operação do serviço de licenciamento, com base no princípio da minimização de dados (Art. 6º, III, LGPD):<br><br>
<strong>2.1 Dados de Identificação da Licença:</strong> chave de ativação (gerada aleatoriamente, não vinculada a CPF ou identidade civil), identificador interno de usuário (numérico, sequencial), nome ou apelido fornecido pelo administrador da licença e endereço de e-mail (opcional, para notificações).<br><br>
<strong>2.2 Dados Técnicos de Autenticação:</strong> número de telefone do WhatsApp vinculado à licença (no formato internacional, ex: 5521999999999), endereço IP de origem das requisições de autenticação, timestamps de último acesso e data de criação da licença.<br><br>
<strong>2.3 Dados NÃO Coletados:</strong> Confirmamos expressamente que o WaSpeed <strong>não coleta, não acessa e não armazena</strong> o conteúdo de mensagens, contatos, conversas, mídias, arquivos ou qualquer dado trafegado pelo WhatsApp. A extensão opera no contexto do navegador sem transmitir conteúdo de comunicações ao servidor.`],
    ['🎯','3. Finalidades e Bases Legais do Tratamento',`O tratamento dos dados pessoais coletados é realizado com as seguintes finalidades e bases legais (Art. 7º, LGPD):<br><br>
<strong>3.1 Execução do Contrato (Art. 7º, V):</strong> validação e controle de acesso à extensão WaSpeed, autenticação do usuário nas sessões de uso, controle do número de dispositivos simultâneos por licença e verificação de validade e limites do plano contratado.<br><br>
<strong>3.2 Legítimo Interesse (Art. 7º, IX):</strong> detecção de uso indevido ou compartilhamento não autorizado de chaves de licença, prevenção a fraudes e abuso do serviço, geração de logs de auditoria para resolução de disputas e análise de disponibilidade e performance do sistema.<br><br>
<strong>3.3 Cumprimento de Obrigação Legal (Art. 7º, II):</strong> quando exigido por autoridade competente, mediante ordem judicial ou administrativa devidamente fundamentada.`],
    ['⏱','4. Prazo de Retenção dos Dados',`Os dados pessoais são retidos pelo tempo estritamente necessário às finalidades declaradas:<br><br>
• <strong>Logs de autenticação (IP, timestamps):</strong> retidos por até 90 (noventa) dias corridos, sendo excluídos automaticamente por processo de limpeza periódica do banco de dados.<br>
• <strong>Dados da licença (chave, número, nome):</strong> mantidos enquanto a licença estiver ativa no sistema ou por até 30 (trinta) dias após o vencimento definitivo, podendo ser antecipados mediante solicitação do titular.<br>
• <strong>Exclusão imediata:</strong> mediante solicitação formal do titular, todos os dados associados à licença são removidos permanentemente em até 5 (cinco) dias úteis.`],
    ['🔒','5. Segurança e Medidas Técnicas',`Adotamos medidas técnicas e organizacionais adequadas para proteger os dados pessoais contra acesso não autorizado, destruição, perda, alteração, comunicação ou difusão indevida (Art. 46, LGPD):<br><br>
• <strong>Armazenamento:</strong> MongoDB Atlas com criptografia AES-256 em repouso (Encryption at Rest) e TLS 1.3 em trânsito, hospedado em infraestrutura certificada ISO/IEC 27001 e SOC 2 Type II.<br>
• <strong>Autenticação:</strong> senhas administrativas protegidas com PBKDF2-SHA512 (120.000 iterações), cookies de sessão HttpOnly e SameSite=Strict.<br>
• <strong>Transmissão:</strong> toda comunicação entre a extensão e o servidor utiliza HTTPS/TLS obrigatório em produção.<br>
• <strong>Controle de acesso:</strong> princípio de menor privilégio; dados são acessados apenas por processos e usuários autorizados com registros de auditoria.`],
    ['🤝','6. Compartilhamento com Terceiros',`Os dados pessoais <strong>não são vendidos, alugados ou cedidos</strong> a terceiros para fins comerciais, de marketing ou quaisquer outras finalidades não relacionadas à operação do serviço. O compartilhamento ocorre exclusivamente com prestadores de infraestrutura tecnológica essencial:<br><br>
• <strong>MongoDB, Inc.</strong> — armazenamento de dados em nuvem. DPA disponível em mongodb.com/legal/data-processing-agreement.<br>
• <strong>Render.com</strong> — hospedagem e execução do servidor de aplicação. DPA disponível em render.com/privacy.<br>
• <strong>Autoridades públicas:</strong> exclusivamente mediante ordem judicial ou determinação de autoridade competente, nos termos da legislação vigente.`],
    ['⚖️','7. Direitos do Titular',`Nos termos dos Arts. 17 a 22 da LGPD, você possui os seguintes direitos em relação aos seus dados pessoais, exercíveis mediante solicitação ao DPO (encarregado de dados):<br><br>
(I) <strong>Confirmação e Acesso</strong> — confirmar a existência e obter cópia dos dados tratados;<br>
(II) <strong>Correção</strong> — solicitar correção de dados incompletos, inexatos ou desatualizados;<br>
(III) <strong>Anonimização, Bloqueio ou Eliminação</strong> — de dados desnecessários, excessivos ou tratados em desconformidade com a LGPD;<br>
(IV) <strong>Portabilidade</strong> — solicitar a portabilidade dos dados a outro fornecedor de serviço;<br>
(V) <strong>Eliminação</strong> — dos dados pessoais tratados com base no consentimento;<br>
(VI) <strong>Informação</strong> — sobre entidades públicas e privadas com as quais dados são compartilhados;<br>
(VII) <strong>Revogação do consentimento</strong> — a qualquer momento.<br><br>
Para exercer seus direitos, entre em contato via WhatsApp ou e-mail informando sua chave de licença e o direito a ser exercido.`],
    ['🔔','8. Alterações desta Política',`Esta Política pode ser atualizada periodicamente para refletir mudanças nos processos de tratamento de dados, na legislação aplicável ou nos serviços oferecidos. A data de última atualização é exibida no topo desta página. Alterações materiais serão comunicadas com antecedência mínima de 15 (quinze) dias pelo portal e via notificação na extensão. A continuidade do uso dos serviços após as alterações implica aceitação dos novos termos.`],
    ['📞','9. Contato e Encarregado de Dados (DPO)',`Para exercício de direitos, dúvidas, solicitações ou reclamações relacionadas ao tratamento de dados pessoais:<br><br>
<strong>Suporte WaSpeed</strong> — disponível via WhatsApp: <a href="https://wa.me/5521996771552" style="color:var(--g)">+55 21 99677-1552</a><br>
Horário de atendimento: segunda a sexta, das 9h às 18h (horário de Brasília).<br><br>
Você também pode registrar reclamações perante a <strong>Autoridade Nacional de Proteção de Dados (ANPD)</strong> pelo portal gov.br/anpd.`],
  ];
  return pubShell('Política de Privacidade', `
<main style="max-width:720px;margin:0 auto;padding:52px 20px 80px">
<div style="margin-bottom:44px">
<p style="font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;font-weight:700">Legal</p>
<h1 style="font-size:clamp(1.5rem,4vw,2.2rem);font-weight:800;letter-spacing:-.03em;margin-bottom:10px">Política de Privacidade</h1>
<p style="font-size:.8rem;color:var(--muted)">Última atualização: ${now} · Em conformidade com a LGPD — Lei nº 13.709/2018</p>
</div>
${sections.map(([ic,t,c])=>`<div style="background:rgba(8,14,9,.85);backdrop-filter:blur(10px);border:1px solid rgba(57,255,20,.12);border-radius:14px;padding:24px 28px;margin-bottom:14px">
<h2 style="font-size:.82rem;font-weight:700;color:var(--g);text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px;display:flex;align-items:center;gap:8px">${ic} ${t}</h2>
<div style="font-size:.83rem;color:#8ab08c;line-height:1.95">${c}</div></div>`).join('')}
</main>`, '/privacidade');
}





function renderClientAuthPainel(storeId, token, page, rec) {
  if (!rec) {
    return clientShell('Sessão inválida', `<div class="card">
      <div class="alert alert-danger">Token inválido ou sessão expirada. Faça login novamente na extensão WaSpeed.</div>
      <a class="btn" href="/${esc(storeId)}/login">Instruções de acesso</a>
    </div>`);
  }
  const code      = rec.code || token;
  const user      = keyToUser(code, rec);
  const st        = keyStatus(rec);
  const premium   = buildUserPremium(code, rec);
  const exp       = rec.expiresAt ? new Date(rec.expiresAt).toLocaleString('pt-BR') : 'Sem vencimento';
  const liberacao = premium?.data_liberacao || '—';
  const pageLabel = page ? esc(decodeURIComponent(page)) : '';
  return clientShell('Minha conta', `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:22px">
      <div class="metric" style="padding:28px 20px"><div class="metric-value" style="font-size:1.1rem;margin-bottom:10px">${statusBadgeHtml(st)}</div><div class="metric-label">Status</div></div>
      <div class="metric" style="padding:28px 20px"><div class="metric-value" style="font-size:1.3rem">${esc(liberacao)}</div><div class="metric-label">Data liberação</div></div>
      <div class="metric" style="padding:28px 20px"><div class="metric-value" style="font-size:1.1rem">${esc(exp)}</div><div class="metric-label">Validade</div></div>
    </div>
    <div class="card" style="padding:28px 30px;margin-bottom:18px">
      <div class="card-title">Conta</div>
      <p style="font-size:1.3rem;font-weight:700;margin-bottom:6px">${esc(user.name)}</p>
      <p style="color:var(--muted);font-size:1rem;margin-bottom:18px">${esc((user.email || '').replace(/@waspeed\.local$/i, ''))}</p>
      <div class="info-grid" style="gap:14px">
        <div class="info-row" style="font-size:1rem"><span class="label" style="font-size:.85rem">Chave</span><code class="key-chip" style="font-size:.9rem">${esc(code)}</code></div>
        ${pageLabel ? `<div class="info-row" style="font-size:1rem"><span class="label" style="font-size:.85rem">Seção</span><span>${pageLabel}</span></div>` : ''}
      </div>
    </div>
    <div class="card" style="padding:28px 30px">
      <div class="card-title">Informações</div>
      <div class="info-grid" style="gap:14px">
        <div class="info-row" style="font-size:1rem"><span class="label" style="font-size:.85rem">Servidor</span><span class="key-chip" style="font-size:.9rem">Servidor de teste ativo</span></div>
        <div class="info-row" style="font-size:1rem"><span class="label" style="font-size:.85rem">WhatsApp</span><span style="font-size:1rem">${esc(rec.lastPhone || '—')}</span></div>
        <div class="info-row" style="font-size:1rem"><span class="label" style="font-size:.85rem">Último uso</span><span style="font-size:1rem">${rec.lastUsed ? esc(new Date(rec.lastUsed).toLocaleString('pt-BR')) : '—'}</span></div>
      </div>
    </div>`, null, `Olá, ${esc(user.name)}`);
}

async function handleClientPanel(req, res, pathname, url) {
  const m = pathname.match(CLIENT_PANEL_RE);
  if (!m) return false;
  const storeId = m[1];
  const route   = m[2].toLowerCase();
  const token   = sanitizeString(url.searchParams.get('token') || url.searchParams.get('bearer_token') || '');
  const page    = url.searchParams.get('page') || '';

  if (route === 'auth-painel') {
    if (!token) { res.writeHead(302, { Location: `/${storeId}/login` }); res.end(); return true; }
    const rec = await findKeyByBearer(token);
    sendHtml(res, renderClientAuthPainel(storeId, token, page, rec));
    return true;
  }
  if (route === 'auth-plugin') {
    const dest = token ? `/${storeId}/auth-painel?token=${encodeURIComponent(token)}` : `/${storeId}/login`;
    res.writeHead(302, { Location: dest }); res.end(); return true;
  }
  if (route === 'redirect-plugin-register' || route === 'register') {
    sendHtml(res, renderPortal(storeId)); return true;
  }
  if (route === 'recovery') { sendHtml(res, renderPortal(storeId)); return true; }
  if (route === 'login')    { sendHtml(res, renderPortal(storeId)); return true; }
  return false;
}

// --- Router de API WaSpeed (Pilar 3) -----------------------------------------

async function handleWaSpeedApi(req, res, pathname, ip) {
  const chromeId = config.chromeStoreId;
  const settings = cachedSettings || {};

  // Rotas públicas (sem access-token)
  if (pathname === `/api/urls/install/${chromeId}` || pathname.match(/^\/api\/urls\/install\//)) {
    await addLog('install', 'Redirect install', { ip });
    return sendJson(res, { success: true, url: settings.installUrl || config.installUrl });
  }
  if (pathname.match(/^\/api\/urls\/uninstall\//)) {
    return sendJson(res, { success: true, url: `${config.baseUrl}/obrigado` });
  }
  if (pathname.match(/^\/api\/urls\/active-notes\//)) {
    return sendJson(res, { success: true, path_note_update: { redirect: config.notesRedirect } });
  }
  if (pathname.match(/^\/api\/urls\/notes\//)) {
    const html = settings.notesHtml || '<h1>WaSpeed</h1>';
    if (!res.headersSent) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }
    return true;
  }
  if (pathname === '/api/urls/update' && (req.method === 'GET' || req.method === 'POST')) {
    return sendJson(res, wppUpdate());
  }
  if (pathname === '/api/services/update' && (req.method === 'GET' || req.method === 'POST')) {
    return sendJson(res, wppUpdate());
  }
  if (pathname === '/api/external/is_instaled') {
    return sendJson(res, { success: true });
  }
  if (pathname === '/api/external/ping') {
    let keyCount = 0;
    try { keyCount = await db.collection(COL.licenses).countDocuments(); } catch {}
    return sendJson(res, { success: true, server: 'waspeed', version: '4.0.0', keys: keyCount, storage: 'mongodb' });
  }

  // A partir daqui: requer access-token
  if (pathname === '/api/portal/remove-phone' && req.method === 'POST') {
    const body = await readJson(req);
    const raw  = sanitizeString(String(body.key || '').trim());
    const key  = normKey(raw);
    const ph   = sanitizeString(String(body.phone || '').trim());
    if (!key || !ph) { sendJson(res, { success: false, msg_id: 'missing_params' }); return true; }
    if (detectInjection(key) || detectInjection(ph)) { sendJson(res, { success: false, msg_id: 'invalid_input' }); return true; }
    const rec = await findKey(key) || await findKeyByBearer(raw);
    if (!rec) { sendJson(res, { success: false, msg_id: 'not_found' }); return true; }
    if (!db) { sendJson(res, { success: false, msg_id: 'db_unavailable' }); return true; }
    await db.collection(COL.licenses).updateOne({ code: normKey(rec.code || key) }, { $pull: { phones: ph } });
    sendJson(res, { success: true });
    return true;
  }

  if (pathname === '/api/auth/validate-portal' && req.method === 'POST') {
    const body = await readJson(req);
    const raw  = sanitizeString(String(body.key || '').trim());
    const key  = normKey(raw);
    if (!key) { sendJson(res, { success: false, msg_id: 'key_required' }); return true; }
    if (detectInjection(key)) { sendJson(res, { success: false, msg_id: 'invalid_key' }); return true; }
    const rec = await findKey(key) || await findKeyByBearer(raw);
    if (!rec) { sendJson(res, { success: false, msg_id: 'not_found' }); return true; }
    const st      = keyStatus(rec);
    const code    = rec.code || key;
    const maxU    = (rec.maxUses != null) ? rec.maxUses : -1;
    const isUnlim = maxU <= 0 || maxU === -1;
    const premium = buildUserPremium(code, rec);
    sendJson(res, {
      success    : true,
      status     : st,
      code       : code,
      label      : rec.label || '',
      expiresAt  : rec.expiresAt || null,
      createdAt  : rec.createdAt || null,
      lastUsed   : rec.lastUsed  || null,
      lastPhone  : rec.lastPhone || null,
      lastIp     : rec.lastIp    || null,
      maxUses    : maxU,
      isUnlimited: isUnlim,
      phones     : (rec.phones || []).length,
      phoneList  : (rec.phones || []),
      premium    : rec.premium || false,
      liberacao  : premium ? premium.data_liberacao : null,
    });
    return true;
  }

  if (!requireAccessToken(req)) {
    return sendJson(res, { success: false, msg_id: 'invalid_access_token' }, 403);
  }

  const extId = req.headers['x-extension-id'] || '';
  if (extId && extId !== config.chromeStoreId) {
    slog(LOG_LEVELS.SECURITY, 'X-Extension-ID divergente (modo unpacked aceito)', { ip, extId });
  }

  const resolvedId = extId || chromeId;

  if ((pathname === `/api/auth/login-bearer/${resolvedId}` || pathname === `/api/auth/login-bearer/${chromeId}`) && (req.method === 'GET' || req.method === 'POST')) {
    if (!checkRate(ip)) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const bearer = parseBearer(req);
    if (detectInjection(bearer)) {
      slog(LOG_LEVELS.SECURITY, 'Injection em login-bearer', { ip });
      dispatchWebhookAlert('nosql_injection', { route: 'login-bearer', ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token' });
    }
    const bBody = req.method === 'POST' ? await readJson(req) : {};
    const bPhone = sanitizeString(String(bBody.whatsapp_plugin || bBody.whatsapp_registro || bBody.phone || '').slice(0, 40));
    const rec = await findKeyByBearer(bearer);
    if (!rec) {
      await addLog('auth_fail', 'Bearer inválido', { ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token' });
    }
    const result = await authSuccess(rec.code || bearer, rec, { phone: bPhone, ip });
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('auth_ok', `Login bearer ${rec.code}`, { ip, phone: bPhone });
    return sendJson(res, result.body);
  }

  if ((pathname === `/api/auth/register-free/${resolvedId}` || pathname === `/api/auth/register-free/${chromeId}`) && req.method === 'POST') {
    if (!checkRate(ip)) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const body  = await readJson(req);
    const phone = sanitizeString(String(body.whatsapp_plugin || body.whatsapp_registro || body.phone || '').slice(0, 40));
    const { code, rec } = await getOrCreateFreeKey(body.extension_id || body.device_id, ip);
    const result = await authSuccess(code, rec, { phone, ip });
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('free_register', `Login free ${code}`, { ip, phone, extension_id: body.extension_id });
    return sendJson(res, result.body);
  }

  if ((pathname === `/api/auth/validation/${resolvedId}` || pathname === `/api/auth/validation/${chromeId}`) && req.method === 'POST') {
    if (!checkRate(ip)) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const body  = await readJson(req);
    const key   = normKey(body.access_token_plugin || body.chave || body.senha || body.email);
    const phone = sanitizeString(String(body.whatsapp_plugin || body.whatsapp_registro || body.phone || '').slice(0, 40));
    if (detectInjection(key)) {
      slog(LOG_LEVELS.SECURITY, 'Injection em validation', { ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token_in_validation' });
    }
    const rec = await findKey(key);
    if (!rec) {
      await addLog('auth_fail', 'Chave inválida validation', { ip, key });
      return sendJson(res, { success: false, msg_id: 'invalid_token_in_validation' });
    }
    const result = await authSuccess(key, rec, { phone, ip });
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('validation_ok', `Validação ${key}`, { ip, phone });
    return sendJson(res, result.body);
  }

  if ((pathname === `/api/auth/login/${resolvedId}` || pathname === `/api/auth/login/${chromeId}`) && req.method === 'POST') {
    if (!checkRate(ip)) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const body  = await readJson(req);
    const key   = normKey(body.senha || body.chave || body.email || body.access_token_plugin);
    const phone = sanitizeString(String(body.whatsapp_plugin || body.whatsapp_registro || body.phone || '').slice(0, 40));
    const rec   = await findKey(key);
    if (!rec) {
      await addLog('auth_fail', 'Login chave inválida', { ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token' });
    }
    const result = await authSuccess(key, rec, { phone, ip });
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('auth_ok', `Login ${key}`, { ip, phone });
    return sendJson(res, result.body);
  }

  if (pathname === '/api/user/update' && req.method === 'POST') {
    const body   = await readJson(req);
    const bearer = parseBearer(req) || body.bearer_token;
    const rec    = await findKeyByBearer(bearer);
    if (!rec) return sendJson(res, { success: false, msg_id: 'invalid_token' });
    const patch  = {};
    if (body.whatsapp_plugin || body.whatsapp_registro) {
      patch.lastPhone = sanitizeString(body.whatsapp_plugin || body.whatsapp_registro);
    }
    if (body.name) patch.label = sanitizeString(String(body.name).slice(0, 60));
    if (Object.keys(patch).length) await updateLicense(rec.code, patch);
    Object.assign(rec, patch);
    return sendJson(res, { success: true, user: keyToUser(rec.code || bearer, rec) });
  }

  if (pathname === `/api/services/initial-data/${resolvedId}` || pathname === `/api/services/initial-data/${chromeId}`) {
    return sendJson(res, {
      webhooks  : settings.webhooks  || [],
      meet      : settings.meet      || {},
      urls      : settings.urls      || {},
      migration : settings.migration || {},
      update_path     : `${config.baseUrl}/api/urls/update`,
      update_path_new : `${config.baseUrl}/api/services/update`,
      update_path_active: 'true',
      wpp_mensagens   : { timer: '60000', enable_two_send: false },
      newModel        : { model: 'taghtml', parm: 'body.color-refresh' },
    });
  }

  // Endpoints de exportação com bloqueio premium server-side (Pilar 3)
  if ((pathname === '/api/XLSX/exporttab' || pathname === '/api/XLSX/exportFunil') && req.method === 'POST') {
    const body   = await readJson(req);
    const bearer = parseBearer(req) || body.bearer_token;
    const rec    = await findKeyByBearer(bearer);
    if (!rec) return sendJson(res, { success: false, msg_id: 'invalid_token' }, 401);
    const st     = keyStatus(rec);
    if (st === 'blocked') return sendJson(res, { success: false, msg_id: 'user_blocked' });
    if (st === 'expired') return sendJson(res, { success: false, msg_id: 'license_expired' });
    // Truncamento server-side para usuários free (Pilar 3)
    if (st !== 'active' && Array.isArray(body.contacts) && body.contacts.length > 5) {
      slog(LOG_LEVELS.INFO, 'Truncamento free-tier aplicado', { code: rec.code, original: body.contacts.length });
      body.contacts = body.contacts.slice(0, 5);
    }
    return sendJson(res, { success: true, contacts: body.contacts || [], truncated: st !== 'active' });
  }

  if (pathname === '/api/image/url-to-base64' && req.method === 'POST') {
    return sendJson(res, { success: false, msg_id: 'not_implemented' });
  }

  // Endpoints de disparo em massa (validação de licença)
  if ((pathname === '/api/XLSX/envioEmMassa' || pathname === '/api/XLSX/gabarito') && req.method === 'POST') {
    const body   = await readJson(req);
    const bearer = parseBearer(req) || body.bearer_token;
    const rec    = await findKeyByBearer(bearer);
    if (!rec) return sendJson(res, { success: false, msg_id: 'invalid_token' }, 401);
    const st = keyStatus(rec);
    if (st === 'blocked' || st === 'expired') return sendJson(res, { success: false, msg_id: 'license_invalid' });
    return sendJson(res, { success: true, msg_id: 'not_implemented_on_this_server' }, 501);
  }

  return false;
}

const PANEL_CSS_ADMIN = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');
:root{--bg:#020604;--sf:#070f0a;--sf2:#0a1610;--sfh:#0d1f13;--bdr:#183326;--bdrb:#26543c;--tx:#e8fff3;--mt:#5a8a6e;--mt2:#8ab89a;--ac:#39ff14;--ac2:#00ff88;--ag:linear-gradient(135deg,#39ff14,#00ff88);--ok:#041f10;--wn:#1e1800;--dg:#ff4466;--dgb:#200810;--sh:0 4px 40px rgba(0,0,0,.7);--rg:rgba(57,255,20,.3);--gw:0 0 18px rgba(57,255,20,.22),0 0 36px rgba(0,255,136,.08);--mn:'JetBrains Mono',ui-monospace,monospace}
*{box-sizing:border-box;margin:0;padding:0}html{font-size:15px;scroll-behavior:smooth}body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--tx);line-height:1.6;min-height:100vh}
a{color:var(--ac);text-decoration:none}.layout{display:flex;min-height:100vh}.sidebar{width:56px;min-height:100vh;background:var(--sf);border-right:1px solid var(--bdr);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow:hidden;z-index:20;transition:width .28s cubic-bezier(.4,0,.2,1);flex-shrink:0}.sidebar:hover{width:240px}.sb-brand{display:flex;align-items:center;gap:10px;padding:20px 16px 16px;font-weight:800;font-size:1.05rem;color:var(--ac);border-bottom:1px solid var(--bdr);text-shadow:0 0 18px rgba(57,255,20,.35);white-space:nowrap}.bdot{width:9px;height:9px;border-radius:50%;background:var(--ac);box-shadow:var(--gw);flex-shrink:0;margin-left:5px}.btxt{opacity:0;transition:opacity .2s .05s}.sidebar:hover .btxt{opacity:1}.sbsec{padding:12px 10px 4px;font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--mt);white-space:nowrap;opacity:0;transition:opacity .2s}.sidebar:hover .sbsec{opacity:1}
.ni{display:flex;align-items:center;gap:10px;padding:10px 14px;margin:2px 6px;border-radius:9px;cursor:pointer;transition:all .2s;font-size:.9rem;font-weight:500;color:var(--mt2);text-decoration:none;border:1px solid transparent;white-space:nowrap;overflow:hidden}.ni:hover,.ni.ac{color:var(--ac);background:rgba(57,255,20,.06);border-color:rgba(57,255,20,.18)}.ni .ic{width:20px;text-align:center;flex-shrink:0}.nl{opacity:0;transition:opacity .15s}.sidebar:hover .nl{opacity:1}.sbft{margin-top:auto;padding:12px 6px;border-top:1px solid var(--bdr)}.main-a{flex:1;min-width:0;display:flex;flex-direction:column}.topbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:14px 24px;background:var(--sf);border-bottom:1px solid var(--bdr);position:sticky;top:0;z-index:10;backdrop-filter:blur(8px)}.content{padding:20px 24px 48px;flex:1}
.card{background:var(--sf2);border:1px solid var(--bdr);border-radius:14px;padding:22px 24px;margin-bottom:18px;box-shadow:var(--sh);transition:border-color .25s}.card:hover{border-color:rgba(57,255,20,.22)}.ct{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--mt);margin-bottom:14px}
.badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;font-size:.67rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.bok{background:var(--ok);color:var(--ac);border:1px solid rgba(57,255,20,.3)}.boff{background:var(--dgb);color:#ff8899;border:1px solid rgba(255,68,102,.22)}.bfree{background:var(--wn);color:#fde047;border:1px solid rgba(253,224,71,.18)}.bwn{background:rgba(255,180,55,.08);color:#fbbf24;border:1px solid rgba(255,180,55,.22)}.bpd{background:rgba(100,100,255,.1);color:#a0a0ff;border:1px solid rgba(100,100,255,.25)}
.kc{font-family:var(--mn);font-size:.8rem;background:#040d06;border:1px solid rgba(57,255,20,.22);color:#7fff6e;padding:5px 11px;border-radius:7px;word-break:break-all;display:inline-block}.tbl-w{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.88rem}th,td{padding:11px 13px;text-align:left;border-bottom:1px solid var(--bdr)}th{cursor:pointer;color:var(--mt);font-size:.73rem;text-transform:uppercase;user-select:none;white-space:nowrap;position:sticky;top:0;background:var(--sf2)}tr:hover td{background:var(--sfh)}.act{display:flex;flex-wrap:wrap;gap:4px}.bs{padding:5px 9px;border-radius:6px;border:1px solid var(--bdr);background:transparent;color:var(--tx);font-size:.75rem;cursor:pointer;transition:all .2s}.bs:hover{border-color:var(--ac);color:var(--ac)}.bs.bg{border-color:rgba(57,255,20,.28);color:var(--ac)}.bs.bd{border-color:rgba(255,68,102,.25);color:#ff8899}
label{display:block;font-size:.8rem;font-weight:600;color:var(--mt);margin:0 0 6px}.field{margin-bottom:16px}input,select,textarea{width:100%;padding:10px 13px;border-radius:8px;border:1px solid var(--bdr);background:#040d06;color:var(--tx);font:inherit;font-size:.93rem;transition:border-color .2s,box-shadow .2s}input:focus,select:focus,textarea:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px var(--rg)}.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:9px 18px;border:none;border-radius:8px;font:inherit;font-size:.855rem;font-weight:600;cursor:pointer;text-decoration:none;color:#020604;background:var(--ag);transition:all .2s;box-shadow:0 4px 18px rgba(57,255,20,.3)}.btn:hover{transform:translateY(-1px);box-shadow:0 6px 26px rgba(57,255,20,.48);color:#020604}.btn-gh{background:transparent;border:1px solid var(--bdr);color:var(--tx);box-shadow:none}.btn-gh:hover{border-color:rgba(57,255,20,.3);color:var(--ac)}.btn-sm{padding:5px 11px;font-size:.75rem;border-radius:6px}.btn-p{padding:8px 16px;border-radius:8px;border:none;background:var(--ag);color:#020604;font-size:.82rem;font-weight:600;cursor:pointer}.btn-w{padding:8px 14px;border-radius:8px;border:1px solid var(--bdr);background:transparent;color:var(--tx);font-size:.8rem;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}.btn-w:hover{border-color:rgba(57,255,20,.3);color:var(--ac)}
.alert{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:.875rem;background:rgba(57,255,20,.05);color:#7fff6e;border:1px solid rgba(57,255,20,.18)}.alert-d{background:rgba(255,68,102,.07);color:#ff8899;border-color:rgba(255,68,102,.22)}.alert-w{background:rgba(255,180,55,.06);color:#fbbf24;border-color:rgba(255,180,55,.2)}
.toast{position:fixed;bottom:22px;right:22px;padding:12px 18px;border-radius:10px;background:var(--sf2);border:1px solid var(--ac);color:var(--ac);font-size:.855rem;opacity:0;transition:opacity .3s;z-index:999;pointer-events:none}.toast.show{opacity:1}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.75);display:none;align-items:center;justify-content:center;z-index:50;backdrop-filter:blur(3px)}.modal-bg.open{display:flex}.modal{background:var(--sf2);border:1px solid var(--bdrb);border-radius:14px;padding:24px;max-width:400px;width:90%}.modal h3{margin-bottom:16px;font-size:1.05rem}.modal .field{margin-bottom:12px}.mrow{display:flex;gap:8px;margin-top:16px}
.login-page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.login-inn{width:100%;max-width:420px;display:flex;flex-direction:column;align-items:center;gap:22px}.login-brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:1.3rem;color:var(--ac);text-shadow:0 0 22px rgba(57,255,20,.38)}.login-card{width:100%;background:var(--sf2);border:1px solid var(--bdr);border-radius:16px;padding:34px 30px}.login-card h1{font-size:1.45rem;margin-bottom:4px;text-align:center}.login-card .sub{color:var(--mt);font-size:.875rem;margin-bottom:22px;text-align:center}.login-card .btn{width:100%;margin-top:8px;color:#020604}
.gen-form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;padding:14px 18px;background:#020904;border-top:1px solid var(--bdr)}.gen-form input,.gen-form select{padding:9px 13px;border-radius:8px;border:1px solid var(--bdr);background:#040d06;color:var(--tx);font-size:.9rem}.gen-form input[type=text]{min-width:180px;flex:1}.gen-form input[type=number]{width:80px}.gen-form select{min-width:90px}
.sec{margin-bottom:20px;background:var(--sf2);border:1px solid var(--bdr);border-radius:14px;overflow:hidden}.sh{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px;border-bottom:1px solid var(--bdr)}.sh-t{font-weight:700;font-size:.92rem}.sc-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;padding:16px 0}.sc{background:var(--sf);border:1px solid var(--bdr);border-radius:12px;padding:14px;text-align:center}.sc .n{font-size:1.55rem;font-weight:800}.sc .l{font-size:.65rem;color:var(--mt);text-transform:uppercase;margin-top:4px;letter-spacing:.06em
.zvm-row{will-change:transform;transition:background .15s}
.zvm-row:hover td{background:#0a1610}
.zvm-td{padding:10px 13px;text-align:left;border-bottom:1px solid #183326;vertical-align:middle}
.zvm-code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.72rem;background:#040d06;border:1px solid rgba(57,255,20,.22);color:#7fff6e;padding:3px 8px;border-radius:5px;word-break:break-all;display:inline-block}
.zvm-badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;font-size:.66rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.zvm-muted{color:#5a8a6e}
.zvm-acts{display:flex;flex-wrap:wrap;gap:3px}
.zvm-btn{padding:4px 8px;border-radius:5px;border:1px solid #183326;background:#070f0a;color:#8ab89a;font-size:.72rem;font-weight:600;cursor:pointer;transition:all .18s;letter-spacing:.03em;white-space:nowrap}
.zvm-btn:hover{border-color:rgba(57,255,20,.3);color:#39ff14;background:#0a1610}
.zvm-btn-ok{border-color:rgba(57,255,20,.25);color:#39ff14}
.zvm-btn-ok:hover{background:rgba(57,255,20,.08)}
.zvm-btn-warn{border-color:rgba(255,180,55,.22);color:#fbbf24}
.zvm-btn-warn:hover{background:rgba(255,180,55,.07)}
.zvm-btn-del{border-color:rgba(255,68,102,.22);color:#ff8899}
.zvm-btn-del:hover{background:rgba(255,68,102,.07)}
.zvm-btn-note{border-color:rgba(100,180,255,.18);color:#90c8ff}
.zvm-btn-note:hover{background:rgba(100,180,255,.06)}
.zvm-gen{display:flex;flex-wrap:wrap;gap:7px;align-items:flex-end;padding:14px 18px;background:#020904;border-top:1px solid #183326}
.zvm-gen input,.zvm-gen select{padding:8px 12px;border-radius:7px;border:1px solid #183326;background:#040d06;color:#e8fff3;font:inherit;font-size:.88rem;transition:border-color .2s,box-shadow .2s}
.zvm-gen input:focus,.zvm-gen select:focus{outline:none;border-color:#39ff14;box-shadow:0 0 0 2px rgba(57,255,20,.15)}
.zvm-gen input[type=text]{min-width:160px;flex:1}
.zvm-gen input[type=number]{width:68px}
.zvm-gen select{min-width:80px}
.zvm-gen .gen-btn{padding:8px 16px;border-radius:7px;border:none;background:linear-gradient(135deg,#39ff14,#00ff88);color:#020604;font-size:.85rem;font-weight:700;cursor:pointer;transition:all .2s;box-shadow:0 2px 12px rgba(57,255,20,.28)}
.zvm-gen .gen-btn:hover{transform:translateY(-1px);box-shadow:0 4px 18px rgba(57,255,20,.45)}
.zvm-search{display:flex;flex-wrap:wrap;gap:8px;padding:12px 18px;border-bottom:1px solid #183326;align-items:center}
.zvm-search input,.zvm-search select{padding:7px 11px;border-radius:7px;border:1px solid #183326;background:#040d06;color:#e8fff3;font:inherit;font-size:.83rem;transition:border-color .2s,box-shadow .2s}
.zvm-search input:focus,.zvm-search select:focus{outline:none;border-color:#39ff14;box-shadow:0 0 0 2px rgba(57,255,20,.15)}
.zvm-search input[type=text]{flex:1;min-width:160px}
}
@media(max-width:768px){.sidebar{width:0;overflow:hidden;position:fixed}.sidebar:hover{width:240px}.layout.sbo .sidebar{width:240px}.main-a{width:100%}}
`;

const ADMIN_CANVAS = `<canvas id="_cvsa" style="position:fixed;inset:0;z-index:0;pointer-events:none"></canvas>
<script>(function(){var c=document.getElementById('_cvsa'),x=c.getContext('2d');function r(){c.width=innerWidth;c.height=innerHeight;}r();addEventListener('resize',r);var p=Array.from({length:45},function(){return{x:Math.random()*c.width,y:Math.random()*c.height,vx:(Math.random()-.5)*.28,vy:(Math.random()-.5)*.28,r:Math.random()*1.6+.4};});function d(){x.clearRect(0,0,c.width,c.height);p.forEach(function(a){a.x+=a.vx;a.y+=a.vy;if(a.x<0||a.x>c.width)a.vx*=-1;if(a.y<0||a.y>c.height)a.vy*=-1;x.beginPath();x.arc(a.x,a.y,a.r,0,Math.PI*2);x.fillStyle='rgba(57,255,20,0.38)';x.fill();});for(var i=0;i<p.length;i++){for(var j=i+1;j<p.length;j++){var dx=p[i].x-p[j].x,dy=p[i].y-p[j].y,dd=Math.sqrt(dx*dx+dy*dy);if(dd<115){x.beginPath();x.moveTo(p[i].x,p[i].y);x.lineTo(p[j].x,p[j].y);x.strokeStyle='rgba(57,255,20,'+(0.08*(1-dd/115))+')';x.lineWidth=.5;x.stroke();}}}requestAnimationFrame(d);}d();})();</script>`;

function adminLoginShell(body) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin — WaSpeed</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23020604'/%3E%3Ctext x='50%25' y='54%25' dominant-baseline='middle' text-anchor='middle' font-family='monospace' font-weight='700' font-size='14' fill='%2339ff14'%3EWS%3C/text%3E%3C/svg%3E"><style>${PANEL_CSS_ADMIN}</style></head>
<body class="login-page"><div class="login-inn" style="position:relative;z-index:1"><div class="login-brand"><span class="bdot"></span>WaSpeed</div>${body}</div>${ADMIN_CANVAS}</body></html>`;
}

function renderAdminLogin(base, role, err) {
  const body = `<div class="login-card"><h1>Entrar</h1><p class="sub">Painel ${esc(role)}</p>${err ? `<div class="alert alert-d">${esc(err)}</div>` : ''}<form method="post" action="${base}/login"><div class="field"><label>Usuário</label><input name="user" required autocomplete="username" placeholder="Seu usuário"></div><div class="field"><label>Senha</label><input name="pass" type="password" required autocomplete="current-password" placeholder="Sua senha"></div><button class="btn" type="submit">Acessar painel</button></form></div>`;
  return adminLoginShell(body);
}

function adminSidebar(active, stats) {
  stats = stats || {};
  const item = (href, icon, label, key) => `<a href="${href}" class="ni${active === key ? ' ac' : ''}"><span class="ic">${icon}</span><span class="nl">${label}</span></a>`;
  return `<aside class="sidebar"><div class="sb-brand"><span class="bdot"></span><span class="btxt">WaSpeed</span></div><div class="sbsec">Principal</div>${item(R_ADMIN,'⚡','Dashboard','dash')}<div class="sbsec">Licenças</div>${item(R_ADMIN+'/keys','🔑','Chaves de Acesso','keys')}<div class="sbsec">Sistema</div>${item(R_ADMIN+'/logs','📋','Logs do Sistema','logs')}<div class="sbft">${item(R_ADMIN+'/logout','→','Sair','out')}</div></aside>`;
}

function spaShell(title, sidebar, topTitle, body) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — WaSpeed</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23020604'/%3E%3Ctext x='50%25' y='54%25' dominant-baseline='middle' text-anchor='middle' font-family='monospace' font-weight='700' font-size='14' fill='%2339ff14'%3EWS%3C/text%3E%3C/svg%3E"><style>${PANEL_CSS_ADMIN}</style></head>
<body><div class="layout" id="layout">${sidebar}<div class="main-a"><div class="topbar" style="position:sticky;top:0;z-index:10"><span style="font-size:1.05rem;font-weight:700">${esc(topTitle)}</span></div><div class="content" style="position:relative;z-index:1">${body}</div></div></div>
<div id="toast" class="toast"></div><div id="modal-bg" class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal" id="modal-box"></div></div>
<script>function toast(m,ok){var t=document.getElementById('toast');t.textContent=m;t.style.borderColor=ok===false?'var(--dg)':'var(--ac)';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3500);}function closeModal(){document.getElementById('modal-bg').classList.remove('open');}</script>
${ADMIN_CANVAS}</body></html>`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR');
}

function panelStatusKey(rec) {
  if (!rec.active) return 'bloqueado';
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) return 'expirada';
  if (rec.premium) return 'ativo';
  return 'free';
}

function buildLicenseRows(licenses) {
  return licenses.map(function(k) {
    var code      = k.code;
    var st        = panelStatusKey(k);
    var maxU      = (k.maxUses != null) ? k.maxUses : -1;
    var isUnlim   = maxU <= 0 || maxU === -1;
    var isPending = keyStatus(k) === 'pending';
    var uses      = (k.phones || []).length;
    var maxDisp   = isUnlim ? '\u221e' : String(maxU);
    var isExpd    = k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
    var valHtml   = !k.expiresAt
      ? '<span class="zvm-muted">Sem limite</span>'
      : '<span' + (isExpd ? ' style="color:#ff8899"' : '') + '>' + esc(new Date(k.expiresAt).toLocaleString('pt-BR')) + '</span>';
    var stBadge   = isPending
      ? '<span class="zvm-badge" style="background:rgba(100,100,255,.12);color:#a0a0ff;border-color:rgba(100,100,255,.28)">PENDENTE</span>'
      : statusBadgeHtml(keyStatus(k));
    var rawNote   = k.note || '';
    var noteShort = rawNote.length > 22 ? rawNote.slice(0, 22) + '\u2026' : rawNote;
    var phonesJson = esc(JSON.stringify(k.phones || []));
    var actBtns   =
      (isPending ? '<button class="zvm-btn zvm-btn-ok" onclick="apiActivate(\'' + esc(code) + '\')">✓ Ativar</button>' : '') +
      '<button class="zvm-btn' + (k.active ? ' zvm-btn-warn' : ' zvm-btn-ok') + '" onclick="apiToggle(\'' + esc(code) + '\')">' + (k.active ? 'Bloq' : 'Liber') + '</button>' +
      '<button class="zvm-btn" onclick="openRenew(\'' + esc(code) + '\')">+Dias</button>' +
      '<button class="zvm-btn" onclick="openUses(\'' + esc(code) + '\',' + maxU + ')">Usos</button>' +
      '<button class="zvm-btn zvm-btn-ok" onclick="openRename(\'' + esc(code) + '\',\'' + esc((k.label||'').replace(/'/g,"\\'")) + '\')">Renomear</button>' +
      '<button class="zvm-btn" onclick="openNumbers(\'' + esc(code) + '\',' + phonesJson + ')">Números</button>' +
      '<button class="zvm-btn zvm-btn-del" onclick="apiDelete(\'' + esc(code) + '\')">✕ Del</button>';
    var noteTd = '<td class="zvm-td zvm-note-cell" style="min-width:70px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.74rem;cursor:pointer" title="' + esc(rawNote) + '" onclick="openNote(\'' + esc(code) + '\',\'' + esc(rawNote.replace(/'/g,"\\'")) + '\')">' + (esc(noteShort) || '<span class="zvm-muted">\u2014</span>') + '</td>';
    return '<tr class="zvm-row" data-code="' + esc(code) + '" data-label="' + esc((k.label||'').toLowerCase()) + '" data-status="' + (isPending?'pendente':st) + '" data-phone="' + esc(k.lastPhone||'') + '" data-lastused="' + (k.lastUsed||'') + '" data-created="' + (k.createdAt||'') + '">' +
      '<td class="zvm-td" style="min-width:160px"><code class="zvm-code">' + esc(code) + '</code></td>' +
      '<td class="zvm-td" style="min-width:90px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(k.label||'—') + '</td>' +
      '<td class="zvm-td" style="min-width:80px">' + stBadge + '</td>' +
      '<td class="zvm-td" style="min-width:100px;font-size:.78rem">' + valHtml + '</td>' +
      '<td class="zvm-td" style="min-width:48px;text-align:center;font-size:.82rem">' + uses + '/' + maxDisp + '</td>' +
      '<td class="zvm-td zvm-muted" style="min-width:90px;font-size:.78rem">' + esc(k.lastPhone||'—') + '</td>' +
      '<td class="zvm-td zvm-muted" style="min-width:86px;font-size:.75rem">' + esc(k.lastIp||'—') + '</td>' +
      '<td class="zvm-td zvm-muted" style="min-width:100px;font-size:.75rem">' + fmtDate(k.lastUsed) + '</td>' +
      '<td class="zvm-td zvm-muted" style="min-width:100px;font-size:.75rem">' + fmtDate(k.createdAt) + '</td>' +
      noteTd +
      '<td class="zvm-td" style="min-width:220px"><div class="zvm-acts">' + actBtns + '</div></td></tr>';
  }).join('');
}

const LOG_LABELS = Object.freeze({
  validation_ok        : 'LOGIN OK',
  auth_ok              : 'LOGIN OK',
  auth_fail            : 'FALHA AO LOGAR',
  admin_login_fail     : 'FALHA ADMIN',
  key_create           : 'CHAVE CRIADA',
  key_delete           : 'CHAVE EXCLUÍDA',
  key_activated        : 'CHAVE ATIVADA',
  free_register        : 'CADASTRO FREE',
  install              : 'INSTALAÇÃO',
  license_expired      : 'CHAVE EXPIRADA',
  key_expired          : 'CHAVE EXPIRADA',
  user_blocked         : 'USU\u00c1RIO BLOQUEADO',
  max_devices_reached  : 'LIMITE DE TELAS',
  nosql_injection      : 'ATAQUE BLOQUEADO',
  rate_limited         : 'RATE LIMIT',
  circuit_breaker_open : 'FALHA NO BANCO',
  internal_error       : 'ERRO INTERNO',
  unhandled_rejection  : 'ERRO INTERNO',
});

function humanizeLogType(type) {
  return LOG_LABELS[type] || String(type).toUpperCase().replace(/_/g, ' ');
}

function buildLogRows(logs) {
  return logs.map(function(l) {
    var d     = new Date(l.at);
    var dt    = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR');
    var lbl   = humanizeLogType(l.type);
    var isOk  = /ok|create|activated|install|free_register/.test(l.type);
    var isBad = /fail|expired|blocked|injection|error|limited/.test(l.type);
    var color = isOk ? '#39ff14' : isBad ? '#ff8899' : '#fbbf24';
    var meta  = l.meta || {};
    var chave = esc(meta.code || meta.key || '');
    var phone = esc(meta.phone || '');
    var ip    = esc(meta.ip    || '');
    return '<tr class="zvm-row" data-log="' + esc((lbl + ' ' + (l.message||'')).toLowerCase()) + '" data-logtype="' + esc(lbl) + '">' +
      '<td class="zvm-td zvm-muted" style="white-space:nowrap;min-width:110px;font-size:.78rem">' + esc(dt) + '</td>' +
      '<td class="zvm-td" style="min-width:110px"><span style="font-family:var(--mn,monospace);font-size:.68rem;font-weight:700;color:' + color + ';background:' + color + '15;border:1px solid ' + color + '28;padding:2px 8px;border-radius:4px;letter-spacing:.05em;white-space:nowrap">' + esc(lbl) + '</span></td>' +
      '<td class="zvm-td" style="min-width:90px">' + (chave ? '<code class="zvm-code" style="font-size:.72rem">' + chave + '</code>' : '<span class="zvm-muted">—</span>') + '</td>' +
      '<td class="zvm-td zvm-muted" style="min-width:90px;font-size:.78rem">' + (phone || '—') + '</td>' +
      '<td class="zvm-td zvm-muted" style="min-width:80px;font-size:.75rem">' + (ip || '—') + '</td>' +
      '<td class="zvm-td" style="font-size:.8rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(l.message || '') + '</td>' +
      '</tr>';
  }).join('');
}


const ADMIN_JS_SAFE = (function() {
  var RA = R_ADMIN;
  var js = '';
  js += 'var _RA="' + RA + '";\n';
  js += 'function toast(m,ok){var t=document.getElementById("toast");t.textContent=m;t.style.borderColor=(ok===false)?"var(--dg)":"var(--ac)";t.classList.add("show");setTimeout(function(){t.classList.remove("show");},3500);}\n';
  js += 'function closeModal(){document.getElementById("modal-bg").classList.remove("open");}\n';
  js += 'function filterKeys(){var q=(document.getElementById("search-input").value||"").toLowerCase();var st=document.getElementById("filter-status").value;document.querySelectorAll("#kb tr").forEach(function(r){var row=(r.dataset.code+r.dataset.label+r.dataset.phone).toLowerCase();r.style.display=((!q||row.includes(q))&&(!st||r.dataset.status===st))?"":"none";});}\n';
  js += 'function filterLog(){var q=(document.getElementById("logSearch").value||"").toLowerCase();var t=(document.getElementById("logTypeFilter")||{}).value||"";document.querySelectorAll("#logb tr").forEach(function(r){r.style.display=((!q||(r.dataset.log||"").includes(q))&&(!t||(r.dataset.logtype||"")===t))?"":"none";});}\n';
  js += 'async function generateKey(){var label=document.getElementById("nlabel").value.trim();if(!label){toast("Informe o cliente",false);return;}var body={label:label,premium:document.getElementById("npremium").value==="1"};var dv=+(document.getElementById("ndays").value)||0,h=+(document.getElementById("nhours").value)||0,m=+(document.getElementById("nmins").value)||0;if(dv)body.expireDays=dv;if(h)body.expireHours=h;if(m)body.expireMinutes=m;var u=document.getElementById("nuses").value.trim();if(u!=="")body.maxUses=parseInt(u);if(document.getElementById("nfirstuse").checked)body.ativarNoPrimeiroUso=true;var r=await fetch(_RA+"/api/keys",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(r.status===401){location.href=_RA+"/login";return;}var j=await r.json();if(j.ok){toast("Chave gerada: "+j.key);["nlabel","ndays","nhours","nmins","nuses"].forEach(function(id){document.getElementById(id).value="";});document.getElementById("nfirstuse").checked=false;doRefresh();}else{toast("Erro: "+(j.error||"?"),false);}}\n';
  js += 'async function clearLogs(){if(!confirm("Limpar todos os logs?"))return;var r=await fetch(_RA+"/api/logs/clear",{method:"POST"});if(r.ok){toast("Logs limpos");doRefresh();}else{toast("Falha",false);}}\n';
  js += 'async function apiActivate(code){var r=await fetch(_RA+"/api/keys/"+encodeURIComponent(code)+"/activate",{method:"POST"});if(r.ok){toast("Chave ativada");doRefresh();}else{toast("Falha",false);}}\n';
  js += 'async function doRefresh(manual){try{var r=await fetch(_RA+"/api/data");if(r.status===401){if(manual)location.href=_RA+"/login";return;}var d=await r.json();if(!d.ok)return;document.getElementById("s-total").textContent=d.totalKeys;document.getElementById("s-active").textContent=d.activeKeys;document.getElementById("s-free").textContent=d.freeKeys;document.getElementById("s-expired").textContent=d.expiredKeys;document.getElementById("s-logs").textContent=d.totalLogs;document.getElementById("kb").innerHTML=d.keysHtml;document.getElementById("logb").innerHTML=d.logsHtml;var lr=document.getElementById("last-r");if(lr)lr.textContent=new Date().toLocaleTimeString("pt-BR");filterKeys();}catch(e){if(manual)toast("Erro ao atualizar",false);}}\n';
  js += 'async function apiToggle(code){var r=await fetch(_RA+"/api/keys/"+encodeURIComponent(code)+"/toggle",{method:"POST"});if(r.ok){toast("Status alterado");doRefresh();}else{toast("Falha",false);}}\n';
  js += 'async function apiDelete(code){if(!confirm("Excluir chave "+code+"?"))return;var r=await fetch(_RA+"/api/keys/"+encodeURIComponent(code),{method:"DELETE"});if(r.ok){toast("Chave removida");doRefresh();}else{toast("Falha",false);}}\n';
  js += 'function openRenew(code){var b=document.getElementById("modal-box");b.innerHTML="<h3>Renovar "+code+"</h3><div class=\"field\"><label>Dias</label><input id=\"rd\" type=\"number\" min=\"0\" value=\"30\"></div><div class=\"field\"><label>Horas</label><input id=\"rh\" type=\"number\" min=\"0\" value=\"0\"></div><div class=\"mrow\"><button class=\"btn-p\" onclick=\"submitRenew(this.dataset.code)\" data-code=\\"+code+"\\\">Confirmar</button><button class=\"btn-w\" onclick=\"closeModal()\">Cancelar</button></div>";document.getElementById("modal-bg").classList.add("open");}\n';
  js += 'async function submitRenew(code){var days=+(document.getElementById("rd").value)||0,hours=+(document.getElementById("rh").value)||0;var r=await fetch(_RA+"/api/keys/"+encodeURIComponent(code)+"/renew",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({days:days,hours:hours})});closeModal();if(r.ok){toast("Renovada");doRefresh();}else{toast("Falha",false);}}\n';
  js += 'function openUses(code,cur){var b=document.getElementById("modal-box");b.innerHTML="<h3>Limite de usos</h3><div class=\"field\"><label>M\u00e1x (-1=∞)</label><input id=\"mu\" type=\"number\" value=\""+cur+"\"></div><div class=\"mrow\"><button class=\"btn-p\" onclick=\"submitUses(this.dataset.code)\" data-code=\\"+code+"\\\">Confirmar</button><button class=\"btn-w\" onclick=\"closeModal()\">Cancelar</button></div>";document.getElementById("modal-bg").classList.add("open");}\n';
  js += 'async function submitUses(code){var maxUses=parseInt(document.getElementById("mu").value);var r=await fetch(_RA+"/api/keys/"+encodeURIComponent(code)+"/max-uses",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({maxUses:maxUses})});closeModal();if(r.ok){toast("Atualizado");doRefresh();}else{toast("Falha",false);}}\n';
  js += 'function openNote(code,cur){var b=document.getElementById("modal-box");var safe=cur.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");b.innerHTML="<h3>Nota</h3><div class=\"field\"><textarea id=\"nt\" rows=\"4\" style=\"width:100%;padding:10px;border-radius:8px;border:1px solid var(--bdr);background:#040d06;color:var(--tx);font:inherit;resize:vertical\">"+safe+"</textarea></div><div class=\"mrow\"><button class=\"btn-p\" onclick=\"submitNote(this.dataset.code)\" data-code=\\"+code+"\\\">Salvar</button><button class=\"btn-w\" onclick=\"closeModal()\">Cancelar</button></div>";document.getElementById("modal-bg").classList.add("open");setTimeout(function(){var t=document.getElementById("nt");if(t)t.focus();},60);}\n';
  js += 'async function submitNote(code){var note=document.getElementById("nt").value;var r=await fetch(_RA+"/api/keys/"+encodeURIComponent(code)+"/note",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({note:note})});closeModal();if(r.ok){toast("Nota salva");doRefresh();}else{toast("Falha",false);}}\n';
  js += 'function openRename(code,cur){var b=document.getElementById("modal-box");b.innerHTML="<h3>Renomear</h3><div class=\"field\"><label>Novo nome</label><input id=\"rn\" type=\"text\" maxlength=\"60\" value=\""+cur.replace(/"/g,"&quot;")+"\"></div><div class=\"mrow\"><button class=\"btn-p\" onclick=\"submitRename(this.dataset.code)\" data-code=\\"+code+"\\\">Salvar</button><button class=\"btn-w\" onclick=\"closeModal()\">Cancelar</button></div>";document.getElementById("modal-bg").classList.add("open");setTimeout(function(){var t=document.getElementById("rn");if(t){t.focus();t.select();}},60);}\n';
  js += 'async function submitRename(code){var label=document.getElementById("rn").value.trim();if(!label){alert("Informe um nome.");return;}var r=await fetch(_RA+"/api/keys/"+encodeURIComponent(code)+"/rename",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:label})});closeModal();if(r.ok){toast("Renomeado");doRefresh();}else{toast("Falha",false);}}\n';
  js += 'function openNumbers(code,phones){var b=document.getElementById("modal-box");var rows=phones&&phones.length?phones.map(function(p){return"<div style=\"display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:6px;border:1px solid rgba(57,255,20,.12);background:#040d06;margin-bottom:5px\"><span style=\"font-family:monospace;font-size:.82rem;color:#c8e8c8\">"+p+"</span><button class=\"zvm-btn zvm-btn-del\" onclick=\"apiRemovePhone(this,\'"+code+"\',\'"+p+"\')\">&times;</button></div>";}).join(""):"<p style=\"color:#5a8a6e;font-size:.85rem;padding:8px 0\">Nenhum n\u00famero.</p>";b.innerHTML="<h3 style=\"margin-bottom:12px\">N\u00fameros &mdash; "+code+"</h3><div style=\"max-height:260px;overflow-y:auto\">"+rows+"</div><div class=\"mrow\"><button class=\"zvm-btn zvm-btn-del\" onclick=\"apiRemoveAllPhones(this,\'"+code+"\')\">&times; Remover Todos</button><button class=\"btn-w\" onclick=\"closeModal()\">Fechar</button></div>";document.getElementById("modal-bg").classList.add("open");}\n';
  js += 'async function apiRemovePhone(btn,code,phone){btn.disabled=true;var r=await fetch(_RA+"/api/keys/"+encodeURIComponent(code)+"/remove-phone",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone:phone})});if(r.ok){var row=btn.parentElement;if(row)row.remove();toast("N\u00famero removido");doRefresh();}else{btn.disabled=false;toast("Falha",false);}}\n';
  js += 'async function apiRemoveAllPhones(btn,code){if(!confirm("Remover todos os n\u00fameros de "+code+"?"))return;btn.disabled=true;var r=await fetch(_RA+"/api/keys/"+encodeURIComponent(code)+"/remove-all-phones",{method:"POST"});if(r.ok){closeModal();toast("Todos removidos");doRefresh();}else{btn.disabled=false;toast("Falha",false);}}\n';
  js += 'function exportCsv(){window.location.href=_RA+"/api/export/csv";}\n';
  js += 'setInterval(doRefresh,60000);\n';
  return js;
})();

let _keysCache = null;
let _keysCacheTs = 0;
const KEYS_CACHE_MS = 15000;

function invalidateKeysCache() { _keysCache = null; _keysCacheTs = 0; }

async function getKeysCached() {
  const now = Date.now();
  if (_keysCache && now - _keysCacheTs < KEYS_CACHE_MS) return _keysCache;
  const lic = await listLicenses();
  _keysCache = lic;
  _keysCacheTs = now;
  return lic;
}

async function getKeyStats() {
  const lic = await getKeysCached();
  let active = 0, free = 0, blocked = 0, expired = 0;
  for (const k of lic) {
    const st = keyStatus(k);
    if (st === 'active') active++;
    else if (st === 'free') free++;
    else if (st === 'blocked') blocked++;
    else if (st === 'expired') expired++;
  }
  const totalLogs = db ? await db.collection(COL.logs).countDocuments() : 0;
  return { totalKeys: lic.length, activeKeys: active, freeKeys: free, blockedKeys: blocked, expiredKeys: expired, totalLogs };
}

function parseLicenseExpiry(body) {
  const days  = parseInt(body.expireDays   || 0, 10) || 0;
  const hours = parseInt(body.expireHours  || 0, 10) || 0;
  const mins  = parseInt(body.expireMinutes || 0, 10) || 0;
  if (!days && !hours && !mins) return { expiresAt: null, expireDays: 0 };
  return { expiresAt: new Date(Date.now() + ((days * 1440) + (hours * 60) + mins) * 60000).toISOString(), expireDays: days };
}

function adminApiRe(suffix) {
  suffix = suffix || '';
  const base = R_ADMIN.replace(/[.*+?^${}()|[\]\\]/g, ch => '\\' + ch);
  return new RegExp('^' + base + '/api/keys/([^/]+)' + suffix + '$');
}

function requireAdminSession(req, res) {
  return validateSession(parseCookies(req)[config.cookieName]).then(sess => {
    if (!sess || sess.role !== 'admin') { res.writeHead(302, { Location: R_ADMIN + '/login' }); res.end(); return null; }
    return sess;
  });
}

async function handleAdminApi(req, res, pathname) {
  if (pathname === R_ADMIN + '/api/data' && req.method === 'GET') {
    const stats    = await getKeyStats();
    const licenses = await getKeysCached();
    const logs     = await getRecentLogs(150);
    sendJsonGzip(req, res, { ok: true, ...stats, keysHtml: buildLicenseRows(licenses), logsHtml: buildLogRows(logs) });
    return true;
  }
  if (pathname === R_ADMIN + '/api/keys' && req.method === 'POST') {
    const body    = await readJson(req);
    if (!body.label) { sendJson(res, { error: 'label obrigatorio' }, 400); return true; }
    const { expiresAt, expireDays } = parseLicenseExpiry(body);
    const maxUses = body.maxUses !== undefined ? parseInt(body.maxUses, 10) : -1;
    try {
      const rec = await createKey({ label: String(body.label).trim().slice(0, 60), premium: body.premium !== false && body.premium !== 0 && body.premium !== '0', expiresAt, expireDays, maxUses: Number.isNaN(maxUses) ? -1 : maxUses, note: String(body.note || '').slice(0, 500), ativarNoPrimeiroUso: body.ativarNoPrimeiroUso === true });
      invalidateKeysCache();
      sendJson(res, { ok: true, key: rec.code });
    } catch (e) {
      if (!res.headersSent) sendJson(res, { error: e.message }, 500);
    }
    return true;
  }
  if (pathname === R_ADMIN + '/api/logs/clear' && req.method === 'POST') {
    if (db) await db.collection(COL.logs).deleteMany({});
    sendJson(res, { ok: true });
    return true;
  }
  if (pathname === R_ADMIN + '/api/export/csv' && req.method === 'GET') {
    const licenses = await listLicenses();
    const csvLines = ['code,label,premium,active,expiresAt,uses,maxUses,lastPhone,lastIp,createdAt,note'];
    for (const k of licenses) {
      csvLines.push([k.code, k.label, k.premium, k.active, k.expiresAt || '', (k.phones || []).length, k.maxUses != null ? k.maxUses : -1, k.lastPhone || '', k.lastIp || '', k.createdAt || '', (k.note || '').replace(/,/g, ';')].map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
    }
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="wspeed-licenses.csv"' });
      res.end('\ufeff' + csvLines.join('\n'));
    }
    return true;
  }
  const codeAct = pathname.match(adminApiRe('/activate'));
  if (codeAct && req.method === 'POST') {
    const rec = await findKey(decodeURIComponent(codeAct[1]));
    if (!rec) { sendJson(res, { error: 'not found' }, 404); return true; }
    await updateLicense(rec.code, { ativarNoPrimeiroUso: false, primeiroUsoAt: new Date().toISOString(), active: true });
    await addLog('key_activated', 'Chave ' + rec.code + ' ativada manualmente', { code: rec.code });
    invalidateKeysCache();
    sendJson(res, { ok: true });
    return true;
  }
  const codeToggle = pathname.match(adminApiRe('/toggle'));
  if (codeToggle && req.method === 'POST') {
    const rec = await findKey(decodeURIComponent(codeToggle[1]));
    if (!rec) { sendJson(res, { error: 'not found' }, 404); return true; }
    await updateLicense(rec.code, { active: !rec.active });
    invalidateKeysCache();
    sendJson(res, { ok: true, active: !rec.active });
    return true;
  }
  const codeRenew = pathname.match(adminApiRe('/renew'));
  if (codeRenew && req.method === 'POST') {
    const rec = await findKey(decodeURIComponent(codeRenew[1]));
    if (!rec) { sendJson(res, { error: 'not found' }, 404); return true; }
    const rbody  = await readJson(req);
    const addMs  = ((parseInt(rbody.days || 0, 10) * 1440) + (parseInt(rbody.hours || 0, 10) * 60)) * 60000;
    if (!addMs) { sendJson(res, { error: 'informe tempo' }, 400); return true; }
    const baseTs = (rec.expiresAt && new Date(rec.expiresAt).getTime() > Date.now()) ? new Date(rec.expiresAt).getTime() : Date.now();
    await updateLicense(rec.code, { expiresAt: new Date(baseTs + addMs).toISOString(), active: true });
    invalidateKeysCache();
    sendJson(res, { ok: true });
    return true;
  }
  const codeMu = pathname.match(adminApiRe('/max-uses'));
  if (codeMu && req.method === 'POST') {
    const rec     = await findKey(decodeURIComponent(codeMu[1]));
    if (!rec) { sendJson(res, { error: 'not found' }, 404); return true; }
    const mbody   = await readJson(req);
    const maxUses = parseInt(mbody.maxUses, 10);
    if (Number.isNaN(maxUses) || maxUses < -1) { sendJson(res, { error: 'invalid' }, 400); return true; }
    await updateLicense(rec.code, { maxUses });
    invalidateKeysCache();
    sendJson(res, { ok: true, maxUses });
    return true;
  }
  const codeNote = pathname.match(adminApiRe('/note'));
  if (codeNote && req.method === 'POST') {
    const rawCode = decodeURIComponent(codeNote[1]);
    const rec     = await findKey(rawCode);
    if (!rec) { sendJson(res, { error: 'not found' }, 404); return true; }
    const nbody   = await readJson(req);
    const note    = sanitizeString(String(nbody.note != null ? nbody.note : '').slice(0, 500));
    if (!db) { sendJson(res, { error: 'db_unavailable' }, 503); return true; }
    try {
      await db.collection(COL.licenses).updateOne({ code: normKey(rawCode) }, { $set: { note } });
    } catch (e) {
      slog(LOG_LEVELS.WARN, 'codeNote update', { err: e.message });
      if (!res.headersSent) sendJson(res, { error: 'update_failed' }, 500);
      return true;
    }
    invalidateKeysCache();
    sendJson(res, { ok: true, note });
    return true;
  }
  const codeDel = pathname.match(adminApiRe());
  if (codeDel && req.method === 'DELETE' && !/\/(toggle|renew|max-uses|activate|note|remove-phone|remove-all-phones|rename)$/.test(pathname)) {
    const code = decodeURIComponent(codeDel[1]);
    await deleteLicense(code);
    await addLog('key_delete', 'Chave ' + code + ' excluida', { code });
    invalidateKeysCache();
    sendJson(res, { ok: true });
    return true;
  }
  const codeRemPhone = pathname.match(adminApiRe('/remove-phone'));
  if (codeRemPhone && req.method === 'POST') {
    const rawCode = decodeURIComponent(codeRemPhone[1]);
    const rec     = await findKey(rawCode);
    if (!rec) { sendJson(res, { error: 'not found' }, 404); return true; }
    const pb = await readJson(req);
    const ph = sanitizeString(String(pb.phone || '').trim());
    if (!ph) { sendJson(res, { error: 'phone required' }, 400); return true; }
    if (!db) { sendJson(res, { error: 'db_unavailable' }, 503); return true; }
    await db.collection(COL.licenses).updateOne({ code: normKey(rawCode) }, { $pull: { phones: ph } });
    invalidateKeysCache();
    sendJson(res, { ok: true });
    return true;
  }
  const codeRemAll = pathname.match(adminApiRe('/remove-all-phones'));
  if (codeRemAll && req.method === 'POST') {
    const rawCode = decodeURIComponent(codeRemAll[1]);
    const rec     = await findKey(rawCode);
    if (!rec) { sendJson(res, { error: 'not found' }, 404); return true; }
    if (!db) { sendJson(res, { error: 'db_unavailable' }, 503); return true; }
    await db.collection(COL.licenses).updateOne({ code: normKey(rawCode) }, { $set: { phones: [], uses: 0 } });
    invalidateKeysCache();
    sendJson(res, { ok: true });
    return true;
  }
  const codeRename = pathname.match(adminApiRe('/rename'));
  if (codeRename && req.method === 'POST') {
    const rawCode = decodeURIComponent(codeRename[1]);
    const rec     = await findKey(rawCode);
    if (!rec) { sendJson(res, { error: 'not found' }, 404); return true; }
    const rb   = await readJson(req);
    const lbl  = sanitizeString(String(rb.label || '').trim().slice(0, 60));
    if (!lbl) { sendJson(res, { error: 'label required' }, 400); return true; }
    if (!db) { sendJson(res, { error: 'db_unavailable' }, 503); return true; }
    await db.collection(COL.licenses).updateOne({ code: normKey(rawCode) }, { $set: { label: lbl } });
    invalidateKeysCache();
    sendJson(res, { ok: true, label: lbl });
    return true;
  }
  return false;
}


function renderAdminDash(keysHtml, logsHtml, stats) {
  var sc = function(id, val, lbl, style) {
    return '<div class="sc"><div class="n" id="' + id + '"' + (style ? ' style="' + style + '"' : '') + '>' + String(val) + '</div><div class="l">' + lbl + '</div></div>';
  };
  var statsRow = '<div class="sc-row" style="margin-bottom:18px">' +
    sc('s-total',   stats.totalKeys,   'Total',     '') +
    sc('s-active',  stats.activeKeys,  'PRO Ativas', 'color:var(--ac)') +
    sc('s-free',    stats.freeKeys,    'Free',      '') +
    sc('s-expired', stats.expiredKeys, 'Expiradas',  stats.expiredKeys ? 'color:var(--dg)' : '') +
    sc('s-logs',    stats.totalLogs,   'Logs',      '') +
    '</div>';
  var logTypeOpts =
    '<option value="">Todos os eventos</option>' +
    '<option value="LOGIN OK">LOGIN OK</option>' +
    '<option value="FALHA AO LOGAR">FALHA AO LOGAR</option>' +
    '<option value="CHAVE CRIADA">CHAVE CRIADA</option>' +
    '<option value="CHAVE EXCLU\u00cdDA">CHAVE EXCLU\u00cdDA</option>' +
    '<option value="CHAVE ATIVADA">CHAVE ATIVADA</option>' +
    '<option value="CADASTRO FREE">CADASTRO FREE</option>' +
    '<option value="FALHA ADMIN">FALHA ADMIN</option>' +
    '<option value="LIMITE DE TELAS">LIMITE DE TELAS</option>' +
    '<option value="ATAQUE BLOQUEADO">ATAQUE BLOQUEADO</option>';
  var keysSection =
    '<div class="sec">' +
    '<div class="sh"><span class="sh-t">\uD83D\uDD11 Licen\u00e7as WaSpeed</span></div>' +
    '<div class="zvm-gen">' +
    '<input type="text" id="nlabel" placeholder="Nome do cliente" style="min-width:150px">' +
    '<input type="number" id="ndays" placeholder="Dias" min="0">' +
    '<input type="number" id="nhours" placeholder="H" min="0">' +
    '<input type="number" id="nmins" placeholder="Min" min="0">' +
    '<input type="number" id="nuses" placeholder="Usos (-1=\u221e)" min="-1">' +
    '<select id="npremium"><option value="1">PRO</option><option value="0">Free</option></select>' +
    '<label style="display:flex;align-items:center;gap:5px;font-size:.78rem;color:var(--mt);margin:0;cursor:pointer"><input type="checkbox" id="nfirstuse" style="width:auto;padding:0"> 1\u00ba uso</label>' +
    '<button class="gen-btn" onclick="generateKey()">+ Gerar Chave</button>' +
    '</div>' +
    '<div class="zvm-search">' +
    '<input type="text" id="search-input" placeholder="\uD83D\uDD0D Buscar chave, cliente, telefone..." oninput="filterKeys()">' +
    '<select id="filter-status" onchange="filterKeys()">' +
    '<option value="">Todos os status</option><option value="ativo">PRO Ativas</option><option value="free">Free</option><option value="pendente">Pendentes</option><option value="expirada">Expiradas</option><option value="bloqueado">Bloqueadas</option>' +
    '</select>' +
    '<button class="zvm-btn zvm-btn-ok" onclick="doRefresh(true)">\u21bb Atualizar</button>' +
    '<button class="zvm-btn" onclick="exportCsv()">\u2b07 CSV</button>' +
    '<span id="last-r" style="font-size:.7rem;color:var(--mt)">&mdash;</span>' +
    '</div>' +
    '<div class="tbl-w" style="overflow-x:auto">' +
    '<table style="min-width:920px"><thead><tr style="background:#070f0a">' +
    '<th style="min-width:160px">Chave</th><th style="min-width:90px">Cliente</th><th style="min-width:80px">Status</th><th style="min-width:100px">Validade</th><th style="min-width:48px">Usos</th><th style="min-width:90px">Telefone</th><th style="min-width:86px">IP</th><th style="min-width:100px">\u00dalt. acesso</th><th style="min-width:100px">Criada</th><th style="min-width:80px">Nota</th><th style="min-width:180px">A\u00e7\u00f5es</th>' +
    '</tr></thead><tbody id="kb">' + keysHtml + '</tbody></table>' +
    '</div></div>';
  var logsSection =
    '<div class="sec">' +
    '<div class="sh"><span class="sh-t">\uD83D\uDCCB Logs do Sistema &mdash; WaSpeed</span>' +
    '<button class="zvm-btn zvm-btn-del" onclick="clearLogs()">\uD83D\uDDD1 Limpar logs</button></div>' +
    '<div class="zvm-search">' +
    '<input type="text" id="logSearch" placeholder="Filtrar logs..." oninput="filterLog()">' +
    '<select id="logTypeFilter" onchange="filterLog()">' + logTypeOpts + '</select>' +
    '</div>' +
    '<div class="tbl-w" style="max-height:52vh;overflow-y:auto;overflow-x:auto">' +
    '<table style="min-width:720px"><thead><tr style="background:#070f0a">' +
    '<th style="min-width:110px">Data/Hora</th><th style="min-width:110px">Evento</th><th style="min-width:90px">Chave</th><th style="min-width:90px">Telefone</th><th style="min-width:80px">IP</th><th style="min-width:180px">Mensagem</th>' +
    '</tr></thead><tbody id="logb">' + logsHtml + '</tbody></table>' +
    '</div></div>';
  var scriptTag = '<scr' + 'ipt>' + ADMIN_JS_SAFE + '</scr' + 'ipt>';
  var body = statsRow + keysSection + logsSection + scriptTag;
  return spaShell('Admin WaSpeed', adminSidebar('dash'), 'WaSpeed Admin', body);
}

async function handleAdmin(req, res, pathname, ip) {
  if (pathname === R_ADMIN + '/login') {
    if (req.method === 'GET') { sendHtml(res, renderAdminLogin(R_ADMIN, 'Admin')); return; }
    if (!checkRate(ip)) { sendHtml(res, renderAdminLogin(R_ADMIN, 'Admin', 'Muitas tentativas. Aguarde.'), 429); return; }
    const body   = await readBody(req);
    const params = new URLSearchParams(body);
    const user   = sanitizeString(params.get('user') || '');
    const pass   = params.get('pass') || '';
    if (await verifyAdminCredentials(user, pass)) {
      const session = await createSession('admin', { user: user.trim() });
      if (!session) { sendHtml(res, renderAdminLogin(R_ADMIN, 'Admin', 'Erro ao criar sessao'), 500); return; }
      setSessionCookie(res, session.token);
      res.writeHead(302, { Location: R_ADMIN });
      res.end();
      return;
    }
    await addLog('admin_login_fail', 'Tentativa invalida', { ip });
    sendHtml(res, renderAdminLogin(R_ADMIN, 'Admin', 'Credenciais invalidas'), 401);
    return;
  }
  if (pathname === R_ADMIN + '/logout') {
    const token = parseCookies(req)[config.cookieName];
    await destroySession(token);
    clearSessionCookie(res);
    res.writeHead(302, { Location: R_ADMIN + '/login' });
    res.end();
    return;
  }
  const sess = await requireAdminSession(req, res);
  if (!sess) return;
  const apiHandled = await handleAdminApi(req, res, pathname);
  if (apiHandled) return;
  if (pathname === R_ADMIN || pathname === R_ADMIN + '/' || pathname === R_ADMIN + '/keys') {
    const stats    = await getKeyStats();
    const licenses = await listLicenses();
    const logs     = await getRecentLogs(150);
    sendHtml(res, renderAdminDash(buildLicenseRows(licenses), buildLogRows(logs), stats));
    return;
  }
  if (pathname === R_ADMIN + '/logs') {
    const logs     = await getRecentLogs(300);
    const stats    = await getKeyStats();
    const licenses = await getKeysCached();
    sendHtml(res, renderAdminDash(buildLicenseRows(licenses), buildLogRows(logs), stats));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
}


// --- Router principal --------------------------------------------------------

const _REQ_SHAPE = { pathname: '', ip: '', method: '' };

async function handleRequest(req, res) {
  applySecurityHeaders(res);

  const url      = new URL(req.url, `http://127.0.0.1:${config.port}`);
  const pathname = url.pathname;
  const ip       = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
  const method   = req.method;

  applyCors(req, res, pathname);

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/ping') {
    sendText(res, 'OK');
    return;
  }

  if (pathname === '/health') {
    const mem      = process.memoryUsage();
    const mongoOk  = mongoReady && db !== null && !cbIsOpen();
    let   keyCount = 0;
    const t0       = Date.now();
    await new Promise((r) => setImmediate(r));
    const loopMs   = Date.now() - t0;
    if (mongoOk) {
      try { keyCount = await db.collection(COL.licenses).countDocuments(); } catch { /**/ }
    }
    sendJson(res, {
      ok                : mongoOk,
      service           : 'waspeed-server',
      version           : '5.0.0',
      keys              : keyCount,
      mongo             : mongoOk,
      circuitBreaker    : cbIsOpen() ? 'OPEN' : 'CLOSED',
      storage           : 'mongodb',
      heapUsedMB        : (mem.heapUsed  / 1048576).toFixed(1),
      heapTotalMB       : (mem.heapTotal / 1048576).toFixed(1),
      rssMB             : (mem.rss       / 1048576).toFixed(1),
      eventLoopLatencyMs: loopMs,
      uptime            : Math.floor(process.uptime()),
    }, mongoOk ? 200 : 503);
    return;
  }

  if (cbIsOpen() && pathname.startsWith('/api/') && !pathname.startsWith('/api/external/')) {
    sendJson(res, { success: false, msg_id: 'service_unavailable' }, 503);
    return;
  }

  if ((!mongoReady || !db) && pathname.startsWith('/api/')) {
    sendError(res, 503, 'db_unavailable');
    return;
  }

  try {
    if (pathname === '/config.json') {
      sendCachedConfigJson(res);
      return;
    }

    if (pathname === '/api/code') {
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
        res.end('');
      }
      return;
    }

    if (pathname === '/obrigado') {
      sendHtml(res, clientShell('Até logo!', `
  <div class="card" style="max-width:540px;margin:0 auto;text-align:center;padding:48px 32px">
    <div style="font-size:3rem;margin-bottom:16px">👋</div>
    <h2 style="font-size:1.5rem;font-weight:800;margin-bottom:10px">Até logo!</h2>
    <p style="color:var(--muted);font-size:.95rem;line-height:1.8;margin-bottom:24px">O WaSpeed foi desinstalado do seu navegador.</p>
    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
      <a class="btn" href="https://chromewebstore.google.com/detail/${config.chromeStoreId}" target="_blank" rel="noopener">🔄 Reinstalar</a>
      <a class="btn btn-ghost" href="/${config.chromeStoreId}/auth-painel">🔑 Minha conta</a>
    </div>
  </div>`));
      return;
    }

    if (pathname === '/' || pathname === '') {
      sendHtml(res, renderPortal(config.chromeStoreId));
      return;
    }

    if (pathname === '/faq' && method === 'GET') {
      sendHtml(res, renderFaqPage());
      return;
    }

    if (pathname === '/planos' && method === 'GET') {
      sendHtml(res, renderPlanosPage());
      return;
    }

    if (pathname === '/privacidade' && method === 'GET') {
      sendHtml(res, renderPrivacyPage());
      return;
    }

    if (pathname.startsWith('/utils/')) {
      sendJson(res, { success: false, msg_id: 'not_configured' }, 501);
      return;
    }

    if (await handleClientPanel(req, res, pathname, url)) return;

    if (pathname.startsWith(R_ADMIN)) {
      await handleAdmin(req, res, pathname, ip);
      return;
    }

    if (pathname.startsWith('/api/')) {
      const handled = await handleWaSpeedApi(req, res, pathname, ip);
      if (handled !== false) return;
      sendJson(res, { success: false, msg_id: 'not_found' }, 404);
      return;
    }

    if (!res.headersSent) {
      res.writeHead(404);
      res.end('Not found');
    }

  } catch (err) {
    sendInternalError(res, err, pathname);
  }
}

// --- Anti-sleep (Render Free Tier) -------------------------------------------

function startAntiSleepCron() {
  const base = config.publicUrl || config.baseUrl;
  if (!base) { slog(LOG_LEVELS.WARN, 'PUBLIC_URL não definida — anti-sleep desativado'); return; }
  const pingUrl = `${base.replace(/\/$/, '')}/ping`;
  slog(LOG_LEVELS.INFO, `Anti-sleep ativo: GET ${pingUrl} a cada 5 min`);
  setInterval(() => {
    try {
      const u    = new URL(pingUrl);
      const opts = { hostname: u.hostname, path: u.pathname, method: 'GET' };
      const mod  = pingUrl.startsWith('https') ? https : http;
      const r    = mod.request(opts, (res) => res.resume());
      r.on('error', () => {});
      r.setTimeout(8000, () => r.destroy());
      r.end();
    } catch {}
  }, ANTI_SLEEP_MS).unref();
}

// --- Shutdown gracioso -------------------------------------------------------

async function shutdown(sig) {
  slog(LOG_LEVELS.INFO, `${sig} — encerrando WaSpeed`);
  mongoReady = false;
  try { if (mongoClient) await mongoClient.close(); }
  catch (err) { slog(LOG_LEVELS.WARN, 'mongo close', { err: err.message }); }
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Proteção contra Unhandled Rejections (Pilar 4)
process.on('unhandledRejection', (reason, promise) => {
  slog(LOG_LEVELS.CRITICAL, 'Unhandled Promise Rejection', { reason: String(reason) });
  dispatchWebhookAlert('unhandled_rejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  slog(LOG_LEVELS.CRITICAL, 'Uncaught Exception', { err: err.message });
  dispatchWebhookAlert('uncaught_exception', { err: err.message });
  process.exit(1);
});

// --- Bootstrap ---------------------------------------------------------------

async function bootstrap() {
  slog(LOG_LEVELS.INFO, 'WaSpeed Server v4.0 — iniciando bootstrap');
  try {
    await connectMongo();
    await initSeed();
    mongoReady = true;
    slog(LOG_LEVELS.INFO, 'MongoDB pronto', { db: config.dbName });
  } catch (err) {
    slog(LOG_LEVELS.CRITICAL, 'Falha no bootstrap', { err: err.message });
    process.exit(1);
  }

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      slog(LOG_LEVELS.CRITICAL, 'Unhandled request error', { err: err?.message, stack: err?.stack });
      if (!res.headersSent) {
        const errorId = crypto.randomBytes(8).toString('hex');
        sendJson(res, { success: false, msg_id: 'server_error', error_id: errorId }, 500);
      }
    });
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout   = 66000;
  server.on('clientError', (err, socket) => {
    slog(LOG_LEVELS.WARN, 'clientError', { err: err.message });
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.listen(config.port, '0.0.0.0', () => {
    slog(LOG_LEVELS.INFO, `WaSpeed Server v4.0 ouvindo na porta ${config.port}`);
    slog(LOG_LEVELS.INFO, `Health : ${config.baseUrl}/health`);
    startAntiSleepCron();
  });
}

bootstrap().catch((err) => {
  slog(LOG_LEVELS.CRITICAL, 'bootstrap fatal', { err: err.message });
  process.exit(1);
});
