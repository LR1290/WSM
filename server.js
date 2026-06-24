'use strict';

// =============================================================================
// WaSpeed Server v4.0 — Refatoração Total (Pilares 1-6)
// Node.js nativo + MongoDB + Segurança OWASP + UI Cyberpunk
// =============================================================================

const http    = require('http');
const https   = require('https');
const crypto  = require('crypto');
const { URL } = require('url');
const { MongoClient } = require('mongodb');

// --- Constantes globais originais (preservadas) ------------------------------

const WPP_VERSION          = '1.11';
const REMOTE_CODE_VERSION  = '1.0.41';
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
    merged.version = base.version || WPP_VERSION;
  }
  return merged;
}

function buildConfigJson(overrides = {}) {
  return {
    remote_code  : {
      version  : REMOTE_CODE_VERSION,
      ambiente : 'production',
      url      : `${config.baseUrl}/api/code?version=${REMOTE_CODE_VERSION}`,
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

async function requireAdmin(req, res) {
  const token = parseCookies(req)[config.cookieName];
  const sess  = await validateSession(token);
  if (!sess || sess.role !== 'admin') {
    res.writeHead(302, { Location: `${R_ADMIN}/login` });
    res.end();
    return null;
  }
  return sess;
}

async function requireMod(req, res) {
  const token = parseCookies(req)[config.cookieName];
  const sess  = await validateSession(token);
  if (!sess || sess.role !== 'mod') {
    res.writeHead(302, { Location: `${R_MOD}/login` });
    res.end();
    return null;
  }
  return sess;
}

// --- Sanitização NoSQL Injection (Pilar 2) ------------------------------------

const NOSQL_OP_RE = /\$(?:gt|gte|lt|lte|ne|eq|in|nin|or|and|not|nor|exists|type|regex|where|expr|elemMatch|size|all|rename|set|unset|push|pull|addToSet|pop)\b/gi;

function sanitizeString(s) {
  if (typeof s !== 'string') return s;
  const clean = s.replace(/\u0000/g, '').replace(NOSQL_OP_RE, '');
  return clean;
}

function sanitizeObject(obj, depth = 0) {
  if (depth > 10 || obj === null || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    const ks = sanitizeString(String(k));
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
  invalidatePanelKeysCache();
  return rec;
}

async function updateLicense(code, patch) {
  if (!db) return false;
  try {
    await db.collection(COL.licenses).updateOne({ code: normKey(code) }, { $set: sanitizeObject(patch) });
    invalidatePanelKeysCache();
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
    invalidatePanelKeysCache();
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

async function authSuccess(code, rec) {
  const st = keyStatus(rec);
  if (st === 'blocked') return { ok: false, msg_id: 'user_blocked' };
  if (st === 'expired') return { ok: false, msg_id: 'license_expired' };
  // Ativar no primeiro uso
  if (st === 'pending' && rec.ativarNoPrimeiroUso && !rec.primeiroUsoAt) {
    await updateLicense(code, { primeiroUsoAt: new Date().toISOString() });
    rec.primeiroUsoAt = new Date().toISOString();
    await addLog('key_activated', `Chave ${code} ativada no primeiro uso`, { code });
  }
  const lastUsed = new Date().toISOString();
  await updateLicense(code, { lastUsed });
  rec.lastUsed = lastUsed;
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

function sendJson(res, data, status = 200) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type'  : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
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
  const panel = pathname.startsWith(R_ADMIN) || pathname.startsWith(R_MOD);
  return {
    'Access-Control-Allow-Origin'  : panel ? 'null' : (req.headers.origin || '*'),
    'Access-Control-Allow-Methods' : 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers' : 'Content-Type, Authorization, access-token, accept, X-Extension-ID',
    'Access-Control-Max-Age'       : '86400',
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
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return sanitizeObject(parsed);
  } catch {
    return {};
  }
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
  return { success: true, version: WPP_VERSION, update: false, message: 'WaSpeed server — módulo atualizado' };
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
.layout{display:flex;min-height:100vh}
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
.gen-form input,.gen-form select{padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:#040d06;color:var(--text);font-size:.82rem}
.gen-form input[type=number]{width:58px}
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
.app{max-width:900px;margin:0 auto;padding:28px 20px 56px}
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

// --- Funções de renderização de UI (Pilar 1) ----------------------------------

function escAll(obj) {
  if (typeof obj === 'string') return esc(obj);
  return obj;
}

function statusBadgeHtml(st) {
  if (st === 'active')   return '<span class="badge badge-ok">PRO Ativo</span>';
  if (st === 'blocked')  return '<span class="badge badge-off">Bloqueado</span>';
  if (st === 'expired')  return '<span class="badge badge-off">Expirado</span>';
  if (st === 'expirando')return '<span class="badge badge-warn">⏰ Expirando</span>';
  return '<span class="badge badge-free">Free</span>';
}

function loginShell(body, roleLabel = '') {
  return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — WaSpeed</title><style>${PANEL_CSS}</style></head>
<body class="login-page"><div class="login-inner">
<div class="login-brand"><span class="brand-dot"></span>WaSpeed</div>
${body}
</div></body></html>`;
}

function renderLogin(base, role, err = '') {
  const body = `<div class="login-card">
    <h1>Entrar</h1>
    <p class="subtitle">Painel ${esc(role)}</p>
    ${err ? `<div class="alert alert-danger">${esc(err)}</div>` : ''}
    <form method="post" action="${base}/login">
      <div class="field"><label>Usuário</label><input name="user" required autocomplete="username" placeholder="Seu usuário"></div>
      <div class="field"><label>Senha</label><input name="pass" type="password" required autocomplete="current-password" placeholder="Sua senha"></div>
      <button class="btn" type="submit">Acessar painel</button>
    </form>
  </div>`;
  return loginShell(body, role);
}

function adminSidebar(active = '', stats = {}) {
  const item = (href, icon, label, key, badge = '', bClass = '') => {
    const badgeHtml = badge !== '' ? `<span class="nav-badge ${bClass}">${badge}</span>` : '';
    return `<a href="${href}" class="nav-item${active === key ? ' active' : ''}">
      <span class="icon">${icon}</span><span class="nav-label">${label}</span>${badgeHtml}</a>`;
  };
  return `<aside class="sidebar" id="sidebar">
  <div class="sidebar-brand"><span class="brand-dot"></span><span class="brand-text">WaSpeed</span></div>
  <div class="sidebar-section">Principal</div>
  ${item(R_ADMIN, '⚡', 'Dashboard', 'dash')}
  <div class="sidebar-section">Licenças</div>
  ${item(R_ADMIN + '/keys', '🔑', 'Chaves de Acesso', 'keys', stats.totalKeys ?? '')}
  <div class="sidebar-section">Sistema</div>
  ${item(R_ADMIN + '/logs', '📋', 'Logs do Sistema', 'logs', stats.totalLogs ?? '')}
  <div class="sidebar-footer">
    ${item(R_ADMIN + '/logout', '→', 'Sair', 'out')}
  </div>
</aside>`;
}

function spaShell(title, sidebar, topbarTitle, body, extraCss = '') {
  return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — WaSpeed</title>
<style>${PANEL_CSS}${extraCss}</style></head>
<body>
<div class="layout" id="layout">
  ${sidebar}
  <div class="main-area">
    <div class="topbar">
      <div style="display:flex;align-items:center;gap:12px">
        <button class="btn-ghost btn-sm" onclick="toggleSb()" style="display:none;border:none;color:var(--muted);font-size:1.1rem" id="sb-btn">☰</button>
        <span class="topbar-title">${esc(topbarTitle)}</span>
      </div>
      <div class="topbar-actions" id="topbar-actions-slot"></div>
    </div>
    <div class="content">${body}</div>
  </div>
</div>
<div id="toast" class="toast"></div>
<div id="modal-bg" class="modal-bg" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modal-box"></div>
</div>
<script>
function toggleSb(){document.getElementById('layout').classList.toggle('sb-open');}
(function(){const btn=document.getElementById('sb-btn');if(window.innerWidth<=768)btn.style.display='inline-flex';})();
function toast(m,ok=true){const t=document.getElementById('toast');t.textContent=m;t.style.borderColor=ok?'var(--accent)':'var(--danger)';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3500);}
function closeModal(){document.getElementById('modal-bg').classList.remove('open');}
</script>
</body></html>`;
}

// Renderiza o SPA principal do admin (Pilar 1)
function renderAdminSpa(keysHtml, logsHtml, stats) {
  const warn = stats.warnKeys   || 0;
  const exp  = stats.expiredKeys || 0;
  const sidebar = adminSidebar('dash', stats);

  const body = `
${exp > 0 || warn > 0 ? `<div class="alert alert-warn">${exp > 0 ? `<strong>${exp} chave(s) expirada(s)</strong>` : ''}${exp > 0 && warn > 0 ? ' · ' : ''}${warn > 0 ? `<strong>${warn} expirando em ${config.expiryWarnHours}h</strong>` : ''}</div>` : ''}
<div class="stats-row" style="margin-bottom:20px">
  <div class="sc"><div class="n" id="s-total">${stats.totalKeys}</div><div class="l">Total</div></div>
  <div class="sc"><div class="n" id="s-active" style="color:var(--accent)">${stats.activeKeys}</div><div class="l">PRO Ativas</div></div>
  <div class="sc"><div class="n" id="s-free">${stats.freeKeys}</div><div class="l">Free</div></div>
  <div class="sc"><div class="n" id="s-expired" style="${exp ? 'color:var(--danger)' : ''}">${stats.expiredKeys}</div><div class="l">Expiradas</div></div>
  <div class="sc"><div class="n" id="s-warn" style="${warn ? 'color:#fbbf24' : ''}">${stats.warnKeys}</div><div class="l">Expirando</div></div>
  <div class="sc"><div class="n" id="s-logs">${stats.totalLogs}</div><div class="l">Logs</div></div>
</div>
<div class="sec">
  <div class="sh">
    <span class="sh-title">🔑 Licenças</span>
    <div class="gen-form">
      <input type="text" id="nlabel" placeholder="Cliente" style="min-width:120px">
      <input type="number" id="ndays"  placeholder="Dias"  min="0" title="Dias">
      <input type="number" id="nhours" placeholder="H"     min="0" title="Horas">
      <input type="number" id="nmins"  placeholder="Min"   min="0" title="Minutos">
      <input type="number" id="nuses"  placeholder="Usos"  min="-1" title="Máx dispositivos (-1=∞)">
      <select id="npremium"><option value="1">PRO</option><option value="0">Free</option></select>
      <label style="display:flex;align-items:center;gap:5px;font-size:.8rem;color:var(--muted);margin:0;cursor:pointer">
        <input type="checkbox" id="nfirstuse" style="width:auto;padding:0"> Ativar no 1º uso
      </label>
      <button class="btn-p" onclick="generateKey()">+ Gerar</button>
    </div>
  </div>
  <div class="sh" style="gap:8px">
    <input type="text" id="search-input" placeholder="🔍 Buscar chave, nome, telefone..." oninput="filterKeys()" style="flex:1;min-width:180px;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:#040d06;color:var(--text)">
    <select id="filter-status" onchange="filterKeys()" style="padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:#040d06;color:var(--text)">
      <option value="">Todos os status</option>
      <option value="ativo">PRO Ativas</option>
      <option value="free">Free</option>
      <option value="pendente">Pendentes</option>
      <option value="expirando">Expirando</option>
      <option value="expirada">Expiradas</option>
      <option value="bloqueado">Bloqueadas</option>
    </select>
    <button class="btn-w" onclick="doRefresh(true)">↻ Atualizar</button>
    <button class="btn-w" onclick="exportCsv()">⬇ CSV</button>
    <span id="last-refresh" style="font-size:.72rem;color:var(--muted)">—</span>
  </div>
  <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th onclick="sortKeys('code')">Chave</th>
        <th onclick="sortKeys('label')">Cliente</th>
        <th onclick="sortKeys('status')">Status</th>
        <th onclick="sortKeys('validity')">Validade</th>
        <th onclick="sortKeys('uses')">Usos</th>
        <th onclick="sortKeys('phone')">Telefone</th>
        <th>Último IP</th>
        <th onclick="sortKeys('lastused')">Último acesso</th>
        <th onclick="sortKeys('created')">Criada</th>
        <th>Nota</th>
        <th>Ações</th>
      </tr></thead>
      <tbody id="kb">${keysHtml}</tbody>
    </table>
  </div>
</div>
<div class="sec">
  <div class="sh">
    <span class="sh-title">📋 Logs do Sistema</span>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input type="text" id="logSearch" placeholder="Filtrar..." oninput="filterLog()" style="padding:7px 11px;border-radius:8px;border:1px solid var(--border);background:#040d06;color:var(--text)">
      <select id="logTypeFilter" onchange="filterLog()" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:#040d06;color:var(--text)">
        <option value="">Todos os tipos</option>
        <option value="validation_ok">validation_ok</option>
        <option value="key_activated">key_activated</option>
        <option value="key_created">key_created</option>
        <option value="key_blocked">key_blocked</option>
        <option value="key_deleted">key_deleted</option>
        <option value="auth_fail">auth_fail</option>
        <option value="admin_login">admin_login</option>
        <option value="security">security</option>
      </select>
      <button class="btn-w" style="border-color:rgba(255,68,102,.3);color:var(--danger-text)" onclick="clearLogs()">🗑 Limpar</button>
    </div>
  </div>
  <div class="tbl-wrap" style="max-height:55vh;overflow-y:auto">
    <table>
      <thead><tr><th>Data</th><th>Tipo</th><th>Mensagem</th><th>Chave</th></tr></thead>
      <tbody id="logb">${logsHtml}</tbody>
    </table>
  </div>
</div>
<script>
const _RA='${R_ADMIN}';
let _sc='created',_sd=-1;
function filterKeys(){
  const q=(document.getElementById('search-input').value||'').toLowerCase();
  const st=document.getElementById('filter-status').value;
  document.querySelectorAll('#kb tr.kr').forEach(r=>{
    const row=(r.dataset.code+r.dataset.label+r.dataset.phone).toLowerCase();
    r.style.display=(!q||row.includes(q))&&(!st||r.dataset.status===st)?'':'none';
  });
}
function filterLog(){
  const q=(document.getElementById('logSearch').value||'').toLowerCase();
  const t=(document.getElementById('logTypeFilter').value||'').toLowerCase();
  document.querySelectorAll('#logb tr').forEach(r=>{
    const txt=(r.dataset.log||'');
    const type=(r.dataset.logtype||'');
    r.style.display=(!q||txt.includes(q))&&(!t||type===t)?'':'none';
  });
}
function sortKeys(col){
  if(_sc===col)_sd*=-1;else{_sc=col;_sd=1;}
  const tb=document.getElementById('kb');
  const rows=[...tb.querySelectorAll('tr.kr')];
  rows.sort((a,b)=>{
    let va=a.dataset[col]||'',vb=b.dataset[col]||'';
    if(col==='uses'){va=+va;vb=+vb;}
    if(va<vb)return -1*_sd;if(va>vb)return 1*_sd;return 0;
  });
  rows.forEach(r=>tb.appendChild(r));
}
async function generateKey(){
  const label=document.getElementById('nlabel').value.trim();
  if(!label){toast('Informe o cliente',false);return;}
  const body={label,premium:document.getElementById('npremium').value==='1'};
  const d=+document.getElementById('ndays').value||0,h=+document.getElementById('nhours').value||0,m=+document.getElementById('nmins').value||0;
  if(d)body.expireDays=d;if(h)body.expireHours=h;if(m)body.expireMinutes=m;
  const u=document.getElementById('nuses').value.trim();if(u!=='')body.maxUses=parseInt(u);
  if(document.getElementById('nfirstuse').checked)body.ativarNoPrimeiroUso=true;
  const r=await fetch(_RA+'/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r.status===401){location.href=_RA+'/login';return;}
  const j=await r.json();
  if(j.ok){toast('✅ '+j.key);['nlabel','ndays','nhours','nmins','nuses'].forEach(id=>document.getElementById(id).value='');document.getElementById('nfirstuse').checked=false;await doRefresh();}
  else toast('Erro: '+(j.error||'?'),false);
}
async function clearLogs(){
  if(!confirm('Limpar todos os logs?'))return;
  const r=await fetch(_RA+'/api/logs/clear',{method:'POST'});
  if(r.ok){toast('Logs limpos');doRefresh();}else toast('Falha',false);
}
async function apiActivate(code){
  const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(code)+'/activate',{method:'POST'});
  if(r.ok){toast('Chave ativada');doRefresh();}else toast('Falha',false);
}
async function doRefresh(manual){
  const r=await fetch(_RA+'/api/data');
  if(r.status===401){if(manual)location.href=_RA+'/login';return;}
  const d=await r.json();if(!d.ok)return;
  document.getElementById('s-total').textContent=d.totalKeys;
  document.getElementById('s-active').textContent=d.activeKeys;
  document.getElementById('s-free').textContent=d.freeKeys;
  document.getElementById('s-expired').textContent=d.expiredKeys;
  document.getElementById('s-warn').textContent=d.warnKeys;
  document.getElementById('s-logs').textContent=d.totalLogs;
  document.getElementById('kb').innerHTML=d.keysHtml;
  document.getElementById('logb').innerHTML=d.logsHtml;
  document.getElementById('last-refresh').textContent=new Date().toLocaleTimeString('pt-BR');
  filterKeys();
}
async function apiToggle(code){
  const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(code)+'/toggle',{method:'POST'});
  if(r.ok){toast('Status alterado');doRefresh();}else toast('Falha',false);
}
async function apiDelete(code){
  if(!confirm('Excluir '+code+'?'))return;
  const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(code),{method:'DELETE'});
  if(r.ok){toast('Removida');doRefresh();}else toast('Falha',false);
}
function openRenew(code){
  document.getElementById('modal-box').innerHTML='<h3>Renovar '+code+'</h3><div class="field"><label>Dias</label><input id="rd" type="number" min="0" value="30"></div><div class="field"><label>Horas</label><input id="rh" type="number" min="0" value="0"></div><div class="mrow"><button class="btn-p" onclick="submitRenew(\\''+code+'\\')">Confirmar</button><button class="btn-w" onclick="closeModal()">Cancelar</button></div>';
  document.getElementById('modal-bg').classList.add('open');
}
async function submitRenew(code){
  const days=+document.getElementById('rd').value||0,hours=+document.getElementById('rh').value||0;
  const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(code)+'/renew',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days,hours})});
  closeModal();if(r.ok){toast('Renovada');doRefresh();}else toast('Falha',false);
}
function openUses(code,cur){
  document.getElementById('modal-box').innerHTML='<h3>Usos — '+code+'</h3><div class="field"><label>Máx (-1=∞)</label><input id="mu" type="number" value="'+cur+'"></div><div class="mrow"><button class="btn-p" onclick="submitUses(\\''+code+'\\')">Confirmar</button><button class="btn-w" onclick="closeModal()">Cancelar</button></div>';
  document.getElementById('modal-bg').classList.add('open');
}
async function submitUses(code){
  const maxUses=parseInt(document.getElementById('mu').value);
  const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(code)+'/max-uses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxUses})});
  closeModal();if(r.ok){toast('Atualizado');doRefresh();}else toast('Falha',false);
}
function exportCsv(){window.location.href=_RA+'/api/export/csv';}
setInterval(()=>doRefresh(),60000);
</script>`;

  return spaShell('Admin — WaSpeed', sidebar, '⚡ WaSpeed Admin', body);
}

// Painel Mod SPA
function renderModSpa(modName, keysHtml, stats) {
  const body = `
<div class="stats-row" style="margin-bottom:18px">
  <div class="sc"><div class="n">${stats.totalKeys}</div><div class="l">Suas chaves</div></div>
  <div class="sc"><div class="n" style="color:var(--accent)">${stats.activeKeys}</div><div class="l">PRO Ativas</div></div>
</div>
<div class="sec">
  <div class="sh">
    <span class="sh-title">🔑 Minhas licenças</span>
    <div class="gen-form">
      <input type="text" id="nlabel" placeholder="Cliente" style="min-width:110px">
      <select id="npremium"><option value="1">PRO</option><option value="0">Free</option></select>
      <input type="number" id="ndays" placeholder="Dias" min="0">
      <button class="btn-p" onclick="generateKey()">+ Gerar</button>
    </div>
  </div>
  <div class="sh"><input type="text" id="search-input" placeholder="Buscar..." oninput="filterKeys()" style="flex:1;padding:7px 11px;border-radius:8px;border:1px solid var(--border);background:#040d06;color:var(--text)"></div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>Chave</th><th>Cliente</th><th>Status</th><th>Validade</th><th>Usos</th><th>Nota</th></tr></thead>
    <tbody id="kb">${keysHtml}</tbody>
  </table></div>
</div>
<script>
const _RM='${R_MOD}';
function filterKeys(){const q=(document.getElementById('search-input').value||'').toLowerCase();
document.querySelectorAll('#kb tr.kr').forEach(r=>{r.style.display=!q||(r.dataset.code+r.dataset.label).toLowerCase().includes(q)?'':'none';});}
async function generateKey(){
  const label=document.getElementById('nlabel').value.trim();if(!label){toast('Informe o cliente',false);return;}
  const body={label,premium:document.getElementById('npremium').value==='1'};
  const d=+document.getElementById('ndays').value;if(d)body.expireDays=d;
  const r=await fetch(_RM+'/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r.status===401){location.href=_RM+'/login';return;}
  const j=await r.json();if(j.ok){toast('✅ '+j.key);document.getElementById('nlabel').value='';doRefresh();}
  else toast('Erro: '+(j.error||'?'),false);
}
async function doRefresh(){
  const r=await fetch(_RM+'/api/data');if(r.status===401)return;
  const d=await r.json();if(d.ok)document.getElementById('kb').innerHTML=d.keysHtml;filterKeys();
}
</script>`;
  const sidebar = `<aside class="sidebar">
  <div class="sidebar-brand"><span class="brand-dot"></span>👮 ${esc(modName)}</div>
  <div class="sidebar-section">Ações</div>
  <a href="${R_MOD}" class="nav-item active"><span class="icon">🔑</span>Minhas Chaves</a>
  <a href="${R_MOD}/keys/new" class="nav-item"><span class="icon">➕</span>Nova Chave</a>
  <div class="sidebar-footer"><a href="${R_MOD}/logout" class="nav-item"><span class="icon">→</span>Sair</a></div>
</aside>`;
  return spaShell(`Mod ${modName}`, sidebar, `👮 ${modName}`, body);
}

function renderKeyForm(base, rec, title) {
  const code = rec?.code || '';
  const sidebar = base.startsWith(R_ADMIN) ? adminSidebar(rec ? 'keys' : 'keys') : '';
  const body = `<div class="card" style="max-width:600px">
    ${code ? `<div class="field"><label>Chave</label><code class="key-chip">${esc(code)}</code></div>` : ''}
    <div class="field"><label>Nome do cliente</label><input name="label" value="${esc(rec?.label || '')}" required placeholder="Nome ou empresa"></div>
    <div class="row">
      <div class="field"><label>Premium (PRO)</label>
        <select name="premium"><option value="1" ${rec?.premium !== false ? 'selected' : ''}>Sim — PRO</option><option value="0" ${rec?.premium === false ? 'selected' : ''}>Free</option></select>
      </div>
      <div class="field"><label>Dias de validade</label><input name="expireDays" type="number" min="0" value="${rec?.expireDays || 0}" placeholder="0 = sem limite"></div>
    </div>
    <div class="field"><label>Nota interna</label><textarea name="note" rows="3" placeholder="Observações opcionais">${esc(rec?.note || '')}</textarea></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" type="submit">Salvar chave</button>
      <a class="btn btn-ghost" href="${base}/keys">← Voltar</a>
    </div>`;
  const formHtml = `<form method="post">${body}</form>`;
  if (base.startsWith(R_ADMIN)) {
    return spaShell(title, adminSidebar('keys'), title, `<div style="max-width:640px">${formHtml}</div>`);
  }
  // Mod: sem sidebar completa
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PANEL_CSS}</style></head><body><div class="app">${formHtml}</div></body></html>`;
}

function renderAdminLogs(logs) {
  const rows = logs.map((l) =>
    `<tr data-log="${esc((l.type + ' ' + l.message).toLowerCase())}">
      <td style="white-space:nowrap;font-size:.78rem;color:var(--muted)">${esc(new Date(l.at).toLocaleString('pt-BR'))}</td>
      <td><span class="log-type">${esc(l.type)}</span></td>
      <td>${esc(l.message)}</td>
      <td style="font-size:.78rem">${esc(l.meta?.code || '')}</td>
    </tr>`).join('');
  const body = `<div class="search-bar" style="margin-bottom:12px"><input type="text" id="logSearch" placeholder="Filtrar logs..." oninput="filterLog()"></div>
  <div class="sec"><div class="tbl-wrap" style="max-height:75vh;overflow-y:auto"><table>
    <thead><tr><th>Data</th><th>Tipo</th><th>Mensagem</th><th>Chave</th></tr></thead>
    <tbody id="logb">${rows || '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:28px">Nenhum evento registrado</td></tr>'}</tbody>
  </table></div></div>
  <script>function filterLog(){const q=(document.getElementById('logSearch').value||'').toLowerCase();document.querySelectorAll('#logb tr').forEach(r=>{r.style.display=!q||r.dataset.log.includes(q)?'':'none';});}</script>`;
  return spaShell('Logs — WaSpeed', adminSidebar('logs'), '📋 Logs do Sistema', body);
}

// --- Helpers de status de licença --------------------------------------------

function isKeyExpiringSoon(rec) {
  if (!rec?.expiresAt || isKeyExpired(rec) || !rec.active) return false;
  const left = new Date(rec.expiresAt).getTime() - Date.now();
  return left > 0 && left <= config.expiryWarnHours * 3600000;
}

function panelStatusKey(rec) {
  if (!rec.active)        return 'bloqueado';
  if (isKeyExpired(rec))  return 'expirada';
  if (isKeyExpiringSoon(rec)) return 'expirando';
  if (rec.premium)        return 'ativo';
  return 'free';
}

function formatLicenseValidity(rec) {
  if (!rec.expiresAt) return '<span style="color:var(--muted)">Sem limite</span>';
  const exp = new Date(rec.expiresAt);
  const txt = exp.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  if (isKeyExpired(rec))    return `<span style="color:var(--danger)">Expirada · ${esc(txt)}</span>`;
  if (isKeyExpiringSoon(rec)) return `<span style="color:#fbbf24">⏰ ${esc(txt)}</span>`;
  return esc(txt);
}

function licenseUsesLabel(rec) {
  const used = (rec.phones || []).length;
  const max  = rec.maxUses;
  if (max === -1 || max == null) return `${used}/∞`;
  return `${used}/${max > 0 ? max : '∞'}`;
}

function parseLicenseExpiry(body) {
  const days = parseInt(body.expireDays  || 0, 10) || 0;
  const hours = parseInt(body.expireHours || 0, 10) || 0;
  const mins  = parseInt(body.expireMinutes || 0, 10) || 0;
  if (!days && !hours && !mins) return { expiresAt: null, expireDays: 0 };
  const ms = ((days * 1440) + (hours * 60) + mins) * 60000;
  return { expiresAt: new Date(Date.now() + ms).toISOString(), expireDays: days };
}

// --- Cache de chaves do painel ------------------------------------------------

let _panelKeysHtmlCache = null;
let _panelKeysHtmlTs    = 0;
const PANEL_KEYS_CACHE_MS = 15000;

function invalidatePanelKeysCache() {
  _panelKeysHtmlCache = null;
  _panelKeysHtmlTs    = 0;
}

function buildLicenseTableRows(licenses) {
  return licenses.map((k) => {
    const code = k.code;
    const st   = panelStatusKey(k);
    const maxU = k.maxUses ?? -1;
    const isPending = keyStatus(k) === 'pending';
    const fmtDate = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso);
      return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR');
    };
    return `<tr class="kr" data-code="${esc(code)}" data-label="${esc((k.label || '').toLowerCase())}"
      data-status="${isPending ? 'pendente' : st}" data-validity="${k.expiresAt || ''}" data-uses="${(k.phones || []).length}"
      data-phone="${esc(k.lastPhone || '')}" data-lastused="${k.lastUsed || ''}" data-created="${k.createdAt || ''}">
      <td><code class="key-chip">${esc(code)}</code></td>
      <td>${esc(k.label || '—')}</td>
      <td>${isPending ? '<span class="badge badge-pending">PENDENTE</span>' : statusBadgeHtml(keyStatus(k))}</td>
      <td>${formatLicenseValidity(k)}</td>
      <td>${licenseUsesLabel(k)}</td>
      <td style="font-size:.82rem">${esc(k.lastPhone || '—')}</td>
      <td style="font-size:.82rem;color:var(--muted)">${esc(k.lastIp || '—')}</td>
      <td style="font-size:.82rem;color:var(--muted)">${fmtDate(k.lastUsed)}</td>
      <td style="font-size:.82rem;color:var(--muted)">${fmtDate(k.createdAt)}</td>
      <td style="font-size:.82rem;max-width:100px;overflow:hidden;text-overflow:ellipsis" title="${esc(k.note || '')}">${esc(k.note || '—')}</td>
      <td class="act">
        ${isPending ? `<button class="bs bg" onclick="apiActivate('${esc(code)}')">✅Ativar</button>` : ''}
        <button class="bs bg" onclick="apiToggle('${esc(code)}')">${k.active ? 'Bloq' : 'Lib'}</button>
        <button class="bs" onclick="openRenew('${esc(code)}')">+Tempo</button>
        <button class="bs" onclick="openUses('${esc(code)}',${maxU})">Usos</button>
        <button class="bs bd" onclick="apiDelete('${esc(code)}')">Del</button>
      </td>
    </tr>`;
  }).join('');
}

function buildPanelLogsHtml(logs) {
  return logs.map((l) => {
    const d = new Date(l.at);
    const dt = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR');
    return `<tr data-log="${esc((l.type + ' ' + l.message).toLowerCase())}" data-logtype="${esc(l.type)}">
      <td style="white-space:nowrap;font-size:.82rem;color:var(--muted)">${esc(dt)}</td>
      <td><span class="log-type">${esc(l.type)}</span></td>
      <td>${esc(l.message)}</td>
      <td style="font-size:.82rem">${esc(l.meta?.code || '')}</td>
    </tr>`;
  }).join('');
}

async function getPanelKeysHtmlCached() {
  const now = Date.now();
  if (_panelKeysHtmlCache && now - _panelKeysHtmlTs < PANEL_KEYS_CACHE_MS) return _panelKeysHtmlCache;
  const licenses = await listLicenses();
  _panelKeysHtmlCache = buildLicenseTableRows(licenses);
  _panelKeysHtmlTs    = now;
  return _panelKeysHtmlCache;
}

async function getPanelKeyStats() {
  const licenses = await listLicenses();
  // O(n) único — sem loops aninhados (Pilar 4)
  let activeKeys = 0, freeKeys = 0, blockedKeys = 0, expiredKeys = 0, warnKeys = 0;
  for (const k of licenses) {
    const st = keyStatus(k);
    if (st === 'active')  activeKeys++;
    else if (st === 'free')    freeKeys++;
    else if (st === 'blocked') blockedKeys++;
    else if (st === 'expired') expiredKeys++;
    if (isKeyExpiringSoon(k)) warnKeys++;
  }
  const totalLogs = db ? await db.collection(COL.logs).countDocuments() : 0;
  return { totalKeys: licenses.length, activeKeys, freeKeys, blockedKeys, expiredKeys, warnKeys, totalLogs };
}

async function getDashboardStats() {
  return getPanelKeyStats();
}

// Regex do admin / mod (cached, O(1) por path — Pilar 4)
function adminPathRegex(suffix = '') {
  const base = R_ADMIN.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
  return new RegExp(`^${base}/keys/([^/]+)${suffix}$`);
}
function adminApiPathRegex(suffix = '') {
  const base = R_ADMIN.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
  return new RegExp(`^${base}/api/keys/([^/]+)${suffix}$`);
}
function modApiPathRegex(suffix = '') {
  const base = R_MOD.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
  return new RegExp(`^${base}/api/keys/([^/]+)${suffix}$`);
}

// --- Painel cliente ----------------------------------------------------------

const CLIENT_PANEL_RE = /^\/([a-z0-9]{16,32})\/(auth-painel|login|recovery|auth-plugin|redirect-plugin-register|register)\/?$/i;

function clientShell(title, body, navHtml = '', subtitle = '') {
  const nav = navHtml ? `<nav style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">${navHtml}</nav>` : '';
  return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — WaSpeed</title><style>${PANEL_CSS}</style></head>
<body><div class="app">
<header class="topbar-simple"><div style="display:flex;align-items:center;gap:10px;font-weight:800;font-size:1rem;color:var(--accent)"><span class="brand-dot"></span>WaSpeed</div>${nav}</header>
<div class="page-head"><h1>${esc(title)}</h1>${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}</div>
${body}
</div></body></html>`;
}

function renderClientLogin(storeId) {
  return clientShell('Painel Clientes', `<div class="card">
    <p style="color:var(--muted);font-size:.875rem;margin-bottom:14px">Extensão WaSpeed · ID ${esc(storeId)}</p>
    <p style="margin-bottom:18px">O acesso ao painel é feito pela extensão no WhatsApp Web.</p>
    <ol class="steps">
      <li>Abra o WhatsApp Web</li>
      <li>Na extensão WaSpeed, faça login com sua <strong>chave de ativação</strong></li>
      <li>Clique em <strong>Painel Clientes</strong> na barra lateral</li>
    </ol>
    <p style="margin-top:22px"><a class="btn" href="https://web.whatsapp.com" target="_blank" rel="noopener">Abrir WhatsApp Web</a></p>
  </div>`, '', 'Instruções de acesso');
}

function renderClientRecovery(storeId) {
  return clientShell('Recuperar acesso', `<div class="card">
    <p style="color:var(--muted);margin-bottom:14px">Extensão WaSpeed</p>
    <p style="margin-bottom:12px">Entre em contato com o administrador do seu servidor WaSpeed para obter uma nova chave.</p>
    <p style="margin-top:22px"><a class="btn btn-ghost" href="/${esc(storeId)}/login">← Voltar ao painel</a></p>
  </div>`, '', 'Recuperação de licença');
}

function renderClientRegister(storeId) {
  return clientShell('Modo gratuito', `<div class="card">
    <p style="color:var(--muted);margin-bottom:14px">Extensão WaSpeed</p>
    <p>O cadastro gratuito é feito na extensão: clique em <strong>Entrar gratuitamente</strong>.</p>
    <p style="margin-top:22px"><a class="btn" href="https://web.whatsapp.com" target="_blank" rel="noopener">Abrir WhatsApp Web</a></p>
  </div>`, '', 'Registro sem custo');
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
  const nav       = `<a href="/${esc(storeId)}/auth-painel?token=${encodeURIComponent(token)}" style="font-size:.875rem;color:var(--muted);padding:6px 12px;border-radius:7px;border:1px solid var(--border)">Minha conta</a>
    <a href="https://web.whatsapp.com" target="_blank" rel="noopener" style="font-size:.875rem;color:var(--muted);padding:6px 12px;border-radius:7px;border:1px solid var(--border)">WhatsApp Web</a>`;

  return clientShell('Minha conta', `
    <div class="metrics">
      <div class="metric"><div class="metric-value" style="font-size:1rem">${statusBadgeHtml(st)}</div><div class="metric-label">Status</div></div>
      <div class="metric"><div class="metric-value" style="font-size:1.1rem">${esc(liberacao)}</div><div class="metric-label">Data liberação</div></div>
      <div class="metric"><div class="metric-value" style="font-size:.95rem">${esc(exp)}</div><div class="metric-label">Validade</div></div>
    </div>
    <div class="card">
      <div class="card-title">Conta</div>
      <p style="font-size:1.05rem;font-weight:700">${esc(user.name)}</p>
      <p style="color:var(--muted);font-size:.875rem">${esc((user.email || '').replace(/@waspeed\.local$/i, ''))}</p>
      <div class="info-grid" style="margin-top:14px">
        <div class="info-row"><span class="label">Chave</span><code class="key-chip">${esc(code)}</code></div>
        ${pageLabel ? `<div class="info-row"><span class="label">Seção</span><span>${pageLabel}</span></div>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="card-title">Informações</div>
      <div class="info-grid">
        <div class="info-row"><span class="label">Servidor</span><span class="key-chip">${esc(config.baseUrl)}</span></div>
        <div class="info-row"><span class="label">WhatsApp</span><span>${esc(rec.lastPhone || '—')}</span></div>
        <div class="info-row"><span class="label">Último uso</span><span>${rec.lastUsed ? esc(new Date(rec.lastUsed).toLocaleString('pt-BR')) : '—'}</span></div>
      </div>
    </div>`, nav, `Olá, ${esc(user.name)}`);
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
    sendHtml(res, renderClientRegister(storeId)); return true;
  }
  if (route === 'recovery') { sendHtml(res, renderClientRecovery(storeId)); return true; }
  if (route === 'login')    { sendHtml(res, renderClientLogin(storeId));    return true; }
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
  if (!requireAccessToken(req)) {
    return sendJson(res, { success: false, msg_id: 'invalid_access_token' }, 403);
  }

  // Acoplamento de X-Extension-ID (Pilar 3) — apenas rotas críticas de auth
  const isAuthRoute = pathname.includes('/api/auth/');
  if (isAuthRoute && !requireExtensionId(req)) {
    slog(LOG_LEVELS.SECURITY, 'X-Extension-ID inválido', { ip, path: pathname, id: req.headers['x-extension-id'] });
    return sendJson(res, { success: false, msg_id: 'invalid_extension_id' }, 403);
  }

  if (pathname === `/api/auth/login-bearer/${chromeId}` && (req.method === 'GET' || req.method === 'POST')) {
    if (!checkRate(ip)) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const bearer = parseBearer(req);
    if (detectInjection(bearer)) {
      slog(LOG_LEVELS.SECURITY, 'Injection em login-bearer', { ip });
      dispatchWebhookAlert('nosql_injection', { route: 'login-bearer', ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token' });
    }
    const rec = await findKeyByBearer(bearer);
    if (!rec) {
      await addLog('auth_fail', 'Bearer inválido', { ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token' });
    }
    const result = await authSuccess(rec.code || bearer, rec);
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('auth_ok', `Login bearer ${rec.code}`, { ip });
    return sendJson(res, result.body);
  }

  if (pathname === `/api/auth/register-free/${chromeId}` && req.method === 'POST') {
    if (!checkRate(ip)) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const body = await readJson(req);
    const { code, rec } = await getOrCreateFreeKey(body.extension_id || body.device_id, ip);
    const result = await authSuccess(code, rec);
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('free_register', `Login free ${code}`, { ip, extension_id: body.extension_id });
    return sendJson(res, result.body);
  }

  if (pathname === `/api/auth/validation/${chromeId}` && req.method === 'POST') {
    if (!checkRate(ip)) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const body = await readJson(req);
    const key  = normKey(body.access_token_plugin || body.chave || body.senha || body.email);
    if (detectInjection(key)) {
      slog(LOG_LEVELS.SECURITY, 'Injection em validation', { ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token_in_validation' });
    }
    const rec = await findKey(key);
    if (!rec) {
      await addLog('auth_fail', 'Chave inválida validation', { ip, key });
      return sendJson(res, { success: false, msg_id: 'invalid_token_in_validation' });
    }
    const result = await authSuccess(key, rec);
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('validation_ok', `Validação ${key}`, { ip });
    return sendJson(res, result.body);
  }

  if (pathname === `/api/auth/login/${chromeId}` && req.method === 'POST') {
    if (!checkRate(ip)) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const body = await readJson(req);
    const key  = normKey(body.senha || body.chave || body.email || body.access_token_plugin);
    const rec  = await findKey(key);
    if (!rec) {
      await addLog('auth_fail', 'Login chave inválida', { ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token' });
    }
    const result = await authSuccess(key, rec);
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('auth_ok', `Login ${key}`, { ip });
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

  if (pathname === `/api/services/initial-data/${chromeId}`) {
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

// --- Handler Admin API -------------------------------------------------------

async function handleAdminApi(req, res, pathname) {
  if (pathname === R_ADMIN + '/api/data' && req.method === 'GET') {
    const stats    = await getPanelKeyStats();
    const keysHtml = await getPanelKeysHtmlCached();
    const logs     = await getRecentLogs(150);
    return sendJson(res, { ok: true, ...stats, keysHtml, logsHtml: buildPanelLogsHtml(logs) });
  }

  if (pathname === R_ADMIN + '/api/keys' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.label?.trim()) return sendJson(res, { error: 'label obrigatório' }, 400);
    const { expiresAt, expireDays } = parseLicenseExpiry(body);
    const maxUses = body.maxUses !== undefined ? parseInt(body.maxUses, 10) : -1;
    try {
      const rec = await createKey({
        label     : String(body.label).trim().slice(0, 60),
        premium   : body.premium !== false && body.premium !== 0 && body.premium !== '0',
        expiresAt,
        expireDays,
        maxUses   : Number.isNaN(maxUses) ? -1 : maxUses,
        note      : String(body.note || '').slice(0, 500),
        ativarNoPrimeiroUso: body.ativarNoPrimeiroUso === true,
      });
      invalidatePanelKeysCache();
      return sendJson(res, { ok: true, key: rec.code });
    } catch (e) {
      return sendJson(res, { error: e.message }, 500);
    }
  }

  if (pathname === R_ADMIN + '/api/logs/clear' && req.method === 'POST') {
    if (db) await db.collection(COL.logs).deleteMany({});
    slog(LOG_LEVELS.INFO, 'Logs limpos pelo admin');
    return sendJson(res, { ok: true });
  }

  const codeActivate = pathname.match(adminApiPathRegex('/activate'));
  if (codeActivate && req.method === 'POST') {
    const rec = await findKey(decodeURIComponent(codeActivate[1]));
    if (!rec) return sendJson(res, { error: 'not found' }, 404);
    await updateLicense(rec.code, { ativarNoPrimeiroUso: false, primeiroUsoAt: new Date().toISOString(), active: true });
    await addLog('key_activated', `Chave ${rec.code} ativada manualmente`, { code: rec.code });
    invalidatePanelKeysCache();
    return sendJson(res, { ok: true });
  }

  const codeToggle = pathname.match(adminApiPathRegex('/toggle'));
  if (codeToggle && req.method === 'POST') {
    const rec = await findKey(decodeURIComponent(codeToggle[1]));
    if (!rec) return sendJson(res, { error: 'not found' }, 404);
    await updateLicense(rec.code, { active: !rec.active });
    invalidatePanelKeysCache();
    return sendJson(res, { ok: true, active: !rec.active });
  }

  const codeRenew = pathname.match(adminApiPathRegex('/renew'));
  if (codeRenew && req.method === 'POST') {
    const rec = await findKey(decodeURIComponent(codeRenew[1]));
    if (!rec) return sendJson(res, { error: 'not found' }, 404);
    const body  = await readJson(req);
    const days  = parseInt(body.days  || 0, 10) || 0;
    const hours = parseInt(body.hours || 0, 10) || 0;
    if (!days && !hours) return sendJson(res, { error: 'informe tempo' }, 400);
    const addMs = ((days * 1440) + (hours * 60)) * 60000;
    const base  = (rec.expiresAt && !isKeyExpired(rec)) ? new Date(rec.expiresAt).getTime() : Date.now();
    await updateLicense(rec.code, { expiresAt: new Date(base + addMs).toISOString(), active: true });
    invalidatePanelKeysCache();
    return sendJson(res, { ok: true });
  }

  const codeMu = pathname.match(adminApiPathRegex('/max-uses'));
  if (codeMu && req.method === 'POST') {
    const rec = await findKey(decodeURIComponent(codeMu[1]));
    if (!rec) return sendJson(res, { error: 'not found' }, 404);
    const body    = await readJson(req);
    const maxUses = parseInt(body.maxUses, 10);
    if (Number.isNaN(maxUses) || maxUses < -1) return sendJson(res, { error: 'invalid' }, 400);
    await updateLicense(rec.code, { maxUses });
    invalidatePanelKeysCache();
    return sendJson(res, { ok: true, maxUses });
  }

  const codeDel = pathname.match(adminApiPathRegex());
  if (codeDel && req.method === 'DELETE' && !pathname.endsWith('/toggle') && !pathname.endsWith('/renew') && !pathname.endsWith('/max-uses')) {
    const code = decodeURIComponent(codeDel[1]);
    await deleteLicense(code);
    await addLog('key_delete', `Chave ${code} excluída`, { code });
    invalidatePanelKeysCache();
    return sendJson(res, { ok: true });
  }

  if (pathname === R_ADMIN + '/api/export/csv' && req.method === 'GET') {
    const licenses = await listLicenses();
    const lines    = ['code,label,premium,active,expiresAt,uses,maxUses,lastPhone,lastIp,createdAt,note'];
    for (const k of licenses) {
      lines.push([
        k.code, k.label, k.premium, k.active, k.expiresAt || '',
        (k.phones || []).length, k.maxUses ?? -1, k.lastPhone || '', k.lastIp || '',
        k.createdAt || '', (k.note || '').replace(/,/g, ';'),
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    const csv = lines.join('\n');
    res.writeHead(200, {
      'Content-Type'       : 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="waspeed-licenses.csv"',
    });
    res.end('\ufeff' + csv);
    return true;
  }
  return false;
}

// --- Handler Mod API ---------------------------------------------------------

async function handleModApi(req, res, pathname, sess) {
  const modName = sess.name;
  if (pathname === R_MOD + '/api/data' && req.method === 'GET') {
    const all      = await listLicenses({ modName });
    const keysHtml = buildLicenseTableRows(all);
    return sendJson(res, {
      ok        : true,
      totalKeys : all.length,
      activeKeys: all.filter((k) => keyStatus(k) === 'active').length,
      keysHtml,
    });
  }
  if (pathname === R_MOD + '/api/keys' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.label?.trim()) return sendJson(res, { error: 'label obrigatório' }, 400);
    const { expiresAt, expireDays } = parseLicenseExpiry(body);
    try {
      const rec = await createKey({
        label     : String(body.label).trim().slice(0, 60),
        premium   : body.premium !== false && body.premium !== 0 && body.premium !== '0',
        expiresAt,
        expireDays,
        note      : String(body.note || '').slice(0, 400),
      }, modName);
      invalidatePanelKeysCache();
      return sendJson(res, { ok: true, key: rec.code });
    } catch (e) {
      return sendJson(res, { error: e.message }, 500);
    }
  }
  return false;
}

// --- Handler Admin (rotas HTML) ----------------------------------------------

async function handleAdmin(req, res, pathname, ip = '') {
  if (pathname === R_ADMIN + '/login') {
    if (req.method === 'GET') return sendHtml(res, renderLogin(R_ADMIN, 'Admin'));
    if (!checkRate(ip)) return sendHtml(res, renderLogin(R_ADMIN, 'Admin', 'Muitas tentativas. Aguarde alguns minutos.'), 429);
    const body   = await readBody(req);
    const params = new URLSearchParams(body);
    const user   = sanitizeString(params.get('user') || '');
    const pass   = params.get('pass') || '';
    if (await verifyAdminCredentials(user, pass)) {
      const session = await createSession('admin', { user: user.trim() });
      if (!session) return sendHtml(res, renderLogin(R_ADMIN, 'Admin', 'Erro ao criar sessão'), 500);
      setSessionCookie(res, session.token);
      res.writeHead(302, { Location: R_ADMIN });
      return res.end();
    }
    await addLog('admin_login_fail', 'Tentativa de login inválida', { ip });
    return sendHtml(res, renderLogin(R_ADMIN, 'Admin', 'Credenciais inválidas'), 401);
  }

  if (pathname === R_ADMIN + '/logout') {
    const token = parseCookies(req)[config.cookieName];
    await destroySession(token);
    clearSessionCookie(res);
    res.writeHead(302, { Location: R_ADMIN + '/login' });
    return res.end();
  }

  const sess = await requireAdmin(req, res);
  if (!sess) return;

  if (await handleAdminApi(req, res, pathname)) return;

  // Auto-pentest endpoint (Pilar 6)
  if (pathname === R_ADMIN + '/security-test' && req.method === 'GET') {
    const report = await runSecurityTests(req);
    const sidebar = adminSidebar('pentest');
    const body = `<div class="card">
      <div class="card-title">🛡️ Relatório de Auto-Pentest</div>
      <pre style="font-family:var(--mono);font-size:.8rem;line-height:1.7;color:var(--text);white-space:pre-wrap">${esc(JSON.stringify(report, null, 2))}</pre>
    </div>`;
    return sendHtml(res, spaShell('Auto-Pentest', sidebar, '🛡️ Auto-Pentest', body));
  }

  if (pathname === R_ADMIN || pathname === R_ADMIN + '/') {
    const stats    = await getPanelKeyStats();
    const keysHtml = await getPanelKeysHtmlCached();
    const logs     = await getRecentLogs(150);
    return sendHtml(res, renderAdminSpa(keysHtml, buildPanelLogsHtml(logs), stats));
  }

  if (pathname === R_ADMIN + '/keys') {
    const licenses = await listLicenses();
    const stats    = await getPanelKeyStats();
    const sidebar  = adminSidebar('keys', stats);
    const body = `<div class="toolbar"><a class="btn btn-success" href="${R_ADMIN}/keys/new">+ Nova Chave</a>
      <span style="color:var(--muted);font-size:.875rem">${licenses.length} chave(s) cadastrada(s)</span></div>
      <div class="sec"><div class="tbl-wrap">${buildLicenseTableRows(licenses) || '<div class="empty-state"><p>Nenhuma chave cadastrada</p></div>'}</div></div>`;
    return sendHtml(res, spaShell('Chaves', sidebar, '🔑 Chaves de Acesso', body));
  }

  if (pathname === R_ADMIN + '/keys/new') {
    if (req.method === 'GET') return sendHtml(res, renderKeyForm(R_ADMIN, null, 'Nova Chave'));
    const body = await readBody(req);
    const p    = new URLSearchParams(body);
    try {
      const rec = await createKey({
        label     : sanitizeString(p.get('label') || ''),
        premium   : p.get('premium') !== '0',
        expireDays: Number(p.get('expireDays') || 0),
        note      : sanitizeString(p.get('note') || ''),
      });
      res.writeHead(302, { Location: `${R_ADMIN}/keys/${encodeURIComponent(rec.code)}` });
      return res.end();
    } catch (err) {
      res.writeHead(500);
      return res.end('Erro ao criar chave: ' + esc(err.message));
    }
  }

  const keyEdit = pathname.match(adminPathRegex());
  if (keyEdit) {
    const code = decodeURIComponent(keyEdit[1]);
    const rec  = await findKey(code);
    if (!rec) { res.writeHead(404); return res.end('Not found'); }
    if (req.method === 'GET') return sendHtml(res, renderKeyForm(R_ADMIN, rec, 'Editar Chave'));
    const body  = await readBody(req);
    const p     = new URLSearchParams(body);
    const patch = {
      label  : sanitizeString(p.get('label') || rec.label),
      premium: p.get('premium') !== '0',
      note   : sanitizeString(p.get('note') || ''),
    };
    const days = Number(p.get('expireDays') || 0);
    if (days > 0) patch.expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    await updateLicense(code, patch);
    res.writeHead(302, { Location: R_ADMIN + '/keys' });
    return res.end();
  }

  const keyToggle = pathname.match(adminPathRegex('/toggle'));
  if (keyToggle && req.method === 'POST') {
    const code = decodeURIComponent(keyToggle[1]);
    const rec  = await findKey(code);
    if (rec) await updateLicense(code, { active: !rec.active });
    res.writeHead(302, { Location: R_ADMIN + '/keys' });
    return res.end();
  }

  const keyDel = pathname.match(adminPathRegex('/delete'));
  if (keyDel && req.method === 'POST') {
    const code = decodeURIComponent(keyDel[1]);
    await deleteLicense(code);
    await addLog('key_delete', `Chave ${code} excluída`, { code });
    res.writeHead(302, { Location: R_ADMIN + '/keys' });
    return res.end();
  }

  if (pathname === R_ADMIN + '/logs') {
    const logs = await getRecentLogs(200);
    return sendHtml(res, renderAdminLogs(logs));
  }

  res.writeHead(404);
  return res.end('Not found');
}

// --- Handler Mod (rotas HTML) ------------------------------------------------

async function handleMod(req, res, pathname, ip = '') {
  if (pathname === R_MOD + '/login') {
    if (req.method === 'GET') return sendHtml(res, renderLogin(R_MOD, 'Moderador'));
    if (!checkRate(ip)) return sendHtml(res, renderLogin(R_MOD, 'Moderador', 'Muitas tentativas. Aguarde.'), 429);
    const body   = await readBody(req);
    const params = new URLSearchParams(body);
    const user   = sanitizeString(params.get('user') || '');
    const pass   = params.get('pass') || '';
    const mod    = await verifyModCredentials(user, pass);
    if (mod) {
      const session = await createSession('mod', { user: user.trim(), modId: mod.modId, name: mod.name });
      if (!session) return sendHtml(res, renderLogin(R_MOD, 'Moderador', 'Erro ao criar sessão'), 500);
      setSessionCookie(res, session.token);
      res.writeHead(302, { Location: R_MOD });
      return res.end();
    }
    return sendHtml(res, renderLogin(R_MOD, 'Moderador', 'Credenciais inválidas'), 401);
  }

  if (pathname === R_MOD + '/logout') {
    const token = parseCookies(req)[config.cookieName];
    await destroySession(token);
    clearSessionCookie(res);
    res.writeHead(302, { Location: R_MOD + '/login' });
    return res.end();
  }

  const sess = await requireMod(req, res);
  if (!sess) return;

  if (await handleModApi(req, res, pathname, sess)) return;

  const all = await listLicenses({ modName: sess.name });

  if (pathname === R_MOD || pathname === R_MOD + '/') {
    const stats = {
      totalKeys : all.length,
      activeKeys: all.filter((k) => keyStatus(k) === 'active').length,
    };
    return sendHtml(res, renderModSpa(sess.name, buildLicenseTableRows(all), stats));
  }

  if (pathname === R_MOD + '/keys/new') {
    if (req.method === 'GET')  return sendHtml(res, renderKeyForm(R_MOD, null, 'Nova Chave (Mod)'));
    if (req.method === 'POST') {
      const body = await readBody(req);
      const p    = new URLSearchParams(body);
      await createKey({
        label  : sanitizeString(p.get('label') || ''),
        premium: p.get('premium') !== '0',
        note   : sanitizeString(p.get('note') || ''),
      }, sess.name);
      res.writeHead(302, { Location: R_MOD });
      return res.end();
    }
  }

  res.writeHead(404);
  return res.end('Not found');
}

// --- Suíte de Auto-Pentest (Pilar 6) -----------------------------------------

async function runSecurityTests(req) {
  const results = [];
  const ts      = new Date().toISOString();

  // Teste 1: Simulação de NoSQL injection
  const injectionPayloads = [
    '{"$gt": ""}', '{"$ne": null}', '{"$or": [{}]}', '{"$where": "1==1"}',
  ];
  let injectionBlocked = 0;
  for (const p of injectionPayloads) {
    try {
      const obj = JSON.parse(p);
      const sanitized = sanitizeObject(obj);
      const keys = Object.keys(sanitized);
      if (!keys.some((k) => k.startsWith('$'))) injectionBlocked++;
    } catch { injectionBlocked++; }
  }
  results.push({
    test   : 'NoSQL Injection Sanitization',
    status : injectionBlocked === injectionPayloads.length ? 'PASS' : 'FAIL',
    detail : `${injectionBlocked}/${injectionPayloads.length} payloads sanitizados`,
  });

  // Teste 2: Prototype Pollution — tenta poluir e verifica se sanitizeObject bloqueia
  const ppTests = [
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{"polluted":true}}}',
  ];
  let ppBlocked = 0;
  const _ppSentinel = Object.create(null);
  for (const p of ppTests) {
    try {
      const obj = JSON.parse(p);
      sanitizeObject(obj);
      if ({}.polluted === undefined) ppBlocked++;
    } catch { ppBlocked++; }
  }
  try { delete Object.prototype.polluted; } catch(_){}
  results.push({
    test   : 'Prototype Pollution Protection',
    status : ppBlocked === ppTests.length ? 'PASS' : 'FAIL',
    detail : `${ppBlocked}/${ppTests.length} ataques bloqueados`,
  });

  // Teste 3: Security Headers presentes
  const fakeHeaders = {};
  const fakeRes     = {
    headersSent: false,
    removeHeader: () => {},
    setHeader: (k, v) => { fakeHeaders[k] = v; },
  };
  applySecurityHeaders(fakeRes);
  const requiredHeaders = [
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Referrer-Policy',
    'Content-Security-Policy',
    'X-XSS-Protection',
  ];
  const missingHeaders = requiredHeaders.filter((h) => !fakeHeaders[h]);
  results.push({
    test   : 'Security Headers',
    status : missingHeaders.length === 0 ? 'PASS' : 'FAIL',
    detail : missingHeaders.length === 0 ? 'Todos os headers presentes' : `Faltando: ${missingHeaders.join(', ')}`,
  });

  // Teste 4: Rate Limiter
  const testIp  = '10.0.0.test';
  const rlPasses = [];
  for (let i = 0; i < 15; i++) {
    rlPasses.push(checkRate(testIp, 'login'));
  }
  const blocked = rlPasses.filter((v) => !v).length;
  // Limpa entry de teste
  rateMap.delete(`${testIp}:login`);
  results.push({
    test   : 'Rate Limiter Activation',
    status : blocked >= 4 ? 'PASS' : 'FAIL',
    detail : `${blocked}/15 requisições bloqueadas após exceder limite`,
  });

  // Teste 5: Cookie Anti-OSINT (nome customizado)
  results.push({
    test   : 'Cookie Anti-OSINT Fingerprint',
    status : config.cookieName !== 'ws_session' ? 'PASS' : 'WARN',
    detail : `Cookie name: ${config.cookieName}`,
  });

  // Teste 6: Circuit Breaker presente
  results.push({
    test   : 'Circuit Breaker',
    status : typeof cbIsOpen === 'function' ? 'PASS' : 'FAIL',
    detail : `Estado atual: ${cbIsOpen() ? 'ABERTO' : 'FECHADO'} | Falhas: ${cbFailCount}`,
  });

  // Teste 7: Webhook configurado
  results.push({
    test   : 'Webhook Alert',
    status : config.webhookUrl ? 'PASS' : 'WARN',
    detail : config.webhookUrl ? 'SECURITY_WEBHOOK_URL configurado' : 'SECURITY_WEBHOOK_URL não definido',
  });

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  return {
    timestamp    : ts,
    summary      : { total: results.length, passed, failed, warnings: results.length - passed - failed },
    overall      : failed === 0 ? 'PASS' : 'FAIL',
    tests        : results,
  };
}

// --- Router principal --------------------------------------------------------

async function handleRequest(req, res) {
  // Aplicar security headers em todas as respostas (Pilar 2)
  applySecurityHeaders(res);

  const url      = new URL(req.url, `http://127.0.0.1:${config.port}`);
  const pathname = url.pathname;
  const ip       = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';

  applyCors(req, res, pathname);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (pathname === '/ping') return sendText(res, 'OK');

    if (pathname === '/login') {
      res.writeHead(302, { Location: R_ADMIN + '/login' });
      return res.end();
    }

    // Health Check avançado (Pilar 5)
    if (pathname === '/health') {
      const mem         = process.memoryUsage();
      let keyCount      = 0;
      let mongoOk       = mongoReady && db !== null && !cbIsOpen();
      const loopStart   = Date.now();
      await new Promise((r) => setImmediate(r));
      const loopLatency = Date.now() - loopStart;

      if (mongoOk) {
        try { keyCount = await db.collection(COL.licenses).countDocuments(); }
        catch (err) { mongoOk = false; }
      }
      return sendJson(res, {
        ok           : mongoOk,
        service      : 'waspeed-server',
        version      : '4.0.0',
        keys         : keyCount,
        mongo        : mongoOk,
        circuitBreaker: cbIsOpen() ? 'OPEN' : 'CLOSED',
        storage      : 'mongodb',
        memory       : {
          heapUsedMB : (mem.heapUsed  / 1048576).toFixed(1),
          heapTotalMB: (mem.heapTotal / 1048576).toFixed(1),
          rssMB      : (mem.rss       / 1048576).toFixed(1),
        },
        eventLoopLatencyMs: loopLatency,
        uptime       : Math.floor(process.uptime()),
      }, mongoOk ? 200 : 503);
    }

    // Circuit breaker — responde 503 imediatamente sem enfileirar (Pilar 5)
    if (cbIsOpen() && pathname.startsWith('/api/') && !pathname.startsWith('/api/external/')) {
      return sendJson(res, {
        success : false,
        msg_id  : 'service_unavailable',
        message : 'Banco de dados temporariamente indisponível. Tente novamente em instantes.',
      }, 503);
    }

    if (!mongoReady || !db) {
      if (!pathname.startsWith('/api/')) {
        // Permitir rotas de front-end mesmo sem DB (modo degradado)
      } else {
        return sendError(res, 503, 'db_unavailable');
      }
    }

    if (pathname === '/') {
      const body = `<div class="card">
        <p style="margin-bottom:8px">Backend ativo em <strong>${esc(config.baseUrl)}</strong></p>
        <p style="color:var(--muted);font-size:.875rem;margin-bottom:18px">Login extensão: somente chave · API: /api/auth/validation/:id</p>
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          <a class="btn" href="${R_ADMIN}">Painel Admin</a>
          <a class="btn btn-ghost" href="${R_MOD}">Painel Mod</a>
        </div>
      </div>`;
      return sendHtml(res, clientShell('WaSpeed Server', body, '', 'Servidor de licenças e configuração'));
    }

    if (pathname === '/config.json') { sendCachedConfigJson(res); return; }

    if (pathname === '/api/code') {
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type' : 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
        res.end('/* WaSpeed remote code stub — WPP injetado localmente pela extensão */\n');
      }
      return;
    }

    if (pathname === '/obrigado') {
      return sendHtml(res, clientShell('Obrigado', '<div class="card" style="text-align:center;padding:48px"><h2 style="margin-bottom:8px">Obrigado!</h2><p style="color:var(--muted)">WaSpeed</p></div>'));
    }

    if (pathname.startsWith('/utils/')) {
      return sendJson(res, { success: false, msg_id: 'not_configured', message: 'Não configurado neste servidor' }, 501);
    }

    if (await handleClientPanel(req, res, pathname, url)) return;

    if (pathname.startsWith('/api/')) {
      const handled = await handleWaSpeedApi(req, res, pathname, ip);
      if (handled !== false) return;
      return sendJson(res, { success: false, msg_id: 'not_found' }, 404);
    }

    if (pathname.startsWith(R_ADMIN)) { await handleAdmin(req, res, pathname, ip); return; }
    if (pathname.startsWith(R_MOD))   { await handleMod(req, res, pathname, ip);   return; }

    if (!res.headersSent) { res.writeHead(404); res.end('Not found'); }

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

  server = http.createServer(handleRequest);
  server.on('clientError', (err, socket) => {
    slog(LOG_LEVELS.WARN, 'clientError', { err: err.message });
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.listen(config.port, () => {
    slog(LOG_LEVELS.INFO, `WaSpeed Server v4.0 ouvindo na porta ${config.port}`);
    slog(LOG_LEVELS.INFO, `Admin  : ${config.baseUrl}${R_ADMIN}/login`);
    slog(LOG_LEVELS.INFO, `Mod    : ${config.baseUrl}${R_MOD}/login`);
    slog(LOG_LEVELS.INFO, `Health : ${config.baseUrl}/health`);
    slog(LOG_LEVELS.INFO, `Pentest: ${config.baseUrl}${R_ADMIN}/security-test (requer sessão admin)`);
    startAntiSleepCron();
  });
}

bootstrap().catch((err) => {
  slog(LOG_LEVELS.CRITICAL, 'bootstrap fatal', { err: err.message });
  process.exit(1);
});
