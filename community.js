/* Stati del Mondo — "Sfide della community".
 *
 * Gli utenti pubblicano le proprie sfide salvate; tutti possono vederle e giocarle, chi ha un account
 * mette "mi piace" e, giocando, fa salire il contatore delle partite e può battere il record.
 * Elenco in stile Reddit: ordinato per "mi piace", per partite o per novità, con il periodo
 * (ultimi 7 giorni, 30 giorni, anno, sempre) calcolato sulla data di pubblicazione.
 *
 * Dati in Firestore (vedi firestore.rules, che controllano ogni scrittura lato server):
 *   public_challenges/{id}            la sfida: nome, impostazioni, stati, autore, contatori, record
 *   public_challenges/{id}/likes/{uid}    esiste = quell'utente ha messo "mi piace"
 *   public_challenges/{id}/players/{uid}  ultima partita registrata di quell'utente (limite di frequenza)
 *   profiles/{uid}  {nick, lastPub}   nicks/{nick in minuscolo}  {uid}   (soprannomi unici)
 *   reports/{id_uid}                  segnalazioni, le legge solo l'amministratore dalla console
 */
import { getApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, query, where, orderBy, limit,
  writeBatch, increment, serverTimestamp, deleteDoc
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';

const ADMIN_UID = 'CB5ryHV0kAXCL2Nel9Z4jblgHN02';
const LIKED_KEY = 'worldgame_liked_v1';
const PAGE = 10;
const CACHE_MS = 3 * 60 * 1000;
const PLAY_EVERY_MS = 60 * 1000;      // stesso limite delle regole: una partita contata al minuto per sfida
const MIN_MS_PER_Q = 700;             // sotto questo tempo medio a domanda il record viene rifiutato
const NICK_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const DAY = 86400000;

const TXT = {
  it: {
    title: 'Sfide della community',
    hint: 'Le sfide pubblicate da chi gioca. Si giocano da soli e scrivendo, così il record è uguale per tutti.',
    s_likes: 'Più amate', s_plays: 'Più giocate', s_new: 'Nuove',
    p_week: 'Ultimi 7 giorni', p_month: 'Ultimi 30 giorni', p_year: 'Ultimo anno', p_all: 'Sempre',
    loading: 'Carico le sfide…', empty: 'Nessuna sfida pubblicata in questo periodo.', emptyAll: 'Ancora nessuna sfida pubblicata: pubblica una delle tue!',
    error: 'Non riesco a caricare le sfide. Controlla la connessione e riprova.', retry: 'Riprova',
    more: 'Mostra altre', by: 'di @{nick}', play: 'Gioca',
    likes: n => n === 1 ? '1 mi piace' : `${n} mi piace`, plays: n => n === 1 ? '1 partita' : `${n} partite`,
    rec: 'Record: {s}/{n} in {t} · {who}', recNone: 'Ancora nessun record',
    like: 'Mi piace', unlike: 'Togli mi piace',
    report: 'Segnala', reported: 'Segnalata, grazie', del: 'Elimina', delAdmin: 'Elimina (admin)', delSure: 'Sicuro? Clicca di nuovo',
    mine: 'tua',
    publish: 'Pubblica', published: 'Pubblicata', unpublish: 'Ritira', unpublishSure: 'Ritirarla? Clicca di nuovo',
    pubHint: 'La versione pubblicata resta com\'era: modificando questa sfida non cambia.',
    pubDone: 'Sfida pubblicata nella community!', unpubDone: 'Sfida ritirata dalla community.',
    pubWait: 'Puoi pubblicare una sfida ogni 2 minuti: riprova tra poco.',
    pubDoneRec: 'Sfida pubblicata con il tuo record ({s}/{n} in {t})!',
    pushRec: 'Pubblica nuovo record', pushHint: 'Hai fatto un record migliore di quello inviato: pubblicalo, conta anche come partita giocata.',
    pushDone: 'Nuovo record pubblicato ({s}/{n} in {t}) e partita contata!',
    pushPlayOnly: 'Partita contata. Il record online resta {rec}, che è migliore del tuo.',
    pushRecOnly: 'Nuovo record pubblicato ({s}/{n} in {t}). La partita non è stata contata: ne conta una al minuto.',
    pushWait: 'Hai appena registrato una partita su questa sfida: riprova tra un minuto.',
    pushGone: 'Questa sfida non è più nella community.',
    changedHint: 'Modificata dopo la pubblicazione: i nuovi record valgono solo qui.',
    needLogin: 'Accedi per mettere "mi piace", pubblicare e far contare i tuoi record.',
    needVerify: 'Conferma prima la tua email (dal pulsante dell\'account in alto).',
    endCounted: 'Partita registrata nella community.', endRec: 'Nuovo record della community salvato!',
    endGuest: 'Accedi per far contare le tue partite e i tuoi record nella community.',
    endFail: 'Non sono riuscito a registrare la partita online.',
    nickTitle: 'Scegli un soprannome', nickText: 'Comparirà accanto alle sfide che pubblichi e ai tuoi record, al posto del tuo nome. 3–20 caratteri: lettere, numeri, . _ -',
    nickLbl: 'Soprannome', nickSave: 'Salva', nickCancel: 'Annulla', nickTaken: 'Questo soprannome è già usato da qualcun altro.',
    nickBad: 'Usa da 3 a 20 caratteri tra lettere, numeri, punto, trattino e trattino basso.',
    nickAcc: 'Soprannome nella community:', nickChange: 'Cambia', nickChoose: 'Scegli un soprannome', nickNone: 'nessuno',
    err: 'Qualcosa è andato storto, riprova.'
  },
  en: {
    title: 'Community challenges',
    hint: 'Challenges published by players. They are played solo and by typing, so the record is the same for everyone.',
    s_likes: 'Most liked', s_plays: 'Most played', s_new: 'New',
    p_week: 'Last 7 days', p_month: 'Last 30 days', p_year: 'Last year', p_all: 'All time',
    loading: 'Loading challenges…', empty: 'No challenges published in this period.', emptyAll: 'No challenges published yet: publish one of yours!',
    error: 'Couldn\'t load the challenges. Check your connection and try again.', retry: 'Retry',
    more: 'Show more', by: 'by @{nick}', play: 'Play',
    likes: n => n === 1 ? '1 like' : `${n} likes`, plays: n => n === 1 ? '1 game' : `${n} games`,
    rec: 'Record: {s}/{n} in {t} · {who}', recNone: 'No record yet',
    like: 'Like', unlike: 'Unlike',
    report: 'Report', reported: 'Reported, thanks', del: 'Delete', delAdmin: 'Delete (admin)', delSure: 'Sure? Click again',
    mine: 'yours',
    publish: 'Publish', published: 'Published', unpublish: 'Withdraw', unpublishSure: 'Withdraw it? Click again',
    pubHint: 'The published version stays as it was: editing this challenge doesn\'t change it.',
    pubDone: 'Challenge published to the community!', unpubDone: 'Challenge withdrawn from the community.',
    pubWait: 'You can publish one challenge every 2 minutes: try again shortly.',
    pubDoneRec: 'Challenge published with your record ({s}/{n} in {t})!',
    pushRec: 'Publish new record', pushHint: 'You beat the record you sent: publish it, it also counts as a game played.',
    pushDone: 'New record published ({s}/{n} in {t}) and game counted!',
    pushPlayOnly: 'Game counted. The online record stays {rec}, which beats yours.',
    pushRecOnly: 'New record published ({s}/{n} in {t}). The game wasn\'t counted: one counts per minute.',
    pushWait: 'You just recorded a game on this challenge: try again in a minute.',
    pushGone: 'This challenge is no longer in the community.',
    changedHint: 'Edited after publishing: new records only count here.',
    needLogin: 'Sign in to like, publish and have your records count.',
    needVerify: 'Confirm your email first (from the account button at the top).',
    endCounted: 'Game recorded in the community.', endRec: 'New community record saved!',
    endGuest: 'Sign in to have your games and records count in the community.',
    endFail: 'Couldn\'t record the game online.',
    nickTitle: 'Choose a nickname', nickText: 'It will appear next to the challenges you publish and your records, instead of your name. 3–20 characters: letters, numbers, . _ -',
    nickLbl: 'Nickname', nickSave: 'Save', nickCancel: 'Cancel', nickTaken: 'This nickname is already taken.',
    nickBad: 'Use 3 to 20 characters: letters, numbers, dot, dash and underscore.',
    nickAcc: 'Community nickname:', nickChange: 'Change', nickChoose: 'Choose a nickname', nickNone: 'none',
    err: 'Something went wrong, please try again.'
  }
};
const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'it');
const t = (k, vars) => {
  let v = TXT[lang()][k];
  if(typeof v === 'string' && vars) v = v.replace(/\{(\w+)\}/g, (m, x) => (x in vars ? vars[x] : m));
  return v;
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; };

