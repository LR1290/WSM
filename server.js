'use strict';

// =============================================================================
// WaSpeed Server v3.0 — http nativo + MongoDB + sessoes seguras
// =============================================================================

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { MongoClient } = require('mongodb');

const WPP_VERSION = '1.11';
const REMOTE_CODE_VERSION = '1.0.41';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ANTI_SLEEP_MS = 5 * 60 * 1000;

const COL = { settings: 'settings', licenses: 'licenses', logs: 'logs', sessions: 'sessions' };

function envStr(key, fallback = '') {
  return String(process.env[key] ?? fallback).trim().replace(/^["']|["']$/g, '');
}

function dbNameFromMongoUri(uri) {
  const m = String(uri || '').match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/);
  return m?.[1] || 'waspeed';
}

const config = {
  port: Number(process.env.PORT) || 3000,
  baseUrl: (envStr('BASE_URL') || envStr('PUBLIC_URL') || envStr('RENDER_EXTERNAL_URL')).replace(/\/$/, ''),
  publicUrl: (envStr('PUBLIC_URL') || envStr('BASE_URL') || envStr('RENDER_EXTERNAL_URL')).replace(/\/$/, ''),
  mongoUri: envStr('MONGODB_URI'),
  dbName: envStr('MONGODB_DB') || dbNameFromMongoUri(envStr('MONGODB_URI')),
  criptKey: envStr('ACCESS_TOKEN', 'ffce211a-7b07-4d91-ba5d-c40bb4034a83'),
  chromeStoreId: envStr('CHROME_STORE_ID', 'balkfdkhbcjjmhndnblgmlmcabnapogp'),
  wlId: envStr('WL_ID', 'waspeed'),
  adminUser: envStr('ADMIN_USER', 'admin'),
  adminPass: envStr('ADMIN_PASS', 'waspeed-admin-change-me'),
  adminPath: envStr('ADMIN_PATH', 'admin-waspeed'),
  modPath: envStr('MOD_PATH', 'mod-waspeed'),
  installUrl: envStr('INSTALL_URL', 'https://web.whatsapp.com'),
  notesRedirect: envStr('NOTES_REDIRECT').toLowerCase() === 'true',
  logMax: Math.min(Number(process.env.LOG_MAX) || 500, 2000),
  expiryWarnHours: Math.max(1, Math.min(720, Number(process.env.EXPIRY_WARN_HOURS) || 48)),
};

if (!config.baseUrl) {
  console.error('[WaSpeed] ERRO: defina BASE_URL, PUBLIC_URL ou deploy no Render (RENDER_EXTERNAL_URL).');
  process.exit(1);
}
if (!config.mongoUri) {
  console.error('[WaSpeed] ERRO: defina MONGODB_URI no painel Environment do Render.');
  process.exit(1);
}
if (/xxxxx|USUARIO|SENHA|<password>|YOUR_CLUSTER/i.test(config.mongoUri)) {
  console.error('[WaSpeed] ERRO: MONGODB_URI ainda contem placeholders do template.');
  process.exit(1);
}

const R_ADMIN = `/${config.adminPath}`;
const R_MOD = `/${config.modPath}`;

let mongoClient = null;
let db = null;
let mongoReady = false;
let cachedSettings = null;
let configJsonBody = null;
let server = null;

const DOM_DEFAULTS = {"version":"1.11","update_path_active":"true","disabled_wait_sync":false,"wpp_mensagens":{"timer":"60000","enable_two_send":false},"newModel":{"model":"taghtml","parm":"body.color-refresh"},"app":{"model":"querySelector","selector":["#app"]},"afiliadoMain":{"model":"querySelector","selector":["body > div"]},"paneSide":{"model":"Element","selector":"#pane-side"},"waPage":{"model":"querySelector","selector":["div.two"]},"two":{"model":"Element","selector":"two"},"menuLateral":{"model":"querySelector","selector":["div.two > div:nth-child(5)"]},"closeChat":{"model":"Element","selector":"x10l6tqk"},"chatListInput":{"model":"querySelector","selector":[".lexical-rich-text-input > div"]},"searchInput":{"model":"querySelector","selector":["[data-icon='search']"]},"downAba":{"model":"querySelector","selector":["header > div > div > div > div > span > div > div:nth-child(1)","header > div._ak0w"]},"chatListHeader":{"model":"querySelector","selector":["header > header > div > span > div"]},"searchCamp":{"model":"querySelector","selector":["#side div[data-testid='chat-list-search-container']"]},"chatName":{"model":"querySelector","selector":["#main header span[title]","#main header div[role=\"button\"] span","#main header h1","#main > header div.x78zum5 > div > div > div > div","#main header [data-testid=\"conversation-info-header-chat-title\"]","#main header"]},"menuVertical":{"model":"querySelector","selector":["#main ._amm9","#main .x1n2onr6.x1vjfegm.x1cqoux5.x14yy4lh"]},"menuHorizontal":{"model":"querySelector","selector":["#main > header > div.x1c4vz4f > div"]},"menuFooter":{"model":"querySelector","selector":["footer ._ak1m"]},"respostaRapida":{"model":"querySelector","selector":["footer > div"]},"footerTextArea":{"model":"querySelector","selector":["footer div[contenteditable=true]"]},"mainAudio":{"model":"querySelector","selector":["footer > div.copyable-area > div"]},"assChat":{"model":"querySelector","selector":["#main > div.x1n2onr6.x1vjfegm.x1cqoux5.x14yy4lh"]},"assInput":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div"]},"assBtn":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div > div:nth-child(6)"]},"assEmoji":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div._ak1m > div > button[tabindex='-1']"]},"assCitacao":{"model":"querySelector","selector":["footer div.x9f619.x1okw0bk > button > div > div > div:nth-child(1)"]},"listMensages":{"model":"querySelector","selector":["div[data-scrolltracepolicy='wa.web.conversation.messages']"]},"allMensages":{"model":"querySelectorAll","selector":["#main div > div[data-id]"]},"assistenteChat":{"model":"querySelector","selector":["#main > footer"]},"trasferidos":{"model":"querySelector","selector":["#side div[tabindex='-1']"]},"notification":{"model":"querySelector","selector":["#side > div:nth-child(2)"]},"quotedMsg":{"model":"querySelector","selector":["#main > footer > div.x10l6tqk.x13vifvy.x1o0tod.xh8yej3 > div > div > div > span > div"]},"listChats":{"model":"querySelector","selector":["#pane-side > div > div > div"]},"listChatsUsers":{"model":"querySelectorAll","selector":["#pane-side > div > div > div > div  div[aria-selected]","#pane-side > div > div > div div[role='button'] > div"]},"listChatAtendimento":{"model":"Element","selector":"div div[data-testid='cell-frame-secondary'] div[role='gridcell']"},"insertAtendente":{"model":"Element","selector":"x10l6tqk xh8yej3 x1g42fcv"},"reactFiberContainer":{"model":"listElement","list":{"reactFiber":"__reactFiber","reactFiberIndex":0,"path_user_id":".child.memoizedProps[1].props.id._serialized","path_key_message":".child.memoizedProps.children[0].key"}},"updateChatList":{"model":"querySelector","selector":["#side div._ai04 > button"]},"useTradutor":{"model":"listElement","list":{"main_audio_1":"div.x121pien.x9f619","main_audio_2":"div.x121pien.x9f619","camp_text_1":"row-translate","camp_text_2":"div > span","add_btn_tradutor":"div.x1c4vz4f.x1q0g3np.x6s0dn4","camp_audio_1":"div[role=\"slider\"] > canvas","camp_audio_2":"div.x1e4oeot.x1ui04y5[role=\"slider\"] > div"}},"chatList":{"model":"querySelector","selector":["#pane-side","#side","div.two > div:first-child","div.two > div._aigw"]},"observerFooter":{"model":"querySelector","selector":["#main > span:nth-child(8)","#main > :last-child"]},"observerFooterNewModel":{"model":"querySelector","selector":["#main > span:nth-child(7)","#main > span:nth-child(8)","#main > span:nth-child(9)"]},"whatsModal":{"model":"querySelector","selector":["#app > div > div > span:nth-child(3)"]},"menu_whats":{"model":"querySelector","selector":["#app > div > div.x78zum5.xdt5ytf.x5yr21d > div > header > div > div:nth-child(2) > div","header > div > div:nth-child(2) > div"]},"actionMonitor":{"model":"querySelector","selector":["#main header"]},"footerIconsLeft":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div"]},"side":{"model":"querySelector","selector":["#side"]},"chatFiltersContainer":{"model":"listElement","list":{"div_filters":"_akap _akan _arj9"}},"chatFilters":{"model":"querySelectorAll","selector":["#side > div:nth-of-type(3) button"]},"selector_theme":{"model":"querySelector","selector":[".os-win"]}};function loadDomDefaults() {
  return structuredClone(DOM_DEFAULTS);
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

