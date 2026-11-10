/* Stati del Mondo — account e sincronizzazione dei progressi tra dispositivi.
 *
 * Funziona da solo accanto al gioco, senza toccarne la logica: il gioco continua a salvare tutto in
 * localStorage come prima; questo modulo
 *   1. aggiunge in alto il pulsante "Accedi" / il proprio account e la finestra di accesso
 *      (email + password, oppure Google);
 *   2. quando si è dentro, copia le chiavi di localStorage del gioco nel documento Firestore
 *      users/{uid} (visibile solo a quell'utente: vedi firestore.rules) e, all'apertura del sito,
 *      riporta in localStorage quelle salvate da un altro dispositivo (unendole se servono);
 *   3. dopo aver scritto dati arrivati dal cloud ricarica la pagina, così il gioco li rilegge con il
 *      suo codice di sempre — ma solo quando si è in un menu, mai durante una partita.
 *
 * La configurazione qui sotto (apiKey ecc.) NON è un segreto: in Firebase identifica solo il progetto.
 * La sicurezza la fanno le regole lato server (firestore.rules) e i domini autorizzati del login.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signInWithPopup, signInWithRedirect,
  GoogleAuthProvider, signOut, setPersistence, browserLocalPersistence, deleteUser
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';

const FIREBASE_CONFIG = window.__WG_FIREBASE_CONFIG__ || {
  apiKey: 'AIzaSyCBW-RvWFUMkoFLORA0NsfIWDFa89WcGa8',
  authDomain: 'stati-del-mondo.firebaseapp.com',
  projectId: 'stati-del-mondo',
  appId: '1:462740275140:web:767d4e8511ce4d615aee91'
};

/* Chiavi del gioco che seguono l'account. La lingua no: sul sito la decide l'indirizzo (/ o /en). */
const SYNC_KEYS = [
  'worldgame_progress_v1',          // Impara: migliori risultati, continenti superati, statistiche errori
  'worldgame_saved_quizzes_v1',     // "I tuoi quiz"
  'worldgame_saved_challenges_v1',  // "Le tue sfide"
  'worldgame_typeall_best_v1',      // record di "Scrivili tutti"
  'worldgame_challenge_v1',         // ultime impostazioni della Sfida
  'worldgame_sound'                 // suoni sì/no
];
const META_KEY = 'worldgame_sync_meta_v1';   // {uid, rev, dirty} — solo locale, non viene sincronizzato
const MAX_FIELD = 200000;                     // stesso limite delle regole Firestore
const UPLOAD_EVERY_MS = 20000;                // al massimo una scrittura ogni 20 s (più una all'uscita)
const SAFE_VIEWS = ['view-menu', 'view-category-menu', 'view-learn-overview'];