/* ---------------------------------------------------------------- stato */
let db = null, FB = null, nick = null, nickUid = null;
const ui = { sort: 'likes', period: 'week', shown: PAGE, editing: false };
const cache = new Map();          // chiave "sort|period" -> {at, items, error}
let loadingKey = null;

const G = () => window.__wgGame;
const me = () => (FB && FB.user) || null;
const verified = () => !!(FB && FB.canSync());

function likedSet(){ try{ return new Set(JSON.parse(localStorage.getItem(LIKED_KEY) || '[]')); }catch(e){ return new Set(); } }
function saveLiked(set){ try{ localStorage.setItem(LIKED_KEY, JSON.stringify(Array.from(set).slice(-500))); }catch(e){} }

function buckets(ms){
  const d = new Date(ms);
  return { wk: Math.floor((ms + 3 * DAY) / (7 * DAY)), mo: d.getUTCFullYear() * 12 + d.getUTCMonth(), yr: d.getUTCFullYear() };
}

/* ---------------------------------------------------------------- lettura elenco */
async function fetchList(sort, period){
  const col = collection(db, 'public_challenges');
  const field = sort === 'plays' ? 'plays' : 'likes';
  const now = Date.now(), b = buckets(now);
  let q, since = 0;
  if(sort === 'new') q = query(col, orderBy('createdAt', 'desc'), limit(30));
  else if(period === 'all') q = query(col, orderBy(field, 'desc'), limit(30));
  else {
    const f = { week: ['wk', [b.wk, b.wk - 1], 7], month: ['mo', [b.mo, b.mo - 1], 30], year: ['yr', [b.yr, b.yr - 1], 365] }[period];
    q = query(col, where(f[0], 'in', f[1]), orderBy(field, 'desc'), limit(40));
    since = now - f[2] * DAY;
  }
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .map(x => ({ ...x, created: x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : now }))
    .filter(x => x.created >= since);
}
async function load(force){
  const key = ui.sort + '|' + (ui.sort === 'new' ? 'all' : ui.period);
  const c = cache.get(key);
  if(!force && c && !c.error && Date.now() - c.at < CACHE_MS) return;
  if(loadingKey === key) return;
  loadingKey = key;
  cache.set(key, { at: Date.now(), items: c && !c.error ? c.items : null, loading: true });
  renderList();
  try{
    const items = await fetchList(ui.sort, ui.period);
    cache.set(key, { at: Date.now(), items });
  }catch(e){
    console.warn('[community] load', e);
    cache.set(key, { at: Date.now(), items: null, error: true });
  }finally{ loadingKey = null; }
  renderList();
}
function patchCached(id, fn){ cache.forEach(c => { (c.items || []).forEach(x => { if(x.id === id) fn(x); }); }); }
function dropCached(id){ cache.forEach(c => { if(c.items) c.items = c.items.filter(x => x.id !== id); }); }