async function refreshSettingsCache() {
  if (!db) return;
  try {
    cachedSettings = await db.collection(COL.settings).findOne({ _id: 'global' });
    configJsonBody = JSON.stringify(buildConfigJson(cachedSettings?.domConfig || {}));
  } catch (err) {
    console.error('[WaSpeed] refreshSettingsCache:', err.message);
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
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function connectMongo() {
  if (db && mongoReady) return db;
  try {
    mongoClient = new MongoClient(config.mongoUri, {
      maxPoolSize: 20,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
    });
    await mongoClient.connect();
    db = mongoClient.db(config.dbName);
    await ensureIndexes();
    return db;
  } catch (err) {
    db = null;
    mongoReady = false;
    console.error('[WaSpeed] connectMongo:', err.message);
    throw err;
  }
}

async function ensureIndexes() {
  if (!db) return;
  const specs = [
    { col: COL.licenses, key: { bearer: 1 }, opts: { unique: true } },
    { col: COL.licenses, key: { code: 1 }, opts: { unique: true } },
    { col: COL.sessions, key: { token: 1 }, opts: { unique: true } },
    { col: COL.sessions, key: { expiresAt: 1 }, opts: { expireAfterSeconds: 0 } },
    { col: COL.logs, key: { at: -1 }, opts: {} },
  ];
  for (const { col, key, opts } of specs) {
    try {
      await db.collection(col).createIndex(key, opts);
    } catch (err) {
      if (err.code === 85 || err.code === 86) continue;
      console.error(`[WaSpeed] ensureIndexes ${col}:`, err.message);
    }
  }
}async function initSeed() {
  if (!db) throw new Error('MongoDB nao conectado');
  try {
    const settingsCol = db.collection(COL.settings);
    let doc = await settingsCol.findOne({ _id: 'global' });
    if (!doc) {
      doc = {
        _id: 'global',
        installUrl: config.installUrl,
        notesHtml: '<h1>WaSpeed</h1><p>Servidor MongoDB ativo.</p>',
        webhooks: [],
        meet: {},
        urls: {},
        migration: {},
        domConfig: buildDomConfig(),
        nextUserId: 1000,
        mods: buildModsFromEnv(),
        admin: {
          username: config.adminUser,
          password: hashPassword(config.adminPass),
        },
      };
      await settingsCol.insertOne(doc);
      console.log('[WaSpeed] Settings inicializados (admin com hash pbkdf2)');
    }
    await syncCredentialsFromEnv();
    const count = await db.collection(COL.licenses).countDocuments();
    if (count === 0) {
      await createKey({ code: 'ws-demo-premium', label: 'Demo Premium', premium: true, note: 'Chave demo — troque em producao' });
      console.log('[WaSpeed] Chave demo: ws-demo-premium');
    }
    await refreshSettingsCache();
  } catch (err) {
    console.error('[WaSpeed] initSeed:', err.message);
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
      id: crypto.createHash('sha256').update(`waspeed-mod:${user}`).digest('hex').slice(0, 16),
      username: user,
      password: hashPassword(pass),
      name: user,
      active: true,
    });
  }
  if (mods.length) return mods;
  return [{
    id: crypto.randomBytes(8).toString('hex'),
    username: 'mod',
    password: hashPassword('mod123'),
    name: 'Moderador',
    active: true,
  }];
}

