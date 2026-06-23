'use strict';

const http   = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { MongoClient } = require('mongodb');

const WPP_VERSION     = '1.11';
const REMOTE_CODE_VER = '1.0.41';
const SESSION_TTL_MS  = 24 * 60 * 60 * 1000;
const ANTI_SLEEP_MS   = 4 * 60 * 1000;
const PANEL_CACHE_MS  = 20_000;
const LOG_TRIM_MS     = 30_000;
const MOD_PREFIXES    = ['MOD','MOD2','MOD3','MOD4','MOD5','MOD6'];
const COL = { settings:'settings', licenses:'licenses', logs:'logs', sessions:'sessions' };

function envStr(k, fb='') { return String(process.env[k]??fb).trim().replace(/^['"]|['"]$/g,''); }
function dbFromUri(u) { return String(u||'').match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/)?.[1]||'waspeed'; }

const cfg = {
  port:    Number(process.env.PORT)||3000,
  base:    (envStr('BASE_URL')||envStr('PUBLIC_URL')||envStr('RENDER_EXTERNAL_URL')).replace(/\/$/,''),
  pub:     (envStr('PUBLIC_URL')||envStr('BASE_URL')||envStr('RENDER_EXTERNAL_URL')).replace(/\/$/,''),
  mongo:   envStr('MONGODB_URI'),
  db:      envStr('MONGODB_DB')||dbFromUri(envStr('MONGODB_URI')),
  token:   envStr('ACCESS_TOKEN','ffce211a-7b07-4d91-ba5d-c40bb4034a83'),
  storeId: envStr('CHROME_STORE_ID','balkfdkhbcjjmhndnblgmlmcabnapogp'),
  wlId:    envStr('WL_ID','waspeed'),
  aUser:   envStr('ADMIN_USER','admin'),
  aPass:   envStr('ADMIN_PASS','waspeed-change-me'),
  aPath:   envStr('ADMIN_PATH','admin-waspeed'),
  mPath:   envStr('MOD_PATH','mod-waspeed'),
  install: envStr('INSTALL_URL','https://web.whatsapp.com'),
  notes:   envStr('NOTES_REDIRECT').toLowerCase()==='true',
  logMax:  Math.min(Number(process.env.LOG_MAX)||500, 2000),
  warnH:   Math.max(1, Math.min(720, Number(process.env.EXPIRY_WARN_HOURS)||48)),
};

if (!cfg.base)  { console.error('[WS] ERRO: BASE_URL nao definida.'); process.exit(1); }
if (!cfg.mongo) { console.error('[WS] ERRO: MONGODB_URI nao definida.'); process.exit(1); }
if (/xxxxx|USUARIO|SENHA|<password>|YOUR_CLUSTER/i.test(cfg.mongo)) { console.error('[WS] ERRO: MONGODB_URI com placeholder.'); process.exit(1); }
if (cfg.aPass==='waspeed-change-me') console.warn('[WS] AVISO: ADMIN_PASS ainda e o default.');
console.log(`[WS] port=${cfg.port} db=${cfg.db} url=${cfg.base}`);

const RA = `/${cfg.aPath}`;
const RM = `/${cfg.mPath}`;

let client=null, db=null, ready=false, srv=null;
let settings=null, cfgJson=null;
let _pkCache=null, _pkTs=0, _trimT=null;
const rateMap  = new Map();
const pwCache  = new Map();
const sessCache = new Map();
setInterval(()=>{ const n=Date.now(); for (const [k,v] of sessCache) if (v.exp<=n) sessCache.delete(k); }, 300_000).unref();

function invPk() { _pkCache=null; _pkTs=0; }
setInterval(()=>{ const n=Date.now(); for (const [k,v] of rateMap) if (n>(v.blockedUntil||0)&&n>(v.reset||0)) rateMap.delete(k); }, 600_000).unref();

const DOM = {"version":"1.11","update_path_active":"true","disabled_wait_sync":false,"wpp_mensagens":{"timer":"60000","enable_two_send":false},"newModel":{"model":"taghtml","parm":"body.color-refresh"},"app":{"model":"querySelector","selector":["#app"]},"afiliadoMain":{"model":"querySelector","selector":["body > div"]},"paneSide":{"model":"Element","selector":"#pane-side"},"waPage":{"model":"querySelector","selector":["div.two"]},"two":{"model":"Element","selector":"two"},"menuLateral":{"model":"querySelector","selector":["div.two > div:nth-child(5)"]},"closeChat":{"model":"Element","selector":"x10l6tqk"},"chatListInput":{"model":"querySelector","selector":[".lexical-rich-text-input > div"]},"searchInput":{"model":"querySelector","selector":["[data-icon='search']"]},"downAba":{"model":"querySelector","selector":["header > div > div > div > div > span > div > div:nth-child(1)","header > div._ak0w"]},"chatListHeader":{"model":"querySelector","selector":["header > header > div > span > div"]},"searchCamp":{"model":"querySelector","selector":["#side div[data-testid='chat-list-search-container']"]},"chatName":{"model":"querySelector","selector":["#main header span[title]","#main header div[role=\"button\"] span","#main header h1","#main > header div.x78zum5 > div > div > div > div","#main header [data-testid=\"conversation-info-header-chat-title\"]","#main header"]},"menuVertical":{"model":"querySelector","selector":["#main ._amm9","#main .x1n2onr6.x1vjfegm.x1cqoux5.x14yy4lh"]},"menuHorizontal":{"model":"querySelector","selector":["#main > header > div.x1c4vz4f > div"]},"menuFooter":{"model":"querySelector","selector":["footer ._ak1m"]},"respostaRapida":{"model":"querySelector","selector":["footer > div"]},"footerTextArea":{"model":"querySelector","selector":["footer div[contenteditable=true]"]},"mainAudio":{"model":"querySelector","selector":["footer > div.copyable-area > div"]},"assChat":{"model":"querySelector","selector":["#main > div.x1n2onr6.x1vjfegm.x1cqoux5.x14yy4lh"]},"assInput":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div"]},"assBtn":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div > div:nth-child(6)"]},"assEmoji":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div._ak1m > div > button[tabindex='-1']"]},"assCitacao":{"model":"querySelector","selector":["footer div.x9f619.x1okw0bk > button > div > div > div:nth-child(1)"]},"listMensages":{"model":"querySelector","selector":["div[data-scrolltracepolicy='wa.web.conversation.messages']"]},"allMensages":{"model":"querySelectorAll","selector":["#main div > div[data-id]"]},"assistenteChat":{"model":"querySelector","selector":["#main > footer"]},"trasferidos":{"model":"querySelector","selector":["#side div[tabindex='-1']"]},"notification":{"model":"querySelector","selector":["#side > div:nth-child(2)"]},"quotedMsg":{"model":"querySelector","selector":["#main > footer > div.x10l6tqk.x13vifvy.x1o0tod.xh8yej3 > div > div > div > span > div"]},"listChats":{"model":"querySelector","selector":["#pane-side > div > div > div"]},"listChatsUsers":{"model":"querySelectorAll","selector":["#pane-side > div > div > div > div  div[aria-selected]","#pane-side > div > div > div div[role='button'] > div"]},"listChatAtendimento":{"model":"Element","selector":"div div[data-testid='cell-frame-secondary'] div[role='gridcell']"},"insertAtendente":{"model":"Element","selector":"x10l6tqk xh8yej3 x1g42fcv"},"reactFiberContainer":{"model":"listElement","list":{"reactFiber":"__reactFiber","reactFiberIndex":0,"path_user_id":".child.memoizedProps[1].props.id._serialized","path_key_message":".child.memoizedProps.children[0].key"}},"updateChatList":{"model":"querySelector","selector":["#side div._ai04 > button"]},"useTradutor":{"model":"listElement","list":{"main_audio_1":"div.x121pien.x9f619","main_audio_2":"div.x121pien.x9f619","camp_text_1":"row-translate","camp_text_2":"div > span","add_btn_tradutor":"div.x1c4vz4f.x1q0g3np.x6s0dn4","camp_audio_1":"div[role=\"slider\"] > canvas","camp_audio_2":"div.x1e4oeot.x1ui04y5[role=\"slider\"] > div"}},"chatList":{"model":"querySelector","selector":["#pane-side","#side","div.two > div:first-child","div.two > div._aigw"]},"observerFooter":{"model":"querySelector","selector":["#main > span:nth-child(8)","#main > :last-child"]},"observerFooterNewModel":{"model":"querySelector","selector":["#main > span:nth-child(7)","#main > span:nth-child(8)","#main > span:nth-child(9)"]},"whatsModal":{"model":"querySelector","selector":["#app > div > div > span:nth-child(3)"]},"menu_whats":{"model":"querySelector","selector":["#app > div > div.x78zum5.xdt5ytf.x5yr21d > div > header > div > div:nth-child(2) > div","header > div > div:nth-child(2) > div"]},"actionMonitor":{"model":"querySelector","selector":["#main header"]},"footerIconsLeft":{"model":"querySelector","selector":["#main > footer > div.copyable-area > div > span > div > div > div"]},"side":{"model":"querySelector","selector":["#side"]},"chatFiltersContainer":{"model":"listElement","list":{"div_filters":"_akap _akan _arj9"}},"chatFilters":{"model":"querySelectorAll","selector":["#side > div:nth-of-type(3) button"]},"selector_theme":{"model":"querySelector","selector":[".os-win"]}};

function buildDom(ov={}) {
  const m={...DOM,...ov}; delete m.remote_code; delete m.dom_selector;
  if (m.version===1||m.selectors) { delete m.selectors; m.version=DOM.version; }
  m.update_path=`${cfg.base}/api/urls/update`; m.update_path_new=`${cfg.base}/api/services/update`; m.update_path_active=String(m.update_path_active??'true');
  return m;
}
function buildCfgJson(ov={}) { return { remote_code:{ version:REMOTE_CODE_VER, ambiente:'production', url:`${cfg.base}/api/code?version=${REMOTE_CODE_VER}` }, dom_selector:buildDom(ov) }; }
async function refreshCache() {
  if (!db) return;
  try { settings=await db.collection(COL.settings).findOne({ _id:'global' }); cfgJson=JSON.stringify(buildCfgJson(settings?.domConfig||{})); }
  catch (e) { console.error('[WS] cache:',e.message); }
}

function mkUrls() {
  const mk=(id,link='https://www.youtube.com/@WaSpeedOficial')=>({ id, link, active:true, redirect:false, msg:'' });
  return { tutoriais:[mk('api'),mk('auto_atendimento','https://waspeed.com.br/autoatendimento-no-whatsapp-em-5-minutos-video/'),mk('envio_em_massa','https://waspeed.com.br/agendamento-whatsapp/como-programar-mensagem-automatica-whatsapp/'),mk('follow_up'),mk('login','https://waspeed.com.br/extensao-chrome-whatsapp/como-instalar-extensao-whatsapp/'),mk('mensagens_agendadas'),mk('resposta_rapida'),mk('status'),mk('webhook'),mk('geral')] };
}
function mergeUrls(u={}) {
  const out={...u}; const arr=Array.isArray(out.tutoriais)?out.tutoriais:Object.values(out.tutoriais||{});
  const map=Object.fromEntries(arr.filter(t=>t?.id).map(t=>[t.id,t]));
  for (const it of mkUrls().tutoriais) if (!map[it.id]?.link) map[it.id]=it;
  out.tutoriais=Object.values(map); return out;
}

async function connectDb() {
  if (db&&ready) return db;
  client=new MongoClient(cfg.mongo,{ maxPoolSize:5, minPoolSize:1, maxIdleTimeMS:60_000, serverSelectionTimeoutMS:10_000, connectTimeoutMS:10_000, socketTimeoutMS:30_000, heartbeatFrequencyMS:30_000, retryWrites:true, retryReads:true });
  await client.connect(); db=client.db(cfg.db);
  client.on('serverClosed',()=>{ ready=false; setTimeout(reconnect,5000); });
  await mkIndexes(); return db;
}
async function reconnect() {
  if (ready) return;
  try { await client?.close().catch(()=>{}); await connectDb(); await refreshCache(); ready=true; console.log('[WS] MongoDB reconectado'); }
  catch (e) { console.error('[WS] reconexão:',e.message); setTimeout(reconnect,10_000); }
}
async function mkIndexes() {
  const specs=[
    { c:COL.licenses, k:{ bearer:1 }, o:{ unique:true } },
    { c:COL.licenses, k:{ code:1 },   o:{ unique:true } },
    { c:COL.licenses, k:{ modName:1 },o:{} },
    { c:COL.sessions, k:{ token:1 },  o:{ unique:true } },
    { c:COL.sessions, k:{ expiresAt:1 },o:{ expireAfterSeconds:0 } },
    { c:COL.logs,     k:{ at:-1 },    o:{} },
  ];
  for (const { c,k,o } of specs) try { await db.collection(c).createIndex(k,o); } catch (e) { if (e.code!==85&&e.code!==86) console.error(`[WS] idx ${c}:`,e.message); }
}

function hashPw(pw) {
  const s=crypto.randomBytes(16).toString('hex');
  return `pbkdf2:${s}:${crypto.pbkdf2Sync(pw,s,10000,64,'sha512').toString('hex')}`;
}
function verPw(pw, stored) {
  if (!stored?.startsWith('pbkdf2:')) return false;
  const ck=`${stored}::${pw}`; if (pwCache.has(ck)) return pwCache.get(ck);
  const [s,h]=stored.slice(7).split(':'); if (!s||!h) return false;
  const chk=crypto.pbkdf2Sync(pw,s,10000,64,'sha512').toString('hex');
  let r=false; try { r=crypto.timingSafeEqual(Buffer.from(h,'hex'),Buffer.from(chk,'hex')); } catch {}
  pwCache.set(ck,r); setTimeout(()=>pwCache.delete(ck),300_000).unref(); return r;
}
function mkModId(u) { return crypto.createHash('sha256').update(`waspeed-mod:${u}`).digest('hex').slice(0,16); }
function buildMods() {
  const m=MOD_PREFIXES.flatMap(p=>{ const u=envStr(`${p}_USER`),pw=envStr(`${p}_PASS`); return u&&pw?[{ id:mkModId(u),username:u,password:hashPw(pw),name:u,active:true }]:[]; });
  return m.length?m:[{ id:crypto.randomBytes(8).toString('hex'),username:'mod',password:hashPw('mod123'),name:'Moderador',active:true }];
}
async function syncCreds() {
  if (!db) return;
  try { await db.collection(COL.settings).updateOne({ _id:'global' },{ $set:{ admin:{ username:cfg.aUser,password:hashPw(cfg.aPass) },mods:buildMods() } },{ upsert:true }); }
  catch (e) { console.error('[WS] syncCreds:',e.message); }
}

async function seed() {
  const col=db.collection(COL.settings);
  let doc=await col.findOne({ _id:'global' });
  if (!doc) {
    await col.insertOne({ _id:'global',installUrl:cfg.install,notesHtml:'<h1>WaSpeed</h1>',webhooks:[],meet:{},urls:mkUrls(),migration:{},domConfig:buildDom(),nextUserId:1000,mods:buildMods(),admin:{ username:cfg.aUser,password:hashPw(cfg.aPass) } });
    console.log('[WS] settings criados');
  } else if (!doc.urls?.tutoriais?.length) {
    await col.updateOne({ _id:'global' },{ $set:{ urls:mergeUrls(doc.urls||{}) } });
  }
  await syncCreds();
  if (!await db.collection(COL.licenses).countDocuments()) {
    await mkKey({ code:'ws-demo-premium',label:'Demo Premium',premium:true,note:'Chave demo' });
    console.log('[WS] chave demo criada');
  }
  await refreshCache();
}

async function verAdmin(u,p) {
  if (!u||!p) return false;
  if (u.toLowerCase()===cfg.aUser.toLowerCase()&&p===cfg.aPass) return true;
  try { const d=await db.collection(COL.settings).findOne({ _id:'global' },{ projection:{ admin:1 } }); if (d?.admin&&u.toLowerCase()===String(d.admin.username||'').toLowerCase()) return verPw(p,d.admin.password); } catch {}
  return false;
}
async function verMod(u,p) {
  if (!u||!p) return null;
  for (const px of MOD_PREFIXES) { const mu=envStr(`${px}_USER`),mp=envStr(`${px}_PASS`); if (mu&&mp&&u.toLowerCase()===mu.toLowerCase()&&p===mp) return { name:mu,id:mkModId(mu) }; }
  try { const d=await db.collection(COL.settings).findOne({ _id:'global' },{ projection:{ mods:1 } }); const mod=(d?.mods||[]).find(m=>m.active!==false&&u.toLowerCase()===String(m.username||'').toLowerCase()); if (mod&&verPw(p,mod.password)) return { name:mod.name||mod.username,id:mod.id }; } catch {}
  return null;
}

async function mkSession(role,meta={}) {
  if (!db) return null;
  const tok=crypto.randomBytes(32).toString('hex'), exp=new Date(Date.now()+SESSION_TTL_MS);
  try {
    await db.collection(COL.sessions).insertOne({ token:tok,role,...meta,createdAt:new Date(),expiresAt:exp });
    sessCache.set(tok,{ token:tok,role,...meta,exp:exp.getTime() });
    return { token:tok,exp };
  } catch { return null; }
}
async function valSession(tok) {
  if (!tok||!db) return null;
  const cached=sessCache.get(tok);
  if (cached) { if (cached.exp>Date.now()) return cached; sessCache.delete(tok); }
  try {
    const s=await db.collection(COL.sessions).findOne({ token:tok,expiresAt:{ $gt:new Date() } });
    if (s) sessCache.set(tok,{ ...s,exp:new Date(s.expiresAt).getTime() });
    return s;
  } catch { return null; }
}
async function delSession(tok) {
  sessCache.delete(tok);
  if (tok&&db) try { await db.collection(COL.sessions).deleteOne({ token:tok }); } catch {}
}
function cookieHdr(tok,age=86400) { const s=cfg.base.startsWith('https'); return [`ws_session=${tok}`,'Path=/','HttpOnly','SameSite=Strict',...(s?['Secure']:[]),`Max-Age=${age}`].join('; '); }
function parseCookies(req) { const o={}; for (const p of (req.headers.cookie||'').split(';')) { const [k,...v]=p.trim().split('='); if(k) o[k]=decodeURIComponent(v.join('=')); } return o; }
async function guard(req,res,role) {
  const sess=await valSession(parseCookies(req).ws_session);
  if (!sess||sess.role!==role) { res.writeHead(302,{ Location:role==='admin'?`${RA}/login`:`${RM}/login` }); res.end(); return null; }
  return sess;
}

function normK(r) { let s=String(r||'').trim().toLowerCase(); if (s.endsWith('@waspeed.local')) s=s.slice(0,-'@waspeed.local'.length); return s.slice(0,48); }
function genCode() { const p=()=>crypto.randomBytes(3).toString('hex'); return `ws-${p()}-${p()}-${p()}`.slice(0,24); }
function expired(r) { return !!r?.expiresAt&&new Date(r.expiresAt).getTime()<Date.now(); }
function soonExp(r) { if (!r?.expiresAt||expired(r)||!r.active) return false; return (new Date(r.expiresAt).getTime()-Date.now())<=cfg.warnH*3_600_000; }
function kStatus(r) { if (!r?.active) return 'blocked'; if (expired(r)) return 'expired'; return r.premium?'active':'free'; }
function pStatus(r) { if (!r.active) return 'bloqueado'; if (expired(r)) return 'expirada'; if (soonExp(r)) return 'expirando'; return r.premium?'ativo':'free'; }

function daysLeft(r) {
  if (!r?.expiresAt) return null;
  const ms=new Date(r.expiresAt).getTime()-Date.now();
  if (ms<=0) return 0;
  return Math.ceil(ms/86_400_000);
}

const APROJ={ projection:{ code:1,bearer:1,bearer_token:1,access_token_plugin:1,active:1,premium:1,expiresAt:1,user_id:1,label:1,lastPhone:1,lastIp:1,lastUsed:1,phones:1,createdAt:1,maxUses:1,uses:1,wppVersion:1,note:1 } };
const keyCache = new Map();
const KEY_CACHE_TTL = 30_000;
function kCachePut(rec) { if (rec?.code) keyCache.set(rec.code,{ rec,exp:Date.now()+KEY_CACHE_TTL }); }
function kCacheGet(code) { const e=keyCache.get(code); if (!e) return null; if (e.exp<Date.now()) { keyCache.delete(code); return null; } return e.rec; }
function kCacheDel(code) { keyCache.delete(code); }
setInterval(()=>{ const n=Date.now(); for (const [k,v] of keyCache) if (v.exp<=n) keyCache.delete(k); }, 60_000).unref();

async function findK(code) {
  const k=normK(code); if (!k||!db) return null;
  const cached=kCacheGet(k); if (cached) return cached;
  try { const r=await db.collection(COL.licenses).findOne({ code:k },APROJ); if (r) kCachePut(r); return r; } catch { return null; }
}
async function findBearer(b) {
  if (!b||!db) return null;
  const k=normK(b); const cached=kCacheGet(k); if (cached) return cached;
  try { const r=await db.collection(COL.licenses).findOne({ $or:[{ bearer:b },{ code:k },{ access_token_plugin:b },{ bearer_token:b }] },APROJ); if (r) kCachePut(r); return r; } catch { return null; }
}
async function listKeys(f={}) { if (!db) return []; try { return await db.collection(COL.licenses).find(f).sort({ createdAt:-1 }).toArray(); } catch { return []; } }

async function mkKey(inp={},modName=null) {
  if (!db) throw new Error('MongoDB indisponivel');
  const code=normK(inp.code)||genCode();
  if (await findK(code)) throw new Error('Chave ja existe');
  const upd=await db.collection(COL.settings).findOneAndUpdate({ _id:'global' },{ $inc:{ nextUserId:1 } },{ returnDocument:'after' });
  const uid=(upd?.nextUserId??1001)-1;
  let exp=inp.expiresAt||null; if (!exp&&inp.expireDays>0) exp=new Date(Date.now()+inp.expireDays*86_400_000).toISOString();
  const rec={ code,bearer:code,user_id:uid,label:inp.label||'Cliente',email:inp.email||`${code}@waspeed.local`,active:inp.active!==false,premium:inp.premium!==false,expiresAt:exp,expireDays:inp.expireDays||0,maxUses:inp.maxUses??-1,phones:[],uses:0,note:inp.note||'',modName:modName||inp.modName||null,bearer_token:code,access_token_plugin:code,createdAt:new Date().toISOString(),lastUsed:null,lastIp:null,lastPhone:null,wppVersion:null };
  await db.collection(COL.licenses).insertOne(rec);
  addLog('key_create',`Chave ${code} criada`,{ code,modName }); invPk(); return rec;
}
async function updKey(code,patch) { if (!db) return false; try { await db.collection(COL.licenses).updateOne({ code:normK(code) },{ $set:patch }); invPk(); kCacheDel(normK(code)); return true; } catch { return false; } }
async function delKey(code) { if (!db) return false; try { await db.collection(COL.licenses).deleteOne({ code:normK(code) }); invPk(); kCacheDel(normK(code)); return true; } catch { return false; } }
async function freeKey(extId,ip) {
  const seed=String(extId||ip||'anon');
  const code=normK(`ws-free-${crypto.createHash('sha256').update(seed).digest('hex').slice(0,16)}`);
  const ex=await findK(code); if (ex) return { code,rec:ex };
  return { code,rec:await mkKey({ code,label:'Usuario Gratuito',premium:false,note:'Free auto' }) };
}

const EMPTY_GOOGLE={ user_id:'',name:'',picture:'',email_auth:'',access_token:'',expires_in:NaN,id_token:'',refresh_token:'',scope:'',token_type:'',updated_at:NaN };
function fmtD(v) { const d=v instanceof Date?v:new Date(v); if (isNaN(d)) return fmtD(new Date()); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function mkPremium(code,rec) {
  if (kStatus(rec)!=='active') return null;
  let dl; if (rec.expiresAt) { const e=new Date(rec.expiresAt); if (!isNaN(e)) { e.setFullYear(e.getFullYear()-1); dl=fmtD(e); } }
  return { id_assinatura:String(rec.user_id||code),data_liberacao:dl||fmtD(rec.createdAt||new Date()),teste:'0' };
}
function toUser(code,rec) {
  return { user_id:String(rec.user_id),name:rec.label||'Usuario',email:code,wl_id:cfg.wlId,bearer_token:rec.bearer_token||code,access_token_plugin:rec.access_token_plugin||code,user_premium:mkPremium(code,rec),dataCadastro:rec.createdAt||new Date().toISOString(),whatsapp_registro:rec.lastPhone||'',whatsapp_plugin:rec.lastPhone||'',path:'',afiliado:'',campanhaID:'',start_form:true,cookies:{ _fbc:'',_fbp:'',_ga:'',_ttclid:'',_ttp:'' } };
}
async function authOk(code,rec) {
  const st=kStatus(rec); if (st==='blocked') return { ok:false,msg_id:'user_blocked' }; if (st==='expired') return { ok:false,msg_id:'license_expired' };
  const lu=new Date().toISOString(); updKey(code,{ lastUsed:lu }); rec.lastUsed=lu;
  return { ok:true,body:{ success:true,user:toUser(code,rec),auth_google:EMPTY_GOOGLE,user_status:st==='active'?'active':'free' } };
}
async function regPhone(rec,ph,ip) {
  const p=String(ph||'').replace(/\D/g,''); if (!p||p.length<8) return;
  const patch={};
  if (rec.lastPhone!==p) patch.lastPhone=p; if (ip&&rec.lastIp!==ip) patch.lastIp=ip;
  if (!(rec.phones||[]).includes(p)) patch.phones=[...(rec.phones||[]),p];
  if (Object.keys(patch).length) { await updKey(rec.code,patch); Object.assign(rec,patch); }
}

async function addLog(type,msg,meta={}) {
  if (!db) return;
  try {
    await db.collection(COL.logs).insertOne({ id:crypto.randomBytes(8).toString('hex'),at:new Date().toISOString(),type,message:msg,meta });
    if (!_trimT) _trimT=setTimeout(async()=>{ _trimT=null; try { const n=await db.collection(COL.logs).countDocuments(); const ex=n-cfg.logMax; if (ex>0) { const old=await db.collection(COL.logs).find({}).sort({ at:1 }).limit(ex).project({ _id:1 }).toArray(); await db.collection(COL.logs).deleteMany({ _id:{ $in:old.map(o=>o._id) } }); } } catch {} },LOG_TRIM_MS).unref();
  } catch {}
}
async function getLogs(n=200) { if (!db) return []; try { return await db.collection(COL.logs).find({}).sort({ at:-1 }).limit(n).toArray(); } catch { return []; } }

function chkRate(ip,limit=10,windowMs=60_000,blockMs=300_000) {
  const k=`${ip}:l`,n=Date.now(); let e=rateMap.get(k);
  if (!e||n>e.reset) e={ count:0,reset:n+windowMs,blockedUntil:0 };
  if (n<e.blockedUntil) return false;
  e.count++; if (e.count>limit) e.blockedUntil=n+blockMs;
  rateMap.set(k,e); return e.count<=limit;
}
function recentVal(code,w=240_000) { const k=`v:${code}`,n=Date.now(); if (n-(rateMap.get(k)||0)<w) return true; rateMap.set(k,n); return false; }

function x(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
const BURL=/trackerdigital\.com\.br/i;
function sanUrl(v) { if (v==null) return v; if (typeof v==='string') return BURL.test(v)?'':v; if (Array.isArray(v)) return v.map(sanUrl); if (typeof v==='object') return Object.fromEntries(Object.entries(v).map(([k,vl])=>[k,sanUrl(vl)])); return v; }
function json(res,d,s=200) { if (res.headersSent) return; const b=JSON.stringify(d); res.writeHead(s,{ 'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(b) }); res.end(b); }
function html(res,h,s=200) { if (res.headersSent) return; res.writeHead(s,{ 'Content-Type':'text/html; charset=utf-8' }); res.end(h); }
function txt(res,t,s=200) { if (res.headersSent) return; res.writeHead(s,{ 'Content-Type':'text/plain; charset=utf-8' }); res.end(t); }
const SEC_HEADERS = {
  'X-Content-Type-Options':    'nosniff',
  'X-Frame-Options':           'DENY',
  'X-XSS-Protection':          '0',
  'Referrer-Policy':           'strict-origin-when-cross-origin',
  'Permissions-Policy':        'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
function applyHeaders(res,extra={}) { for (const [k,v] of Object.entries({ ...SEC_HEADERS,...extra })) res.setHeader(k,v); }
function cors(req,res,p) {
  const panel=p.startsWith(RA)||p.startsWith(RM);
  applyHeaders(res,{
    'Access-Control-Allow-Origin':  panel?'null':(req.headers.origin||'*'),
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,access-token,accept',
    'Access-Control-Max-Age':       '86400',
  });
}
async function readBody(req,max=2*1024*1024) { return new Promise((res,rej)=>{ const c=[];let sz=0; req.on('data',d=>{ sz+=d.length; if(sz>max){rej(new Error('too_large'));req.destroy();return;} c.push(d); }); req.on('end',()=>res(Buffer.concat(c).toString('utf8'))); req.on('error',rej); }); }
async function bodyJson(req) { try { const r=await readBody(req); return r?JSON.parse(r):{}; } catch { return {}; } }
function hasToken(req) { return req.headers['access-token']===cfg.token; }
function bearerTok(req) { return /^Bearer\s+(.+)$/i.exec(req.headers.authorization||'')?.[1]?.trim()||''; }
function wppUpd() { return { success:true,version:WPP_VERSION,update:false,message:'WaSpeed server ok' }; }
function parseExp(b) { const d=parseInt(b.expireDays||0,10)||0,h=parseInt(b.expireHours||0,10)||0,m=parseInt(b.expireMinutes||0,10)||0; if (!d&&!h&&!m) return { expiresAt:null,expireDays:0 }; return { expiresAt:new Date(Date.now()+((d*1440)+(h*60)+m)*60_000).toISOString(),expireDays:d }; }

const BASE_CSS = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
:root{--bg:#020904;--s0:#060e09;--s1:#0b1a0f;--s2:#0f2116;--bd:#1a3d26;--bd2:#245233;--t0:#e8fff2;--t1:#9dc4ad;--t2:#5a8a6a;--g:#2aff6e;--gd:#00e055;--gg:linear-gradient(135deg,#2aff6e,#00ff88 50%,#00cc55);--re:#ff3355;--rb:#1f0008;--rt:#ff7a8a;--ya:#ffcc00;--sh:0 2px 24px rgba(0,0,0,.6);--glow:0 0 16px rgba(42,255,110,.2),0 0 40px rgba(0,255,136,.08);--ring:rgba(42,255,110,.3)}
*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--t0);line-height:1.6;min-height:100vh}
a{color:var(--g);text-decoration:none;transition:color .15s}a:hover{color:#7fffaa}
::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:var(--s0)}::-webkit-scrollbar-thumb{background:var(--bd2);border-radius:3px}`;

const ADMIN_CSS = BASE_CSS+`
body{background-image:radial-gradient(ellipse 60% 40% at 20% 0,rgba(42,255,110,.06),transparent),radial-gradient(ellipse 40% 30% at 80% 100%,rgba(0,255,136,.04),transparent)}
.layout{display:flex;min-height:100vh}
.sidebar{width:52px;min-height:100vh;background:var(--s0);border-right:1px solid var(--bd);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow:hidden;flex-shrink:0;transition:width .2s ease}
.sidebar:hover,.sidebar.open{width:210px}
.sb-brand{padding:14px 10px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--bd);white-space:nowrap;overflow:hidden;min-height:56px}
.sb-logo{width:32px;height:32px;border-radius:9px;background:var(--gg);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:.7rem;color:#020904;letter-spacing:.04em;box-shadow:var(--glow);flex-shrink:0}
.sb-info{overflow:hidden;opacity:0;transition:opacity .15s .05s;white-space:nowrap}
.sidebar:hover .sb-info,.sidebar.open .sb-info{opacity:1}
.sb-name{font-weight:800;font-size:.88rem;color:var(--t0);letter-spacing:-.02em}
.sb-role{font-size:.62rem;color:var(--t2);font-weight:500;text-transform:uppercase;letter-spacing:.04em}
.sb-nav{padding:8px 8px;flex:1;overflow:hidden}
.sb-sec{font-size:.58rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--t2);padding:10px 4px 4px;white-space:nowrap;overflow:hidden;opacity:0;transition:opacity .15s}
.sidebar:hover .sb-sec,.sidebar.open .sb-sec{opacity:1}
.sb-lnk{display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;color:var(--t1);font-size:.82rem;font-weight:500;transition:all .15s;cursor:pointer;border:none;background:transparent;width:100%;text-align:left;text-decoration:none;white-space:nowrap;overflow:hidden}
.sb-lnk:hover{background:var(--s2);color:var(--t0)}
.sb-lnk.on{background:rgba(42,255,110,.1);color:var(--g);font-weight:600}
.sb-lnk svg{width:16px;height:16px;flex-shrink:0;opacity:.6;transition:opacity .15s}
.sb-lnk:hover svg,.sb-lnk.on svg{opacity:1}
.sb-lnk span{overflow:hidden;opacity:0;transition:opacity .15s .05s}
.sidebar:hover .sb-lnk span,.sidebar.open .sb-lnk span{opacity:1}
.sb-bot{padding:8px;border-top:1px solid var(--bd)}
.sb-out{display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;color:var(--t2);font-size:.8rem;cursor:pointer;transition:all .15s;text-decoration:none;border:none;background:transparent;width:100%;white-space:nowrap;overflow:hidden}
.sb-out:hover{color:var(--re);background:rgba(255,51,85,.06)}
.sb-out svg{width:16px;height:16px;flex-shrink:0}
.sb-out span{overflow:hidden;opacity:0;transition:opacity .15s .05s}
.sidebar:hover .sb-out span,.sidebar.open .sb-out span{opacity:1}
.main{flex:1;overflow-x:hidden;min-width:0}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:52px;border-bottom:1px solid var(--bd);background:rgba(6,14,9,.9);backdrop-filter:blur(12px);position:sticky;top:0;z-index:20;gap:12px}
.pg-title{font-size:1rem;font-weight:700;letter-spacing:-.02em;display:flex;align-items:center;gap:8px}
.tb-right{display:flex;align-items:center;gap:8px}
.ts{font-size:.7rem;color:var(--t2);font-variant-numeric:tabular-nums}
.content{padding:20px 24px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:20px}
.stat{background:var(--s1);border:1px solid var(--bd);border-radius:11px;padding:14px 16px;display:flex;align-items:center;gap:12px;transition:all .15s;cursor:default;overflow:hidden}
.stat:hover{border-color:var(--bd2)}
.stat .si{width:36px;height:36px;border-radius:9px;background:var(--s2);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.stat .si svg{width:16px;height:16px;color:var(--t2)}
.stat.hi .si{background:rgba(42,255,110,.1)} .stat.hi .si svg{color:var(--g)}
.stat.warn .si{background:rgba(255,204,0,.08)} .stat.warn .si svg{color:var(--ya)}
.stat.danger .si{background:rgba(255,51,85,.08)} .stat.danger .si svg{color:var(--re)}
.stat .sd .val{font-size:1.5rem;font-weight:900;line-height:1;letter-spacing:-.04em}
.stat.hi .sd .val{color:var(--g);text-shadow:0 0 16px rgba(42,255,110,.35)}
.stat.warn .sd .val{color:var(--ya)} .stat.danger .sd .val{color:var(--re)}
.stat .sd .lbl{font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--t2);margin-top:1px}
.panel{background:var(--s1);border:1px solid var(--bd);border-radius:13px;overflow:hidden;margin-bottom:18px}
.ph{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:12px 16px;border-bottom:1px solid var(--bd)}
.pt{font-weight:600;font-size:.85rem;display:flex;align-items:center;gap:8px;color:var(--t0);white-space:nowrap}
.pt svg{width:14px;height:14px;flex-shrink:0}
.btn svg{width:13px;height:13px;flex-shrink:0}
.gen-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.gen-row input,.gen-row select{padding:6px 9px;border-radius:7px;border:1px solid var(--bd);background:var(--s0);color:var(--t0);font:inherit;font-size:.78rem;transition:border-color .15s;height:30px}
.gen-row input:focus,.gen-row select:focus{outline:none;border-color:var(--g)}
.gen-row input[type=number]{width:54px}
.gen-row input[type=text]{width:130px}
.gen-row label{display:flex;align-items:center;gap:5px;font-size:.75rem;color:var(--t2);cursor:pointer;white-space:nowrap}
.gen-row input[type=checkbox]{width:14px;height:14px;accent-color:var(--g)}
.flt-row{display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px;border-bottom:1px solid var(--bd);align-items:center}
.flt-row input,.flt-row select{flex:1;min-width:160px;padding:7px 11px;border-radius:7px;border:1px solid var(--bd);background:var(--s0);color:var(--t0);font:inherit;font-size:.8rem;height:32px}
.flt-row input:focus,.flt-row select:focus{outline:none;border-color:var(--g)}
.flt-count{font-size:.72rem;color:var(--t2);white-space:nowrap}
.ov{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.78rem}
thead{position:sticky;top:52px;background:var(--s0);z-index:1}
th{padding:9px 13px;text-align:left;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--t2);border-bottom:1px solid var(--bd);white-space:nowrap;cursor:pointer;user-select:none;transition:color .15s}
th:hover{color:var(--g)} th.sort-asc::after{content:' ↑'} th.sort-desc::after{content:' ↓'}
td{padding:9px 13px;border-bottom:1px solid rgba(26,61,38,.4);vertical-align:middle}
tr.kr:hover td{background:rgba(42,255,110,.03)}
tr.kr:last-child td{border-bottom:none}
.chip{font-family:ui-monospace,'Cascadia Code',monospace;font-size:.72rem;background:rgba(42,255,110,.06);border:1px solid rgba(42,255,110,.18);color:#7fffaa;padding:2px 8px;border-radius:5px;white-space:nowrap;letter-spacing:.02em;display:inline-block}
.badge{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:999px;font-size:.62rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}
.b-ok{background:rgba(42,255,110,.1);color:var(--g);border:1px solid rgba(42,255,110,.22)} .b-ok::before{content:'●';font-size:.5rem}
.b-off{background:rgba(255,51,85,.08);color:var(--rt);border:1px solid rgba(255,51,85,.18)} .b-off::before{content:'✕';font-size:.55rem}
.b-free{background:rgba(255,204,0,.08);color:var(--ya);border:1px solid rgba(255,204,0,.18)} .b-free::before{content:'◌';font-size:.65rem}
.b-warn{background:rgba(255,150,0,.08);color:#ffaa44;border:1px solid rgba(255,150,0,.18)} .b-warn::before{content:'⏳';font-size:.55rem}
.b-wait{background:rgba(100,100,255,.08);color:#aaaaff;border:1px solid rgba(100,100,255,.18)} .b-wait::before{content:'◷';font-size:.55rem}
.val-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:6px;font-size:.72rem;font-weight:600;white-space:nowrap}
.vp-ok{background:rgba(42,255,110,.08);color:var(--g);border:1px solid rgba(42,255,110,.15)}
.vp-warn{background:rgba(255,150,0,.1);color:#ffaa44;border:1px solid rgba(255,150,0,.2)}
.vp-exp{background:rgba(255,51,85,.08);color:var(--rt);border:1px solid rgba(255,51,85,.18)}
.vp-free{color:var(--t2);font-size:.7rem}
.act-row{display:flex;gap:3px;flex-wrap:nowrap}
.ab{padding:3px 7px;border-radius:5px;border:1px solid var(--bd);background:transparent;color:var(--t1);font-size:.68rem;cursor:pointer;transition:all .12s;white-space:nowrap;font-family:inherit}
.ab:hover{border-color:var(--bd2);color:var(--t0);background:var(--s2)}
.ab.grn{border-color:rgba(42,255,110,.22);color:var(--g)} .ab.grn:hover{background:rgba(42,255,110,.07)}
.ab.red{border-color:rgba(255,51,85,.22);color:var(--rt)} .ab.red:hover{background:rgba(255,51,85,.06)}
.ab.blu{border-color:rgba(100,150,255,.22);color:#aac0ff} .ab.blu:hover{background:rgba(100,150,255,.06)}
.ab.yel{border-color:rgba(255,204,0,.22);color:var(--ya)} .ab.yel:hover{background:rgba(255,204,0,.06)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:6px 14px;border:none;border-radius:8px;font:inherit;font-size:.8rem;font-weight:600;cursor:pointer;text-decoration:none;color:#020904;background:var(--gg);transition:all .15s;box-shadow:0 2px 10px rgba(42,255,110,.22);height:30px}
.btn:hover{transform:translateY(-1px);box-shadow:0 3px 16px rgba(42,255,110,.38);color:#020904}
.btn-sm{height:26px;padding:4px 10px;font-size:.74rem;border-radius:7px}
.btn-ghost{background:transparent;border:1px solid var(--bd);color:var(--t1);box-shadow:none;height:30px} .btn-ghost:hover{background:var(--s2);border-color:var(--bd2);color:var(--t0)}
.btn-red{background:linear-gradient(135deg,#cc0022,#ff3355);color:#fff;box-shadow:0 2px 10px rgba(255,51,85,.22)} .btn-red:hover{box-shadow:0 3px 16px rgba(255,51,85,.38)}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--t2)}
.field input,.field select,.field textarea{padding:9px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--s0);color:var(--t0);font:inherit;font-size:.85rem;transition:border-color .15s,box-shadow .15s}
.field input:focus,.field select:focus,.field textarea:focus{outline:none;border-color:var(--g);box-shadow:0 0 0 3px var(--ring)}
.field textarea{resize:vertical;min-height:68px;width:100%}
.form-grid{display:grid;gap:16px}
.form-card{background:var(--s1);border:1px solid var(--bd);border-radius:13px;padding:24px;max-width:640px}
.alert-bar{padding:10px 14px;border-radius:8px;font-size:.8rem;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.ab-warn{background:rgba(255,204,0,.07);color:var(--ya);border:1px solid rgba(255,204,0,.2)}
.ab-danger{background:rgba(255,51,85,.07);color:var(--rt);border:1px solid rgba(255,51,85,.2)}
.toast{position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:9px;background:var(--s1);border:1px solid var(--g);color:var(--g);font-size:.8rem;font-weight:500;opacity:0;transition:opacity .22s;z-index:999;pointer-events:none;box-shadow:var(--glow);max-width:320px}
.toast.show{opacity:1} .toast.err{border-color:var(--re);color:var(--rt);box-shadow:none}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.75);display:none;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(4px)}
.modal-bg.open{display:flex}
.modal{background:var(--s1);border:1px solid var(--bd);border-radius:13px;padding:22px;max-width:400px;width:92%;box-shadow:var(--sh)}
.modal h3{font-size:.95rem;font-weight:700;margin-bottom:14px;color:var(--t0)}
.modal .mfield{margin-bottom:12px} .modal .mrow{display:flex;gap:8px;margin-top:14px}
.empty{text-align:center;padding:40px;color:var(--t2);font-size:.82rem}
.log-row td{font-size:.75rem} .log-type{font-family:ui-monospace,monospace;font-size:.68rem;color:var(--gd);background:rgba(42,255,110,.06);padding:1px 6px;border-radius:4px;white-space:nowrap}
@media(max-width:640px){.content{padding:12px 14px}.topbar{padding:0 14px}.gen-row input[type=text]{width:100px}}`;

const LOGIN_CSS = BASE_CSS+`
body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;background-image:radial-gradient(ellipse 70% 50% at 50% -10%,rgba(42,255,110,.08),transparent)}
.lw{width:100%;max-width:380px;display:flex;flex-direction:column;align-items:center;gap:24px}
.l-brand{display:flex;align-items:center;gap:10px}
.l-logo{width:40px;height:40px;border-radius:11px;background:var(--gg);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:.78rem;color:#020904;box-shadow:var(--glow)}
.l-name{font-weight:900;font-size:1.2rem;letter-spacing:-.03em;color:var(--t0)}
.l-card{width:100%;background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:28px;box-shadow:var(--sh)}
.l-card h2{font-size:1rem;font-weight:700;margin-bottom:2px}
.l-card .sub{font-size:.76rem;color:var(--t2);margin-bottom:20px}
.l-field{margin-bottom:12px}
.l-field label{display:block;font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--t2);margin-bottom:5px}
.l-field input{width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--s0);color:var(--t0);font:inherit;font-size:.86rem;transition:border-color .15s,box-shadow .15s}
.l-field input:focus{outline:none;border-color:var(--g);box-shadow:0 0 0 3px var(--ring)}
.l-btn{width:100%;padding:10px;border:none;border-radius:8px;background:var(--gg);color:#020904;font:inherit;font-size:.86rem;font-weight:700;cursor:pointer;transition:all .15s;box-shadow:0 2px 14px rgba(42,255,110,.28);margin-top:6px}
.l-btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(42,255,110,.42)}
.l-err{background:rgba(255,51,85,.08);border:1px solid rgba(255,51,85,.2);color:var(--rt);padding:9px 12px;border-radius:7px;font-size:.78rem;margin-bottom:12px}`;

const CLIENT_CSS = BASE_CSS+`
body{padding:0;background-image:radial-gradient(ellipse 60% 50% at 50% -5%,rgba(42,255,110,.07),transparent)}
.cw{max-width:500px;margin:0 auto;padding:32px 20px 60px}
.c-brand{display:flex;align-items:center;gap:9px;margin-bottom:28px}
.c-logo{width:34px;height:34px;border-radius:9px;background:var(--gg);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:.68rem;color:#020904;box-shadow:var(--glow);flex-shrink:0}
.c-name{font-weight:800;font-size:.95rem;letter-spacing:-.02em}
.c-card{background:var(--s1);border:1px solid var(--bd);border-radius:13px;padding:20px;margin-bottom:12px;box-shadow:var(--sh)}
.c-card h2{font-size:.88rem;font-weight:700;margin-bottom:14px;color:var(--t1);text-transform:uppercase;letter-spacing:.05em;font-size:.68rem}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
.met{background:var(--s0);border:1px solid var(--bd);border-radius:9px;padding:12px;text-align:center}
.met .mv{font-size:.95rem;font-weight:800;margin-bottom:2px;line-height:1.2}
.met .ml{font-size:.6rem;color:var(--t2);text-transform:uppercase;letter-spacing:.05em}
.kv{display:flex;flex-direction:column;gap:9px}
.kv-row{display:flex;flex-wrap:wrap;gap:4px;align-items:baseline}
.kv-lbl{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--t2);min-width:100px;flex-shrink:0}
.kv-val{font-size:.83rem;color:var(--t0)}
.steps{list-style:none;counter-reset:s;margin-top:8px}
.steps li{counter-increment:s;padding:8px 0 8px 34px;position:relative;color:var(--t1);font-size:.83rem;border-bottom:1px solid var(--bd)}
.steps li:last-child{border-bottom:none}
.steps li::before{content:counter(s);position:absolute;left:0;top:8px;width:20px;height:20px;border-radius:50%;background:var(--s2);border:1px solid var(--bd);display:flex;align-items:center;justify-content:center;font-size:.62rem;font-weight:700;color:var(--g)}
.c-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.c-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:none;border-radius:8px;background:var(--gg);color:#020904;font:inherit;font-size:.8rem;font-weight:700;cursor:pointer;text-decoration:none;transition:all .15s;box-shadow:0 2px 10px rgba(42,255,110,.22)}
.c-btn:hover{transform:translateY(-1px);box-shadow:0 4px 18px rgba(42,255,110,.38);color:#020904}
.c-btn-ghost{background:transparent;border:1px solid var(--bd);color:var(--t1);box-shadow:none}
.c-btn-ghost:hover{background:var(--s2);color:var(--t0)}`;

function svg(d) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`; }
const IC = {
  dash:  svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  key:   svg('<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>'),
  log:   svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
  out:   svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  ref:   svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.18-5"/>'),
  dl:    svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  plus:  svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  total: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>'),
  pro:   svg('<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>'),
  free:  svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'),
  exp:   svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  warn:  svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  logs2: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
};

function lnk(href,label,ic,active,cur) { return `<a href="${href}" class="sb-lnk${cur===active?' on':''}">${ic}<span>${x(label)}</span></a>`; }
function sidebar(active,role='admin',name='') {
  const nav=role==='admin'
    ?`<div class="sb-sec">Menu</div>${lnk(RA,'Dashboard',IC.dash,'dash',active)}${lnk(RA+'/keys','Licenças',IC.key,'keys',active)}${lnk(RA+'/logs','Logs',IC.log,'logs',active)}`
    :`<div class="sb-sec">Menu</div>${lnk(RM,'Licenças',IC.key,'keys',active)}`;
  const lo=role==='admin'?`${RA}/logout`:`${RM}/logout`;
  return `<aside class="sidebar" id="sb">
<div class="sb-brand"><div class="sb-logo">WS</div><div class="sb-info"><div class="sb-name">WaSpeed</div><div class="sb-role">${x(role==='admin'?'Admin':'Mod')}</div></div></div>
<nav class="sb-nav">${nav}</nav>
<div class="sb-bot"><a href="${lo}" class="sb-out">${IC.out}<span>Sair</span></a></div>
</aside>`;
}
function adminPage(title,content,active,role='admin',name='',extra='') {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${x(title)} — WaSpeed</title><style>${ADMIN_CSS}</style></head><body>
<div class="layout">${sidebar(active,role,name)}
<div class="main"><div class="topbar"><span class="pg-title">${x(title)}</span><div class="tb-right"><span class="ts" id="ts"></span>${extra}</div></div>
<div class="content">${content}</div></div></div>
<div id="toast" class="toast"></div>
<div id="mbg" class="modal-bg" onclick="if(event.target===this)cM()"><div class="modal" id="mbox"></div></div>
<script>
function toast(m,ok=true){const t=document.getElementById('toast');t.textContent=m;t.className='toast show'+(ok?'':' err');setTimeout(()=>t.className='toast',3200);}
function cM(){document.getElementById('mbg').classList.remove('open');}
document.getElementById('ts').textContent=new Date().toLocaleTimeString('pt-BR');
</script></body></html>`;
}
function loginPage(role,base,err='') {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar — WaSpeed</title><style>${LOGIN_CSS}</style></head><body>
<div class="lw"><div class="l-brand"><div class="l-logo">WS</div><div class="l-name">WaSpeed</div></div>
<div class="l-card"><h2>Bem-vindo</h2><p class="sub">Painel ${x(role)}</p>
${err?`<div class="l-err">${x(err)}</div>`:''}
<form method="post" action="${base}/login">
<div class="l-field"><label>Usuário</label><input name="user" required autocomplete="username" placeholder="seu usuário" autofocus></div>
<div class="l-field"><label>Senha</label><input name="pass" type="password" required autocomplete="current-password" placeholder="••••••••"></div>
<button class="l-btn" type="submit">Entrar</button>
</form></div></div></body></html>`;
}

function badge(st) {
  if (st==='active')  return '<span class="badge b-ok">PRO</span>';
  if (st==='blocked') return '<span class="badge b-off">Bloqueado</span>';
  if (st==='expired') return '<span class="badge b-off">Expirado</span>';
  return '<span class="badge b-free">Free</span>';
}

function valPill(rec) {
  if (!rec.expiresAt) return '<span class="kv-val" style="color:var(--t2)">Sem limite</span>';
  const dl=daysLeft(rec);
  const dt=new Date(rec.expiresAt).toLocaleDateString('pt-BR',{ day:'2-digit',month:'2-digit',year:'2-digit',timeZone:'America/Sao_Paulo' });
  if (dl===0||expired(rec)) return `<span class="val-pill vp-exp">Vencida ${x(dt)}</span>`;
  if (dl<=cfg.warnH/24)     return `<span class="val-pill vp-warn">${dl}d restantes · ${x(dt)}</span>`;
  return `<span class="val-pill vp-ok">${dl}d restantes · ${x(dt)}</span>`;
}
function usesCell(rec) { const u=(rec.phones||[]).length,m=rec.maxUses??-1; const lbl=m===-1?`${u}/∞`:`${u}/${m}`; const warn=m!==-1&&u>=m; return `<span style="${warn?'color:var(--ya)':'color:var(--t1)'}">${lbl}</span>`; }

function buildRows(list) {
  return list.map(k=>{
    const st=pStatus(k),mu=k.maxUses??-1;
    const wppV=k.wppVersion?`<span style="font-size:.68rem;color:var(--t2)">${x(k.wppVersion)}</span>`:'<span style="color:var(--bd2)">—</span>';
    const phones=(k.phones||[]);
    const phonesCell=phones.length>0
      ?`<span style="font-size:.72rem">${x(phones[0])}${phones.length>1?` <span style="color:var(--t2)">+${phones.length-1}</span>`:''}</span>`
      :'<span style="color:var(--bd2)">—</span>';
    return `<tr class="kr" data-code="${x(k.code)}" data-label="${x((k.label||'').toLowerCase())}" data-status="${st}" data-validity="${k.expiresAt||''}" data-uses="${phones.length}" data-phone="${x(k.lastPhone||'')}" data-lastused="${k.lastUsed||''}" data-created="${k.createdAt||''}">
<td><code class="chip">${x(k.code)}</code></td>
<td style="font-weight:500;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${x(k.label||'—')}</td>
<td>${badge(kStatus(k))}</td>
<td>${valPill(k)}</td>
<td>${usesCell(k)}</td>
<td>${phonesCell}</td>
<td style="font-size:.72rem;color:var(--t2)">${x(k.lastIp||'—')}</td>
<td style="font-size:.72rem;color:var(--t2)">${k.lastUsed?new Date(k.lastUsed).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—'}</td>
<td style="font-size:.72rem;color:var(--t2)">${k.createdAt?new Date(k.createdAt).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit'}):'—'}</td>
<td>${wppV}</td>
<td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.7rem;color:var(--t2)" title="${x(k.note||'')}">${x(k.note||'—')}</td>
<td><div class="act-row">
<button class="ab grn" onclick="apiTog('${x(k.code)}')" title="${k.active?'Bloquear':'Liberar'}">${k.active?'Bloq':'Lib'}</button>
<button class="ab" onclick="oRenew('${x(k.code)}')" title="Adicionar tempo">+T</button>
<button class="ab blu" onclick="oNums('${x(k.code)}')" title="Ver números">Nums</button>
<button class="ab yel" onclick="oUses('${x(k.code)}',${mu})" title="Limite de usos">Usos</button>
<button class="ab red" onclick="apiDel('${x(k.code)}')" title="Excluir">Del</button>
</div></td></tr>`;
  }).join('');
}

async function panelData() {
  const [list,logCount]=await Promise.all([listKeys(),db?db.collection(COL.logs).countDocuments():Promise.resolve(0)]);
  let ac=0,fr=0,bl=0,ex=0,wn=0;
  for (const k of list) { const s=kStatus(k); if(s==='active')ac++;else if(s==='free')fr++;else if(s==='blocked')bl++;else if(s==='expired')ex++; if(soonExp(k))wn++; }
  const stats={ totalKeys:list.length,activeKeys:ac,freeKeys:fr,blockedKeys:bl,expiredKeys:ex,warnKeys:wn,totalLogs:logCount };
  const now=Date.now();
  if (!_pkCache||now-_pkTs>=PANEL_CACHE_MS) { _pkCache=buildRows(list); _pkTs=now; }
  return { stats,keysHtml:_pkCache,lbl:Object.fromEntries(list.map(k=>[k.code,k.label||'—'])) };
}
function buildLogsHtml(logs,lbl={}) {
  if (!logs.length) return '<tr><td colspan="5" class="empty">Nenhum registro.</td></tr>';
  return logs.map(l=>{
    const code=l.meta?.code||l.meta?.key||'',cl=lbl[code]||'—';
    const typeColor=l.type.includes('fail')?'color:var(--rt)':l.type.includes('ok')?'color:var(--g)':'';
    return `<tr data-log="${x((l.type+' '+l.message+' '+cl).toLowerCase())}">
<td style="white-space:nowrap;color:var(--t2)">${new Date(l.at).toLocaleString('pt-BR',{ day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit' })}</td>
<td><span class="log-type" style="${typeColor}">${x(l.type)}</span></td>
<td style="color:var(--t0)">${x(l.message)}</td>
<td style="color:var(--t1)">${x(cl)}</td>
<td>${code?`<code class="chip" style="font-size:.66rem">${x(code)}</code>`:''}</td></tr>`;
  }).join('');
}

function renderDash(pd,lgs) {
  const { stats:s,keysHtml:kh,lbl }=pd;
  const w=s.warnKeys,ex=s.expiredKeys;
  const statsHtml=`<div class="stats">
<div class="stat"><div class="si">${IC.total}</div><div class="sd"><div class="val" id="s-total">${s.totalKeys}</div><div class="lbl">Total</div></div></div>
<div class="stat hi"><div class="si">${IC.pro}</div><div class="sd"><div class="val" id="s-active">${s.activeKeys}</div><div class="lbl">Ativas</div></div></div>
<div class="stat"><div class="si">${IC.free}</div><div class="sd"><div class="val" id="s-free">${s.freeKeys}</div><div class="lbl">Free</div></div></div>
<div class="stat${ex?' danger':''}"><div class="si">${IC.exp}</div><div class="sd"><div class="val" id="s-expired">${s.expiredKeys}</div><div class="lbl">Expiradas</div></div></div>
<div class="stat${w?' warn':''}"><div class="si">${IC.warn}</div><div class="sd"><div class="val" id="s-warn">${s.warnKeys}</div><div class="lbl">Expirando</div></div></div>
<div class="stat"><div class="si">${IC.logs2}</div><div class="sd"><div class="val" id="s-logs">${s.totalLogs}</div><div class="lbl">Logs</div></div></div>
</div>`;
  const alert=(ex||w)?`<div class="alert-bar ${ex?'ab-danger':'ab-warn'}">${IC.warn}${ex?`${ex} licença(s) expirada(s)`:''} ${ex&&w?'·':''} ${w?`${w} expirando em breve`:''}</div>`:'';
  const keySec=`<div class="panel">
<div class="ph">
<span class="pt">${IC.key} Chaves de Acesso</span>
<div class="gen-row">
<input type="text" id="nl" placeholder="Nome do cliente">
<input type="number" id="nd" placeholder="Dias" min="0" title="Dias">
<input type="number" id="nh" placeholder="H" min="0" title="Horas">
<input type="number" id="nm" placeholder="Min" min="0" title="Minutos">
<input type="number" id="nu" placeholder="Usos" min="-1" title="Máx dispositivos (-1=∞)" value="-1">
<select id="np"><option value="1">PRO</option><option value="0">Free</option></select>
<button class="btn btn-sm" onclick="genKey()">${IC.plus} Gerar Chave</button>
</div>
</div>
<div class="flt-row">
<input type="text" id="si" placeholder="🔍  Buscar por chave, nome, telefone ou IP..." oninput="flt()">
<select id="sf" onchange="flt()">
<option value="">Todos os status</option>
<option value="ativo">PRO ativas</option>
<option value="free">Free</option>
<option value="expirando">Expirando em breve</option>
<option value="expirada">Expiradas</option>
<option value="bloqueado">Bloqueadas</option>
</select>
<span class="flt-count" id="kcount">${s.totalKeys} chave(s)</span>
</div>
<div class="ov"><table>
<thead><tr>
<th onclick="srt('code')">Chave</th>
<th onclick="srt('label')">Cliente</th>
<th onclick="srt('status')">Status</th>
<th onclick="srt('validity')">Validade</th>
<th onclick="srt('uses')">Usos</th>
<th onclick="srt('phone')">Telefone</th>
<th>Último IP</th>
<th onclick="srt('lastused')">Último acesso</th>
<th onclick="srt('created')">Criada em</th>
<th>WPP Ver.</th>
<th>Notas</th>
<th>Ações</th>
</tr></thead>
<tbody id="kb">${kh}</tbody>
</table></div></div>`;
  const logSec=`<div class="panel">
<div class="ph">
<span class="pt">${IC.log} Logs do sistema</span>
<div style="display:flex;gap:8px;align-items:center">
<input type="text" id="li" placeholder="Filtrar logs..." oninput="fltLog()" style="padding:5px 10px;border-radius:7px;border:1px solid var(--bd);background:var(--s0);color:var(--t0);font-size:.78rem;width:160px;height:28px">
</div>
</div>
<div class="ov"><table>
<thead><tr><th>Data/Hora</th><th>Tipo</th><th>Mensagem</th><th>Cliente</th><th>Chave</th></tr></thead>
<tbody id="lb">${buildLogsHtml(lgs,lbl)}</tbody>
</table></div></div>`;
  const extra=`<button class="btn btn-ghost" style="height:28px;font-size:.74rem" onclick="doRef(true)">${IC.ref} Atualizar</button><button class="btn btn-ghost" style="height:28px;font-size:.74rem" onclick="expCsv()">${IC.dl} CSV</button>`;
  const js=`<script>
const _RA='${RA}';let _sc='created',_sd=-1;
function flt(){const q=(document.getElementById('si').value||'').toLowerCase(),st=document.getElementById('sf').value;let c=0;document.querySelectorAll('#kb tr.kr').forEach(r=>{const row=(r.dataset.code+r.dataset.label+r.dataset.phone+r.dataset.lastused).toLowerCase();const show=(!q||row.includes(q))&&(!st||r.dataset.status===st);r.style.display=show?'':'none';if(show)c++;});document.getElementById('kcount').textContent=c+' chave(s)';}
function fltLog(){const q=(document.getElementById('li').value||'').toLowerCase();document.querySelectorAll('#lb tr').forEach(r=>{r.style.display=!q||r.dataset.log?.includes(q)?'':'none';});}
function srt(c){if(_sc===c)_sd*=-1;else{_sc=c;_sd=1;}document.querySelectorAll('th').forEach(t=>{t.classList.remove('sort-asc','sort-desc');});const th=document.querySelector('th[onclick="srt(\''+c+'\')"]');if(th)th.classList.add(_sd===1?'sort-asc':'sort-desc');const tb=document.getElementById('kb'),rows=[...tb.querySelectorAll('tr.kr')];rows.sort((a,b)=>{const va=a.dataset[c]||'',vb=b.dataset[c]||'';return c==='uses'?_sd*(+va-+vb):_sd*(va<vb?-1:va>vb?1:0);});rows.forEach(r=>tb.appendChild(r));}
async function genKey(){const label=document.getElementById('nl').value.trim();if(!label){toast('Informe o nome do cliente',false);return;}
const b={label,premium:document.getElementById('np').value==='1'};
const d=+document.getElementById('nd').value||0,h=+document.getElementById('nh').value||0,m=+document.getElementById('nm').value||0;
if(d)b.expireDays=d;if(h)b.expireHours=h;if(m)b.expireMinutes=m;
const u=document.getElementById('nu').value.trim();if(u!=='')b.maxUses=parseInt(u);
const r=await fetch(_RA+'/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
if(r.status===401){location.href=_RA+'/login';return;}
const j=await r.json();if(j.ok){toast('✓ Chave gerada: '+j.key);['nl','nd','nh','nm'].forEach(id=>document.getElementById(id).value='');document.getElementById('nu').value='-1';doRef();}else toast(j.error||'Erro ao gerar',false);}
async function doRef(m){const r=await fetch(_RA+'/api/data');if(r.status===401){if(m)location.href=_RA+'/login';return;}
const d=await r.json();if(!d.ok)return;
document.getElementById('s-total').textContent=d.totalKeys;
document.getElementById('s-active').textContent=d.activeKeys;
document.getElementById('s-free').textContent=d.freeKeys;
document.getElementById('s-expired').textContent=d.expiredKeys;
document.getElementById('s-warn').textContent=d.warnKeys;
document.getElementById('s-logs').textContent=d.totalLogs;
document.getElementById('kb').innerHTML=d.keysHtml;
document.getElementById('lb').innerHTML=d.logsHtml;
document.getElementById('ts').textContent=new Date().toLocaleTimeString('pt-BR');flt();}
async function apiTog(c){const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(c)+'/toggle',{method:'POST'});if(r.ok){toast('Status alterado');doRef();}else toast('Falha',false);}
async function apiDel(c){if(!confirm('Excluir a chave '+c+'?\n\nEsta ação não pode ser desfeita.'))return;const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(c),{method:'DELETE'});if(r.ok){toast('Chave removida');doRef();}else toast('Falha ao remover',false);}
function oRenew(c){document.getElementById('mbox').innerHTML='<h3>Adicionar tempo — '+c+'</h3><div class="mfield"><div class="field"><label>Dias</label><input id="rd" type="number" min="0" value="30" style="width:100%"></div></div><div class="mfield"><div class="field"><label>Horas</label><input id="rh" type="number" min="0" value="0" style="width:100%"></div></div><div class="mrow"><button class="btn btn-sm" onclick="subRenew(\''+c+'\')">Confirmar</button><button class="btn btn-ghost btn-sm" onclick="cM()">Cancelar</button></div>';document.getElementById('mbg').classList.add('open');}
async function subRenew(c){const d=+document.getElementById('rd').value||0,h=+document.getElementById('rh').value||0;const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(c)+'/renew',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days:d,hours:h})});cM();if(r.ok){toast('Validade renovada');doRef();}else toast('Falha ao renovar',false);}
function oUses(c,cur){document.getElementById('mbox').innerHTML='<h3>Limite de dispositivos — '+c+'</h3><p style="font-size:.78rem;color:var(--t2);margin-bottom:12px">Informe -1 para ilimitado.</p><div class="mfield"><div class="field"><label>Máximo de usos</label><input id="mu" type="number" value="'+cur+'" style="width:100%"></div></div><div class="mrow"><button class="btn btn-sm" onclick="subUses(\''+c+'\')">Confirmar</button><button class="btn btn-ghost btn-sm" onclick="cM()">Cancelar</button></div>';document.getElementById('mbg').classList.add('open');}
async function subUses(c){const v=parseInt(document.getElementById('mu').value);const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(c)+'/max-uses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxUses:v})});cM();if(r.ok){toast('Limite atualizado');doRef();}else toast('Falha',false);}
async function oNums(c){const r=await fetch(_RA+'/api/keys/'+encodeURIComponent(c)+'/phones');if(!r.ok){toast('Erro',false);return;}const d=await r.json();const list=d.phones?.length?d.phones.map(p=>'<div style="padding:6px 0;border-bottom:1px solid var(--bd);font-family:monospace;font-size:.82rem">'+p+'</div>').join(''):'<p style="color:var(--t2);font-size:.82rem">Nenhum número registrado.</p>';document.getElementById('mbox').innerHTML='<h3>Números — '+c+'</h3><div style="max-height:280px;overflow-y:auto;margin:8px 0">'+list+'</div><div class="mrow"><button class="btn-ghost btn btn-sm" onclick="cM()">Fechar</button></div>';document.getElementById('mbg').classList.add('open');}
function expCsv(){location.href=_RA+'/api/export/csv';}
setInterval(()=>doRef(),60000);
</script>`;
  return adminPage('Dashboard',alert+statsHtml+keySec+logSec+js,'dash','admin','',extra);
}

function renderModDash(modName,list,lgs) {
  const ac=list.filter(k=>kStatus(k)==='active').length;
  const statsHtml=`<div class="stats">
<div class="stat"><div class="si">${IC.total}</div><div class="sd"><div class="val">${list.length}</div><div class="lbl">Suas chaves</div></div></div>
<div class="stat hi"><div class="si">${IC.pro}</div><div class="sd"><div class="val">${ac}</div><div class="lbl">PRO ativas</div></div></div>
</div>`;
  const sec=`<div class="panel">
<div class="ph"><span class="pt">${IC.key} Minhas Licenças</span>
<div class="gen-row">
<input type="text" id="nl" placeholder="Nome do cliente">
<select id="np"><option value="1">PRO</option><option value="0">Free</option></select>
<input type="number" id="nd" placeholder="Dias" min="0" title="Dias de validade">
<button class="btn btn-sm" onclick="genKey()">${IC.plus} Gerar</button>
</div></div>
<div class="flt-row"><input type="text" id="si" placeholder="Buscar..." oninput="flt()"><span class="flt-count" id="kcount">${list.length} chave(s)</span></div>
<div class="ov"><table>
<thead><tr><th>Chave</th><th>Cliente</th><th>Status</th><th>Validade</th><th>Usos</th><th>Telefone</th><th>Ações</th></tr></thead>
<tbody id="kb">${buildRows(list)}</tbody></table></div></div>`;
  const js=`<script>
const _RM='${RM}';
function flt(){const q=(document.getElementById('si').value||'').toLowerCase();let c=0;document.querySelectorAll('#kb tr.kr').forEach(r=>{const show=!q||(r.dataset.code+r.dataset.label+r.dataset.phone).toLowerCase().includes(q);r.style.display=show?'':'none';if(show)c++;});document.getElementById('kcount').textContent=c+' chave(s)';}
async function genKey(){const label=document.getElementById('nl').value.trim();if(!label){toast('Informe o nome',false);return;}
const b={label,premium:document.getElementById('np').value==='1'};const d=+document.getElementById('nd').value;if(d)b.expireDays=d;
const r=await fetch(_RM+'/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
if(r.status===401){location.href=_RM+'/login';return;}const j=await r.json();if(j.ok){toast('✓ '+j.key);document.getElementById('nl').value='';doRef();}else toast(j.error||'Erro',false);}
async function doRef(){const r=await fetch(_RM+'/api/data');if(r.status===401)return;const d=await r.json();if(d.ok){document.getElementById('kb').innerHTML=d.keysHtml;flt();}}
</script>`;
  const extra=`<button class="btn btn-ghost" style="height:28px;font-size:.74rem" onclick="doRef()">${IC.ref} Atualizar</button>`;
  return adminPage(`Olá, ${x(modName)}`,statsHtml+sec+js,'keys','mod',modName,extra);
}

function renderKeyForm(base,rec,title) {
  const code=rec?.code||'';
  return adminPage(title,`<form method="post"><div class="form-card"><div class="form-grid">
${code?`<div class="field"><label>Chave</label><code class="chip">${x(code)}</code></div>`:''}
<div style="display:grid;grid-template-columns:1fr auto;gap:12px">
<div class="field"><label>Nome do cliente</label><input name="label" value="${x(rec?.label||'')}" required placeholder="Nome ou empresa"></div>
<div class="field"><label>Tipo</label><select name="premium"><option value="1"${rec?.premium!==false?' selected':''}>PRO</option><option value="0"${rec?.premium===false?' selected':''}>Free</option></select></div>
</div>
<div class="field"><label>Dias de validade (0 = sem limite)</label><input name="expireDays" type="number" min="0" value="${rec?.expireDays||0}"></div>
<div class="field"><label>Nota interna</label><textarea name="note" rows="3">${x(rec?.note||'')}</textarea></div>
<div style="display:flex;gap:8px"><button class="btn" type="submit">Salvar</button><a href="${base}/keys" class="btn btn-ghost">Cancelar</a></div>
</div></div></form>`,'keys','admin');
}

function renderKeysList(list,base) {
  if (!list.length) return '<div class="empty">Nenhuma chave cadastrada.</div>';
  const rows=list.map(({ code,rec })=>{
    const st=kStatus(rec),exp=rec.expiresAt?new Date(rec.expiresAt).toLocaleDateString('pt-BR'):'Sem limite';
    return `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--bd)">
<code class="chip">${x(code)}</code>
<span style="flex:1;min-width:120px;font-size:.83rem;font-weight:500">${x(rec.label)}</span>
${badge(st)}
<span style="font-size:.75rem;color:var(--t2)">${exp}</span>
<div style="display:flex;gap:6px;margin-left:auto">
<a href="${base}/keys/${encodeURIComponent(code)}" class="btn btn-ghost btn-sm">Editar</a>
<form method="post" action="${base}/keys/${encodeURIComponent(code)}/toggle" style="display:inline"><button class="btn btn-ghost btn-sm" type="submit">${rec.active?'Bloquear':'Liberar'}</button></form>
<form method="post" action="${base}/keys/${encodeURIComponent(code)}/delete" onsubmit="return confirm('Excluir?')" style="display:inline"><button class="btn btn-red btn-sm" type="submit">Excluir</button></form>
</div></div>`;
  }).join('');
  return `<div class="panel" style="padding:0;overflow:hidden">${rows}</div>`;
}
function renderLogsPage(logs) {
  const rows=logs.map(l=>`<tr><td style="white-space:nowrap;color:var(--t2)">${new Date(l.at).toLocaleString('pt-BR')}</td><td><span class="log-type">${x(l.type)}</span></td><td>${x(l.message)}</td></tr>`).join('');
  return adminPage('Logs',`<div class="panel"><div class="ov"><table><thead><tr><th>Data/Hora</th><th>Tipo</th><th>Mensagem</th></tr></thead><tbody>${rows||'<tr><td colspan="3" class="empty">Sem registros.</td></tr>'}</tbody></table></div></div>`,'logs','admin');
}

const PAGE_UNINSTALL=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Até logo — WaSpeed</title><style>${BASE_CSS}
body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:32px;background-image:radial-gradient(ellipse 70% 60% at 50% -10%,rgba(42,255,110,.07),transparent)}
.wrap{max-width:440px;width:100%;text-align:center;background:var(--s1);border:1px solid var(--bd);border-radius:18px;padding:44px 36px;box-shadow:0 8px 48px rgba(0,0,0,.5)}
.logo{width:72px;height:72px;border-radius:18px;background:var(--gg);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:1.3rem;color:#020904;margin:0 auto 20px;box-shadow:var(--glow)}
h1{font-size:1.35rem;font-weight:800;margin-bottom:10px;letter-spacing:-.03em}
p{color:var(--t1);font-size:.88rem;line-height:1.7;margin-bottom:6px}
.heart{color:var(--g);font-size:.82rem;margin-top:20px}
</style></head><body><div class="wrap"><div class="logo">WS</div><h1>Até logo!</h1><p>A extensão foi removida. Esperamos que o WaSpeed tenha sido útil para organizar seus atendimentos.</p><p>Se mudar de ideia, estaremos aqui quando precisar.</p><p class="heart">Obrigado por usar o WaSpeed · ZVM by LR1290</p></div></body></html>`;

const CLIENT_RE=/^\/([a-z0-9]{16,32})\/(auth-painel|login|recovery|auth-plugin|redirect-plugin-register|register)\/?$/i;

function clientPage(storeId,token,page,rec) {
  if (!rec) return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acesso negado — WaSpeed</title><style>${CLIENT_CSS}</style></head><body>
<div class="cw"><div class="c-brand"><div class="c-logo">WS</div><div class="c-name">WaSpeed</div></div>
<div class="c-card"><h2>Sessão inválida</h2><p style="color:var(--t1);font-size:.85rem;margin-bottom:16px">Token inválido ou sessão expirada. Faça login novamente pela extensão WaSpeed.</p>
<div class="c-actions"><button class="c-btn c-btn-ghost" onclick="history.length>1?history.back():window.close()">← Voltar</button></div></div></div></body></html>`;
  const code=rec.code||token,user=toUser(code,rec),st=kStatus(rec),prem=mkPremium(code,rec);
  const exp=rec.expiresAt?new Date(rec.expiresAt).toLocaleDateString('pt-BR',{ day:'2-digit',month:'2-digit',year:'numeric' }):'Sem vencimento';
  const dl=daysLeft(rec);
  const mets=`<div class="metrics">
<div class="met"><div class="mv">${badge(st)}</div><div class="ml">Status</div></div>
<div class="met"><div class="mv" style="font-size:.85rem">${x(prem?.data_liberacao||'—')}</div><div class="ml">Liberação</div></div>
<div class="met"><div class="mv" style="font-size:.85rem${dl&&dl<=7?';color:var(--ya)':''}">${dl!==null?dl+'d':exp}</div><div class="ml">${dl!==null?'Restantes':'Validade'}</div></div>
</div>`;
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Minha conta — WaSpeed</title><style>${CLIENT_CSS}</style></head><body>
<div class="cw">
<div class="c-brand"><div class="c-logo">WS</div><div class="c-name">WaSpeed</div></div>
<div class="c-card">
<h2>Minha conta</h2>${mets}
<div class="kv">
<div class="kv-row"><span class="kv-lbl">Nome</span><span class="kv-val" style="font-weight:600">${x(user.name)}</span></div>
<div class="kv-row"><span class="kv-lbl">Identificador</span><code class="chip" style="font-size:.72rem">${x(code)}</code></div>
${page?`<div class="kv-row"><span class="kv-lbl">Seção</span><span class="kv-val">${x(decodeURIComponent(page))}</span></div>`:''}
</div>
</div>
<div class="c-card">
<h2>WhatsApp</h2>
<div class="kv">
<div class="kv-row"><span class="kv-lbl">Número</span><span class="kv-val">${x(rec.lastPhone||'—')}</span></div>
<div class="kv-row"><span class="kv-lbl">Último acesso</span><span class="kv-val">${rec.lastUsed?new Date(rec.lastUsed).toLocaleString('pt-BR'):'—'}</span></div>
</div>
</div>
<div class="c-actions">
<button class="c-btn c-btn-ghost" onclick="history.length>1?history.back():window.close()">← Voltar</button>
</div>
</div></body></html>`;
}

function clientLoginPage(storeId) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Painel — WaSpeed</title><style>${CLIENT_CSS}</style></head><body>
<div class="cw">
<div class="c-brand"><div class="c-logo">WS</div><div class="c-name">WaSpeed</div></div>
<div class="c-card">
<h2>Acesso ao painel</h2>
<p style="color:var(--t1);font-size:.84rem;margin-bottom:14px">O acesso é feito pela extensão WaSpeed no WhatsApp Web.</p>
<ol class="steps">
<li>Abra o <strong>WhatsApp Web</strong> no Chrome</li>
<li>Clique no ícone do WaSpeed na barra de extensões</li>
<li>Faça login com sua <strong>chave de ativação</strong></li>
<li>Clique em <strong>Painel do Cliente</strong> na barra lateral</li>
</ol>
<div class="c-actions">
<a href="https://web.whatsapp.com" target="_blank" rel="noopener" class="c-btn">Abrir WhatsApp Web</a>
</div>
</div>
</div></body></html>`;
}

async function handleClientPanel(req,res,path,url) {
  const m=path.match(CLIENT_RE); if (!m) return false;
  const sid=m[1],route=m[2].toLowerCase();
  const tok=url.searchParams.get('token')||url.searchParams.get('bearer_token')||'';
  const pg=url.searchParams.get('page')||'';
  if (route==='auth-painel') { if (!tok) { res.writeHead(302,{ Location:`/${sid}/login` }); res.end(); return true; } html(res,clientPage(sid,tok,pg,await findBearer(tok))); return true; }
  if (route==='auth-plugin') { res.writeHead(302,{ Location:tok?`/${sid}/auth-painel?token=${encodeURIComponent(tok)}`:`/${sid}/login` }); res.end(); return true; }
  if (route==='redirect-plugin-register'||route==='register') { html(res,clientLoginPage(sid)); return true; }
  if (route==='recovery') { html(res,`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recuperar — WaSpeed</title><style>${CLIENT_CSS}</style></head><body><div class="cw"><div class="c-brand"><div class="c-logo">WS</div><div class="c-name">WaSpeed</div></div><div class="c-card"><h2>Recuperar acesso</h2><p style="color:var(--t1);font-size:.84rem;margin-bottom:12px">Entre em contato com o administrador para obter uma nova chave de ativação.</p><div class="c-actions"><a href="/${x(sid)}/login" class="c-btn c-btn-ghost">← Voltar</a></div></div></div></body></html>`); return true; }
  if (route==='login') { html(res,clientLoginPage(sid)); return true; }
  return false;
}

const RE=(()=>{
  const e=s=>s.replace(/[.*+?^${}()|[\]\\]/g,c=>`\\${c}`),a=e(RA),m=e(RM);
  return {
    aKey:    new RegExp(`^${a}/keys/([^/]+)$`),
    aToggle: new RegExp(`^${a}/keys/([^/]+)/toggle$`),
    aDelete: new RegExp(`^${a}/keys/([^/]+)/delete$`),
    apiTog:  new RegExp(`^${a}/api/keys/([^/]+)/toggle$`),
    apiRen:  new RegExp(`^${a}/api/keys/([^/]+)/renew$`),
    apiMU:   new RegExp(`^${a}/api/keys/([^/]+)/max-uses$`),
    apiDel:  new RegExp(`^${a}/api/keys/([^/]+)$`),
    apiPh:   new RegExp(`^${a}/api/keys/([^/]+)/phones$`),
    install: /^\/api\/urls\/install\//,
    uninst:  /^\/api\/urls\/uninstall\//,
    anotes:  /^\/api\/urls\/active-notes\//,
    notes:   /^\/api\/urls\/notes\//,
  };
})();

async function handleApi(req,res,path,ip) {
  const s=settings||{};
  if (RE.install.test(path))  { addLog('install','Install redirect',{ ip }); return json(res,{ success:true,url:s.installUrl||cfg.install }); }
  if (RE.uninst.test(path))   { res.writeHead(302,{ Location:`${cfg.base}/obrigado` }); res.end(); return; }
  if (RE.anotes.test(path))   return json(res,{ success:true,path_note_update:{ redirect:cfg.notes } });
  if (RE.notes.test(path))    { res.writeHead(200,{ 'Content-Type':'text/html; charset=utf-8' }); return res.end(s.notesHtml||'<h1>WaSpeed</h1>'); }
  if (path==='/api/urls/update'||path==='/api/services/update') return json(res,wppUpd());
  if (path==='/api/external/is_instaled'&&req.method==='POST') return json(res,{ success:true });
  if (path==='/api/external/ping') { let k=0; try { k=await db.collection(COL.licenses).countDocuments(); } catch {} return json(res,{ success:true,server:'waspeed',keys:k,storage:'mongodb' }); }
  if (!hasToken(req)) return json(res,{ success:false,msg_id:'invalid_access_token' },403);
  const cid=cfg.storeId;
  if (path===`/api/auth/login-bearer/${cid}`&&req.method==='GET') {
    if (!chkRate(ip)) return json(res,{ success:false,msg_id:'rate_limited' },429);
    const b=bearerTok(req),rec=await findBearer(b);
    if (!rec) { addLog('auth_fail','Bearer invalido',{ ip,code:b }); return json(res,{ success:false,msg_id:'invalid_token' }); }
    const r=await authOk(rec.code,rec); if (!r.ok) return json(res,{ success:false,msg_id:r.msg_id });
    addLog('auth_ok',`Login bearer ${rec.code}`,{ ip,code:rec.code }); return json(res,r.body);
  }
  if (path===`/api/auth/register-free/${cid}`&&req.method==='POST') {
    if (!chkRate(ip)) return json(res,{ success:false,msg_id:'rate_limited' },429);
    const b=await bodyJson(req),{ code,rec }=await freeKey(b.extension_id||b.device_id,ip);
    const r=await authOk(code,rec); if (!r.ok) return json(res,{ success:false,msg_id:r.msg_id });
    addLog('free_register',`Free ${code}`,{ ip,code }); return json(res,r.body);
  }
  if (path===`/api/auth/validation/${cid}`&&req.method==='POST') {
    if (!chkRate(ip)) return json(res,{ success:false,msg_id:'rate_limited' },429);
    const b=await bodyJson(req),key=normK(b.access_token_plugin||b.chave||b.senha||b.email);
    const rec=await findK(key);
    if (!rec) { addLog('auth_fail','Chave invalida',{ ip,code:key }); return json(res,{ success:false,msg_id:'invalid_token_in_validation' }); }
    const skip=recentVal(key); if (!skip) await regPhone(rec,b.whatsapp_plugin||b.whatsapp_registro,ip);
    if (b.wpp_version&&rec.wppVersion!==b.wpp_version) updKey(key,{ wppVersion:b.wpp_version });
    const r=await authOk(key,rec); if (!r.ok) return json(res,{ success:false,msg_id:r.msg_id });
    if (!skip) addLog('validation_ok',`Validacao ${key}`,{ ip,code:key }); return json(res,r.body);
  }
  if (path===`/api/auth/login/${cid}`&&req.method==='POST') {
    if (!chkRate(ip)) return json(res,{ success:false,msg_id:'rate_limited' },429);
    const b=await bodyJson(req),key=normK(b.senha||b.chave||b.email||b.access_token_plugin);
    const rec=await findK(key);
    if (!rec) { addLog('auth_fail','Login invalido',{ ip,code:key }); return json(res,{ success:false,msg_id:'invalid_token' }); }
    const r=await authOk(key,rec); if (!r.ok) return json(res,{ success:false,msg_id:r.msg_id });
    addLog('auth_ok',`Login ${key}`,{ ip,code:key }); return json(res,r.body);
  }
  if (path==='/api/user/update'&&req.method==='POST') {
    const b=await bodyJson(req),br=bearerTok(req)||b.bearer_token||b.access_token_plugin;
    const rec=await findBearer(br); if (!rec) return json(res,{ success:false,msg_id:'invalid_token' });
    await regPhone(rec,b.whatsapp_plugin||b.whatsapp_registro,ip);
    if (b.name) { await updKey(rec.code,{ label:b.name }); rec.label=b.name; }
    return json(res,{ success:true,user:toUser(rec.code,rec) });
  }
  if (path===`/api/services/initial-data/${cid}`) return json(res,{ webhooks:sanUrl(s.webhooks||[]),meet:sanUrl(s.meet||{}),urls:sanUrl(mergeUrls(s.urls||{})),migration:sanUrl(s.migration||{}) });
  if (path==='/api/image/url-to-base64'&&req.method==='POST') return json(res,{ success:false,msg_id:'not_implemented' });
  return false;
}

async function handleAdminApi(req,res,path) {
  if (path===`${RA}/api/data`&&req.method==='GET') {
    const [pd,lgs]=await Promise.all([panelData(),getLogs(150)]);
    return json(res,{ ok:true,...pd.stats,keysHtml:pd.keysHtml,logsHtml:buildLogsHtml(lgs,pd.lbl) });
  }
  if (path===`${RA}/api/keys`&&req.method==='POST') {
    const b=await bodyJson(req); if (!b.label?.trim()) return json(res,{ error:'label obrigatorio' },400);
    const { expiresAt,expireDays }=parseExp(b),mu=b.maxUses!==undefined?parseInt(b.maxUses,10):-1;
    try { const rec=await mkKey({ label:String(b.label).trim().slice(0,60),premium:b.premium!==false&&b.premium!==0&&b.premium!=='0',expiresAt,expireDays,maxUses:isNaN(mu)?-1:mu,note:String(b.note||'').slice(0,500) }); return json(res,{ ok:true,key:rec.code }); }
    catch (e) { return json(res,{ error:e.message },500); }
  }
  const ph=path.match(RE.apiPh); if (ph&&req.method==='GET') { const rec=await findK(decodeURIComponent(ph[1])); if (!rec) return json(res,{ error:'not found' },404); return json(res,{ ok:true,phones:rec.phones||[] }); }
  const tog=path.match(RE.apiTog); if (tog&&req.method==='POST') { const rec=await findK(decodeURIComponent(tog[1])); if (!rec) return json(res,{ error:'not found' },404); await updKey(rec.code,{ active:!rec.active }); return json(res,{ ok:true }); }
  const ren=path.match(RE.apiRen); if (ren&&req.method==='POST') {
    const rec=await findK(decodeURIComponent(ren[1])); if (!rec) return json(res,{ error:'not found' },404);
    const b=await bodyJson(req),ms=(((parseInt(b.days||0,10)||0)*1440)+((parseInt(b.hours||0,10)||0)*60))*60_000;
    if (!ms) return json(res,{ error:'informe tempo' },400);
    const base=(rec.expiresAt&&!expired(rec))?new Date(rec.expiresAt).getTime():Date.now();
    await updKey(rec.code,{ expiresAt:new Date(base+ms).toISOString(),active:true }); return json(res,{ ok:true });
  }
  const mu=path.match(RE.apiMU); if (mu&&req.method==='POST') {
    const rec=await findK(decodeURIComponent(mu[1])); if (!rec) return json(res,{ error:'not found' },404);
    const b=await bodyJson(req),v=parseInt(b.maxUses,10); if (isNaN(v)||v<-1) return json(res,{ error:'invalid' },400);
    await updKey(rec.code,{ maxUses:v }); return json(res,{ ok:true });
  }
  const dl=path.match(RE.apiDel); if (dl&&req.method==='DELETE') { const code=decodeURIComponent(dl[1]); await delKey(code); addLog('key_delete',`Chave ${code} excluida`,{ code }); return json(res,{ ok:true }); }
  if (path===`${RA}/api/export/csv`&&req.method==='GET') {
    const list=await listKeys();
    const lines=['code,label,premium,active,expiresAt,daysLeft,uses,maxUses,lastPhone,lastIp,lastUsed,createdAt,wppVersion,note'];
    for (const k of list) lines.push([k.code,k.label,k.premium,k.active,k.expiresAt||'',daysLeft(k)??'',( k.phones||[]).length,k.maxUses??-1,k.lastPhone||'',k.lastIp||'',k.lastUsed||'',k.createdAt||'',k.wppVersion||'',(k.note||'').replace(/,/g,';')].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
    res.writeHead(200,{ 'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="waspeed-licenses.csv"' });
    return res.end('\ufeff'+lines.join('\n'));
  }
  return false;
}

async function handleAdmin(req,res,path,ip) {
  if (path===`${RA}/login`) {
    if (req.method==='GET') return html(res,loginPage('Administrador',RA));
    if (!chkRate(ip)) return html(res,loginPage('Administrador',RA,'Muitas tentativas. Aguarde.'),429);
    const p=new URLSearchParams(await readBody(req));
    if (await verAdmin(p.get('user')||'',p.get('pass')||'')) {
      const s=await mkSession('admin',{ user:(p.get('user')||'').trim() }); if (!s) return html(res,loginPage('Administrador',RA,'Erro interno'),500);
      res.setHeader('Set-Cookie',cookieHdr(s.token)); res.writeHead(302,{ Location:RA }); return res.end();
    }
    return html(res,loginPage('Administrador',RA,'Usuário ou senha incorretos.'),401);
  }
  if (path===`${RA}/logout`) { await delSession(parseCookies(req).ws_session); res.setHeader('Set-Cookie',cookieHdr('',0)); res.writeHead(302,{ Location:`${RA}/login` }); return res.end(); }
  if (!await guard(req,res,'admin')) return;
  if (await handleAdminApi(req,res,path)) return;
  if (path===RA||path===`${RA}/`) { const [pd,lgs]=await Promise.all([panelData(),getLogs(150)]); return html(res,renderDash(pd,lgs)); }
  if (path===`${RA}/keys`) { const list=(await listKeys()).map(rec=>({ code:rec.code,rec })); return html(res,adminPage('Licenças',`<div style="display:flex;justify-content:flex-end;margin-bottom:14px"><a href="${RA}/keys/new" class="btn">${IC.plus} Nova chave</a></div>${renderKeysList(list,RA)}`,'keys','admin')); }
  if (path===`${RA}/keys/new`) {
    if (req.method==='GET') return html(res,renderKeyForm(RA,null,'Nova licença'));
    const p=new URLSearchParams(await readBody(req));
    try { const rec=await mkKey({ label:p.get('label'),premium:p.get('premium')!=='0',expireDays:Number(p.get('expireDays')||0),note:p.get('note')||'' }); res.writeHead(302,{ Location:`${RA}/keys/${encodeURIComponent(rec.code)}` }); return res.end(); }
    catch (e) { res.writeHead(500); return res.end('Erro: '+e.message); }
  }
  const ke=path.match(RE.aKey); if (ke&&!path.includes('/toggle')&&!path.includes('/delete')) {
    const code=decodeURIComponent(ke[1]),rec=await findK(code); if (!rec) { res.writeHead(404); return res.end('Not found'); }
    if (req.method==='GET') return html(res,renderKeyForm(RA,rec,'Editar licença'));
    const p=new URLSearchParams(await readBody(req)),patch={ label:p.get('label')||rec.label,premium:p.get('premium')!=='0',note:p.get('note')||'' };
    const d=Number(p.get('expireDays')||0); if (d>0) patch.expiresAt=new Date(Date.now()+d*86_400_000).toISOString();
    await updKey(code,patch); res.writeHead(302,{ Location:`${RA}/keys` }); return res.end();
  }
  const kt=path.match(RE.aToggle); if (kt&&req.method==='POST') { const rec=await findK(decodeURIComponent(kt[1])); if (rec) await updKey(rec.code,{ active:!rec.active }); res.writeHead(302,{ Location:`${RA}/keys` }); return res.end(); }
  const kd=path.match(RE.aDelete); if (kd&&req.method==='POST') { const code=decodeURIComponent(kd[1]); await delKey(code); addLog('key_delete',`Chave ${code} excluida`,{ code }); res.writeHead(302,{ Location:`${RA}/keys` }); return res.end(); }
  if (path===`${RA}/logs`) return html(res,renderLogsPage(await getLogs(200)));
  res.writeHead(404); res.end('Not found');
}

async function handleMod(req,res,path,ip) {
  if (path===`${RM}/login`) {
    if (req.method==='GET') return html(res,loginPage('Moderador',RM));
    if (!chkRate(ip)) return html(res,loginPage('Moderador',RM,'Muitas tentativas.'),429);
    const p=new URLSearchParams(await readBody(req)),mod=await verMod(p.get('user')||'',p.get('pass')||'');
    if (mod) { const s=await mkSession('mod',{ user:(p.get('user')||'').trim(),modId:mod.id,name:mod.name }); if (!s) return html(res,loginPage('Moderador',RM,'Erro interno'),500); res.setHeader('Set-Cookie',cookieHdr(s.token)); res.writeHead(302,{ Location:RM }); return res.end(); }
    return html(res,loginPage('Moderador',RM,'Usuário ou senha incorretos.'),401);
  }
  if (path===`${RM}/logout`) { await delSession(parseCookies(req).ws_session); res.setHeader('Set-Cookie',cookieHdr('',0)); res.writeHead(302,{ Location:`${RM}/login` }); return res.end(); }
  const sess=await guard(req,res,'mod'); if (!sess) return;
  const modName=sess.name;
  if (path===`${RM}/api/data`&&req.method==='GET') { const all=await listKeys({ modName }); return json(res,{ ok:true,totalKeys:all.length,activeKeys:all.filter(k=>kStatus(k)==='active').length,keysHtml:buildRows(all) }); }
  if (path===`${RM}/api/keys`&&req.method==='POST') {
    const b=await bodyJson(req); if (!b.label?.trim()) return json(res,{ error:'label obrigatorio' },400);
    const { expiresAt,expireDays }=parseExp(b);
    try { const rec=await mkKey({ label:String(b.label).trim().slice(0,60),premium:b.premium!==false&&b.premium!=='0',expiresAt,expireDays,note:String(b.note||'').slice(0,400) },modName); return json(res,{ ok:true,key:rec.code }); }
    catch (e) { return json(res,{ error:e.message },500); }
  }
  if (path===RM||path===`${RM}/`) { const all=await listKeys({ modName }); return html(res,renderModDash(modName,all,[])); }
  if (path===`${RM}/keys/new`) {
    if (req.method==='GET') return html(res,renderKeyForm(RM,null,'Nova licença'));
    const p=new URLSearchParams(await readBody(req)); await mkKey({ label:p.get('label'),premium:p.get('premium')!=='0',note:p.get('note')||'' },modName); res.writeHead(302,{ Location:RM }); return res.end();
  }
  res.writeHead(404); res.end('Not found');
}

async function handle(req,res) {
  const u=new URL(req.url,`http://x:${cfg.port}`),path=u.pathname;
  const ip=req.headers['x-forwarded-for']?.split(',')[0]?.trim()||req.socket.remoteAddress||'';
  cors(req,res,path);
  if (req.method==='OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (path==='/ping')  return txt(res,'OK');
    if (path==='/login') { res.writeHead(302,{ Location:`${RA}/login` }); return res.end(); }
    if (path==='/health') {
      let k=0,ok=ready&&!!db;
      if (ok) try { k=await db.collection(COL.licenses).countDocuments(); } catch { ok=false; }
      return json(res,{ ok,service:'waspeed',keys:k,mongo:ok,uptime:Math.floor(process.uptime()) },ok?200:503);
    }
    if (!ready||!db) return json(res,{ success:false,msg_id:'db_unavailable' },503);
    if (path==='/') { res.writeHead(302,{ Location:`${RA}/login` }); return res.end(); }
    if (path==='/config.json') { const b=cfgJson||JSON.stringify(buildCfgJson()); res.writeHead(200,{ 'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=300','Content-Length':Buffer.byteLength(b) }); return res.end(b); }
    if (path==='/api/code') { res.writeHead(200,{ 'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'public, max-age=3600' }); return res.end('\n'); }
    if (path==='/obrigado') return html(res,PAGE_UNINSTALL);
    if (path.startsWith('/utils/')) return json(res,{ success:false,msg_id:'not_configured' },501);
    if (await handleClientPanel(req,res,path,u)) return;
    if (path.startsWith('/api/')) { const h=await handleApi(req,res,path,ip); if (h!==false) return; return json(res,{ success:false,msg_id:'not_found' },404); }
    if (path.startsWith(RA)) return handleAdmin(req,res,path,ip);
    if (path.startsWith(RM)) return handleMod(req,res,path,ip);
    res.writeHead(404); res.end('Not found');
  } catch (e) { console.error('[WS] req:',e.message); if (!res.headersSent) json(res,{ success:false,msg_id:'server_error' },500); }
}

function antiSleep() {
  const url=`${(cfg.pub||cfg.base).replace(/\/$/,'')}/ping`;
  setInterval(()=>fetch(url,{ signal:AbortSignal.timeout(10_000) }).catch(e=>console.warn('[WS] ping:',e.message)),ANTI_SLEEP_MS).unref();
}
async function shutdown(sig) {
  console.log(`[WS] ${sig}`); ready=false;
  try { if (client) await client.close(); } catch {}
  if (srv) srv.close(()=>process.exit(0)); else process.exit(0);
  setTimeout(()=>process.exit(1),10_000).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('uncaughtException',e=>console.error('[WS] uncaught:',e.message));
process.on('unhandledRejection',r=>console.error('[WS] rejection:',r));

async function boot() {
  try { await connectDb(); await seed(); ready=true; }
  catch (e) { console.error('[WS] boot:',e.message); process.exit(1); }
  srv=http.createServer(handle);
  srv.keepAliveTimeout=65_000; srv.headersTimeout=66_000; srv.requestTimeout=30_000; srv.maxHeadersCount=50;
  srv.on('clientError',(e,s)=>{ if (!s.destroyed) s.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
  srv.listen(cfg.port,()=>{
    console.log(`[WS] v5.1 porta ${cfg.port} | db=${cfg.db}`);
    console.log(`[WS] Admin: ${cfg.base}${RA}/login | Mod: ${cfg.base}${RM}/login`);
    antiSleep();
  });
}
boot().catch(e=>{ console.error('[WS] fatal:',e.message); process.exit(1); });