/* ---------------------------------------------------------------- interfaccia: sezione */
let root = null;
function injectStyles(){
  const s = document.createElement('style');
  s.textContent = `
  .pub-section{ margin:28px 0 18px; }
  .pub-section > .field-hint{ margin:6px 0 4px; }
  .pub-section .saved-head{ display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
  .pub-tools{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:10px 0 12px; }
  .pub-seg{ display:inline-flex; background:var(--surface); border:2px solid var(--line-soft); border-radius:14px; padding:3px; gap:2px; box-shadow:0 3px 0 var(--lip); }
  .pub-seg button{ border:none; background:transparent; color:var(--ink); font:inherit; font-weight:700; font-size:.86rem; padding:6px 12px; border-radius:10px; cursor:pointer; }
  .pub-seg button[aria-pressed=true]{ background:var(--accent); color:#fff; }
  .pub-period{ font:inherit; font-weight:700; font-size:.86rem; padding:8px 10px; border-radius:12px; border:2px solid var(--line-soft); background:var(--surface); color:var(--ink); box-shadow:0 3px 0 var(--lip); }
  .pub-list{ display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:12px; }
  .pub-card{ position:relative; background:var(--surface); border:2px solid var(--line-soft); border-radius:18px; box-shadow:0 4px 0 var(--lip); padding:14px 16px; display:flex; flex-direction:column; gap:6px; min-width:0; }
  .pub-card .pub-rank{ position:absolute; top:12px; right:14px; font-family:'Fredoka','Nunito',sans-serif; font-weight:600; color:var(--ink-soft); font-size:.95rem; }
  .pub-card .pub-name{ font-family:'Fredoka','Nunito',sans-serif; font-weight:600; font-size:1.08rem; padding-right:34px; overflow-wrap:anywhere; }
  .pub-card .pub-by{ font-size:.82rem; color:var(--ink-soft); overflow-wrap:anywhere; }
  .pub-card .pub-by .pub-mine{ background:var(--custom-bg); color:#5A3FB8; border-radius:999px; padding:1px 7px; font-weight:800; margin-left:4px; }
  .pub-card .pub-sum{ font-size:.84rem; color:var(--ink-soft); }
  .pub-card .pub-rec{ display:flex; gap:6px; align-items:center; font-size:.86rem; font-weight:700; overflow-wrap:anywhere; }
  .pub-card .pub-rec.none{ color:var(--ink-soft); font-weight:600; }
  .pub-card .pub-rec .ico svg{ width:18px; height:18px; }
  .pub-card .pub-stats{ display:flex; gap:12px; font-size:.84rem; color:var(--ink-soft); font-weight:700; }
  .pub-card .pub-actions{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:4px; }
  .pub-like{ display:inline-flex; align-items:center; gap:6px; }
  .pub-like svg{ width:16px; height:16px; }
  .pub-like[aria-pressed=true]{ background:#FFE6DA !important; border-color:#FF9F7A !important; color:#B0402F !important; }
  .pub-msg{ color:var(--ink-soft); font-size:.92rem; padding:18px 4px; }
  .pub-more{ margin-top:12px; }
  .pub-flag{ font-size:.8rem; }
  .chs-pub-row{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:6px; font-size:.82rem; }
  .chs-pub-note{ margin:0; width:100%; }
  .chs-pub-badge{ background:var(--good-bg); color:var(--good); font-weight:800; border-radius:999px; padding:2px 9px; }
  #wg-nick-modal .text-field{ width:100%; max-width:none; box-sizing:border-box; }
  .acc-nick{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; font-size:.9rem; color:var(--ink-soft); }
  .acc-nick b{ color:var(--ink); }
  `;
  document.head.appendChild(s);
}
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.6-9.3C1 7.9 3 4.5 6.6 4.5c2.1 0 3.6 1.2 4.4 2.5.8-1.3 2.3-2.5 4.4-2.5 3.6 0 5.6 3.4 4.2 6.7C19.5 15.9 12 20.5 12 20.5z" fill="currentColor"/></svg>';