/* ------------------------------------------------------------------ testi */
const TXT = {
  it: {
    signin: 'Accedi', account: 'Account',
    title: 'Accedi per salvare i progressi',
    lead: 'Con un account i tuoi progressi, i quiz salvati e le sfide ti seguono su ogni dispositivo. Puoi continuare a giocare anche senza.',
    google: 'Continua con Google', or: 'oppure con email',
    email: 'Email', password: 'Password', password2: 'Ripeti la password',
    login: 'Accedi', register: 'Crea account',
    toRegister: 'Non hai un account? Creane uno', toLogin: 'Hai già un account? Accedi',
    forgot: 'Password dimenticata?', cancel: 'Chiudi',
    sentReset: 'Se esiste un account con questa email, ti abbiamo mandato un link per scegliere una nuova password.',
    verifyTitle: 'Conferma la tua email',
    verifyText: e => `Ti abbiamo mandato un'email a ${e}. Apri il link che contiene, poi torna qui e premi "Ho confermato". Finché non confermi, i progressi restano solo su questo dispositivo.`,
    verifyDone: 'Ho confermato', verifyResend: 'Rimanda l\'email', verifyResent: 'Email inviata di nuovo.',
    verifyStill: 'Non risulta ancora confermata: controlla anche lo spam.',
    signedAs: 'Sei dentro come', signout: 'Esci', del: 'Elimina account',
    delConfirm: 'Premi di nuovo per eliminare per sempre l\'account e i progressi salvati online.',
    delRecent: 'Per sicurezza esci, rientra e riprova subito a eliminare l\'account.',
    st_syncing: 'Sincronizzazione…', st_ok: 'Progressi salvati online', st_off: 'Offline: salvo appena torna la connessione',
    st_unverified: 'Conferma l\'email per salvare online', st_err: 'Salvataggio online non riuscito, riprovo più tardi',
    toastIn: 'Progressi sincronizzati', pending: 'Progressi aggiornati da un altro dispositivo: li carico appena torni al menu.',
    e: {
      'auth/invalid-email': 'L\'indirizzo email non è valido.',
      'auth/missing-password': 'Scrivi la password.',
      'auth/weak-password': 'La password deve avere almeno 8 caratteri.',
      'auth/password-does-not-meet-requirements': 'La password deve avere almeno 8 caratteri.',
      'auth/email-already-in-use': 'Esiste già un account con questa email: prova ad accedere.',
      'auth/invalid-credential': 'Email o password non corretti.',
      'auth/wrong-password': 'Email o password non corretti.',
      'auth/user-not-found': 'Email o password non corretti.',
      'auth/too-many-requests': 'Troppi tentativi: aspetta qualche minuto e riprova.',
      'auth/network-request-failed': 'Nessuna connessione: riprova.',
      'auth/popup-blocked': 'Il browser ha bloccato la finestra di Google: riprova.',
      'auth/unauthorized-domain': 'L\'accesso funziona solo sul sito online (stati-del-mondo.vercel.app).',
      'auth/operation-not-supported-in-this-environment': 'L\'accesso funziona solo sul sito online (stati-del-mondo.vercel.app).',
      mismatch: 'Le due password non coincidono.', short: 'La password deve avere almeno 8 caratteri.',
      generic: 'Qualcosa è andato storto, riprova.'
    }
  },
  en: {
    signin: 'Sign in', account: 'Account',
    title: 'Sign in to save your progress',
    lead: 'With an account your progress, saved quizzes and challenges follow you on every device. You can keep playing without one too.',
    google: 'Continue with Google', or: 'or with email',
    email: 'Email', password: 'Password', password2: 'Repeat password',
    login: 'Sign in', register: 'Create account',
    toRegister: 'No account yet? Create one', toLogin: 'Already have an account? Sign in',
    forgot: 'Forgot your password?', cancel: 'Close',
    sentReset: 'If an account exists for this email, we sent you a link to choose a new password.',
    verifyTitle: 'Confirm your email',
    verifyText: e => `We sent an email to ${e}. Open the link inside, then come back and press "I've confirmed". Until then your progress stays on this device only.`,
    verifyDone: 'I\'ve confirmed', verifyResend: 'Resend email', verifyResent: 'Email sent again.',
    verifyStill: 'Not confirmed yet: check your spam folder too.',
    signedAs: 'Signed in as', signout: 'Sign out', del: 'Delete account',
    delConfirm: 'Press again to permanently delete your account and the progress saved online.',
    delRecent: 'For security, sign out, sign back in and try deleting again right away.',
    st_syncing: 'Syncing…', st_ok: 'Progress saved online', st_off: 'Offline: will save when back online',
    st_unverified: 'Confirm your email to save online', st_err: 'Couldn\'t save online, will retry later',
    toastIn: 'Progress synced', pending: 'Progress updated from another device: loading it when you\'re back at the menu.',
    e: {
      'auth/invalid-email': 'That email address isn\'t valid.',
      'auth/missing-password': 'Enter your password.',
      'auth/weak-password': 'Password must be at least 8 characters.',
      'auth/password-does-not-meet-requirements': 'Password must be at least 8 characters.',
      'auth/email-already-in-use': 'An account with this email already exists: try signing in.',
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/wrong-password': 'Wrong email or password.',
      'auth/user-not-found': 'Wrong email or password.',
      'auth/too-many-requests': 'Too many attempts: wait a few minutes and try again.',
      'auth/network-request-failed': 'No connection: try again.',
      'auth/popup-blocked': 'Your browser blocked the Google window: try again.',
      'auth/unauthorized-domain': 'Sign-in only works on the online site (stati-del-mondo.vercel.app).',
      'auth/operation-not-supported-in-this-environment': 'Sign-in only works on the online site (stati-del-mondo.vercel.app).',
      mismatch: 'The two passwords don\'t match.', short: 'Password must be at least 8 characters.',
      generic: 'Something went wrong, please try again.'
    }
  }
};
const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'it');
const t = k => TXT[lang()][k];
const errText = err => {
  const m = TXT[lang()].e;
  const code = (err && (err.code || err)) || 'generic';
  return m[code] || m.generic;
};

