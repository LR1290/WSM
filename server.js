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
  console.error('[WaSpeed] Copie a URI real em MongoDB Atlas → Connect → Drivers → Node.js');
  process.exit(1);
}
if (config.adminPass === 'waspeed-admin-change-me') {
  console.warn('[WaSpeed] AVISO: ADMIN_PASS ainda e o default — altere no Render.');
}
console.log(`[WaSpeed] Config: port=${config.port} db=${config.dbName} url=${config.baseUrl}`);

const R_ADMIN = `/${config.adminPath}`;
const R_MOD = `/${config.modPath}`;

let mongoClient = null;
let db = null;
let mongoReady = false;
let cachedSettings = null;
let configJsonBody = null;
let server = null;

// --- DOM defaults ------------------------------------------------------------

const DOM_DEFAULTS = {"version":"1.11","update_path_active":"true","disabled_wait_sync":false,"wpp_mensagens":{"timer":"60000","enable_two_send":false},"newModel":{"model":"taghtml","parm":"body.color-refresh"},"app":{"model":"querySelector","selector":["#app"]},"afiliadoMain":{"model":"querySelector","selector":["body > div"]},"paneSide":{"model":"Element","selector":"#pane-side"},"waPage":{"model":"querySelector","selector":["div.two"]},"two":{"model":"Element","selector":"two"},"menuLateral":{"model":"querySelector","selector":["div.two > div:nth-child(5)"]},"closeChat":{"model":"Element","selector":"x10l6tqk"},"chatListInput":{"model":"querySelector","selector":[".lexical-rich-text-input > div"]},"searchInput":{"model":"querySelector","selector":["[data-icon='search']"]},"downAba":{"model":"querySelector","selector":["header > div > div > div > div > span > div > div:nth-child(1)","header > div._ak0w"]},"chatListHeader":{"model":"querySelector","selector":["header > header > div > span > div"]},"searchCamp":{"model":"querySelector","selector":["#side div[data-testid='chat-list-search-container']"]},"chatName":{"model":"querySelector","selector":["#main header span[title]","#main header div[role=\"button\"] span","#main header h1","#main > header div.x78zum5 > div > div > div > div","#main header [data-testid=\"conversation-info-header-chat-title\"]","#main header"]},"menuVertical":{"model":"querySelector","selector":["#main ._amm9","#main .x1n2onr6.x1vjfegm.x1cqoux5.x14yy4lh"]},"menuHorizontal":{"model":"querySelector","selector":["#main > header > div.x1c4vz4f > div"]},"menuFooter":{"model":"querySelector","selector":["footer ._ak1m"]},"respostaRapida":{"model":"querySelector","selector":["footer > div"]},"footerTextArea":{"model":"querySelector","selector":["footer div[contenteditable=true]"]},"mainAudio":{"model":"querySelector","selector":["footer > div.copyable-area > div"]},"assChat":{"model":"querySelector","selector":["#main > div.x1n2onr6.x1vjfegm.x1cqoux5.x14yy4lh"]},"assInput":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div"]},"assBtn":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div > div:nth-child(6)"]},"assEmoji":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div._ak1m > div > button[tabindex='-1']"]},"assCitacao":{"model":"querySelector","selector":["footer div.x9f619.x1okw0bk > button > div > div > div:nth-child(1)"]},"listMensages":{"model":"querySelector","selector":["div[data-scrolltracepolicy='wa.web.conversation.messages']"]},"allMensages":{"model":"querySelectorAll","selector":["#main div > div[data-id]"]},"assistenteChat":{"model":"querySelector","selector":["#main > footer"]},"trasferidos":{"model":"querySelector","selector":["#side div[tabindex='-1']"]},"notification":{"model":"querySelector","selector":["#side > div:nth-child(2)"]},"quotedMsg":{"model":"querySelector","selector":["#main > footer > div.x10l6tqk.x13vifvy.x1o0tod.xh8yej3 > div > div > div > span > div"]},"listChats":{"model":"querySelector","selector":["#pane-side > div > div > div"]},"listChatsUsers":{"model":"querySelectorAll","selector":["#pane-side > div > div > div > div  div[aria-selected]","#pane-side > div > div > div div[role='button'] > div"]},"listChatAtendimento":{"model":"Element","selector":"div div[data-testid='cell-frame-secondary'] div[role='gridcell']"},"insertAtendente":{"model":"Element","selector":"x10l6tqk xh8yej3 x1g42fcv"},"reactFiberContainer":{"model":"listElement","list":{"reactFiber":"__reactFiber","reactFiberIndex":0,"path_user_id":".child.memoizedProps[1].props.id._serialized","path_key_message":".child.memoizedProps.children[0].key"}},"updateChatList":{"model":"querySelector","selector":["#side div._ai04 > button"]},"useTradutor":{"model":"listElement","list":{"main_audio_1":"div.x121pien.x9f619","main_audio_2":"div.x121pien.x9f619","camp_text_1":"row-translate","camp_text_2":"div > span","add_btn_tradutor":"div.x1c4vz4f.x1q0g3np.x6s0dn4","camp_audio_1":"div[role=\"slider\"] > canvas","camp_audio_2":"div.x1e4oeot.x1ui04y5[role=\"slider\"] > div"}},"chatList":{"model":"querySelector","selector":["#pane-side","#side","div.two > div:first-child","div.two > div._aigw"]},"observerFooter":{"model":"querySelector","selector":["#main > span:nth-child(8)","#main > :last-child"]},"observerFooterNewModel":{"model":"querySelector","selector":["#main > span:nth-child(7)","#main > span:nth-child(8)","#main > span:nth-child(9)"]},"whatsModal":{"model":"querySelector","selector":["#app > div > div > span:nth-child(3)"]},"menu_whats":{"model":"querySelector","selector":["#app > div > div.x78zum5.xdt5ytf.x5yr21d > div > header > div > div:nth-child(2) > div","header > div > div:nth-child(2) > div"]},"actionMonitor":{"model":"querySelector","selector":["#main header"]},"footerIconsLeft":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div"]},"side":{"model":"querySelector","selector":["#side"]},"chatFiltersContainer":{"model":"listElement","list":{"div_filters":"_akap _akan _arj9"}},"chatFilters":{"model":"querySelectorAll","selector":["#side > div:nth-of-type(3) button"]},"selector_theme":{"model":"querySelector","selector":[".os-win"]}};

function loadDomDefaults() {
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

// --- MongoDB -----------------------------------------------------------------

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
}

async function initSeed() {
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
    console.log('[WaSpeed] Admin/mod sincronizados do .env');
  } catch (err) {
    console.error('[WaSpeed] syncCredentialsFromEnv:', err.message);
  }
}

// --- Seguranca (pbkdf2 + sessoes MongoDB) ------------------------------------

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
    console.error('[WaSpeed] getSettingsAdmin:', err.message);
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
        name: mu,
        modId: crypto.createHash('sha256').update(`waspeed-mod:${mu}`).digest('hex').slice(0, 16),
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
    console.error('[WaSpeed] verifyModCredentials:', err.message);
  }
  return null;
}

async function createSession(role, meta = {}) {
  if (!db) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  try {
    await db.collection(COL.sessions).insertOne({
      token,
      role,
      ...meta,
      createdAt: new Date(),
      expiresAt,
    });
    return { token, expiresAt };
  } catch (err) {
    console.error('[WaSpeed] createSession:', err.message);
    return null;
  }
}

async function validateSession(token) {
  if (!token || !db) return null;
  try {
    return await db.collection(COL.sessions).findOne({
      token,
      expiresAt: { $gt: new Date() },
    });
  } catch (err) {
    console.error('[WaSpeed] validateSession:', err.message);
    return null;
  }
}

async function destroySession(token) {
  if (!token || !db) return;
  try {
    await db.collection(COL.sessions).deleteOne({ token });
  } catch (err) {
    console.error('[WaSpeed] destroySession:', err.message);
  }
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

// --- Licencas ----------------------------------------------------------------

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
    console.error('[WaSpeed] findKey:', err.message);
    return null;
  }
}

async function findKeyByBearer(bearer) {
  const b = String(bearer || '').trim();
  if (!b || !db) return null;
  try {
    return await db.collection(COL.licenses).findOne({
      $or: [{ bearer: b }, { code: normKey(b) }, { access_token_plugin: b }, { bearer_token: b }],
    });
  } catch (err) {
    console.error('[WaSpeed] findKeyByBearer:', err.message);
    return null;
  }
}

async function listLicenses(filter = {}) {
  if (!db) return [];
  try {
    return await db.collection(COL.licenses).find(filter).sort({ createdAt: -1 }).toArray();
  } catch (err) {
    console.error('[WaSpeed] listLicenses:', err.message);
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
    console.error('[WaSpeed] createKey nextUserId:', err.message);
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
    console.error('[WaSpeed] createKey insert:', err.message);
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
    console.error('[WaSpeed] updateLicense:', err.message);
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
    console.error('[WaSpeed] deleteLicense:', err.message);
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
    label: 'Usuario Gratuito',
    premium: false,
    note: 'Registro free automatico',
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
  return {
    id_assinatura: String(rec.user_id || code),
    data_liberacao: dataLiberacao,
    teste: '0',
  };
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
    path: '',
    afiliado: '',
    campanhaID: '',
    start_form: true,
    cookies: { _fbc: '', _fbp: '', _ga: '', _ttclid: '', _ttp: '' },
  };
}