function render(editing){
  root = document.getElementById('pub-section');
  if(!root || !db) return;
  ui.editing = editing;
  root.hidden = editing;
  if(editing) return;
  setTimeout(autoPushAll, 0);
  root.innerHTML = '';
  const head = el('div', 'saved-head'); head.appendChild(el('h3', null, t('title'))); root.appendChild(head);
  root.appendChild(el('p', 'field-hint', t('hint')));
  const tools = el('div', 'pub-tools');
  const seg = el('div', 'pub-seg'); seg.setAttribute('role', 'group');
  [['likes', 's_likes'], ['plays', 's_plays'], ['new', 's_new']].forEach(([k, lbl]) => {
    const b = el('button', null, t(lbl)); b.type = 'button'; b.setAttribute('aria-pressed', ui.sort === k ? 'true' : 'false');
    b.addEventListener('click', () => { ui.sort = k; ui.shown = PAGE; render(false); });
    seg.appendChild(b);
  });
  tools.appendChild(seg);
  if(ui.sort !== 'new'){
    const sel = el('select', 'pub-period'); sel.setAttribute('aria-label', t('p_week') + ' / ' + t('p_all'));
    ['week', 'month', 'year', 'all'].forEach(p => { const o = el('option', null, t('p_' + p)); o.value = p; if(ui.period === p) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', () => { ui.period = sel.value; ui.shown = PAGE; render(false); });
    tools.appendChild(sel);
  }
  root.appendChild(tools);
  root.appendChild(el('div', 'pub-list-wrap'));
  renderList();
  load(false);
}
function renderList(){
  if(!root || ui.editing) return;
  const wrap = root.querySelector('.pub-list-wrap'); if(!wrap) return;
  const key = ui.sort + '|' + (ui.sort === 'new' ? 'all' : ui.period);
  const c = cache.get(key);
  wrap.innerHTML = '';
  if(!c || (c.loading && !c.items)){ wrap.appendChild(el('div', 'pub-msg', t('loading'))); return; }
  if(c.error){
    const m = el('div', 'pub-msg', t('error') + ' ');
    const r = el('button', 'link-btn', t('retry')); r.type = 'button'; r.addEventListener('click', () => load(true));
    m.appendChild(r); wrap.appendChild(m); return;
  }
  const items = c.items || [];
  if(!items.length){ wrap.appendChild(el('div', 'pub-msg', t(ui.sort === 'new' || ui.period === 'all' ? 'emptyAll' : 'empty'))); return; }
  const list = el('div', 'pub-list');
  items.slice(0, ui.shown).forEach((x, i) => list.appendChild(card(x, i + 1)));
  wrap.appendChild(list);
  if(items.length > ui.shown){
    const more = el('button', 'btn ghost btn-sm pub-more', t('more')); more.type = 'button';
    more.addEventListener('click', () => { ui.shown += PAGE; renderList(); });
    wrap.appendChild(more);
  }
}
function playSettings(x){ const st = Object.assign({}, x.settings || {}); st.players = 1; st.input = 'text'; return st; }
function recText(r){
  if(!r) return t('recNone');
  return t('rec', { s: r.s, n: r.n, t: G().fmtMs(r.t), who: '@' + r.nick });
}
function card(x, rank){
  const u = me(), mine = u && x.author === u.uid, admin = u && u.uid === ADMIN_UID;
  const c = el('div', 'pub-card');
  if(ui.sort !== 'new') c.appendChild(el('div', 'pub-rank', '#' + rank));
  c.appendChild(el('div', 'pub-name', x.name));
  const by = el('div', 'pub-by', t('by', { nick: x.authorNick }) + ' · ' + G().date(x.created));
  if(mine) by.appendChild(el('span', 'pub-mine', t('mine')));
  c.appendChild(by);
  c.appendChild(el('div', 'pub-sum', G().summary({ settings: playSettings(x), states: x.states || [] })));
  const rec = el('div', 'pub-rec' + (x.rec ? '' : ' none'));
  const ic = el('span', 'ico'); ic.innerHTML = G().icons.trophy; rec.appendChild(ic); rec.appendChild(el('span', null, recText(x.rec)));
  c.appendChild(rec);
  const stats = el('div', 'pub-stats');
  stats.appendChild(el('span', null, t('plays')(x.plays || 0)));
  c.appendChild(stats);
  const act = el('div', 'pub-actions');
  const play = el('button', 'btn primary btn-sm', t('play')); play.type = 'button';
  play.addEventListener('click', () => G().playPublic({ id: 'pub:' + x.id, pubId: x.id, name: x.name, settings: x.settings, states: x.states || [],
    best: x.rec ? { s: x.rec.s, n: x.rec.n, t: x.rec.t, name: '@' + x.rec.nick, d: x.rec.d && x.rec.d.toMillis ? x.rec.d.toMillis() : null } : null, count: x.plays || 0 }));
  act.appendChild(play);
  const liked = likedSet().has(x.id);
  const like = el('button', 'btn ghost btn-sm pub-like'); like.type = 'button';
  like.setAttribute('aria-pressed', liked ? 'true' : 'false'); like.setAttribute('aria-label', liked ? t('unlike') : t('like'));
  like.innerHTML = HEART; like.appendChild(el('span', null, String(x.likes || 0)));
  like.addEventListener('click', () => toggleLike(x, like));
  act.appendChild(like);
  if(mine || admin){
    const del = el('button', 'link-btn saved-del', mine ? t('del') : t('delAdmin')); del.type = 'button';
    del.addEventListener('click', () => {
      if(!del.classList.contains('armed')){ del.classList.add('armed'); del.textContent = t('delSure'); setTimeout(() => { if(del.isConnected){ del.classList.remove('armed'); del.textContent = mine ? t('del') : t('delAdmin'); } }, 3500); return; }
      removePublic(x.id);
    });
    act.appendChild(del);
  }else if(u){
    const rep = el('button', 'link-btn pub-flag', t('report')); rep.type = 'button';
    rep.addEventListener('click', () => report(x.id, rep));
    act.appendChild(rep);
  }
  c.appendChild(act);
  return c;
}

/* ---------------------------------------------------------------- azioni */
function needAccount(){
  if(!me()){ FB.toast(t('needLogin')); FB.openLogin(); return true; }
  if(!verified()){ FB.toast(t('needVerify')); return true; }
  return false;
}
async function toggleLike(x, btn){
  if(needAccount()) return;
  const set = likedSet(), on = !set.has(x.id), uid = me().uid;
  btn.disabled = true;
  const b = writeBatch(db);
  const cref = doc(db, 'public_challenges', x.id), lref = doc(db, 'public_challenges', x.id, 'likes', uid);
  if(on){ b.set(lref, { at: serverTimestamp() }); b.update(cref, { likes: increment(1) }); }
  else { b.delete(lref); b.update(cref, { likes: increment(-1) }); }
  try{
    await b.commit();
    if(on) set.add(x.id); else set.delete(x.id);
    saveLiked(set); patchCached(x.id, y => { y.likes = Math.max(0, (y.likes || 0) + (on ? 1 : -1)); });
  }catch(e){
    // Lo stato locale non coincideva con quello online (es. like messo da un altro dispositivo): riallinea.
    try{ const s = await getDoc(lref); if(s.exists()) set.add(x.id); else set.delete(x.id); saveLiked(set); }catch(e2){}
    console.warn('[community] like', e);
  }
  renderList();
}
async function report(id, btn){
  if(needAccount()) return;
  btn.disabled = true;
  try{ const uid = me().uid; const b = writeBatch(db); b.set(doc(db, 'reports', id + '_' + uid), { pid: id, uid, at: serverTimestamp() }); await b.commit(); }catch(e){}
  btn.textContent = t('reported');
}
async function removePublic(id){
  try{ await deleteDoc(doc(db, 'public_challenges', id)); }catch(e){ FB.toast(t('err')); return; }
  dropCached(id);
  const list = G().savedList(); let ch = false;
  list.forEach(sv => { if(sv.pubId === id){ delete sv.pubId; delete sv.pubSig; delete sv.pubSent; ch = true; } });
  if(ch) G().saveList(list);
  FB.toast(t('unpubDone'));
  G().rerenderSetup();
}
/* Miglior record della sfida salvata fatto scrivendo (solo quelli vanno online:
   a voce è il giocatore stesso a dire se ha indovinato). */
function localRec(sv){
  const n = sv && sv.settings && sv.settings.rounds;
  const ok = r => r && r.n === n && r.t != null && r.s >= 1 && r.s <= n && r.t >= n * MIN_MS_PER_Q;
  const cands = [];
  if(ok(sv && sv.bestText)) cands.push(sv.bestText);
  const b = sv && sv.best;
  // i record salvati prima che il gioco annotasse il modo (inp) valgono se la sfida si gioca scrivendo
  if(ok(b) && (b.inp === 'text' || (b.inp == null && sv.settings.input === 'text'))) cands.push(b);
  let r = null;
  cands.forEach(c => { const x = { s: c.s, n, t: Math.round(c.t) }; if(better(x, r)) r = x; });
  return r;
}
const better = (a, b) => !!a && (!b || a.s > b.s || (a.s === b.s && a.t < b.t));
// "Stessa sfida" = stessi stati, modalità, tempo, domande, errori. Giocatori e modo di risposta non contano:
// online si gioca sempre da soli e scrivendo, quindi si può passare la propria sfida a "scrivendo" senza perderne il legame.
function sig(sv){ const st = G().settingsCopy(sv.settings); delete st.players; delete st.input; return JSON.stringify([st, (sv.states || []).slice().sort()]); }
function sigLegacy(sv){ return JSON.stringify([G().settingsCopy(sv.settings), (sv.states || []).slice().sort()]); }
const sameSig = sv => !sv.pubSig || sv.pubSig === sig(sv) || sv.pubSig === sigLegacy(sv);
function updateSaved(id, fn){ const list = G().savedList(); list.forEach(x => { if(x.id === id) fn(x); }); G().saveList(list); }

async function publish(sv, btn){
  if(needAccount()) return;
  if(!nick){ const ok = await askNick(); if(!ok) return; }
  btn.disabled = true;
  const uid = me().uid, now = Date.now(), bk = buckets(now);
  const ref = doc(collection(db, 'public_challenges'));
  const lr = localRec(sv);
  const b = writeBatch(db);
  b.set(ref, {
    v: 1, name: String(sv.name).slice(0, 40), settings: G().settingsCopy(sv.settings), states: (sv.states || []).slice(0, 195),
    author: uid, authorNick: nick, createdAt: serverTimestamp(), wk: bk.wk, mo: bk.mo, yr: bk.yr,
    likes: 0, plays: lr ? 1 : 0, rec: lr ? { s: lr.s, n: lr.n, t: lr.t, nick, uid, d: serverTimestamp() } : null
  });
  b.set(doc(db, 'profiles', uid), { nick, lastPub: serverTimestamp() });
  try{ await b.commit(); }
  catch(e){ btn.disabled = false; console.warn('[community] publish', e); FB.toast(e && e.code === 'permission-denied' ? t('pubWait') : t('err')); return; }
  updateSaved(sv.id, x => { x.pubId = ref.id; x.pubSig = sig(sv); x.pubSent = lr; });
  cache.clear(); ui.sort = 'new'; ui.shown = PAGE;
  FB.toast(lr ? t('pubDoneRec', { s: lr.s, n: lr.n, t: G().fmtMs(lr.t) }) : t('pubDone'));
  G().rerenderSetup();
}
/* "Pubblica" di nuovo su una sfida già pubblicata: invia il nuovo record e conta la partita. */
async function pushRecord(sv, btn, auto){
  if(auto){ if(!me() || !verified() || !nick) return; }
  else{ if(needAccount()) return; if(!nick){ const ok = await askNick(); if(!ok) return; } }
  const lr = localRec(sv); if(!lr) return;
  if(pushing.has(sv.id)) return;
  pushing.add(sv.id);
  try{ await pushRecordInner(sv, btn || { disabled: false }, auto, lr); } finally { pushing.delete(sv.id); }
}
const pushing = new Set();
async function pushRecordInner(sv, btn, auto, lr){
  btn.disabled = true;
  const uid = me().uid, id = sv.pubId;
  const cref = doc(db, 'public_challenges', id), pref = doc(db, 'public_challenges', id, 'players', uid);
  let online, last = 0;
  try{
    const cs = await getDoc(cref);
    if(!cs.exists()){ updateSaved(sv.id, x => { delete x.pubId; delete x.pubSig; delete x.pubSent; }); FB.toast(t('pushGone')); G().rerenderSetup(); return; }
    online = cs.data();
    const ps = await getDoc(pref); if(ps.exists() && ps.data().at) last = ps.data().at.toMillis();
  }catch(e){ btn.disabled = false; if(!auto) FB.toast(t('err')); return; }
  const countIt = Date.now() - last >= PLAY_EVERY_MS + 2000;
  const recIt = better(lr, online.rec) && Date.now() - last >= 12000;
  if(!countIt && !recIt){ btn.disabled = false; if(!auto) FB.toast(t('pushWait')); return; }
  const upd = {};
  if(countIt) upd.plays = increment(1);
  if(recIt) upd.rec = { s: lr.s, n: lr.n, t: lr.t, nick, uid, d: serverTimestamp() };
  const b = writeBatch(db);
  b.update(cref, upd); b.set(pref, { at: serverTimestamp() });
  try{ await b.commit(); }
  catch(e){ btn.disabled = false; console.warn('[community] push', e); if(!auto) FB.toast(t('err')); return; }
  updateSaved(sv.id, x => { x.pubSent = lr; });
  patchCached(id, y => { if(countIt) y.plays = (y.plays || 0) + 1; if(recIt) y.rec = { s: lr.s, n: lr.n, t: lr.t, nick, uid }; });
  const v = { s: lr.s, n: lr.n, t: G().fmtMs(lr.t) };
  FB.toast(recIt && countIt ? t('pushDone', v) : recIt ? t('pushRecOnly', v) : t('pushPlayOnly', { rec: recText(online.rec).replace(/^[^:]*:\s*/, '') }));
  G().rerenderSetup();
}

/* Invio automatico: il record fatto sulla propria sfida pubblicata va online da solo
   (a fine partita, e all'apertura della schermata per quelli rimasti in sospeso). */
function pendingPush(sv){ return sv.pubId && sameSig(sv) && better(localRec(sv), sv.pubSent || null); }
function autoPushAll(){
  if(!me() || !verified() || !nick || !G()) return;
  G().savedList().filter(pendingPush).forEach(sv => pushRecord(sv, null, true));
}
function onSavedEnd(id){
  const sv = G().savedList().filter(x => x.id === id)[0];
  if(sv && pendingPush(sv)) pushRecord(sv, null, true);
}

function decorateSaved(cardEl, sv){
  if(!db) return;
  const row = el('div', 'chs-pub-row');
  if(sv.pubId){
    row.appendChild(el('span', 'chs-pub-badge', t('published')));
    const w = el('button', 'link-btn', t('unpublish')); w.type = 'button';
    w.addEventListener('click', () => {
      if(!w.classList.contains('armed')){ w.classList.add('armed'); w.textContent = t('unpublishSure'); setTimeout(() => { if(w.isConnected){ w.classList.remove('armed'); w.textContent = t('unpublish'); } }, 3500); return; }
      removePublic(sv.pubId);
    });
    row.appendChild(w);
    row.title = t('pubHint');
    if(!sameSig(sv)) row.appendChild(el('span', 'field-hint chs-pub-note', t('changedHint')));
    else if(pendingPush(sv)){
      const p = el('button', 'btn primary btn-sm', t('pushRec')); p.type = 'button'; p.title = t('pushHint');
      p.addEventListener('click', () => pushRecord(sv, p));
      row.insertBefore(p, row.firstChild);
    }
  }else{
    const p = el('button', 'btn ghost btn-sm', t('publish')); p.type = 'button';
    p.addEventListener('click', () => publish(sv, p));
    row.appendChild(p);
  }
  const actions = cardEl.querySelector('.saved-actions');
  if(actions) actions.after(row); else cardEl.appendChild(row);
}

/* Fine partita di una sfida della community (chiamata dal gioco). */
async function onEnd(pv, res){
  if(!me() || !verified()){ FB.toast(t('endGuest')); return; }
  const uid = me().uid, id = pv.pubId;
  const cref = doc(db, 'public_challenges', id), pref = doc(db, 'public_challenges', id, 'players', uid);
  let last = 0;
  try{ const s = await getDoc(pref); if(s.exists() && s.data().at) last = s.data().at.toMillis(); }catch(e){}
  const countIt = Date.now() - last >= PLAY_EVERY_MS + 2000;
  const recOk = res.isRec && nick && res.t != null && res.t >= res.n * MIN_MS_PER_Q && res.s >= 1;
  if(!countIt && !recOk) return;
  const upd = {};
  if(countIt) upd.plays = increment(1);
  if(recOk) upd.rec = { s: res.s, n: res.n, t: Math.round(res.t), nick, uid, d: serverTimestamp() };
  const b = writeBatch(db);
  b.update(cref, upd);
  b.set(pref, { at: serverTimestamp() });
  try{
    await b.commit();
    patchCached(id, y => { if(countIt) y.plays = (y.plays || 0) + 1; if(recOk) y.rec = { s: res.s, n: res.n, t: Math.round(res.t), nick, uid }; });
    FB.toast(recOk ? t('endRec') : t('endCounted'));
  }catch(e){ console.warn('[community] end', e); FB.toast(t('endFail')); }
}

/* ---------------------------------------------------------------- soprannome */
async function loadNick(u){
  nick = null; nickUid = u ? u.uid : null;
  if(!u || !verified()) return;
  try{ const s = await getDoc(doc(db, 'profiles', u.uid)); if(nickUid === u.uid && s.exists()) nick = s.data().nick || null; }catch(e){}
  FB.refreshModal();
}
function askNick(){
  return new Promise(resolve => {
    let m = document.getElementById('wg-nick-modal');
    if(m) m.remove();
    m = el('div', 'modal-backdrop'); m.id = 'wg-nick-modal';
    m.innerHTML = '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="wg-nick-title"><h3 id="wg-nick-title"></h3><p></p><form novalidate style="display:flex;flex-direction:column;gap:10px;margin:0"><label style="font-weight:700;font-size:.88rem;display:flex;flex-direction:column;gap:5px"><span></span><input class="text-field" name="nick" maxlength="20" autocomplete="nickname" autocapitalize="off" spellcheck="false"></label><div class="form-error" role="alert" hidden></div><div class="btn-row modal-actions"><button type="button" class="btn ghost" data-a="no"></button><button type="submit" class="btn primary"></button></div></form></div>';
    m.querySelector('h3').textContent = t('nickTitle');
    m.querySelector('p').textContent = t('nickText');
    m.querySelector('label span').textContent = t('nickLbl');
    m.querySelector('[data-a=no]').textContent = t('nickCancel');
    m.querySelector('[type=submit]').textContent = t('nickSave');
    const inp = m.querySelector('input'); inp.value = nick || '';
    const err = m.querySelector('.form-error');
    const close = ok => { m.remove(); resolve(ok); };
    m.querySelector('[data-a=no]').addEventListener('click', () => close(false));
    m.addEventListener('click', e => { if(e.target === m) close(false); });
    m.addEventListener('keydown', e => { if(e.key === 'Escape') close(false); });
    m.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const v = inp.value.trim();
      err.hidden = true;
      if(!NICK_RE.test(v)){ err.textContent = t('nickBad'); err.hidden = false; return; }
      if(nick && v === nick) return close(true);
      m.querySelectorAll('button,input').forEach(x => { x.disabled = true; });
      const uid = me().uid, low = v.toLowerCase();
      try{
        const taken = await getDoc(doc(db, 'nicks', low));
        if(taken.exists() && taken.data().uid !== uid) throw { code: 'taken' };
        const b = writeBatch(db);
        if(!taken.exists()) b.set(doc(db, 'nicks', low), { uid });   // già tuo (es. cambi solo maiuscole): non va riscritto
        b.set(doc(db, 'profiles', uid), { nick: v }, { merge: true });
        // soprannome attuale letto dal server (non solo dalla memoria della pagina), così il vecchio viene sempre liberato
        let old = nick;
        try{ const ps = await getDoc(doc(db, 'profiles', uid)); if(ps.exists() && ps.data().nick) old = ps.data().nick; }catch(e2){}
        if(old && old.toLowerCase() !== low) b.delete(doc(db, 'nicks', old.toLowerCase()));
        await b.commit();
        nick = v; FB.refreshModal(); close(true);
      }catch(ex){
        m.querySelectorAll('button,input').forEach(x => { x.disabled = false; });
        console.warn('[community] nick', ex);
        err.textContent = ex && ex.code === 'taken' ? t('nickTaken') : t('err');
        err.hidden = false;
      }
    });
    document.getElementById('app').appendChild(m);
    inp.focus();
  });
}
function accountExtras(box){
  if(!verified()) return;
  const r = el('div', 'acc-nick');
  r.appendChild(el('span', null, t('nickAcc')));
  r.appendChild(el('b', null, nick ? '@' + nick : t('nickNone')));
  const b = el('button', 'link-btn', nick ? t('nickChange') : t('nickChoose')); b.type = 'button';
  b.addEventListener('click', () => askNick());
  r.appendChild(b);
  box.appendChild(r);
}

/* ---------------------------------------------------------------- avvio */
window.__wgCommunity = { render, decorateSaved, onEnd, onSavedEnd, nick: () => nick };
function start(){
  FB = window.__wgFB;
  if(!FB || !FB.app || !G()) return;
  try{ db = getFirestore(getApp()); }catch(e){ console.warn('[community] init', e); return; }
  injectStyles();
  FB.accountExtras = accountExtras;
  FB.onUser(u => { loadNick(u).then(() => { if(G().screen() === 'challenge-setup') G().rerenderSetup(); }); if(G().screen() === 'challenge-setup') G().rerenderSetup(); });
  new MutationObserver(() => { if(G().screen() === 'challenge-setup') G().rerenderSetup(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  if(G().screen() === 'challenge-setup') G().rerenderSetup();
}
if(window.__wgFB && window.__wgFB.app) start(); else window.addEventListener('wg-fb-ready', start, { once: true });