/* ------------------------------------------------------------------ localStorage helpers */
const ls = {
  get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
  set(k, v){ try{ origSet.call(localStorage, k, v); }catch(e){} },
  del(k){ try{ origRemove.call(localStorage, k); }catch(e){} }
};
function readMeta(){ try{ return JSON.parse(ls.get(META_KEY) || 'null') || {}; }catch(e){ return {}; } }
function writeMeta(m){ ls.set(META_KEY, JSON.stringify(m)); }
function localSnapshot(){
  const out = {};
  SYNC_KEYS.forEach(k => { const v = ls.get(k); if(v !== null && v.length <= MAX_FIELD) out[k] = v; });
  return out;
}
function hasAnyLocal(){ return Object.keys(localSnapshot()).length > 0; }

/* Ogni scrittura del gioco su una chiave sincronizzata segna "ci sono modifiche da caricare". */
const origSet = Storage.prototype.setItem;
const origRemove = Storage.prototype.removeItem;
Storage.prototype.setItem = function(k, v){
  origSet.call(this, k, v);
  if(this === window.localStorage && SYNC_KEYS.includes(k)) markDirty();
};
Storage.prototype.removeItem = function(k){
  origRemove.call(this, k);
  if(this === window.localStorage && SYNC_KEYS.includes(k)) markDirty();
};

/* ------------------------------------------------------------------ unione dati locali + cloud */
const J = s => { try{ return JSON.parse(s); }catch(e){ return null; } };
function mergeProgress(a, b){
  if(!a) return b; if(!b) return a;
  const out = { learn:{}, stats:{} };
  ['stati','capitali','bandiere'].forEach(cat => {
    const la = (a.learn && a.learn[cat]) || {}, lb = (b.learn && b.learn[cat]) || {};
    const best = Object.assign({}, la.best || {});
    Object.entries(lb.best || {}).forEach(([k, v]) => { if(!(k in best) || v > best[k]) best[k] = v; });
    const completed = Object.assign({}, la.completed || {});
    Object.entries(lb.completed || {}).forEach(([k, v]) => { if(v) completed[k] = v; });
    out.learn[cat] = { best, completed };
    const sa = (a.stats && a.stats[cat]) || {}, sb = (b.stats && b.stats[cat]) || {};
    const st = Object.assign({}, sa);
    Object.entries(sb).forEach(([id, e]) => { if(!st[id] || (e && e.attempts > st[id].attempts)) st[id] = e; });
    out.stats[cat] = st;
  });
  return out;
}
function mergeById(a, b, stamp){
  const map = new Map();
  [].concat(a || [], b || []).forEach(x => {
    if(!x || typeof x.id !== 'string') return;
    const cur = map.get(x.id);
    if(!cur || stamp(x) > stamp(cur)) map.set(x.id, x);
  });
  return Array.from(map.values()).sort((x, y) => stamp(y) - stamp(x)).slice(0, 3);
}
function mergeBest(a, b){
  const out = Object.assign({}, a || {});
  Object.entries(b || {}).forEach(([k, v]) => {
    const c = out[k];
    if(!c || (v && (v.n > c.n || (v.n === c.n && v.ms < c.ms)))) out[k] = v;
  });
  return out;
}
function mergeAll(local, cloud){
  const out = Object.assign({}, cloud, local);   // per sound / impostazioni sfida vince questo dispositivo
  const P = 'worldgame_progress_v1', Q = 'worldgame_saved_quizzes_v1', C = 'worldgame_saved_challenges_v1', B = 'worldgame_typeall_best_v1';
  if(local[P] && cloud[P]) out[P] = JSON.stringify(mergeProgress(J(local[P]), J(cloud[P])));
  if(local[Q] && cloud[Q]) out[Q] = JSON.stringify(mergeById(J(local[Q]), J(cloud[Q]), q => q.updatedAt || 0));
  if(local[C] && cloud[C]) out[C] = JSON.stringify(mergeById(J(local[C]), J(cloud[C]), c => Math.max(c.created || 0, ...((c.plays || []).map(p => p.d || 0)))));
  if(local[B] && cloud[B]) out[B] = JSON.stringify(mergeBest(J(local[B]), J(cloud[B])));
  return out;
}
const sameData = (a, b) => SYNC_KEYS.every(k => (a[k] ?? null) === (b[k] ?? null));