async function authSuccess(code, rec) {
  const st = keyStatus(rec);
  if (st === 'blocked') return { ok: false, msg_id: 'user_blocked' };
  if (st === 'expired') return { ok: false, msg_id: 'license_expired' };
  const lastUsed = new Date().toISOString();
  await updateLicense(code, { lastUsed });
  rec.lastUsed = lastUsed;
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
    console.error('[WaSpeed] addLog:', err.message);
  }
}

async function getRecentLogs(limit = 200) {
  if (!db) return [];
  try {
    return await db.collection(COL.logs).find({}).sort({ at: -1 }).limit(limit).toArray();
  } catch (err) {
    console.error('[WaSpeed] getRecentLogs:', err.message);
    return [];
  }
}

// --- Rate limit --------------------------------------------------------------

const RL = { login: { max: 10, windowMs: 60000, blockMs: 300000 } };
const rateMap = new Map();

function checkRate(ip) {
  const cfg = RL.login;
  const key = `${ip}:login`;
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
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const BLOCKED_URL_RE = /trackerdigital\.com\.br/i;

function isBlockedUrl(url) {
  return BLOCKED_URL_RE.test(String(url ?? ''));
}

function sanitizeUrls(value) {
  if (value == null) return value;
  if (typeof value === 'string') return isBlockedUrl(value) ? '' : value;
  if (Array.isArray(value)) return value.map(sanitizeUrls);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeUrls(v);
    return out;
  }
  return value;
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

function sendText(res, text, status = 200) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendError(res, status, msgId) {
  if (res.headersSent) return;
  sendJson(res, { success: false, msg_id: msgId }, status);
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

// --- UI (Neon Green) ---------------------------------------------------------

const PANEL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
:root{
  --bg:#030806;--surface:#0a1410;--surface-hover:#0f1f18;--border:#1a4032;
  --text:#eafff5;--muted:#6b9e82;--accent:#39ff14;--accent-dim:#00e676;
  --accent-grad:linear-gradient(135deg,#39ff14 0%,#00ff88 50%,#00cc66 100%);
  --ok-bg:#052e1a;--ok-text:#39ff14;--warn-bg:#2a2205;--warn-text:#fde047;
  --danger:#ff4466;--danger-bg:#2a0a10;--danger-text:#ff8899;
  --shadow:0 4px 32px rgba(0,0,0,.5);--ring:rgba(57,255,20,.35);
  --neon-glow:0 0 20px rgba(57,255,20,.25),0 0 40px rgba(0,255,136,.1);
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{
  font-family:'Inter',system-ui,-apple-system,sans-serif;
  background:var(--bg);color:var(--text);line-height:1.6;min-height:100vh;
  background-image:radial-gradient(ellipse 70% 55% at 50% -10%,rgba(57,255,20,.09),transparent),
    radial-gradient(ellipse 50% 40% at 80% 100%,rgba(0,255,136,.04),transparent);
}
a{color:var(--accent);text-decoration:none;transition:color .2s ease}
a:hover{color:#7fff6e;text-shadow:0 0 8px rgba(57,255,20,.4)}
.app{max-width:1100px;margin:0 auto;padding:28px 20px 56px}
.app--centered .page-head,.app--centered .metrics,.app--centered .card{text-align:center}
.app--centered .card .card-title{text-align:left}
.app--centered .key-list,.app--centered .log-list{text-align:left}
.topbar{
  display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:16px;
  padding:14px 24px;margin-bottom:28px;border-radius:14px;
  background:var(--surface);border:1px solid var(--border);box-shadow:var(--shadow);
}
.brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:1.1rem;letter-spacing:-.02em}
.brand-dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:var(--neon-glow)}
.nav{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.nav a,.nav .nav-link{
  color:var(--muted);font-size:.875rem;font-weight:500;padding:8px 14px;border-radius:8px;
  border:1px solid transparent;transition:all .2s ease-in-out;
}
.nav a:hover,.nav a.active{
  color:var(--accent);background:rgba(57,255,20,.06);border-color:rgba(57,255,20,.25);
  box-shadow:0 0 12px rgba(57,255,20,.12);
}
.page-head{margin-bottom:28px;text-align:center}
.page-head h1{font-size:1.85rem;font-weight:800;letter-spacing:-.03em;line-height:1.2;color:var(--text)}
.page-head .subtitle{color:var(--muted);font-size:.95rem;margin-top:8px}
.card{
  background:var(--surface);border:1px solid var(--border);border-radius:14px;
  padding:24px;margin-bottom:20px;box-shadow:var(--shadow);transition:border-color .2s ease,box-shadow .2s ease;
}
.card:hover{border-color:rgba(57,255,20,.3);box-shadow:var(--shadow),var(--neon-glow)}
.card-title{font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:12px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.metric{
  background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px 24px;
  transition:all .2s ease-in-out;text-align:center;
}
.metric:hover{transform:translateY(-2px);border-color:rgba(57,255,20,.35);box-shadow:var(--neon-glow)}
.metric-value{font-size:2.25rem;font-weight:800;letter-spacing:-.04em;line-height:1;margin-bottom:6px}
.metric-value.accent{color:var(--accent);text-shadow:0 0 16px rgba(57,255,20,.45)}
.metric-label{font-size:.8rem;color:var(--muted);font-weight:500}
.badge{
  display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;
  font-size:.7rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
}
.badge-ok{background:var(--ok-bg);color:var(--ok-text);border:1px solid rgba(57,255,20,.35);box-shadow:0 0 8px rgba(57,255,20,.15)}
.badge-off{background:var(--danger-bg);color:var(--danger-text);border:1px solid rgba(255,68,102,.25)}
.badge-free{background:var(--warn-bg);color:var(--warn-text);border:1px solid rgba(253,224,71,.2)}
.key-chip,code.key-chip{
  font-family:ui-monospace,'Cascadia Code',monospace;font-size:.82rem;
  background:#061008;border:1px solid rgba(57,255,20,.25);color:#7fff6e;
  padding:6px 12px;border-radius:8px;word-break:break-all;display:inline-block;
  box-shadow:0 0 10px rgba(57,255,20,.08);
}
.key-list{display:flex;flex-direction:column;gap:0}
.key-list-head{
  display:grid;grid-template-columns:1.4fr 1fr .7fr .9fr 1fr auto;gap:12px;
  padding:10px 16px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  border-bottom:1px solid var(--border);
}
.key-row{
  display:grid;grid-template-columns:1.4fr 1fr .7fr .9fr 1fr auto;gap:12px;align-items:center;
  padding:16px;border-bottom:1px solid var(--border);transition:background .2s ease;
}
.key-row:last-child{border-bottom:none}
.key-row:hover{background:var(--surface-hover)}
.key-row .actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.empty-state{text-align:center;padding:48px 24px;color:var(--muted)}
.log-list{display:flex;flex-direction:column;gap:0;max-height:70vh;overflow:auto}
.log-row{
  display:grid;grid-template-columns:160px 100px 1fr;gap:16px;padding:14px 16px;
  border-bottom:1px solid var(--border);font-size:.875rem;transition:background .2s ease;
}
.log-row:hover{background:var(--surface-hover)}
.log-type{font-family:monospace;font-size:.78rem;color:var(--accent-dim)}
label{display:block;font-size:.78rem;font-weight:600;color:var(--muted);margin:0 0 6px}
.field{margin-bottom:18px;text-align:left}
input,select,textarea{
  width:100%;padding:11px 14px;border-radius:8px;border:1px solid var(--border);
  background:#061008;color:var(--text);font:inherit;font-size:.9rem;
  transition:border-color .2s ease,box-shadow .2s ease;
}
input:focus,select:focus,textarea:focus{
  outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--ring),0 0 12px rgba(57,255,20,.15);
}
textarea{resize:vertical;min-height:80px}
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:10px 18px;border:none;border-radius:8px;font:inherit;font-size:.875rem;font-weight:600;
  cursor:pointer;text-decoration:none;color:#030806;background:var(--accent-grad);
  transition:all .2s ease-in-out;box-shadow:0 4px 18px rgba(57,255,20,.35);
}
.btn:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(57,255,20,.5);color:#030806}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text);box-shadow:none}
.btn-ghost:hover{background:rgba(57,255,20,.06);border-color:rgba(57,255,20,.35);color:var(--accent);box-shadow:0 0 12px rgba(57,255,20,.12)}
.btn-danger{background:linear-gradient(135deg,#cc0033,#ff4466);color:#fff;box-shadow:0 4px 14px rgba(255,68,102,.3)}
.btn-sm{padding:6px 12px;font-size:.78rem;border-radius:6px}
.btn-success{background:var(--accent-grad);color:#030806}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}
.alert{
  padding:14px 18px;border-radius:10px;margin-bottom:20px;font-size:.9rem;text-align:left;
  background:rgba(57,255,20,.06);color:#7fff6e;border:1px solid rgba(57,255,20,.2);
}
.alert-danger{background:rgba(255,68,102,.08);color:var(--danger-text);border-color:rgba(255,68,102,.25)}
.login-page{
  min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
}
.login-page-inner{width:100%;max-width:440px;display:flex;flex-direction:column;align-items:center;gap:24px}
.login-brand{
  display:flex;align-items:center;gap:12px;font-weight:800;font-size:1.35rem;
  color:var(--accent);text-shadow:0 0 20px rgba(57,255,20,.35);
}
.login-card{width:100%;padding:36px 32px;text-align:center}
.login-card h1{font-size:1.5rem;margin-bottom:4px;color:var(--text)}
.login-card .subtitle{color:var(--muted);font-size:.875rem;margin-bottom:24px}
.login-card form{text-align:left}
.login-card .btn{width:100%;margin-top:8px;color:#030806}
.steps{counter-reset:step;padding-left:0;list-style:none;text-align:left}
.steps li{counter-increment:step;padding:10px 0 10px 36px;position:relative;color:var(--muted);font-size:.9rem}
.steps li::before{
  content:counter(step);position:absolute;left:0;top:10px;width:24px;height:24px;
  border-radius:50%;background:var(--surface-hover);border:1px solid var(--border);
  display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;color:var(--accent);
}
.info-grid{display:grid;gap:12px;text-align:left}
.info-row{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;font-size:.9rem}
.info-row .label{color:var(--muted);min-width:120px;font-size:.8rem;font-weight:600}
.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:center;margin-bottom:16px}
@media(max-width:900px){
  .key-list-head{display:none}
  .key-row{grid-template-columns:1fr;gap:8px;padding:20px 16px}
  .key-row .actions{justify-content:flex-start;margin-top:8px}
  .log-row{grid-template-columns:1fr;gap:4px}
}
`;

function panelShell(title, body, navHtml = '', subtitle = '') {
  const navBlock = navHtml ? `<nav class="nav">${navHtml}</nav>` : '';
  return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — WaSpeed</title><style>${PANEL_CSS}</style></head>
<body><div class="app app--centered">
<header class="topbar"><div class="brand"><span class="brand-dot"></span>WaSpeed</div>${navBlock}</header>
<div class="page-head"><h1>${esc(title)}</h1>${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}</div>
${body}
</div></body></html>`;
}

function loginShell(body, roleLabel = '') {
  return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — WaSpeed</title><style>${PANEL_CSS}</style></head>
<body class="login-page"><div class="login-page-inner">
<div class="login-brand"><span class="brand-dot"></span>WaSpeed</div>
${body}
</div></body></html>`;
}

function renderUninstallPage() {
  return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Até logo — ZVM</title><style>
${PANEL_CSS}
.uninstall-page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 20px;position:relative;overflow:hidden;background:var(--bg)}
.uninstall-page::before{
  content:'ZVM';position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:min(42vw,280px);font-weight:900;letter-spacing:.08em;color:rgba(57,255,20,.045);
  pointer-events:none;user-select:none;z-index:0
}
.uninstall-card{position:relative;z-index:1;max-width:520px;width:100%;text-align:center;padding:48px 36px}
.uninstall-logo{
  display:inline-flex;align-items:center;justify-content:center;
  width:88px;height:88px;border-radius:20px;margin-bottom:24px;
  background:var(--accent-grad);box-shadow:0 0 40px rgba(57,255,20,.35);
  font-weight:900;font-size:1.75rem;color:#030806;letter-spacing:.06em
}
.uninstall-card h1{font-size:1.75rem;margin-bottom:12px;color:var(--text)}
.uninstall-card p{color:var(--muted);font-size:1rem;line-height:1.65;margin-bottom:8px}
.uninstall-heart{color:var(--accent);font-size:1.05rem;margin-top:24px;font-weight:600}
</style></head>
<body class="uninstall-page">
<div class="card uninstall-card">
  <div class="uninstall-logo">ZVM</div>
  <h1>Sentimos muito em ver você partir</h1>
  <p>A extensão foi removida do seu navegador. Esperamos que o WaSpeed tenha ajudado você a organizar seus atendimentos no WhatsApp.</p>
  <p>Se mudar de ideia, estaremos aqui quando precisar.</p>
  <p class="uninstall-heart">Obrigado por usar o WaSpeed · ZVM by LR1290</p>
</div>
</body></html>`;
}

function adminNav(active = '') {
  const item = (href, label, key) =>
    `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
  return [
    item(R_ADMIN, 'Painel SPA', 'dash'),
    item(`${R_ADMIN}/keys`, 'Chaves (form)', 'keys'),
    item(`${R_ADMIN}/logs`, 'Logs', 'logs'),
    item(`${R_ADMIN}/logout`, 'Sair', 'out'),
  ].join('');
}

function mongoBanner() {
  return `<div class="alert"><strong>MongoDB Atlas</strong> — persistencia centralizada. Sessoes expiram em 24h.</div>`;
}

function statusBadgeHtml(st) {
  if (st === 'active') return '<span class="badge badge-ok">PRO Ativo</span>';
  if (st === 'blocked') return '<span class="badge badge-off">Bloqueado</span>';
  if (st === 'expired') return '<span class="badge badge-off">Expirado</span>';
  return '<span class="badge badge-free">Free</span>';
}

function keysListHtml(keysArr, base, canDelete) {
  if (!keysArr.length) {
    return '<div class="empty-state"><p>Nenhuma chave cadastrada ainda.</p></div>';
  }
  const rows = keysArr.map(({ code, rec }) => {
    const st = keyStatus(rec);
    const exp = rec.expiresAt ? new Date(rec.expiresAt).toLocaleString('pt-BR') : 'Sem limite';
    const delForm = canDelete
      ? `<form method="post" action="${base}/keys/${encodeURIComponent(code)}/delete" onsubmit="return confirm('Excluir chave?')"><button class="btn btn-sm btn-danger" type="submit">Excluir</button></form>`
      : '';
    return `<div class="key-row">
      <div><code class="key-chip">${esc(code)}</code></div>
      <div>${esc(rec.label)}</div>
      <div>${statusBadgeHtml(st)}</div>
      <div style="color:var(--muted);font-size:.85rem">${esc(exp)}</div>
      <div style="color:var(--muted);font-size:.85rem">${esc(rec.note || '—')}</div>
      <div class="actions">
        <a class="btn btn-sm btn-ghost" href="${base}/keys/${encodeURIComponent(code)}">Editar</a>
        <form method="post" action="${base}/keys/${encodeURIComponent(code)}/toggle"><button class="btn btn-sm btn-ghost" type="submit">${rec.active ? 'Bloquear' : 'Liberar'}</button></form>
        ${delForm}
      </div>
    </div>`;
  }).join('');
  return `<div class="key-list">
    <div class="key-list-head"><span>Chave</span><span>Cliente</span><span>Status</span><span>Validade</span><span>Nota</span><span></span></div>
    ${rows}
  </div>`;
}

function renderAdminDashboard(stats) {
  return panelShell('Dashboard', `${mongoBanner()}
    <div class="metrics">
      <div class="metric"><div class="metric-value">${stats.total}</div><div class="metric-label">Total de chaves</div></div>
      <div class="metric"><div class="metric-value accent">${stats.active}</div><div class="metric-label">Licencas PRO ativas</div></div>
      <div class="metric"><div class="metric-value">${stats.free}</div><div class="metric-label">Contas Free</div></div>
      <div class="metric"><div class="metric-value">${stats.logCount}</div><div class="metric-label">Eventos registrados</div></div>
    </div>
    <div class="card">
      <div class="card-title">Endpoint da API</div>
      <p class="key-chip">${esc(config.baseUrl)}/api/</p>
      <div class="card-title" style="margin-top:20px">Access Token</div>
      <p class="key-chip">${esc(config.criptKey)}</p>
    </div>
    <div class="card" style="display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:12px">
      <div style="text-align:center"><strong>Gerenciamento</strong><p style="color:var(--muted);font-size:.875rem;margin-top:4px">Crie e gerencie licencas de clientes</p></div>
      <a class="btn btn-success" href="${R_ADMIN}/keys/new">+ Nova Chave</a>
    </div>`, adminNav('dash'), 'Visao geral do servidor WaSpeed');
}

function renderAdminKeys(list) {
  return panelShell('Chaves de licenca', `${mongoBanner()}
    <div class="toolbar">
      <p style="color:var(--muted);font-size:.875rem">${list.length} chave(s) cadastrada(s)</p>
      <a class="btn btn-success" href="${R_ADMIN}/keys/new">+ Nova Chave</a>
    </div>
    <div class="card" style="padding:0;overflow:hidden">${keysListHtml(list, R_ADMIN, true)}</div>`,
    adminNav('keys'), 'Controle completo de licencas PRO e Free');
}

function renderKeyForm(base, rec, title) {
  const code = rec?.code || '';
  const body = `<div class="card" style="max-width:640px">
    <form method="post">
      ${code ? `<div class="field"><label>Chave</label><code class="key-chip">${esc(code)}</code></div>` : ''}
      <div class="field"><label>Nome do cliente</label><input name="label" value="${esc(rec?.label || '')}" required placeholder="Nome ou empresa"></div>
      <div class="row">
        <div class="field"><label>Premium (PRO)</label>
          <select name="premium"><option value="1" ${rec?.premium !== false ? 'selected' : ''}>Sim — PRO</option><option value="0" ${rec?.premium === false ? 'selected' : ''}>Free</option></select>
        </div>
        <div class="field"><label>Dias de validade</label><input name="expireDays" type="number" min="0" value="${rec?.expireDays || 0}" placeholder="0 = sem limite"></div>
      </div>
      <div class="field"><label>Nota interna</label><textarea name="note" rows="3" placeholder="Observacoes opcionais">${esc(rec?.note || '')}</textarea></div>
      <button class="btn" type="submit">Salvar chave</button>
    </form>
  </div>`;
  return panelShell(title, body, `<a href="${base}/keys" class="nav-link">← Voltar</a>`, code ? 'Edite os dados da licenca' : 'Gere uma nova chave de ativacao');
}

function renderLogin(base, role, err = '') {
  const body = `<div class="card login-card">
    <h1>Entrar</h1>
    <p class="subtitle">Painel ${esc(role)}</p>
    ${err ? `<div class="alert alert-danger">${esc(err)}</div>` : ''}
    <form method="post" action="${base}/login">
      <div class="field"><label>Usuario</label><input name="user" required autocomplete="username" placeholder="Seu usuario"></div>
      <div class="field"><label>Senha</label><input name="pass" type="password" required autocomplete="current-password" placeholder="Sua senha"></div>
      <button class="btn" type="submit">Acessar painel</button>
    </form>
  </div>`;
  return loginShell(body, role);
}

function renderAdminLogs(logs) {
  const rows = logs.map((l) =>
    `<div class="log-row">
      <span style="color:var(--muted);font-size:.8rem">${esc(new Date(l.at).toLocaleString('pt-BR'))}</span>
      <span class="log-type">${esc(l.type)}</span>
      <span>${esc(l.message)}</span>
    </div>`).join('');
  return panelShell('Logs do sistema', `<div class="card" style="padding:0;overflow:hidden">
    <div class="log-list">${rows || '<div class="empty-state"><p>Nenhum evento registrado</p></div>'}</div>
  </div>`, adminNav('logs'), 'Auditoria de autenticacao e operacoes');
}

async function getDashboardStats() {
  if (!db) return { total: 0, active: 0, free: 0, logCount: 0 };
  try {
    const licenses = await listLicenses();
    const logCount = await db.collection(COL.logs).countDocuments();
    return {
      total: licenses.length,
      active: licenses.filter((r) => keyStatus(r) === 'active').length,
      free: licenses.filter((r) => keyStatus(r) === 'free').length,
      logCount,
    };
  } catch (err) {
    console.error('[WaSpeed] getDashboardStats:', err.message);
    return { total: 0, active: 0, free: 0, logCount: 0 };
  }
}

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

function parseLicenseExpiry(body) {
  const days = parseInt(body.expireDays || 0, 10) || 0;
  const hours = parseInt(body.expireHours || 0, 10) || 0;
  const mins = parseInt(body.expireMinutes || 0, 10) || 0;
  if (!days && !hours && !mins) return { expiresAt: null, expireDays: 0 };
  const ms = ((days * 1440) + (hours * 60) + mins) * 60000;
  return { expiresAt: new Date(Date.now() + ms).toISOString(), expireDays: days };
}

function isKeyExpiringSoon(rec) {
  if (!rec?.expiresAt || isKeyExpired(rec) || !rec.active) return false;
  const left = new Date(rec.expiresAt).getTime() - Date.now();
  return left > 0 && left <= config.expiryWarnHours * 3600000;
}

function panelStatusKey(rec) {
  if (!rec.active) return 'bloqueado';
  if (isKeyExpired(rec)) return 'expirada';
  if (isKeyExpiringSoon(rec)) return 'expirando';
  if (rec.premium) return 'ativo';
  return 'free';
}

function formatLicenseValidity(rec) {
  if (!rec.expiresAt) return '<span style="color:var(--muted)">Sem limite</span>';
  const exp = new Date(rec.expiresAt);
  const txt = exp.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  if (isKeyExpired(rec)) return `<span style="color:var(--danger)">Expirada · ${esc(txt)}</span>`;
  if (isKeyExpiringSoon(rec)) return `<span style="color:#ffb347">⏰ ${esc(txt)}</span>`;
  return esc(txt);
}

function licenseUsesLabel(rec) {
  const used = (rec.phones || []).length;
  const max = rec.maxUses;
  if (max === -1 || max == null) return `${used}/∞`;
  const cap = max > 0 ? max : '∞';
  return `${used}/${cap}`;
}

let _panelKeysHtmlCache = null;
let _panelKeysHtmlTs = 0;
const PANEL_KEYS_CACHE_MS = 15000;

function invalidatePanelKeysCache() {
  _panelKeysHtmlCache = null;
  _panelKeysHtmlTs = 0;
}

async function getPanelKeyStats() {
  const licenses = await listLicenses();
  let activeKeys = 0;
  let freeKeys = 0;
  let blockedKeys = 0;
  let expiredKeys = 0;
  let warnKeys = 0;
  for (const k of licenses) {
    const st = keyStatus(k);
    if (st === 'active') activeKeys++;
    else if (st === 'free') freeKeys++;
    else if (st === 'blocked') blockedKeys++;
    else if (st === 'expired') expiredKeys++;
    if (isKeyExpiringSoon(k)) warnKeys++;
  }
  const logCount = db ? await db.collection(COL.logs).countDocuments() : 0;
  return {
    totalKeys: licenses.length,
    activeKeys,
    freeKeys,
    blockedKeys,
    expiredKeys,
    warnKeys,
    totalLogs: logCount,
  };
}

function buildLicenseTableRows(licenses) {
  return licenses.map((k) => {
    const code = k.code;
    const st = panelStatusKey(k);
    const maxU = k.maxUses ?? -1;
    return `<tr class="kr" data-code="${esc(code)}" data-label="${esc((k.label || '').toLowerCase())}"
      data-status="${st}" data-validity="${k.expiresAt || ''}" data-uses="${(k.phones || []).length}"
      data-phone="${esc(k.lastPhone || '')}" data-lastused="${k.lastUsed || ''}" data-created="${k.createdAt || ''}">
      <td><code class="key-chip">${esc(code)}</code></td>
      <td>${esc(k.label || '—')}</td>
      <td>${statusBadgeHtml(keyStatus(k))}</td>
      <td>${formatLicenseValidity(k)}</td>
      <td>${licenseUsesLabel(k)}</td>
      <td style="font-size:.8rem">${esc(k.lastPhone || '—')}</td>
      <td style="font-size:.8rem;color:var(--muted)">${esc(k.lastIp || '—')}</td>
      <td style="font-size:.8rem;color:var(--muted)">${k.lastUsed ? esc(new Date(k.lastUsed).toLocaleString('pt-BR')) : '—'}</td>
      <td style="font-size:.8rem;color:var(--muted)">${k.createdAt ? esc(new Date(k.createdAt).toLocaleString('pt-BR')) : '—'}</td>
      <td style="font-size:.8rem;max-width:120px;overflow:hidden;text-overflow:ellipsis" title="${esc(k.note || '')}">${esc(k.note || '—')}</td>
      <td class="act">
        <button class="bs bg" onclick="apiToggle('${esc(code)}')">${k.active ? 'Bloq' : 'Lib'}</button>
        <button class="bs" onclick="openRenew('${esc(code)}')">+Tempo</button>
        <button class="bs" onclick="openUses('${esc(code)}',${maxU})">Usos</button>
        <button class="bs bd" onclick="apiDelete('${esc(code)}')">Del</button>
      </td>
    </tr>`;
  }).join('');
}

async function getPanelKeysHtmlCached() {
  const now = Date.now();
  if (_panelKeysHtmlCache && now - _panelKeysHtmlTs < PANEL_KEYS_CACHE_MS) return _panelKeysHtmlCache;
  const licenses = await listLicenses();
  _panelKeysHtmlCache = buildLicenseTableRows(licenses);
  _panelKeysHtmlTs = now;
  return _panelKeysHtmlCache;
}

function buildPanelLogsHtml(logs) {
  return logs.map((l) =>
    `<tr data-log="${esc((l.type + ' ' + l.message).toLowerCase())}">
      <td style="white-space:nowrap;font-size:.8rem;color:var(--muted)">${esc(new Date(l.at).toLocaleString('pt-BR'))}</td>
      <td><span class="log-type">${esc(l.type)}</span></td>
      <td>${esc(l.message)}</td>
      <td style="font-size:.8rem">${esc(l.meta?.code || '')}</td>
    </tr>`).join('');
}

const ADMIN_SPA_CSS = `
.hdr{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:16px 20px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
.hdr h1{font-size:1.25rem;font-weight:800;color:var(--accent)}
.hdr-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;padding:16px 20px}
.sc{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center}
.sc .n{font-size:1.6rem;font-weight:800}
.sc .l{font-size:.7rem;color:var(--muted);text-transform:uppercase;margin-top:4px}
.sec{margin:0 20px 24px;background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.sh{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--border)}
.st{font-weight:700;font-size:.95rem}
.gen-form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.gen-form input,.gen-form select{padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:#061008;color:var(--text);font-size:.85rem}
.gen-form input[type=number]{width:56px}
.search-bar{display:flex;flex-wrap:wrap;gap:8px;padding:12px 18px;border-bottom:1px solid var(--border)}
.search-bar input,.search-bar select{flex:1;min-width:140px;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:#061008;color:var(--text)}
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
.bw,.bp,.bcsv,.out{padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:.8rem;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.bp{background:var(--accent-grad);color:#030806;border:none;font-weight:600}
.toast{position:fixed;bottom:24px;right:24px;padding:12px 18px;border-radius:10px;background:var(--surface);border:1px solid var(--accent);color:var(--accent);font-size:.875rem;opacity:0;transition:opacity .3s;z-index:99;pointer-events:none}
.toast.show{opacity:1}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;z-index:50}
.modal-bg.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px;max-width:400px;width:90%}
.modal h3{margin-bottom:16px}
.modal .field{margin-bottom:12px}
.modal .row{display:flex;gap:8px;margin-top:16px}
`;

function renderAdminSpa(keysHtml, logsHtml, stats) {
  const warn = stats.warnKeys || 0;
  const exp = stats.expiredKeys || 0;
  return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — WaSpeed</title>
<style>${PANEL_CSS}${ADMIN_SPA_CSS}</style></head>
<body>
<header class="hdr">
  <h1>⚡ WaSpeed Admin</h1>
  <div class="hdr-actions">
    <span id="last-refresh" style="font-size:.75rem;color:var(--muted)">—</span>
    <button class="bw" onclick="doRefresh(true)">↻ Atualizar</button>
    <button class="bcsv" onclick="exportCsv()">⬇ CSV</button>
    <a class="out" href="${R_ADMIN}/keys">Formulários</a>
    <a class="out" href="${R_ADMIN}/logout">Sair</a>
  </div>
</header>
${warn > 0 || exp > 0 ? `<div class="alert" style="margin:12px 20px">${exp > 0 ? `<strong>${exp} expirada(s)</strong>` : ''}${exp > 0 && warn > 0 ? ' · ' : ''}${warn > 0 ? `<strong>${warn} expirando em ${config.expiryWarnHours}h</strong>` : ''}</div>` : ''}
<div class="stats">
  <div class="sc"><div class="n" id="s-total">${stats.totalKeys}</div><div class="l">Total</div></div>
  <div class="sc"><div class="n" id="s-active" style="color:var(--accent)">${stats.activeKeys}</div><div class="l">PRO ativas</div></div>
  <div class="sc"><div class="n" id="s-free">${stats.freeKeys}</div><div class="l">Free</div></div>
  <div class="sc"><div class="n" id="s-expired" style="${exp ? 'color:var(--danger)' : ''}">${stats.expiredKeys}</div><div class="l">Expiradas</div></div>
  <div class="sc"><div class="n" id="s-warn" style="${warn ? 'color:#ffb347' : ''}">${stats.warnKeys}</div><div class="l">Expirando</div></div>
  <div class="sc"><div class="n" id="s-logs">${stats.totalLogs}</div><div class="l">Logs</div></div>
</div>
<div class="sec">
  <div class="sh">
    <span class="st">🔑 Licenças</span>
    <div class="gen-form">
      <input type="text" id="nlabel" placeholder="Cliente">
      <input type="number" id="ndays" placeholder="Dias" min="0" title="Dias">
      <input type="number" id="nhours" placeholder="H" min="0" title="Horas">
      <input type="number" id="nmins" placeholder="Min" min="0" title="Minutos">
      <input type="number" id="nuses" placeholder="Usos" min="-1" title="Máx dispositivos (-1=∞)">
      <select id="npremium"><option value="1">PRO</option><option value="0">Free</option></select>
      <button class="bp" onclick="generateKey()">+ Gerar</button>
    </div>
  </div>
  <div class="search-bar">
    <input type="text" id="search-input" placeholder="🔍 Buscar chave, nome, telefone, IP..." oninput="filterKeys()">
    <select id="filter-status" onchange="filterKeys()">
      <option value="">Todos</option>
      <option value="ativo">PRO ativas</option>
      <option value="free">Free</option>
      <option value="expirando">Expirando</option>
      <option value="expirada">Expiradas</option>
      <option value="bloqueado">Bloqueadas</option>
    </select>
  </div>
  <div class="ov">
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
  <div class="sh"><span class="st">📋 Logs</span><input type="text" id="logSearch" placeholder="Filtrar..." oninput="filterLog()" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:#061008;color:var(--text)"></div>
  <div class="ov"><table><thead><tr><th>Data</th><th>Tipo</th><th>Mensagem</th><th>Chave</th></tr></thead>
  <tbody id="logb">${logsHtml}</tbody></table></div>
</div>
<div id="toast" class="toast"></div>
<div id="modal-bg" class="modal-bg" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modal-box"></div>
</div>
<script>
const _RA='${R_ADMIN}';
let _sortCol='created',_sortDir=-1;
function toast(m,ok=true){const t=document.getElementById('toast');t.textContent=m;t.style.borderColor=ok?'var(--accent)':'var(--danger)';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3500);}
function closeModal(){document.getElementById('modal-bg').classList.remove('open');}
function filterKeys(){const q=(document.getElementById('search-input').value||'').toLowerCase();const st=document.getElementById('filter-status').value;
document.querySelectorAll('#kb tr.kr').forEach(r=>{const row=(r.dataset.code+r.dataset.label+r.dataset.phone).toLowerCase();
r.style.display=(!q||row.includes(q))&&(!st||r.dataset.status===st)?'':'none';});}
function filterLog(){const q=(document.getElementById('logSearch').value||'').toLowerCase();
document.querySelectorAll('#logb tr').forEach(r=>{r.style.display=!q||r.dataset.log.includes(q)?'':'none';});}
function sortKeys(col){if(_sortCol===col)_sortDir*=-1;else{_sortCol=col;_sortDir=1;}
const tb=document.getElementById('kb');const rows=[...tb.querySelectorAll('tr.kr')];
rows.sort((a,b)=>{let va=a.dataset[col]||'',vb=b.dataset[col]||'';
if(col==='uses'){va=+va;vb=+vb;if(va<vb)return -1*_sortDir;if(va>vb)return 1*_sortDir;return 0;}
if(va<vb)return -1*_sortDir;if(va>vb)return 1*_sortDir;return 0;});
rows.forEach(r=>tb.appendChild(r));}
async function generateKey(){
  const label=document.getElementById('nlabel').value.trim();
  if(!label){toast('Informe o cliente',false);return;}
  const body={label,premium:document.getElementById('npremium').value==='1'};
  const d=+document.getElementById('ndays').value||0,h=+document.getElementById('nhours').value||0,m=+document.getElementById('nmins').value||0;
  if(d)body.expireDays=d;if(h)body.expireHours=h;if(m)body.expireMinutes=m;
  const u=document.getElementById('nuses').value.trim();if(u!=='')body.maxUses=parseInt(u);
  const r=await fetch(_RA+'/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r.status===401){location.href=_RA+'/login';return;}
  const j=await r.json();if(j.ok){toast('✅ '+j.key);['nlabel','ndays','nhours','nmins','nuses'].forEach(id=>document.getElementById(id).value='');await doRefresh();}
  else toast('Erro: '+(j.error||'?'),false);}
async function doRefresh(manual){
  const r=await fetch(_RA+'/api/data');if(r.status===401){if(manual)location.href=_RA+'/login';return;}
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
  filterKeys();}
async function apiToggle(code){const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(code)+'/toggle',{method:'POST'});
if(r.ok){toast('Status alterado');doRefresh();}else toast('Falha',false);}
async function apiDelete(code){if(!confirm('Excluir '+code+'?'))return;
const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(code),{method:'DELETE'});
if(r.ok){toast('Removida');doRefresh();}else toast('Falha',false);}
function openRenew(code){document.getElementById('modal-box').innerHTML='<h3>Renovar '+code+'</h3><div class="field"><label>Dias</label><input id="rd" type="number" min="0" value="30"></div><div class="field"><label>Horas</label><input id="rh" type="number" min="0" value="0"></div><div class="row"><button class="bp" onclick="submitRenew(\\''+code+'\\')">OK</button><button class="bw" onclick="closeModal()">Cancelar</button></div>';
document.getElementById('modal-bg').classList.add('open');}
async function submitRenew(code){const days=+document.getElementById('rd').value||0,hours=+document.getElementById('rh').value||0;
const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(code)+'/renew',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days,hours})});
closeModal();if(r.ok){toast('Renovada');doRefresh();}else toast('Falha',false);}
function openUses(code,cur){document.getElementById('modal-box').innerHTML='<h3>Usos — '+code+'</h3><div class="field"><label>Máx (-1=∞)</label><input id="mu" type="number" value="'+cur+'"></div><div class="row"><button class="bp" onclick="submitUses(\\''+code+'\\')">OK</button><button class="bw" onclick="closeModal()">Cancelar</button></div>';
document.getElementById('modal-bg').classList.add('open');}
async function submitUses(code){const maxUses=parseInt(document.getElementById('mu').value);
const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(code)+'/max-uses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxUses})});
closeModal();if(r.ok){toast('Atualizado');doRefresh();}else toast('Falha',false);}
function exportCsv(){window.location.href=_RA+'/api/export/csv';}
setInterval(()=>doRefresh(),60000);
</script>
</body></html>`;
}

function renderModSpa(modName, keysHtml, stats) {
  return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mod — WaSpeed</title>
<style>${PANEL_CSS}${ADMIN_SPA_CSS}</style></head>
<body>
<header class="hdr">
  <h1>👮 ${esc(modName)}</h1>
  <div class="hdr-actions">
    <button class="bw" onclick="doRefresh()">↻ Atualizar</button>
    <a class="out" href="${R_MOD}/keys/new">+ Nova (form)</a>
    <a class="out" href="${R_MOD}/logout">Sair</a>
  </div>
</header>
<div class="stats">
  <div class="sc"><div class="n">${stats.totalKeys}</div><div class="l">Suas chaves</div></div>
  <div class="sc"><div class="n" style="color:var(--accent)">${stats.activeKeys}</div><div class="l">PRO ativas</div></div>
</div>
<div class="sec">
  <div class="sh">
    <span class="st">🔑 Minhas licenças</span>
    <div class="gen-form">
      <input type="text" id="nlabel" placeholder="Cliente">
      <select id="npremium"><option value="1">PRO</option><option value="0">Free</option></select>
      <input type="number" id="ndays" placeholder="Dias" min="0">
      <button class="bp" onclick="generateKey()">+ Gerar</button>
    </div>
  </div>
  <div class="search-bar"><input type="text" id="search-input" placeholder="Buscar..." oninput="filterKeys()"></div>
  <div class="ov"><table><thead><tr><th>Chave</th><th>Cliente</th><th>Status</th><th>Validade</th><th>Usos</th><th>Nota</th></tr></thead>
  <tbody id="kb">${keysHtml}</tbody></table></div>
</div>
<script>
const _RM='${R_MOD}';
function toast(m){const t=document.createElement('div');t.className='toast show';t.textContent=m;t.style.cssText='position:fixed;bottom:20px;right:20px;padding:12px;background:var(--surface);border:1px solid var(--accent);border-radius:8px;z-index:99';document.body.appendChild(t);setTimeout(()=>t.remove(),3000);}
function filterKeys(){const q=(document.getElementById('search-input').value||'').toLowerCase();
document.querySelectorAll('#kb tr.kr').forEach(r=>{r.style.display=!q||(r.dataset.code+r.dataset.label).toLowerCase().includes(q)?'':'none';});}
async function generateKey(){
  const label=document.getElementById('nlabel').value.trim();if(!label){toast('Informe o cliente');return;}
  const body={label,premium:document.getElementById('npremium').value==='1'};
  const d=+document.getElementById('ndays').value;if(d)body.expireDays=d;
  const r=await fetch(_RM+'/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r.status===401){location.href=_RM+'/login';return;}
  const j=await r.json();if(j.ok){toast('✅ '+j.key);document.getElementById('nlabel').value='';doRefresh();}}
async function doRefresh(){
  const r=await fetch(_RM+'/api/data');if(r.status===401)return;
  const d=await r.json();if(d.ok)document.getElementById('kb').innerHTML=d.keysHtml;filterKeys();}
</script>
</body></html>`;
}

async function handleAdminApi(req, res, pathname) {
  if (pathname === R_ADMIN + '/api/data' && req.method === 'GET') {
    const stats = await getPanelKeyStats();
    const keysHtml = await getPanelKeysHtmlCached();
    const logs = await getRecentLogs(150);
    return sendJson(res, { ok: true, ...stats, keysHtml, logsHtml: buildPanelLogsHtml(logs) });
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
    const body = await readJson(req);
    const days = parseInt(body.days || 0, 10) || 0;
    const hours = parseInt(body.hours || 0, 10) || 0;
    if (!days && !hours) return sendJson(res, { error: 'informe tempo' }, 400);
    const addMs = ((days * 1440) + (hours * 60)) * 60000;
    const base = (rec.expiresAt && !isKeyExpired(rec)) ? new Date(rec.expiresAt).getTime() : Date.now();
    await updateLicense(rec.code, { expiresAt: new Date(base + addMs).toISOString(), active: true });
    invalidatePanelKeysCache();
    return sendJson(res, { ok: true });
  }
  const codeMu = pathname.match(adminApiPathRegex('/max-uses'));
  if (codeMu && req.method === 'POST') {
    const rec = await findKey(decodeURIComponent(codeMu[1]));
    if (!rec) return sendJson(res, { error: 'not found' }, 404);
    const body = await readJson(req);
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
    await addLog('key_delete', `Chave ${code} excluida`, { code });
    invalidatePanelKeysCache();
    return sendJson(res, { ok: true });
  }
  if (pathname === R_ADMIN + '/api/export/csv' && req.method === 'GET') {
    const licenses = await listLicenses();
    const lines = ['code,label,premium,active,expiresAt,uses,maxUses,lastPhone,lastIp,createdAt,note'];
    for (const k of licenses) {
      lines.push([
        k.code, k.label, k.premium, k.active, k.expiresAt || '',
        (k.phones || []).length, k.maxUses ?? -1, k.lastPhone || '', k.lastIp || '',
        k.createdAt || '', (k.note || '').replace(/,/g, ';'),
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    const csv = lines.join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="waspeed-licenses.csv"',
    });
    res.end('\ufeff' + csv);
    return true;
  }
  return false;
}

async function handleModApi(req, res, pathname, sess) {
  const modName = sess.name;
  if (pathname === R_MOD + '/api/data' && req.method === 'GET') {
    const all = await listLicenses({ modName });
    let activeKeys = all.filter((k) => keyStatus(k) === 'active').length;
    const keysHtml = buildLicenseTableRows(all);
    return sendJson(res, {
      ok: true,
      totalKeys: all.length,
      activeKeys,
      keysHtml,
    });
  }
  if (pathname === R_MOD + '/api/keys' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.label?.trim()) return sendJson(res, { error: 'label obrigatorio' }, 400);
    const { expiresAt, expireDays } = parseLicenseExpiry(body);
    try {
      const rec = await createKey({
        label: String(body.label).trim().slice(0, 60),
        premium: body.premium !== false && body.premium !== 0 && body.premium !== '0',
        expiresAt,
        expireDays,
        note: String(body.note || '').slice(0, 400),
      }, modName);
      invalidatePanelKeysCache();
      return sendJson(res, { ok: true, key: rec.code });
    } catch (e) {
      return sendJson(res, { error: e.message }, 500);
    }
  }
  return false;
}

// --- Painel cliente ----------------------------------------------------------

const CLIENT_PANEL_RE = /^\/([a-z0-9]{16,32})\/(auth-painel|login|recovery|auth-plugin|redirect-plugin-register|register)\/?$/i;

function renderClientLogin(storeId) {
  return panelShell('Painel Clientes', `<div class="card">
    <p style="color:var(--muted);font-size:.875rem;margin-bottom:16px">Extensao WaSpeed · ID ${esc(storeId)}</p>
    <p style="margin-bottom:20px">O acesso ao painel e feito pela extensao no WhatsApp Web.</p>
    <ol class="steps">
      <li>Abra o WhatsApp Web</li>
      <li>Na extensao WaSpeed, faca login com sua <strong>chave de ativacao</strong></li>
      <li>Clique em <strong>Painel Clientes</strong> na barra lateral</li>
    </ol>
    <p style="margin-top:24px"><a class="btn" href="https://web.whatsapp.com" target="_blank" rel="noopener">Abrir WhatsApp Web</a></p>
  </div>`, '', 'Instrucoes de acesso');
}

function renderClientRecovery(storeId) {
  return panelShell('Recuperar acesso', `<div class="card">
    <p style="color:var(--muted);margin-bottom:16px">Extensao WaSpeed</p>
    <p style="margin-bottom:12px">Entre em contato com o administrador do seu servidor WaSpeed para obter uma nova chave.</p>
    <p style="margin-top:24px"><a class="btn btn-ghost" href="/${esc(storeId)}/login">← Voltar ao painel</a></p>
  </div>`, '', 'Recuperacao de licenca');
}

function renderClientRegister(storeId) {
  return panelShell('Modo gratuito', `<div class="card">
    <p style="color:var(--muted);margin-bottom:16px">Extensao WaSpeed</p>
    <p style="margin-bottom:12px">O cadastro gratuito e feito na extensao: clique em <strong>Entrar gratuitamente</strong>.</p>
    <p style="margin-top:24px"><a class="btn" href="https://web.whatsapp.com" target="_blank" rel="noopener">Abrir WhatsApp Web</a></p>
  </div>`, '', 'Registro sem custo');
}

function renderClientAuthPainel(storeId, token, page, rec) {
  if (!rec) {
    return panelShell('Sessao invalida', `<div class="card">
      <div class="alert alert-danger">Token invalido ou sessao expirada. Faca login novamente na extensao WaSpeed.</div>
      <a class="btn" href="/${esc(storeId)}/login">Instrucoes de acesso</a>
    </div>`);
  }

  const code = rec.code || token;
  const user = keyToUser(code, rec);
  const st = keyStatus(rec);
  const premium = buildUserPremium(code, rec);
  const exp = rec.expiresAt ? new Date(rec.expiresAt).toLocaleString('pt-BR') : 'Sem vencimento';
  const liberacao = premium?.data_liberacao || '—';
  const pageLabel = page ? esc(decodeURIComponent(page)) : '';

  const nav = `<a href="/${esc(storeId)}/auth-painel?token=${encodeURIComponent(token)}">Minha conta</a>
    <a href="https://web.whatsapp.com" target="_blank" rel="noopener">WhatsApp Web</a>`;

  return panelShell('Minha conta', `
    <div class="metrics">
      <div class="metric"><div class="metric-value" style="font-size:1rem">${statusBadgeHtml(st)}</div><div class="metric-label">Status da licenca</div></div>
      <div class="metric"><div class="metric-value" style="font-size:1.1rem">${esc(liberacao)}</div><div class="metric-label">Data liberacao</div></div>
      <div class="metric"><div class="metric-value" style="font-size:1rem">${esc(exp)}</div><div class="metric-label">Validade</div></div>
    </div>
    <div class="card">
      <div class="card-title">Conta</div>
      <p style="font-size:1.1rem;font-weight:700">${esc(user.name)}</p>
      <p style="color:var(--muted);font-size:.875rem">${esc(user.email)}</p>
      <div class="info-grid" style="margin-top:16px">
        <div class="info-row"><span class="label">Chave</span><code class="key-chip">${esc(code)}</code></div>
        ${pageLabel ? `<div class="info-row"><span class="label">Secao</span><span>${pageLabel}</span></div>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="card-title">Informacoes</div>
      <div class="info-grid">
        <div class="info-row"><span class="label">Servidor</span><span class="key-chip">${esc(config.baseUrl)}</span></div>
        <div class="info-row"><span class="label">WhatsApp</span><span>${esc(rec.lastPhone || '—')}</span></div>
        <div class="info-row"><span class="label">Ultimo uso</span><span>${rec.lastUsed ? esc(new Date(rec.lastUsed).toLocaleString('pt-BR')) : '—'}</span></div>
      </div>
    </div>`, nav, `Ola, ${esc(user.name)}`);
}

async function handleClientPanel(req, res, pathname, url) {
  const m = pathname.match(CLIENT_PANEL_RE);
  if (!m) return false;

  const storeId = m[1];
  const route = m[2].toLowerCase();
  const token = url.searchParams.get('token') || url.searchParams.get('bearer_token') || '';
  const page = url.searchParams.get('page') || '';

  if (route === 'auth-painel') {
    if (!token) {
      res.writeHead(302, { Location: `/${storeId}/login` });
      res.end();
      return true;
    }
    const rec = await findKeyByBearer(token);
    sendHtml(res, renderClientAuthPainel(storeId, token, page, rec));
    return true;
  }

  if (route === 'auth-plugin') {
    const dest = token
      ? `/${storeId}/auth-painel?token=${encodeURIComponent(token)}`
      : `/${storeId}/login`;
    res.writeHead(302, { Location: dest });
    res.end();
    return true;
  }

  if (route === 'redirect-plugin-register' || route === 'register') {
    sendHtml(res, renderClientRegister(storeId));
    return true;
  }

  if (route === 'recovery') {
    sendHtml(res, renderClientRecovery(storeId));
    return true;
  }

  if (route === 'login') {
    sendHtml(res, renderClientLogin(storeId));
    return true;
  }

  return false;
}

// --- Router ------------------------------------------------------------------

async function handleWaSpeedApi(req, res, pathname, ip) {
  const chromeId = config.chromeStoreId;
  const settings = cachedSettings || {};

  if (pathname === '/api/urls/install/' + chromeId || pathname.match(/^\/api\/urls\/install\//)) {
    await addLog('install', 'Redirect install', { ip });
    return sendJson(res, { success: true, url: settings.installUrl || config.installUrl });
  }
  if (pathname.match(/^\/api\/urls\/uninstall\//)) {
    res.writeHead(302, { Location: `${config.baseUrl}/obrigado` });
    return res.end();
  }
  if (pathname.match(/^\/api\/urls\/active-notes\//)) {
    return sendJson(res, { success: true, path_note_update: { redirect: config.notesRedirect } });
  }
  if (pathname.match(/^\/api\/urls\/notes\//)) {
    const html = settings.notesHtml || '<h1>WaSpeed</h1>';
    if (res.headersSent) return true;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
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
    let keyCount = 0;
    try { keyCount = await db.collection(COL.licenses).countDocuments(); } catch {}
    return sendJson(res, { success: true, server: 'waspeed', version: '3.0.0', keys: keyCount, storage: 'mongodb' });
  }

  if (!requireAccessToken(req)) {
    return sendJson(res, { success: false, msg_id: 'invalid_access_token' }, 403);
  }

  if (pathname === `/api/auth/login-bearer/${chromeId}` && req.method === 'GET') {
    if (!checkRate(ip)) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const bearer = parseBearer(req);
    const rec = await findKeyByBearer(bearer);
    const code = rec ? (rec.code || bearer) : null;
    if (!rec) {
      await addLog('auth_fail', 'Bearer invalido', { ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token' });
    }
    const result = await authSuccess(code, rec);
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('auth_ok', `Login bearer ${code}`, { ip });
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
    const key = normKey(body.access_token_plugin || body.chave || body.senha || body.email);
    const rec = await findKey(key);
    if (!rec) {
      await addLog('auth_fail', 'Chave invalida validation', { ip, key });
      return sendJson(res, { success: false, msg_id: 'invalid_token_in_validation' });
    }
    const result = await authSuccess(key, rec);
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('validation_ok', `Validacao ${key}`, { ip });
    return sendJson(res, result.body);
  }

  if (pathname === `/api/auth/login/${chromeId}` && req.method === 'POST') {
    if (!checkRate(ip)) return sendJson(res, { success: false, msg_id: 'rate_limited' }, 429);
    const body = await readJson(req);
    const key = normKey(body.senha || body.chave || body.email || body.access_token_plugin);
    const rec = await findKey(key);
    if (!rec) {
      await addLog('auth_fail', 'Login chave invalida', { ip });
      return sendJson(res, { success: false, msg_id: 'invalid_token' });
    }
    const result = await authSuccess(key, rec);
    if (!result.ok) return sendJson(res, { success: false, msg_id: result.msg_id });
    await addLog('auth_ok', `Login ${key}`, { ip });
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
    if (body.name) patch.label = body.name;
    if (Object.keys(patch).length) await updateLicense(rec.code, patch);
    Object.assign(rec, patch);
    const code = rec.code || bearer;
    return sendJson(res, { success: true, user: keyToUser(code, rec) });
  }

  if (pathname === `/api/services/initial-data/${chromeId}`) {
    return sendJson(res, {
      webhooks: sanitizeUrls(settings.webhooks || []),
      meet: sanitizeUrls(settings.meet || {}),
      urls: sanitizeUrls(settings.urls || {}),
      migration: sanitizeUrls(settings.migration || {}),
    });
  }

  if (pathname === '/api/image/url-to-base64' && req.method === 'POST') {
    return sendJson(res, { success: false, msg_id: 'not_implemented' });
  }

  return false;
}

async function handleAdmin(req, res, pathname, ip = '') {
  if (pathname === R_ADMIN + '/login') {
    if (req.method === 'GET') return sendHtml(res, renderLogin(R_ADMIN, 'Admin'));
    if (!checkRate(ip)) {
      return sendHtml(res, renderLogin(R_ADMIN, 'Admin', 'Muitas tentativas. Aguarde alguns minutos.'), 429);
    }
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const user = params.get('user') || '';
    const pass = params.get('pass') || '';
    if (await verifyAdminCredentials(user, pass)) {
      const session = await createSession('admin', { user: user.trim() });
      if (!session) {
        return sendHtml(res, renderLogin(R_ADMIN, 'Admin', 'Erro ao criar sessao'), 500);
      }
      setSessionCookie(res, session.token);
      res.writeHead(302, { Location: R_ADMIN });
      return res.end();
    }
    return sendHtml(res, renderLogin(R_ADMIN, 'Admin', 'Credenciais invalidas'), 401);
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

  if (await handleAdminApi(req, res, pathname)) return;

  if (pathname === R_ADMIN || pathname === R_ADMIN + '/') {
    const stats = await getPanelKeyStats();
    const keysHtml = await getPanelKeysHtmlCached();
    const logs = await getRecentLogs(150);
    return sendHtml(res, renderAdminSpa(keysHtml, buildPanelLogsHtml(logs), stats));
  }

  if (pathname === R_ADMIN + '/keys') {
    const licenses = await listLicenses();
    const list = licenses.map((rec) => ({ code: rec.code, rec }));
    return sendHtml(res, renderAdminKeys(list));
  }

  if (pathname === R_ADMIN + '/keys/new') {
    if (req.method === 'GET') return sendHtml(res, renderKeyForm(R_ADMIN, null, 'Nova chave'));
    const body = await readBody(req);
    const p = new URLSearchParams(body);
    try {
      const rec = await createKey({
        label: p.get('label'),
        premium: p.get('premium') !== '0',
        expireDays: Number(p.get('expireDays') || 0),
        note: p.get('note') || '',
      });
      res.writeHead(302, { Location: `${R_ADMIN}/keys/${encodeURIComponent(rec.code)}` });
      return res.end();
    } catch (err) {
      res.writeHead(500);
      return res.end('Erro ao criar chave: ' + err.message);
    }
  }

  const keyEdit = pathname.match(adminPathRegex());
  if (keyEdit) {
    const code = decodeURIComponent(keyEdit[1]);
    const rec = await findKey(code);
    if (!rec) {
      res.writeHead(404);
      return res.end('Not found');
    }
    if (req.method === 'GET') return sendHtml(res, renderKeyForm(R_ADMIN, rec, 'Editar chave'));
    const body = await readBody(req);
    const p = new URLSearchParams(body);
    const patch = {
      label: p.get('label') || rec.label,
      premium: p.get('premium') !== '0',
      note: p.get('note') || '',
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
    const rec = await findKey(code);
    if (rec) await updateLicense(code, { active: !rec.active });
    res.writeHead(302, { Location: R_ADMIN + '/keys' });
    return res.end();
  }

  const keyDel = pathname.match(adminPathRegex('/delete'));
  if (keyDel && req.method === 'POST') {
    const code = decodeURIComponent(keyDel[1]);
    await deleteLicense(code);
    await addLog('key_delete', `Chave ${code} excluida`, { code });
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

async function handleMod(req, res, pathname, ip = '') {
  if (pathname === R_MOD + '/login') {
    if (req.method === 'GET') return sendHtml(res, renderLogin(R_MOD, 'Moderador'));
    if (!checkRate(ip)) {
      return sendHtml(res, renderLogin(R_MOD, 'Moderador', 'Muitas tentativas. Aguarde alguns minutos.'), 429);
    }
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const user = params.get('user') || '';
    const pass = params.get('pass') || '';
    const mod = await verifyModCredentials(user, pass);
    if (mod) {
      const session = await createSession('mod', { user: user.trim(), modId: mod.modId, name: mod.name });
      if (!session) {
        return sendHtml(res, renderLogin(R_MOD, 'Moderador', 'Erro ao criar sessao'), 500);
      }
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

  const all = await listLicenses({ modName });

  if (pathname === R_MOD || pathname === R_MOD + '/') {
    const stats = {
      totalKeys: all.length,
      activeKeys: all.filter((k) => keyStatus(k) === 'active').length,
    };
    return sendHtml(res, renderModSpa(modName, buildLicenseTableRows(all), stats));
  }

  if (pathname === R_MOD + '/keys/new' && req.method === 'POST') {
    const body = await readBody(req);
    const p = new URLSearchParams(body);
    await createKey({ label: p.get('label'), premium: p.get('premium') !== '0', note: p.get('note') || '' }, modName);
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
    if (pathname === '/ping') {
      return sendText(res, 'OK');
    }

    if (pathname === '/login') {
      res.writeHead(302, { Location: R_ADMIN + '/login' });
      return res.end();
    }

    if (pathname === '/health') {
      let keyCount = 0;
      let mongoOk = mongoReady && db !== null;
      if (mongoOk) {
        try {
          keyCount = await db.collection(COL.licenses).countDocuments();
        } catch (err) {
          console.error('[WaSpeed] health count:', err.message);
          mongoOk = false;
        }
      }
      return sendJson(res, {
        ok: mongoOk,
        service: 'waspeed-server',
        version: '3.0.0',
        keys: keyCount,
        mongo: mongoOk,
        storage: 'mongodb',
      }, mongoOk ? 200 : 503);
    }

    if (!mongoReady || !db) {
      return sendError(res, 503, 'db_unavailable');
    }

    if (pathname === '/') {
      return sendHtml(res, panelShell('WaSpeed Server', `${mongoBanner()}
        <div class="card">
          <p style="margin-bottom:8px">Backend ativo em <strong>${esc(config.baseUrl)}</strong></p>
          <p style="color:var(--muted);font-size:.875rem;margin-bottom:20px">Login extensao: somente chave · API: /api/auth/validation/:id</p>
          <div style="display:flex;flex-wrap:wrap;gap:10px">
            <a class="btn" href="${R_ADMIN}">Painel Admin</a>
            <a class="btn btn-ghost" href="${R_MOD}">Painel Mod</a>
          </div>
        </div>`, '', 'Servidor de licencas e configuracao'));
    }

    if (pathname === '/config.json') {
      sendCachedConfigJson(res);
      return;
    }

    if (pathname === '/api/code') {
      if (res.headersSent) return;
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end('/* WaSpeed remote code stub — WPP injetado localmente pela extensao */\n');
      return;
    }

    if (pathname === '/obrigado') {
      return sendHtml(res, renderUninstallPage());
    }

    if (pathname.startsWith('/utils/')) {
      return sendJson(res, { success: false, msg_id: 'not_configured', message: 'Nao configurado neste servidor' }, 501);
    }

    if (await handleClientPanel(req, res, pathname, url)) return;

    if (pathname.startsWith('/api/')) {
      const handled = await handleWaSpeedApi(req, res, pathname, ip);
      if (handled !== false) return;
      return sendJson(res, { success: false, msg_id: 'not_found' }, 404);
    }

    if (pathname.startsWith(R_ADMIN)) {
      await handleAdmin(req, res, pathname, ip);
      return;
    }
    if (pathname.startsWith(R_MOD)) {
      await handleMod(req, res, pathname, ip);
      return;
    }

    if (!res.headersSent) {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch (err) {
    console.error('[WaSpeed] handleRequest:', err.message);
    if (!res.headersSent) {
      sendJson(res, { success: false, msg_id: 'server_error' }, 500);
    }
  }
}

// --- Anti-sleep (Render Free Tier) -------------------------------------------

function startAntiSleepCron() {
  const base = config.publicUrl || config.baseUrl;
  if (!base) {
    console.warn('[WaSpeed] PUBLIC_URL nao definida — anti-sleep desativado');
    return;
  }
  const pingUrl = `${base.replace(/\/$/, '')}/ping`;
  console.log(`[WaSpeed] Anti-sleep ativo: GET ${pingUrl} a cada 5 min`);
  setInterval(() => {
    fetch(pingUrl, { method: 'GET' }).catch((err) => {
      console.warn('[WaSpeed] Anti-sleep ping falhou:', err.message);
    });
  }, ANTI_SLEEP_MS).unref();
}

// --- Bootstrap ---------------------------------------------------------------

async function shutdown(sig) {
  console.log(`[WaSpeed] ${sig} — encerrando`);
  mongoReady = false;
  try {
    if (mongoClient) await mongoClient.close();
  } catch (err) {
    console.error('[WaSpeed] mongo close:', err.message);
  }
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function bootstrap() {
  try {
    await connectMongo();
    await initSeed();
    mongoReady = true;
  } catch (err) {
    console.error('[WaSpeed] Falha no bootstrap:', err.message);
    process.exit(1);
  }

  server = http.createServer(handleRequest);
  server.on('clientError', (err, socket) => {
    console.warn('[WaSpeed] clientError:', err.message);
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.listen(config.port, () => {
    console.log(`WaSpeed Server v3.0 em http://localhost:${config.port}`);
    console.log(`MongoDB: ${config.dbName} (ready=${mongoReady})`);
    console.log(`Admin: ${config.baseUrl}${R_ADMIN}/login`);
    console.log(`Mod:   ${config.baseUrl}${R_MOD}/login`);
    console.log(`Health: ${config.baseUrl}/health`);
    console.log(`Ping:   ${config.baseUrl}/ping`);
    startAntiSleepCron();
  });
}

bootstrap().catch((err) => {
  console.error('[WaSpeed] bootstrap fatal:', err.message);
  process.exit(1);
});