async function syncCredentialsFromEnv() {
  if (!db) return;
  try {
    const patch = {
      admin: {
        username: config.adminUser,
        password: hashPassword(config.adminPass),
      },
      mods: buildModsFromEnv(),
    };
    await db.collection(COL.settings).updateOne(
      { _id: 'global' },
      { $set: patch },
      { upsert: true },
    );
  } catch (err) {
    console.error('[WaSpeed] syncCredentialsFromEnv:', err.message);
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return `pbkdf2:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored?.startsWith('pbkdf2:')) return false;
  const rest = stored.slice(7);
  const sep = rest.indexOf(':');
  if (sep < 0) return false;
  const salt = rest.slice(0, sep);
  const hash = rest.slice(sep + 1);
  const check = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

async function getSettingsAdmin() {
  if (!db) return cachedSettings?.admin || null;
  try {
    const doc = await db.collection(COL.settings).findOne({ _id: 'global' }, { projection: { admin: 1 } });
    return doc?.admin || null;
  } catch (err) {
    return cachedSettings?.admin || null;
  }
}

async function verifyAdminCredentials(user, pass) {
  const u = String(user || '').trim();
  const p = String(pass || '');
  if (!u || !p) return false;
  if (u.toLowerCase() === config.adminUser.toLowerCase() && p === config.adminPass) {
    await syncCredentialsFromEnv();
    await refreshSettingsCache();
    return true;
  }
  const admin = await getSettingsAdmin();
  if (admin && u.toLowerCase() === String(admin.username || '').toLowerCase() && verifyPassword(p, admin.password)) {
    return true;
  }
  return false;
}async function verifyModCredentials(user, pass) {
  const u = String(user || '').trim();
  const p = String(pass || '');
  if (!u || !p) return null;
  for (const prefix of ['MOD', 'MOD2', 'MOD3', 'MOD4', 'MOD5', 'MOD6']) {
    const mu = envStr(`${prefix}_USER`);
    const mp = envStr(`${prefix}_PASS`);
    if (mu && mp && u.toLowerCase() === mu.toLowerCase() && p === mp) {
      await syncCredentialsFromEnv();
      await refreshSettingsCache();
      return { name: mu, modId: crypto.createHash('sha256').update(`waspeed-mod:${mu}`).digest('hex').slice(0, 16) };
    }
  }
  try {
    const doc = await db.collection(COL.settings).findOne({ _id: 'global' }, { projection: { mods: 1 } });
    const mod = (doc?.mods || []).find((m) => m.active !== false && u.toLowerCase() === String(m.username || '').toLowerCase());
    if (mod && verifyPassword(p, mod.password)) {
      return { name: mod.name || mod.username, modId: mod.id };
    }
  } catch (err) {
    console.error('[WaSpeed] verifyModCredentials:', err.message);
  }
  return null;
}

async function createSession(role, meta = {}) {
  if (!db) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  try {
    await db.collection(COL.sessions).insertOne({ token, role, ...meta, createdAt: new Date(), expiresAt });
    return { token, expiresAt };
  } catch (err) {
    return null;
  }
}

async function validateSession(token) {
  if (!token || !db) return null;
  try {
    return await db.collection(COL.sessions).findOne({ token, expiresAt: { $gt: new Date() } });
  } catch (err) {
    return null;
  }
}

async function destroySession(token) {
  if (!token || !db) return;
  try {
    await db.collection(COL.sessions).deleteOne({ token });
  } catch (err) {}
}

function setSessionCookie(res, token, maxAgeSec = 86400) {
  const secure = config.baseUrl.startsWith('https');
  const parts = [`ws_session=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  parts.push(`Max-Age=${maxAgeSec}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const secure = config.baseUrl.startsWith('https');
  const parts = ['ws_session=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

async function requireAdmin(req, res) {
  const token = parseCookies(req).ws_session;
  const sess = await validateSession(token);
  if (!sess || sess.role !== 'admin') {
    res.writeHead(302, { Location: `${R_ADMIN}/login` });
    res.end();
    return null;
  }
  return sess;
}

async function requireMod(req, res) {
  const token = parseCookies(req).ws_session;
  const sess = await validateSession(token);
  if (!sess || sess.role !== 'mod') {
    res.writeHead(302, { Location: `${R_MOD}/login` });
    res.end();
    return null;
  }
  return sess;
}

function normKey(raw) {
  return String(raw || '').trim().toLowerCase().slice(0, 48);
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
  if (isKeyExpired(rec)) return 'expired';
  return rec.premium ? 'active' : 'free';
}

async function findKey(code) {
  const k = normKey(code);
  if (!k || !db) return null;
  try {
    return await db.collection(COL.licenses).findOne({ code: k });
  } catch (err) {
    return null;
  }
}async function findKeyByBearer(bearer) {
  const b = String(bearer || '').trim();
  if (!b || !db) return null;
  try {
    return await db.collection(COL.licenses).findOne({
      $or: [{ bearer: b }, { code: normKey(b) }, { access_token_plugin: b }, { bearer_token: b }],
    });
  } catch (err) {
    return null;
  }
}

async function listLicenses(filter = {}) {
  if (!db) return [];
  try {
    return await db.collection(COL.licenses).find(filter).sort({ createdAt: -1 }).toArray();
  } catch (err) {
    return [];
  }
}

async function createKey(input = {}, modName = null) {
  if (!db) throw new Error('MongoDB indisponivel');
  const code = normKey(input.code) || generateKeyCode();
  const existing = await findKey(code);
  if (existing) throw new Error('Chave ja existe');

  let userId;
  try {
    const upd = await db.collection(COL.settings).findOneAndUpdate(
      { _id: 'global' },
      { $inc: { nextUserId: 1 } },
      { returnDocument: 'after' },
    );
    userId = upd?.nextUserId ? upd.nextUserId - 1 : 1000;
  } catch (err) {
    throw err;
  }

  const rec = {
    code,
    bearer: code,
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
  if (input.expiresAt) {
    rec.expiresAt = input.expiresAt;
  } else if (input.expireDays > 0) {
    rec.expiresAt = new Date(Date.now() + input.expireDays * 86400000).toISOString();
  }

  try {
    await db.collection(COL.licenses).insertOne(rec);
  } catch (err) {
    throw err;
  }
  await addLog('key_create', `Chave ${code} criada`, { code, modName });
  invalidatePanelKeysCache();
  return rec;
}

async function updateLicense(code, patch) {
  if (!db) return false;
  try {
    await db.collection(COL.licenses).updateOne({ code: normKey(code) }, { $set: patch });
    invalidatePanelKeysCache();
    return true;
  } catch (err) {
    return false;
  }
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
    user_id: String(rec.user_id),
    name: rec.label || 'Usuario',
    email: rec.email || `${code}@waspeed.local`,
    wl_id: config.wlId,
    bearer_token: rec.bearer_token || code,
    access_token_plugin: rec.access_token_plugin || code,
    user_premium: buildUserPremium(code, rec),
    dataCadastro: rec.createdAt || new Date().toISOString(),
    whatsapp_registro: rec.lastPhone || '',
    whatsapp_plugin: rec.lastPhone || '',
    path: '', afiliado: '', campanhaID: '', start_form: true,
    cookies: { _fbc: '', _fbp: '', _ga: '', _ttclid: '', _ttp: '' },
  };
}async function authSuccess(code, rec) {
  const st = keyStatus(rec);
  if (st === 'blocked') return { ok: false, msg_id: 'blocked' };
  if (st === 'expired') return { ok: false, msg_id: 'expired' };
  return { ok: true, body: { user: keyToUser(code, rec), status: st } };
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sendJson(res, data, status = 200) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, html, status = 200) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function addLog(type, message, meta = {}) {
  if (!db) return;
  try {
    await db.collection(COL.logs).insertOne({ type, message, meta, at: new Date().toISOString() });
    triggerLogTrim();
  } catch (err) {}
}

function triggerLogTrim() {
  if (_logTrimInProgress) return;
  _logTrimInProgress = true;
  setTimeout(async () => {
    try {
      if (db) {
        const col = db.collection(COL.logs);
        const total = await col.countDocuments();
        if (total > config.logMax + 50) {
          const skipAmt = config.logMax;
          const keepDocs = await col.find().sort({ at: -1 }).project({ _id: 1 }).skip(skipAmt).toArray();
          if (keepDocs.length > 0) {
            const ids = keepDocs.map((d) => d._id);
            await col.deleteMany({ _id: { $in: ids } });
          }
        }
      }
    } catch (e) {
    } finally {
      _logTrimInProgress = false;
    }
  }, 5000).unref();
}

async function getRecentLogs(limit = 100) {
  if (!db) return [];
  try {
    return await db.collection(COL.logs).find().sort({ at: -1 }).limit(limit).toArray();
  } catch (err) {
    return [];
  }
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
    });
  }
  return list;
}

function parseBearer(req) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 2 * 1024 * 1024) req.socket.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', (err) => reject(err));
  });
}

async function readJson(req) {
  try {
    const raw = await readBody(req);
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function formatDateYMD(d) {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const dStr = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${dStr}`;
}

function isKeyExpiringSoon(rec) {
  if (!rec.expiresAt) return false;
  const diff = new Date(rec.expiresAt).getTime() - Date.now();
  return diff > 0 && diff <= config.expiryWarnHours * 60 * 60 * 1000;
}function panelShell(title, body, navHtml = '', subtitle = '') {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${esc(title)} — WaSpeed Dashboard</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    :root{
      --bg:#030806;--surface:#0a1410;--surface-hover:#0f1f18;--border:#1a4032;
      --text:#eafff5;--muted:#6b9e82;--accent:#39ff14;--accent-dim:#00e676;
      --accent-grad:linear-gradient(135deg,#39ff14 0%,#00ff88 50%,#00cc66 100%);
      --ok-bg:#052e1a;--ok-text:#39ff14;--warn-bg:#2a2205;--warn-text:#fde047;
      --danger:#ff4466;--danger-bg:#2d0b11;--danger-text:#ff6685;
    }
    *{box-sizing:border-box;margin:0;padding:0;font-family:'Inter',sans-serif}
    body{background:var(--bg);color:var(--text);padding:24px 16px;min-height:100vh}
    .container{max-width:1200px;margin:0 auto}
    header{display:flex;justify-content:between;align-items:center;margin-bottom:24px;border-bottom:1px solid var(--border);padding-bottom:16px}
    .logo-area h1{font-size:1.4rem;font-weight:800;letter-spacing:-0.5px;color:var(--text)}
    .logo-area h1 span{background:var(--accent-grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .logo-sub{font-size:.78rem;color:var(--muted);margin-top:2px}
    nav{display:flex;gap:8px}
    .nav-link,.out-link{padding:8px 14px;border-radius:8px;font-size:.82rem;font-weight:500;text-decoration:none;transition:all .2s;color:var(--text);border:1px solid var(--border)}
    .nav-link:hover{background:var(--surface-hover);border-color:var(--accent-dim)}
    .out-link{border-color:rgba(255,68,102,.2);color:var(--danger-text)}
    .out-link:hover{background:var(--danger-bg)}
    .grid{display:grid;grid-template-columns:1fr;gap:16px;margin-bottom:16px}
    @media(min-width:768px){.grid{grid-template-columns:repeat(4,1fr)}}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;position:relative}
    .card-title{font-size:.72rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);font-weight:600}
    .card-val{font-size:1.6rem;font-weight:700;margin-top:6px;color:var(--text)}
    .alert{background:var(--warn-bg);border:1px solid #4a3e05;color:var(--warn-text);border-radius:10px;padding:12px;font-size:.82rem;margin-bottom:16px}
    .main-box{background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden}
    .sh{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--border)}
    .st{font-weight:700;font-size:.95rem}
    .gen-form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
    .gen-form input,.gen-form select{padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:#061008;color:var(--text);font-size:.85rem;outline:none}
    .gen-form input[type=number]{width:56px}
    .search-bar{display:flex;flex-wrap:wrap;gap:8px;padding:12px 18px;border-bottom:1px solid var(--border)}
    .search-bar input,.search-bar select{flex:1;min-width:140px;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:#061008;color:var(--text);outline:none}
    .ov{overflow-x:auto}
    table{width:100%;border-collapse:collapse;font-size:.82rem}
    th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--border)}
    th{cursor:pointer;color:var(--muted);font-size:.72rem;text-transform:uppercase;user-select:none;white-space:nowrap}
    th:hover{color:var(--accent)}
    tr.kr:hover{background:var(--surface-hover)}
    .act{display:flex;flex-wrap:wrap;gap:4px}
    .bs{padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:.72rem;cursor:pointer}
    .bs:hover{border-color:var(--accent);color:var(--accent)}
    .bs.bg{border-color:rgba(57,255,20,.3);color:var(--accent)}
    .bs.bd{border-color:rgba(255,68,102,.3);color:var(--danger-text)}
    .bp,.bcsv{padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:.8rem;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
    .bp{background:var(--accent-grad);color:#030806;border:none;font-weight:600}
    .badge{padding:3px 6px;border-radius:6px;font-size:.72rem;font-weight:600}
    .badge-ok{background:var(--ok-bg);color:var(--ok-text)}
    .badge-off{background:var(--danger-bg);color:var(--danger-text)}
    .badge-free{background:#111827;color:#9ca3af}
    #toast{position:fixed;bottom:20px;right:20px;background:var(--surface);border:1px solid var(--border);padding:12px 24px;border-radius:10px;font-size:.85rem;font-weight:500;box-shadow:0 10px 30px rgba(0,0,0,.5);transform:translateY(100px);opacity:0;transition:all .3s;z-index:9999}
    #toast.show{transform:translateY(0);opacity:1}
    #toast.err{border-color:var(--danger);color:var(--danger-text)}
    #toast.ok{border-color:var(--accent);color:var(--accent)}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-area">
        <h1>WaSpeed <span>v3.0</span></h1>
        <div class="logo-sub">${esc(subtitle || 'Painel de Gestao Local')}</div>
      </div>
      <nav>${navHtml}</nav>
    </header>
    ${body}
  </div>
  <div id="toast"></div>
</body>
</html>`;
}function loginShell(body, role) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Login — WaSpeed</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    body{background:#030806;color:#eafff5;font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
    .card{background:#0a1410;border:1px solid #1a4032;border-radius:16px;padding:32px;width:100%;max-width:400px;box-shadow:0 20px 40px rgba(0,0,0,.6)}
    h1{font-size:1.6rem;font-weight:800;letter-spacing:-0.5px;text-align:center}
    .subtitle{font-size:.8rem;color:#6b9e82;text-align:center;margin-top:4px;margin-bottom:24px;text-transform:uppercase;letter-spacing:1px;font-weight:600}
    .alert{background:#2d0b11;border:1px solid rgba(255,68,102,.2);color:#ff6685;border-radius:8px;padding:10px 12px;font-size:.82rem;margin-bottom:16px;text-align:center}
    .field{margin-bottom:16px}
    label{display:block;font-size:.75rem;font-weight:600;color:#6b9e82;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px}
    input{width:100%;padding:10px 14px;border-radius:8px;border:1px solid #1a4032;background:#061008;color:#eafff5;font-size:.9rem;outline:none;transition:border-color .2s}
    input:focus{border-color:#39ff14}
    .btn{width:100%;padding:12px;border-radius:8px;border:none;background:linear-gradient(135deg,#39ff14 0%,#00ff88 100%);color:#030806;font-weight:700;font-size:.9rem;cursor:pointer;margin-top:8px;transition:opacity .2s}
    .btn:hover{opacity:.95}
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

function renderLogin(base, role, err = '') {
  const body = `<div class="card">
    <h1>WaSpeed</h1>
    <p class="subtitle">Painel de Acesso — ${esc(role)}</p>
    ${err ? `<div class="alert">${esc(err)}</div>` : ''}
    <form method="post" action="${base}/login">
      <div class="field"><label>Usuario</label><input name="user" required autocomplete="username" placeholder="Seu usuario"></div>
      <div class="field"><label>Senha</label><input name="pass" type="password" required autocomplete="current-password" placeholder="Sua senha"></div>
      <button class="btn" type="submit">Acessar Sistema</button>
    </form>
  </div>`;
  return loginShell(body, role);
}

function panelStatusKey(k) {
  if (!k.active) return 'blocked';
  if (isKeyExpired(k)) return 'expired';
  return k.premium ? 'active' : 'free';
}

function panelStatusBadge(st) {
  if (st === 'active') return '<span class="badge badge-ok">Premium</span>';
  if (st === 'blocked') return '<span class="badge badge-off">Bloqueado</span>';
  if (st === 'expired') return '<span class="badge badge-off">Expirado</span>';
  return '<span class="badge badge-free">Free</span>';
}

function licenseValidityLabel(rec) {
  if (!rec.expiresAt) return '<span>Sem limite</span>';
  const exp = new Date(rec.expiresAt);
  const txt = exp.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  if (isKeyExpired(rec)) return `<span style="color:var(--danger)">Expirada · ${esc(txt)}</span>`;
  if (isKeyExpiringSoon(rec)) return `<span style="color:#ffb347">⏰ ${esc(txt)}</span>`;
  return esc(txt);
}

function buildLicenseTableRows(licenses) {
  return licenses.map((k) => {
    const code = k.code;
    const st = panelStatusKey(k);
    const maxU = k.maxUses ?? -1;
    const countUses = (k.phones || []).length;
    const displayMax = maxU === -1 ? '∞' : maxU;
    return `<tr class="kr" data-code="${esc(code)}" data-label="${esc((k.label || '').toLowerCase())}" data-status="${st}" data-validity="${k.expiresAt || ''}" data-uses="${countUses}" data-phone="${esc(k.lastPhone || '')}" data-lastused="${k.lastUsed || ''}" data-created="${k.createdAt || ''}">
      <td><strong style="color:var(--accent);font-family:monospace;font-size:.9rem">${esc(code)}</strong></td>
      <td>${esc(k.label || 'Cliente')}</td>
      <td>${panelStatusBadge(st)}</td>
      <td>${countUses}/${displayMax}</td>
      <td><span style="font-family:monospace">${esc(k.lastPhone || '—')}</span></td>
      <td>${licenseValidityLabel(k)}</td>
      <td>
        <div class="act">
          <button class="bs bg" onclick="toggleKey('${esc(code)}')">${k.active ? 'Bloquear' : 'Desbloquear'}</button>
          <button class="bs" onclick="renewKey('${esc(code)}')">+30d</button>
          <button class="bs bd" onclick="deleteKey('${esc(code)}')">Excluir</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}async function getPanelKeyStats() {
  const licenses = await listLicenses();
  let activeKeys = 0, freeKeys = 0, blockedKeys = 0, expiredKeys = 0, warnKeys = 0;
  for (const k of licenses) {
    const st = panelStatusKey(k);
    if (st === 'active') activeKeys++;
    else if (st === 'free') freeKeys++;
    else if (st === 'blocked') blockedKeys++;
    else if (st === 'expired') expiredKeys++;
    if (isKeyExpiringSoon(k)) warnKeys++;
  }
  const logCount = db ? await db.collection(COL.logs).countDocuments() : 0;
  return { totalKeys: licenses.length, activeKeys, freeKeys, blockedKeys, expiredKeys, warnKeys, totalLogs: logCount };
}

function buildPanelLogsHtml(logs) {
  if (!logs.length) return '<tr><td colspan="3" style="text-align:center;color:var(--muted)">Nenhum evento registrado</td></tr>';
  return logs.map((l) => `<tr data-log="${esc((l.type + ' ' + l.message).toLowerCase())}">
    <td style="color:var(--muted);white-space:nowrap;font-size:.78rem">${esc(new Date(l.at).toLocaleString('pt-BR'))}</td>
    <td><span class="badge" style="background:#111827;color:var(--muted);border:1px solid var(--border)">${esc(l.type)}</span></td>
    <td style="color:#d1fae5;font-size:.8rem">${esc(l.message)}</td>
  </tr>`).join('');
}

function parseLicenseExpiry(body) {
  let expiresAt = null;
  let expireDays = 0;
  if (body.expireDays > 0) {
    expireDays = parseInt(body.expireDays, 10);
  } else if (body.expireHours > 0) {
    expiresAt = new Date(Date.now() + parseInt(body.expireHours, 10) * 3600000).toISOString();
  } else if (body.expireMinutes > 0) {
    expiresAt = new Date(Date.now() + parseInt(body.expireMinutes, 10) * 60000).toISOString();
  } else {
    expireDays = 30;
  }
  return { expiresAt, expireDays };
}

let _panelKeysHtmlCache = null;
let _panelKeysHtmlTs = 0;
const PANEL_KEYS_CACHE_MS = 15000;

function invalidatePanelKeysCache() {
  _panelKeysHtmlCache = null;
  _panelKeysHtmlTs = 0;
}

function renderAdminSpa(keysHtml, logsHtml, stats) {
  const navHtml = `<a href="${R_ADMIN}/logout" class="out-link">Sair</a>`;
  const body = `
  <div class="grid">
    <div class="card"><div class="card-title">Total de Chaves</div><div class="card-val" id="st-total">${stats.totalKeys}</div></div>
    <div class="card"><div class="card-title">Ativas / Premium</div><div class="card-val" id="st-active" style="color:var(--accent)">${stats.activeKeys}</div></div>
    <div class="card"><div class="card-title">Expiradas / Alertas</div><div class="card-val" id="st-warn" style="color:#fde047">${stats.expiredKeys} / ${stats.warnKeys}</div></div>
    <div class="card"><div class="card-title">Logs Recentes</div><div class="card-val" id="st-logs">${stats.totalLogs}</div></div>
  </div>
  
  <div class="main-box" style="margin-bottom:20px">
    <div class="sh"><div class="st">Gerar Nova Licenca</div></div>
    <div style="padding:18px">
      <div class="gen-form">
        <div style="flex:2;min-width:200px"><label>Nome do Cliente / Identificador</label><input type="text" id="nlabel" placeholder="Ex: Joao Silva - Comercial"></div>
        <div style="width:100px"><label>Validade</label><input type="number" id="ndays" value="30" placeholder="Dias"></div>
        <div style="width:90px"><label>Limite Dispositivos</label><input type="number" id="nuses" value="1" placeholder="Ex: 1"></div>
        <div style="width:110px"><label>Nivel</label><select id="npremium"><option value="1">Premium</option><option value="0">Free</option></select></div>
        <button class="bp" onclick="generateKey()">Criar Chave</button>
      </div>
    </div>
  </div>

  <div class="main-box" style="margin-bottom:20px">
    <div class="sh">
      <div class="st">Licencas Registradas</div>
      <div><a class="bcsv" href="#" onclick="downloadCsv();return false;">Exportar CSV</a></div>
    </div>
    <div class="search-bar">
      <input type="text" id="search-input" oninput="filterKeys()" placeholder="Buscar por chave, cliente ou telefone...">
      <select id="filter-status" onchange="filterKeys()"><option value="">Todos os status</option><option value="active">Premium Ativo</option><option value="expired">Expirado</option><option value="blocked">Bloqueado</option></select>
    </div>
    <div class="ov">
      <table>
        <thead><tr><th onclick="sortKeys('code')">Chave</th><th onclick="sortKeys('label')">Cliente</th><th>Status</th><th>Usos</th><th>Ultimo Fone</th><th onclick="sortKeys('validity')">Validade</th><th>Acoes</th></tr></thead>
        <tbody id="kb">${keysHtml}</tbody>
      </table>
    </div>
  </div>

  <div class="main-box">
    <div class="sh"><div class="st">Logs de Atividades Globais</div><input type="text" id="logSearch" oninput="filterLog()" placeholder="Filtrar logs..." style="padding:6px 12px;border-radius:6px;border:1px solid var(--border);background:#030806;color:#fff;font-size:.8rem;outline:none"></div>
    <div class="ov" style="max-height:260px;overflow-y:auto"><table style="background:#040a08"><tbody id="logb">${logsHtml}</tbody></table></div>
  </div>

  <script>
    const _RA = "${R_ADMIN}";
    let _sortCol='', _sortDir=1;
    function toast(m,o=true){const t=document.getElementById('toast');t.textContent=m;t.className='show '+(o?'ok':'err');setTimeout(()=>t.className='',3500);}
    function filterKeys(){const q=(document.getElementById('search-input').value||'').toLowerCase();const st=document.getElementById('filter-status').value;document.querySelectorAll('#kb tr.kr').forEach(r=>{const s=(r.dataset.code+r.dataset.label+r.dataset.phone).toLowerCase();r.style.display=(!q||s.includes(q))&&(!st||r.dataset.status===st)?'':'none';});}
    function filterLog(){const q=(document.getElementById('logSearch').value||'').toLowerCase();document.querySelectorAll('#logb tr').forEach(r=>{r.style.display=!q||r.dataset.log.includes(q)?'':'none';});}
    function sortKeys(c){if(_sortCol===c)_sortDir*=-1;else{_sortCol=c;_sortDir=1;}const tb=document.getElementById('kb');const rows=[...tb.querySelectorAll('tr.kr')];rows.sort((a,b)=>{let va=a.dataset[c]||'',vb=b.dataset[c]||'';if(c==='uses'){va=+va;vb=+vb;return(va-vb)*_sortDir;}return va.localeCompare(vb)*_sortDir;});rows.forEach(r=>tb.appendChild(r));}
    async function refreshData(){const r=await fetch(_RA+'/api/data');if(r.ok){const d=await r.json();document.getElementById('kb').innerHTML=d.keysHtml;document.getElementById('logb').innerHTML=d.logsHtml;document.getElementById('st-total').textContent=d.totalKeys;document.getElementById('st-active').textContent=d.activeKeys;document.getElementById('st-warn').textContent=d.expiredKeys+' / '+d.warnKeys;document.getElementById('st-logs').textContent=d.totalLogs;filterKeys();}}
    async function generateKey(){const l=document.getElementById('nlabel').value.trim();if(!l){toast('Informe o cliente',false);return;}const body={label:l,premium:document.getElementById('npremium').value==='1',expireDays:+document.getElementById('ndays').value||0,maxUses:+document.getElementById('nuses').value||-1};const r=await fetch(_RA+'/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(r.ok){toast('Licenca gerada com sucesso');document.getElementById('nlabel').value='';refreshData();}else{const e=await r.json();toast(e.error||'Erro',false);}}
    async function toggleKey(c){const r=await fetch(_RA+'/api/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c})});if(r.ok){toast('Status alterado');refreshData();}}
    async function renewKey(c){const r=await fetch(_RA+'/api/renew',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c,days:30})});if(r.ok){toast('Licenca renovada por 30 dias');refreshData();}}
    async function deleteKey(c){if(!confirm('Deseja excluir permanentemente a chave '+c+'?'))return;const r=await fetch(_RA+'/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c})});if(r.ok){toast('Chave excluida');refreshData();}}
    function downloadCsv(){window.location.href=_RA+'/api/csv';}
    setInterval(refreshData, 20000);
  </script>
  `;
  return panelShell('Administracao Central', body, navHtml, 'Modulo de Controle Supremo');
}function renderModSpa(modName, keysHtml, stats) {
  const navHtml = `<a href="${R_MOD}/logout" class="out-link">Sair</a>`;
  const body = `
  <div class="grid" style="grid-template-columns:1fr 1fr;max-width:600px;margin-bottom:20px">
    <div class="card"><div class="card-title">Minhas Chaves Criadas</div><div class="card-val">${stats.totalKeys}</div></div>
    <div class="card"><div class="card-title">Minhas Chaves Ativas</div><div class="card-val" style="color:var(--accent)">${stats.activeKeys}</div></div>
  </div>

  <div class="main-box" style="margin-bottom:20px">
    <div class="sh"><div class="st">Gerar Chave de Ativacao</div></div>
    <div style="padding:18px">
      <div class="gen-form">
        <div style="flex:2;min-width:240px"><label>Cliente</label><input type="text" id="nlabel" placeholder="Nome do cliente"></div>
        <div style="width:120px"><label>Validade (Dias)</label><input type="number" id="ndays" value="30"></div>
        <button class="bp" onclick="generateKey()">Gerar Licenca</button>
      </div>
    </div>
  </div>

  <div class="main-box">
    <div class="sh"><div class="st">Minhas Licencas Emitidas</div></div>
    <div class="search-bar">
      <input type="text" id="search-input" oninput="filterKeys()" placeholder="Filtrar minhas chaves...">
    </div>
    <div class="ov">
      <table>
        <thead><tr><th>Chave</th><th>Cliente</th><th>Status</th><th>Usos</th><th>Ultimo Fone</th><th>Validade</th><th>Acoes</th></tr></thead>
        <tbody id="kb">${keysHtml}</tbody>
      </table>
    </div>
  </div>

  <script>
    const _RM = "${R_MOD}";
    function toast(m,o=true){const t=document.getElementById('toast');t.textContent=m;t.className='show '+(o?'ok':'err');setTimeout(()=>t.className='',3500);}
    function filterKeys(){const q=(document.getElementById('search-input').value||'').toLowerCase();document.querySelectorAll('#kb tr.kr').forEach(r=>{const s=(r.dataset.code+r.dataset.label+r.dataset.phone).toLowerCase();r.style.display=!q||s.includes(q)?'':'none';});}
    async function refreshData(){const r=await fetch(_RM+'/api/data');if(r.ok){const d=await r.json();document.getElementById('kb').innerHTML=d.keysHtml;filterKeys();}}
    async function generateKey(){const l=document.getElementById('nlabel').value.trim();if(!l){toast('Informe o cliente',false);return;}const r=await fetch(_RM+'/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:l,expireDays:+document.getElementById('ndays').value||30})});if(r.ok){toast('Licenca emitida');document.getElementById('nlabel').value='';refreshData();}else{const e=await r.json();toast(e.error||'Erro',false);}}
    async function toggleKey(c){const r=await fetch(_RM+'/api/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c})});if(r.ok){toast('Status atualizado');refreshData();}}
    async function renewKey(c){const r=await fetch(_RM+'/api/renew',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c,days:30})});if(r.ok){toast('Licenca estendida');refreshData();}}
    async function deleteKey(c){if(!confirm('Excluir chave '+c+'?'))return;const r=await fetch(_RM+'/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c})});if(r.ok){toast('Chave removida');refreshData();}}
  </script>
  `;
  return panelShell('Painel do Distribuidor', body, navHtml, 'Espaco do Moderador: ' + esc(modName));
}

function adminApiPathRegex(suffix) {
  return new RegExp(`^${R_ADMIN.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}${suffix}$`);
}async function handleAdminApi(req, res, pathname, ip) {
  if (pathname === R_ADMIN + '/api/data' && req.method === 'GET') {
    const licenses = await listLicenses();
    const stats = await getPanelKeyStats();
    const keysHtml = buildLicenseTableRows(licenses);
    const logs = await getRecentLogs(60);
    const logsHtml = buildPanelLogsHtml(logs);
    return sendJson(res, { ok: true, keysHtml, logsHtml, ...stats });
  }

  if (pathname === R_ADMIN + '/api/keys' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.label?.trim()) return sendJson(res, { error: 'label obrigatorio' }, 400);
    const { expiresAt, expireDays } = parseLicenseExpiry(body);
    const maxUses = body.maxUses !== undefined ? parseInt(body.maxUses, 10) : -1;
    try {
      const rec = await createKey({
        label: String(body.label).trim().slice(0, 60),
        premium: body.premium !== false && body.premium !== 0 && body.premium !== '0',
        expiresAt,
        expireDays,
        maxUses: Number.isNaN(maxUses) ? -1 : maxUses,
        note: String(body.note || '').slice(0, 500),
      });
      invalidatePanelKeysCache();
      return sendJson(res, { ok: true, key: rec.code });
    } catch (e) {
      return sendJson(res, { error: e.message }, 500);
    }
  }

  if (pathname === R_ADMIN + '/api/toggle' && req.method === 'POST') {
    const body = await readJson(req);
    const rec = await findKey(body.code);
    if (!rec) return sendJson(res, { error: 'not found' }, 404);
    await updateLicense(rec.code, { active: !rec.active });
    await addLog('key_toggle', `Status alterado para chave: ${rec.code} (Ativo: ${!rec.active})`, { ip });
    invalidatePanelKeysCache();
    return sendJson(res, { ok: true, active: !rec.active });
  }

  if (pathname === R_ADMIN + '/api/renew' && req.method === 'POST') {
    const body = await readJson(req);
    const rec = await findKey(body.code);
    if (!rec) return sendJson(res, { error: 'not found' }, 404);
    const days = parseInt(body.days || 30, 10);
    let current = rec.expiresAt ? new Date(rec.expiresAt).getTime() : Date.now();
    if (current < Date.now()) current = Date.now();
    const nextExp = new Date(current + days * 86400000).toISOString();
    await updateLicense(rec.code, { expiresAt: nextExp });
    await addLog('key_renew', `Chave ${rec.code} renovada por ${days} dias`, { ip });
    invalidatePanelKeysCache();
    return sendJson(res, { ok: true, expiresAt: nextExp });
  }

  if (pathname === R_ADMIN + '/api/delete' && req.method === 'POST') {
    const body = await readJson(req);
    const rec = await findKey(body.code);
    if (!rec) return sendJson(res, { error: 'not found' }, 404);
    await db.collection(COL.licenses).deleteOne({ code: rec.code });
    await addLog('key_delete', `Chave ${rec.code} permanentemente removida`, { ip });
    invalidatePanelKeysCache();
    return sendJson(res, { ok: true });
  }

  if (pathname === R_ADMIN + '/api/csv' && req.method === 'GET') {
    const licenses = await listLicenses();
    const lines = [['Chave', 'Cliente', 'Status', 'Usos Max', 'Fones Vinculados', 'Ultimo Fone', 'Ultimo IP', 'Criado Em', 'Notas']];
    for (const k of licenses) {
      lines.push([
        k.code, k.label || 'Cliente', panelStatusKey(k), k.maxUses ?? -1,
        (k.phones || []).join('; '), k.lastPhone || '', k.lastIp || '', k.createdAt || '',
        (k.note || '').replace(/,/g, ';'),
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    const csv = lines.join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="waspeed-licenses.csv"' });
    res.end('\ufeff' + csv);
    return true;
  }
  return false;
}async function handleAdmin(req, res, pathname, ip) {
  if (pathname === R_ADMIN + '/login') {
    if (req.method === 'GET') return sendHtml(res, renderLogin(R_ADMIN, 'Administrador'));
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const user = params.get('user');
    const pass = params.get('pass');
    if (await verifyAdminCredentials(user, pass)) {
      const session = await createSession('admin', { user: user.trim() });
      if (!session) return sendHtml(res, renderLogin(R_ADMIN, 'Administrador', 'Erro de sessao'), 500);
      setSessionCookie(res, session.token);
      await addLog('admin_login', `Admin logado com sucesso`, { ip });
      res.writeHead(302, { Location: R_ADMIN });
      return res.end();
    }
    await addLog('admin_login_fail', `Falha de autenticacao de Admin`, { ip, user });
    return sendHtml(res, renderLogin(R_ADMIN, 'Administrador', 'Credenciais invalidas'), 401);
  }

  if (pathname === R_ADMIN + '/logout') {
    const token = parseCookies(req).ws_session;
    await destroySession(token);
    clearSessionCookie(res);
    res.writeHead(302, { Location: R_ADMIN + '/login' });
    return res.end();
  }

  const sess = await requireAdmin(req, res);
  if (!sess) return;

  const handled = await handleAdminApi(req, res, pathname, ip);
  if (handled) return;

  if (pathname === R_ADMIN || pathname === R_ADMIN + '/') {
    const licenses = await listLicenses();
    const stats = await getPanelKeyStats();
    const keysHtml = buildLicenseTableRows(licenses);
    const logs = await getRecentLogs(60);
    const logsHtml = buildPanelLogsHtml(logs);
    return sendHtml(res, renderAdminSpa(keysHtml, logsHtml, stats));
  }
  res.writeHead(404);
  res.end('Not Found');
}

async function handleModApi(req, res, pathname, sess) {
  const modName = sess.name;
  if (pathname === R_MOD + '/api/data' && req.method === 'GET') {
    const all = await listLicenses({ modName });
    const activeKeys = all.filter((k) => panelStatusKey(k) === 'active').length;
    const keysHtml = buildLicenseTableRows(all);
    return sendJson(res, { ok: true, totalKeys: all.length, activeKeys, keysHtml });
  }

  if (pathname === R_MOD + '/api/keys' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.label?.trim()) return sendJson(res, { error: 'label obrigatorio' }, 400);
    const { expiresAt, expireDays } = parseLicenseExpiry(body);
    try {
      const rec = await createKey({ label: String(body.label).trim().slice(0, 60), premium: true, expiresAt, expireDays, maxUses: 1 }, modName);
      return sendJson(res, { ok: true, key: rec.code });
    } catch (e) {
      return sendJson(res, { error: e.message }, 500);
    }
  }

  if (pathname === R_MOD + '/api/toggle' && req.method === 'POST') {
    const body = await readJson(req);
    const rec = await findKey(body.code);
    if (!rec || rec.modName !== modName) return sendJson(res, { error: 'not found' }, 404);
    await updateLicense(rec.code, { active: !rec.active });
    return sendJson(res, { ok: true, active: !rec.active });
  }

  if (pathname === R_MOD + '/api/renew' && req.method === 'POST') {
    const body = await readJson(req);
    const rec = await findKey(body.code);
    if (!rec || rec.modName !== modName) return sendJson(res, { error: 'not found' }, 404);
    const days = parseInt(body.days || 30, 10);
    let current = rec.expiresAt ? new Date(rec.expiresAt).getTime() : Date.now();
    if (current < Date.now()) current = Date.now();
    const nextExp = new Date(current + days * 86400000).toISOString();
    await updateLicense(rec.code, { expiresAt: nextExp });
    return sendJson(res, { ok: true, expiresAt: nextExp });
  }

  if (pathname === R_MOD + '/api/delete' && req.method === 'POST') {
    const body = await readJson(req);
    const rec = await findKey(body.code);
    if (!rec || rec.modName !== modName) return sendJson(res, { error: 'not found' }, 404);
    await db.collection(COL.licenses).deleteOne({ code: rec.code });
    return sendJson(res, { ok: true });
  }
  return false;
}async function handleMod(req, res, pathname, ip) {
  if (pathname === R_MOD + '/login') {
    if (req.method === 'GET') return sendHtml(res, renderLogin(R_MOD, 'Moderador'));
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const user = params.get('user');
    const pass = params.get('pass');
    const mod = await verifyModCredentials(user, pass);
    if (mod) {
      const session = await createSession('mod', { user: user.trim(), modId: mod.modId, name: mod.name });
      if (!session) return sendHtml(res, renderLogin(R_MOD, 'Moderador', 'Erro ao criar sessao'), 500);
      setSessionCookie(res, session.token);
      res.writeHead(302, { Location: R_MOD });
      return res.end();
    }
    return sendHtml(res, renderLogin(R_MOD, 'Moderador', 'Credenciais invalidas'), 401);
  }

  if (pathname === R_MOD + '/logout') {
    const token = parseCookies(req).ws_session;
    await destroySession(token);
    clearSessionCookie(res);
    res.writeHead(302, { Location: R_MOD + '/login' });
    return res.end();
  }

  const sess = await requireMod(req, res);
  if (!sess) return;
  const modName = sess.name;

  if (await handleModApi(req, res, pathname, sess)) return;

  if (pathname === R_MOD || pathname === R_MOD + '/') {
    const all = await listLicenses({ modName });
    const keysHtml = buildLicenseTableRows(all);
    const stats = { totalKeys: all.length, activeKeys: all.filter((k) => panelStatusKey(k) === 'active').length };
    return sendHtml(res, renderModSpa(modName, keysHtml, stats));
  }
  res.writeHead(404);
  res.end('Not Found');
}

async function handleClientPanel(req, res, pathname, url) {
  if (pathname === '/api/user/login' && req.method === 'POST') {
    const body = await readJson(req);
    const key = normKey(body.senha || body.chave || body.email || body.access_token_plugin);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const rec = await findKey(key);
    if (!rec) {
      await addLog('auth_fail', 'Login chave invalida', { ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token' });
    }
    const result = await authSuccess(key, rec);
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('auth_ok', `Login efetuado para chave: ${key}`, { ip });
    return sendJson(res, result.body);
  }

  if (pathname === '/api/user/update' && req.method === 'POST') {
    const body = await readJson(req);
    const bearer = parseBearer(req) || body.bearer_token;
    const rec = await findKeyByBearer(bearer);
    if (!rec) return sendJson(res, { success: false, msg_id: 'invalid_token' });
    const patch = {};
    if (body.whatsapp_plugin || body.whatsapp_registro) {
      patch.lastPhone = body.whatsapp_plugin || body.whatsapp_registro;
    }
    if (body.whatsapp_plugin && !rec.phones.includes(body.whatsapp_plugin)) {
      const list = [...rec.phones];
      if (rec.maxUses === -1 || list.length < rec.maxUses) {
        list.push(body.whatsapp_plugin);
        patch.phones = list;
      } else {
        return sendJson(res, { success: false, msg_id: 'max_devices_reached' }, 403);
      }
    }
    patch.lastUsed = new Date().toISOString();
    patch.lastIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    await updateLicense(rec.code, patch);
    return sendJson(res, { success: true, user: keyToUser(rec.code, { ...rec, ...patch }) });
  }
  return false;
}async function handleRequest(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  
  const pathParts = pathname.split('/').filter(Boolean);
  if (pathParts.length === 2 && pathParts[1] === 'auth-painel') {
      const extensionId = pathParts[0];
      
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
          <meta charset="UTF-8">
          <title>WaSpeed - Painel do Cliente</title>
          <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
          <style>
              body { background: #0f0f13; color: #e1e1e6; font-family: 'Segoe UI', sans-serif; }
              .card-panel { background: #181820; border: 1px solid #282834; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
              .btn-gradient { background: linear-gradient(135deg, #00b4db, #0083b0); color: white; border: none; font-weight: 600; }
          </style>
      </head>
      <body class="d-flex align-items-center min-vh-100">
          <div class="container">
              <div class="row justify-content-center">
                  <div class="col-md-6 col-lg-5">
                      <div class="card card-panel p-4 text-center">
                          <h2 class="fw-bold text-white mb-1">WaSpeed <span class="text-info" style="font-size: 1rem;">v3.0</span></h2>
                          <p class="text-muted small">Autenticação do Dispositivo</p>
                          
                          <div id="authBox">
                              <div class="form-floating mb-3">
                                  <input type="text" class="form-control bg-dark text-white border-secondary" id="licenseKey" placeholder="Sua Chave">
                                  <label for="licenseKey" class="text-muted">Chave de Licença</label>
                              </div>
                              <button id="btnVerify" class="w-100 btn btn-gradient py-3 rounded-3 mb-2">Verificar e Vincular</button>
                          </div>

                          <div id="statusBox" class="mt-3 d-none">
                              <div class="alert alert-dark border-secondary bg-opacity-10 text-start">
                                  <p class="mb-1 small"><strong>Status:</strong> <span class="badge bg-success">Ativo / Vinculado</span></p>
                                  <p class="mb-0 small text-muted text-truncate"><strong>ID:</strong> ${extensionId}</p>
                              </div>
                          </div>
                          <div id="msgResponse" class="mt-3 small"></div>
                      </div>
                  </div>
              </div>
          </div>
          <script>
              const extId = "${extensionId}";
              const btn = document.getElementById('btnVerify');
              const keyInput = document.getElementById('licenseKey');
              const msg = document.getElementById('msgResponse');

              if(localStorage.getItem('waspeed_token')) {
                  document.getElementById('statusBox').classList.remove('d-none');
              }

              btn.addEventListener('click', async () => {
                  const key = keyInput.value.trim();
                  if(!key) return;
                  try {
                      const res = await fetch('/api/user/login', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ key, token: extId })
                      });
                      const data = await res.json();
                      if(data.success) {
                          localStorage.setItem('waspeed_token', extId);
                          location.reload();
                      } else {
                          msg.innerHTML = '<span class="text-danger">' + (data.message || 'Erro') + '</span>';
                      }
                  } catch(e) { msg.innerHTML = '<span class="text-danger">Erro de conexão</span>'; }
              });
          </script>
      </body>
      </html>
      `);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-access-token');
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (!mongoReady) {
      await connectMongo();
      mongoReady = true;
    }

    if (pathname === '/config.json') {
      sendCachedConfigJson(res);
      return;
    }

    if (pathname === '/api/code') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return res.end('/* WaSpeed remote code stub — WPP injetado localmente pela extensao */\n');
    }

    if (pathname.startsWith(R_ADMIN)) {
      await handleAdmin(req, res, pathname, ip);
      return;
    }

    if (pathname.startsWith(R_MOD)) {
      await handleMod(req, res, pathname, ip);
      return;
    }

    if (await handleClientPanel(req, res, pathname, url)) return;

    if (pathname === '/' || pathname === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>WaSpeed Server Ativo</h1>');
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    console.error('[Server Error]:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
    }
  }
}

function antiSleep() {
  const url = `${config.baseUrl}/ping`;
  setInterval(() => {
    fetch(url, { signal: AbortSignal.timeout(10000) })
      .catch((e) => console.warn('[WS] ping anti-sleep:', e.message));
  }, ANTI_SLEEP_MS).unref();
}

async function shutdown(sig) {
  console.log(`[WaSpeed] ${sig} — encerrando`);
  mongoReady = false;
  try {
    if (mongoClient) await mongoClient.close();
  } catch (err) {}
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Bootstrap de Inicializacao Unificado
(async () => {
  try {
    await connectMongo();
    await initSeed();
    mongoReady = true;
  } catch (err) {
    console.error('[WaSpeed] Falha no bootstrap:', err.message);
    process.exit(1);
  }

  server = http.createServer(handleRequest);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  server.on('clientError', (err, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.listen(config.port, () => {
    console.log(`WaSpeed Server v3.0 ativo em: ${config.baseUrl}`);
    antiSleep();
  });
})();