/* ------------------------------------------------------------------ Firebase */
let app, auth, db, user = null, ready = false;
let uploadTimer = null, lastUpload = 0, uploading = false, status = '', pendingApply = null;

function canSync(u){
  if(!u) return false;
  const google = u.providerData.some(p => p.providerId === 'google.com');
  return google || u.emailVerified;
}
const newRev = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function markDirty(){
  const m = readMeta();
  if(!m.dirty){ m.dirty = true; writeMeta(m); }
  scheduleUpload();
}
function scheduleUpload(){
  if(!user || !canSync(user) || uploadTimer) return;
  const wait = Math.max(1500, UPLOAD_EVERY_MS - (Date.now() - lastUpload));
  uploadTimer = setTimeout(() => { uploadTimer = null; upload(); }, wait);
}
async function upload(){
  if(!user || !canSync(user) || uploading || pendingApply) return;
  const m = readMeta();
  if(!m.dirty || m.uid !== user.uid) return;
  if(!navigator.onLine){ setStatus('off'); return; }
  uploading = true; setStatus('syncing');
  const rev = newRev();
  try{
    m.dirty = false; writeMeta(m);          // modifiche fatte durante l'invio rimetteranno dirty
    await setDoc(doc(db, 'users', user.uid), { v: 1, rev, updatedAt: serverTimestamp(), data: localSnapshot() });
    const m2 = readMeta(); m2.rev = rev; writeMeta(m2);
    lastUpload = Date.now(); setStatus('ok');
  }catch(e){
    const m2 = readMeta(); m2.dirty = true; writeMeta(m2);
    setStatus(navigator.onLine ? 'err' : 'off');
    console.warn('[account] upload', e);
  }finally{
    uploading = false;
    if(readMeta().dirty) scheduleUpload();
  }
}
function flushNow(){ if(uploadTimer){ clearTimeout(uploadTimer); uploadTimer = null; } upload(); }

/* Scarica il documento dell'utente e decide cosa fare con i dati di questo dispositivo. */
let lastPull = 0;
async function pull(force){
  if(!user || !canSync(user) || pendingApply) return;
  if(!force && Date.now() - lastPull < 60000) return;
  lastPull = Date.now();
  setStatus('syncing');
  let snap;
  try{ snap = await getDoc(doc(db, 'users', user.uid)); }
  catch(e){ setStatus(navigator.onLine ? 'err' : 'off'); console.warn('[account] pull', e); return; }
  const m = readMeta();
  const local = localSnapshot();
  const sameUser = m.uid === user.uid;
  const localDirty = sameUser ? !!m.dirty : hasAnyLocal();   // primo accesso qui: i dati locali valgono come modifiche
  if(!snap.exists()){
    writeMeta({ uid: user.uid, rev: null, dirty: true });
    await upload();
    return;
  }
  const cloud = (snap.data() && snap.data().data) || {};
  const cloudRev = snap.data().rev || null;
  if(sameUser && cloudRev === m.rev){            // nessuno ha scritto altrove dall'ultima volta
    if(localDirty) await upload(); else setStatus('ok');
    return;
  }
  const result = localDirty ? mergeAll(local, cloud) : cloud;
  writeMeta({ uid: user.uid, rev: cloudRev, dirty: localDirty && !sameData(result, cloud) });
  if(!sameData(result, local)) applyToLocal(result);
  else setStatus('ok');
  if(readMeta().dirty) await upload();
}
function applyToLocal(data){
  if(!inSafeView()){ if(!pendingApply) toast(t('pending')); pendingApply = data; setStatus('ok'); return; }
  if(readMeta().dirty) data = mergeAll(localSnapshot(), data);   // modifiche fatte mentre si aspettava il menu
  SYNC_KEYS.forEach(k => { if(k in data) ls.set(k, data[k]); else ls.del(k); });
  try{ sessionStorage.setItem('worldgame_sync_toast', '1'); }catch(e){}
  location.reload();
}
function inSafeView(){
  return SAFE_VIEWS.some(id => { const el = document.getElementById(id); return el && !el.hidden; }) &&
         !document.querySelector('.modal-backdrop:not([hidden]):not(#wg-acc-modal)');
}
setInterval(() => { if(pendingApply && inSafeView()){ const d = pendingApply; pendingApply = null; applyToLocal(d); } }, 1000);

/* ------------------------------------------------------------------ interfaccia */
const ICON_USER = '<svg class="i" viewBox="0 0 32 32" fill="none" stroke="#256F8C" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="16" cy="11.5" r="5.5" fill="#8CCFE0"/><path d="M5.5 27 a10.5 9 0 0 1 21 0 Z" fill="#FFFFFF"/></svg>';
const ICON_G = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function injectStyles(){
  const s = document.createElement('style');
  s.textContent = `
  #wg-acc-btn .acc-label{ max-width:11ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #wg-acc-btn .acc-dot{ width:8px; height:8px; border-radius:50%; background:var(--accent); display:inline-block; }
  #wg-acc-btn .acc-dot.warn{ background:#E0A100; } #wg-acc-btn .acc-dot.bad{ background:var(--bad); }
  #wg-acc-modal .modal-card{ gap:12px; }
  #wg-acc-modal .acc-google{ display:flex; align-items:center; justify-content:center; gap:10px; width:100%; }
  #wg-acc-modal .acc-or{ display:flex; align-items:center; gap:10px; color:var(--ink-soft); font-size:.84rem; }
  #wg-acc-modal .acc-or::before, #wg-acc-modal .acc-or::after{ content:''; flex:1; height:2px; background:var(--line-soft); border-radius:2px; }
  #wg-acc-modal form{ display:flex; flex-direction:column; gap:10px; margin:0; }
  #wg-acc-modal label{ font-weight:700; font-size:.88rem; display:flex; flex-direction:column; gap:5px; }
  #wg-acc-modal .text-field{ width:100%; max-width:none; box-sizing:border-box; }
  #wg-acc-modal .acc-link{ background:none; border:none; padding:2px 0; color:var(--accent-strong); font-weight:700; cursor:pointer; text-decoration:underline; text-underline-offset:3px; font-size:.88rem; align-self:flex-start; }
  #wg-acc-modal .acc-msg{ margin:0; font-size:.88rem; color:var(--good); background:var(--good-bg); border-radius:12px; padding:8px 12px; }
  #wg-acc-modal .acc-status{ font-size:.86rem; color:var(--ink-soft); }
  #wg-acc-modal .acc-who{ font-weight:800; word-break:break-all; color:var(--ink); }
  #wg-acc-modal .btn-row{ display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
  #wg-acc-modal .acc-danger{ color:var(--bad); }
  #wg-acc-toast{ position:fixed; left:50%; bottom:22px; transform:translateX(-50%); z-index:60; background:var(--ink); color:var(--paper); padding:10px 18px; border-radius:14px; font-weight:700; font-size:.9rem; box-shadow:0 4px 0 rgba(0,0,0,.25); max-width:calc(100% - 32px); text-align:center; }
  `;
  document.head.appendChild(s);
}

let btn, modal, mode = 'login', delArmed = false;
function buildUI(){
  injectStyles();
  const bar = document.querySelector('.hud-actions');
  btn = document.createElement('button');
  btn.className = 'icon-btn'; btn.id = 'wg-acc-btn'; btn.type = 'button';
  bar.insertBefore(btn, bar.firstChild);
  btn.addEventListener('click', () => openModal());

  modal = document.createElement('div');
  modal.className = 'modal-backdrop'; modal.id = 'wg-acc-modal'; modal.hidden = true;
  modal.innerHTML = '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="wg-acc-title"></div>';
  document.getElementById('app').appendChild(modal);
  modal.addEventListener('click', e => { if(e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && !modal.hidden) closeModal(); });

  new MutationObserver(() => { renderButton(); if(!modal.hidden) renderModal(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  renderButton();
}
function renderButton(){
  if(!btn) return;
  if(!user){
    btn.innerHTML = `<span class="ico">${ICON_USER}</span><span>${t('signin')}</span>`;
    btn.setAttribute('aria-label', t('signin'));
  }else{
    const name = (user.displayName || user.email || t('account')).split(/[ @]/)[0];
    const cls = status === 'err' ? 'bad' : (status === 'off' || !canSync(user)) ? 'warn' : '';
    btn.innerHTML = `<span class="ico">${ICON_USER}</span><span class="acc-label"></span><span class="acc-dot ${cls}" aria-hidden="true"></span>`;
    btn.querySelector('.acc-label').textContent = name;
    btn.setAttribute('aria-label', t('account') + ': ' + (user.email || name));
  }
}
function setStatus(s){ status = s; renderButton(); if(modal && !modal.hidden && user) renderModal(); }
function openModal(){ delArmed = false; modal.hidden = false; renderModal(); const f = modal.querySelector('input'); if(f) f.focus(); }
function closeModal(){ modal.hidden = true; }

function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function renderModal(message){
  const card = modal.querySelector('.modal-card');
  if(user && !canSync(user)){
    card.innerHTML = `
      <h3 id="wg-acc-title">${t('verifyTitle')}</h3>
      <p>${esc(t('verifyText')(user.email))}</p>
      ${message ? `<p class="acc-msg">${esc(message)}</p>` : ''}
      <div class="form-error" role="alert" hidden></div>
      <div class="btn-row">
        <button class="btn ghost btn-sm" data-a="signout">${t('signout')}</button>
        <button class="btn ghost btn-sm" data-a="resend">${t('verifyResend')}</button>
        <button class="btn primary" data-a="verified">${t('verifyDone')}</button>
      </div>`;
  }else if(user){
    const st = { syncing: t('st_syncing'), ok: t('st_ok'), off: t('st_off'), err: t('st_err') }[status] || '';
    card.innerHTML = `
      <h3 id="wg-acc-title">${t('account')}</h3>
      <p>${t('signedAs')} <span class="acc-who">${esc(user.email || user.displayName || '')}</span></p>
      <p class="acc-status">${esc(st)}</p>
      ${message ? `<p class="acc-msg">${esc(message)}</p>` : ''}
      <div class="form-error" role="alert" hidden></div>
      <div class="btn-row">
        <button class="btn ghost btn-sm acc-danger" data-a="delete">${t('del')}</button>
        <button class="btn ghost btn-sm" data-a="signout">${t('signout')}</button>
        <button class="btn primary" data-a="close">${t('cancel')}</button>
      </div>`;
  }else{
    const reg = mode === 'register';
    card.innerHTML = `
      <h3 id="wg-acc-title">${t('title')}</h3>
      <p>${t('lead')}</p>
      <button class="btn ghost acc-google" data-a="google" type="button">${ICON_G}<span>${t('google')}</span></button>
      <div class="acc-or">${t('or')}</div>
      <form novalidate>
        <label>${t('email')}<input class="text-field" type="email" name="email" autocomplete="email" required maxlength="254"></label>
        <label>${t('password')}<input class="text-field" type="password" name="pw" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="8" maxlength="128"></label>
        ${reg ? `<label>${t('password2')}<input class="text-field" type="password" name="pw2" autocomplete="new-password" required minlength="8" maxlength="128"></label>` : ''}
        ${message ? `<p class="acc-msg">${esc(message)}</p>` : ''}
        <div class="form-error" role="alert" hidden></div>
        ${reg ? '' : `<button class="acc-link" data-a="forgot" type="button">${t('forgot')}</button>`}
        <div class="btn-row">
          <button class="btn ghost" data-a="close" type="button">${t('cancel')}</button>
          <button class="btn primary" type="submit">${reg ? t('register') : t('login')}</button>
        </div>
        <button class="acc-link" data-a="switch" type="button">${reg ? t('toLogin') : t('toRegister')}</button>
      </form>`;
    card.querySelector('form').addEventListener('submit', onSubmit);
  }
  card.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', onAction));
}
function showError(msg){
  const el = modal.querySelector('.form-error');
  if(el){ el.textContent = msg; el.hidden = !msg; }
}
function busy(on){ modal.querySelectorAll('button, input').forEach(x => { x.disabled = on; }); }

async function onSubmit(e){
  e.preventDefault();
  const f = e.target, email = f.email.value.trim(), pw = f.pw.value;
  showError('');
  if(mode === 'register'){
    if(pw.length < 8) return showError(errText('short'));
    if(pw !== f.pw2.value) return showError(errText('mismatch'));
  }
  busy(true);
  try{
    if(mode === 'register'){
      const cred = await createUserWithEmailAndPassword(auth, email, pw);
      try{ await sendEmailVerification(cred.user, { url: location.origin + location.pathname }); }catch(e2){}
    }else{
      await signInWithEmailAndPassword(auth, email, pw);
    }
  }catch(err){ busy(false); showError(errText(err)); return; }
  busy(false);
}
async function onAction(e){
  const a = e.currentTarget.dataset.a;
  showError('');
  try{
    if(a === 'close') return closeModal();
    if(a === 'switch'){ mode = mode === 'login' ? 'register' : 'login'; renderModal(); modal.querySelector('input').focus(); return; }
    if(a === 'google'){
      const p = new GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      try{ await signInWithPopup(auth, p); }
      catch(err){
        if(err && (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request')) await signInWithRedirect(auth, p);
        else if(err && err.code !== 'auth/popup-closed-by-user') throw err;
      }
      return;
    }
    if(a === 'forgot'){
      const email = modal.querySelector('input[name=email]').value.trim();
      if(!email) return showError(errText('auth/invalid-email'));
      try{ await sendPasswordResetEmail(auth, email, { url: location.origin + location.pathname }); }
      catch(err){ if(err.code !== 'auth/user-not-found') throw err; }
      return renderModal(t('sentReset'));
    }
    if(a === 'resend'){ await sendEmailVerification(user, { url: location.origin + location.pathname }); return renderModal(t('verifyResent')); }
    if(a === 'verified'){
      await user.reload(); await user.getIdToken(true);
      if(!user.emailVerified) return renderModal(t('verifyStill'));
      onUser(auth.currentUser);
      return;
    }
    if(a === 'signout') return doSignOut();
    if(a === 'delete'){
      if(!delArmed){ delArmed = true; return showError(t('delConfirm')); }
      busy(true);
      try{ await deleteDoc(doc(db, 'users', user.uid)); }catch(err){}
      try{ await deleteUser(user); }
      catch(err){ busy(false); if(err.code === 'auth/requires-recent-login') return showError(t('delRecent')); throw err; }
      clearLocalAndReload();
    }
  }catch(err){ busy(false); showError(errText(err)); }
}
async function doSignOut(){
  busy(true);
  await upload();                 // non perdere le ultime modifiche
  await signOut(auth);
  clearLocalAndReload();
}
/* Uscendo, i dati dell'account restano online e spariscono da questo browser:
   su un computer condiviso la persona dopo non vede (né eredita) i progressi di chi è uscito. */
function clearLocalAndReload(){
  SYNC_KEYS.forEach(k => ls.del(k));
  ls.del(META_KEY);
  location.reload();
}

let toastTimer = null;
function toast(msg){
  let el = document.getElementById('wg-acc-toast');
  if(!el){ el = document.createElement('div'); el.id = 'wg-acc-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

/* ------------------------------------------------------------------ avvio */
let lastUid = null;
function onUser(u){
  user = u;
  renderButton();
  if(!modal.hidden) renderModal();
  if(u && canSync(u)){
    if(!modal.hidden && lastUid !== u.uid) closeModal();
    lastUid = u.uid;
    pull(true);
  }else if(u){
    if(modal.hidden) openModal();     // appena registrato: mostra "conferma la tua email"
  }
}
function start(){
  buildUI();
  try{ if(sessionStorage.getItem('worldgame_sync_toast')){ sessionStorage.removeItem('worldgame_sync_toast'); toast(t('toastIn')); } }catch(e){}
  if(FIREBASE_CONFIG.apiKey.startsWith('__')){ console.warn('[account] Firebase non configurato'); btn.hidden = true; return; }
  try{
    app = initializeApp(FIREBASE_CONFIG);
    auth = getAuth(app);
    auth.languageCode = lang();
    db = getFirestore(app);
  }catch(e){ console.warn('[account] init', e); btn.hidden = true; return; }
  setPersistence(auth, browserLocalPersistence).catch(() => {});
  onAuthStateChanged(auth, u => { ready = true; onUser(u); });
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') flushNow(); else if(user && canSync(user)) pull(); });
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('online', () => { if(readMeta().dirty) scheduleUpload(); });
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

/* Solo per i test automatici. */
window.__wgAccount = { pull, upload, mergeAll, mergeProgress, mergeById, mergeBest, readMeta, SYNC_KEYS, get user(){ return user; }, get status(){ return status; } };
