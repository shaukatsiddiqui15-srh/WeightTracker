/* Morning Scale — daily fasting weigh-in tracker.
   Everything is stored in this browser (IndexedDB). No server, no account. */
(() => {
'use strict';

/* ---------- tiny helpers ---------- */
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return dayKey(d); };
const daysBetween = (a, b) => Math.round((Date.UTC(...b.split('-').map((v, i) => i === 1 ? v - 1 : +v)) - Date.UTC(...a.split('-').map((v, i) => i === 1 ? v - 1 : +v))) / 864e5);
const fmtDay = (k, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => parseKey(k).toLocaleDateString('en-IN', opts);
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const kg = (n) => (Math.round(n * 10) / 10).toFixed(1);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTH_DAYS = 30.4375;

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- storage (IndexedDB) ---------- */
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('morning-scale', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('entries', { keyPath: 'date' });
      d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store);
    let out; const req = fn(s); if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const getSettings = () => tx('meta', 'readonly', (s) => s.get('settings'));
const putSettings = (v) => tx('meta', 'readwrite', (s) => s.put(v, 'settings'));
const allEntries = () => tx('entries', 'readonly', (s) => s.getAll());
const putEntry = (e) => tx('entries', 'readwrite', (s) => s.put(e));
const delEntry = (k) => tx('entries', 'readwrite', (s) => s.delete(k));
const clearAll = async () => { await tx('entries', 'readwrite', (s) => s.clear()); await tx('meta', 'readwrite', (s) => s.clear()); };

/* ---------- photo: capture time + compression ---------- */
// Reads DateTimeOriginal from a JPEG's EXIF block. Returns a Date or null.
async function exifDate(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off), len = v.getUint16(off + 2);
      if ((marker & 0xFF00) !== 0xFF00) return null;
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return readTiffDate(v, off + 10);
      off += 2 + len;
    }
  } catch (e) { /* unreadable EXIF — fall back below */ }
  return null;
}
function readTiffDate(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
  const find = (ifd, tag) => { const n = u16(ifd); for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === tag) return e; } return null; };
  const ifd0 = t + u32(t + 4);
  let entry = null;
  const exifPtr = find(ifd0, 0x8769);
  if (exifPtr) entry = find(t + u32(exifPtr + 8), 0x9003);
  if (!entry) entry = find(ifd0, 0x0132);
  if (!entry) return null;
  const at = t + u32(entry + 8); let s = '';
  for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(at + i));
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
async function photoTakenAt(file) {
  const ex = await exifDate(file);
  if (ex && !isNaN(ex)) return { time: ex, source: 'camera data' };
  return { time: new Date(file.lastModified || Date.now()), source: 'file time' };
}
async function compress(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  }
  const w = src.width, h = src.height, max = 1100, s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
}

/* ---------- targets ---------- */
let S = null;           // settings
let E = [];             // entries sorted by date
const byDate = () => new Map(E.map((e) => [e.date, e]));
function targetOn(k) {
  const d = Math.max(0, daysBetween(S.startDate, k));
  let t = S.startWeight - S.monthlyLoss * d / MONTH_DAYS;
  if (S.goalWeight) t = Math.max(t, S.goalWeight);
  return t;
}
function avg7(k, map) {
  const vals = [];
  for (let i = 0; i < 7; i++) { const e = map.get(addDays(k, -i)); if (e) vals.push(e.weight); }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
function lastBefore(k) { for (let i = E.length - 1; i >= 0; i--) if (E[i].date < k) return E[i]; return null; }

/* ---------- verification ---------- */
function runChecks({ hasPhoto, takenAt, source, weight, fasting, date }) {
  const out = [];
  out.push({ ok: hasPhoto, text: hasPhoto ? 'Scale photo attached' : 'Scale photo is required' });
  if (hasPhoto) {
    const sameDay = dayKey(takenAt) === date;
    out.push({ ok: sameDay, text: sameDay ? `Photo taken today, ${fmtTime(takenAt.toISOString())} (${source})` : `Photo is from ${fmtDay(dayKey(takenAt))}, not today` });
    const morning = takenAt.getHours() < S.cutoffHour;
    const cut = new Date(2000, 0, 1, S.cutoffHour).toLocaleTimeString('en-IN', { hour: 'numeric' });
    out.push({ ok: morning, text: morning ? `Morning weigh-in (before ${cut})` : `Photo taken after ${cut}` });
  }
  out.push({ ok: !!fasting, text: fasting ? 'Weighed before eating or drinking' : 'Not marked as fasting' });
  if (weight) {
    const prev = lastBefore(date);
    if (prev && daysBetween(prev.date, date) <= 3) {
      const diff = weight - prev.weight;
      const ok = Math.abs(diff) <= 2.5;
      out.push({ ok, text: ok ? `Change from last entry looks normal (${diff > 0 ? '+' : ''}${kg(diff)} kg)` : `Big jump from last entry (${diff > 0 ? '+' : ''}${kg(diff)} kg). Check the number matches the photo` });
    }
  }
  return out;
}
const checksHTML = (list) => list.map((c) => `<li class="${c.ok ? 'pass' : 'fail'}"><span class="i">${c.ok ? '✓' : '!'}</span><span>${esc(c.text)}</span></li>`).join('');

/* ---------- rendering ---------- */
let urls = [];
const objURL = (blob) => { const u = URL.createObjectURL(blob); urls.push(u); return u; };

function render() {
  urls.forEach(URL.revokeObjectURL); urls = [];
  const today = dayKey();
  const map = byDate();
  $('subtitle').textContent = S.name ? `${S.name}'s daily fasting weigh-in` : 'Daily fasting weigh-in';
  renderToday(today, map);
  renderStats(today, map);
  renderChart(today, map);
  renderHistory(today, map);
}

function renderToday(today, map) {
  const el = $('today'); const e = map.get(today);
  const target = targetOn(today);
  const dateLine = `<div class="date">${fmtDay(today, { weekday: 'long', day: 'numeric', month: 'long' })}</div>`;
  const started = daysBetween(S.startDate, today) >= 0;
  if (!started) {
    el.className = 'today';
    el.innerHTML = `${dateLine}<p class="headline">Tracking starts on ${fmtDay(S.startDate)}.</p>`;
    return;
  }
  if (!e) {
    const late = new Date().getHours() >= S.cutoffHour;
    el.className = 'today ' + (late ? 'missing' : 'waiting');
    el.innerHTML = `${dateLine}
      <p class="headline">${late ? "Today's weight has not been given." : "Today's weigh-in is still pending."}</p>
      <div class="pace"><span>Today's target <b>${kg(target)} kg</b></span>${late ? '<span>Morning window has passed</span>' : `<span>Log before ${new Date(2000, 0, 1, S.cutoffHour).toLocaleTimeString('en-IN', { hour: 'numeric' })}</span>`}</div>
      <button class="btn primary block" id="logBtn">Log this morning's weight</button>`;
    $('logBtn').onclick = openLog;
    return;
  }
  const a7 = avg7(today, map);
  const diff = (a7 ?? e.weight) - target;
  el.className = 'today';
  el.innerHTML = `${dateLine}
    <div class="today-row">
      <img class="thumb" src="${objURL(e.photo)}" alt="Scale photo for today" id="todayThumb">
      <div>
        <div class="big">${kg(e.weight)}<small>kg</small></div>
        <div style="margin-top:6px">${e.status === 'verified' ? '<span class="chip ok">Verified</span>' : '<span class="chip flag">Needs a look</span>'}</div>
      </div>
    </div>
    <div class="pace"><span>Target today <b>${kg(target)} kg</b></span><span>${diff <= 0 ? `<b>${kg(-diff)} kg</b> ahead of pace` : `<b>${kg(diff)} kg</b> behind pace`}</span></div>`;
  $('todayThumb').onclick = () => openView(e.date);
}

function streak(today, map) {
  let k = map.has(today) ? today : addDays(today, -1), n = 0;
  while (map.has(k)) { n++; k = addDays(k, -1); }
  return n;
}

function renderStats(today, map) {
  const latest = E[E.length - 1];
  const a7 = avg7(today, map) ?? (latest ? avg7(latest.date, map) : null);
  const lost = latest ? S.startWeight - latest.weight : 0;
  const tgt = targetOn(today);
  const st = streak(today, map);
  const totalDays = Math.max(0, daysBetween(S.startDate, today) + 1);
  const missed = Math.max(0, totalDays - E.filter((x) => x.date >= S.startDate && x.date <= today).length - (map.has(today) ? 0 : 1));
  $('stats').innerHTML = `
    <div class="stat"><div class="k">Latest</div><div class="v">${latest ? kg(latest.weight) : '—'}<small>kg</small></div><div class="n">${latest ? fmtDay(latest.date, { day: 'numeric', month: 'short' }) : 'No entries yet'}</div></div>
    <div class="stat"><div class="k">Lost so far</div><div class="v">${kg(Math.max(lost, 0))}<small>kg</small></div><div class="n">from ${kg(S.startWeight)} kg</div></div>
    <div class="stat"><div class="k">7-day avg</div><div class="v">${a7 ? kg(a7) : '—'}<small>kg</small></div><div class="n ${a7 ? (a7 <= tgt ? 'good' : 'bad') : ''}">${a7 ? (a7 <= tgt ? 'On pace' : `${kg(a7 - tgt)} kg over pace`) : 'Needs entries'}</div></div>
    <div class="stat"><div class="k">Streak</div><div class="v">${st}<small>day${st === 1 ? '' : 's'}</small></div><div class="n">${missed ? `${missed} day${missed === 1 ? '' : 's'} missed` : 'No missed days'}</div></div>`;
}

function renderChart(today, map) {
  const W = 560, H = 250, L = 42, R = 12, T = 14, B = 30;
  const span = Math.max(30, daysBetween(S.startDate, today) + 3);
  const endKey = addDays(S.startDate, span);
  const pts = E.filter((e) => e.date >= S.startDate);
  const avgs = pts.map((e) => ({ d: daysBetween(S.startDate, e.date), v: avg7(e.date, map) }));
  const vals = [S.startWeight, targetOn(endKey), ...pts.map((e) => e.weight)];
  let lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  const x = (d) => L + (W - L - R) * d / span;
  const y = (v) => T + (H - T - B) * (hi - v) / (hi - lo);
  const step = hi - lo > 14 ? 4 : hi - lo > 7 ? 2 : 1;
  let g = '';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) g += `<line class="c-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="c-label" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  const xt = [0, Math.round(span / 2), span];
  xt.forEach((d, i) => { g += `<text class="c-label" x="${x(d)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">${fmtDay(addDays(S.startDate, d), { day: 'numeric', month: 'short' })}</text>`; });
  if (S.goalWeight && S.goalWeight > lo) g += `<line class="c-goal" x1="${L}" x2="${W - R}" y1="${y(S.goalWeight)}" y2="${y(S.goalWeight)}"/><text class="c-label" x="${W - R}" y="${y(S.goalWeight) - 5}" text-anchor="end">goal ${S.goalWeight}</text>`;
  // target pace line (may bend where it reaches the goal)
  const tp = []; for (let d = 0; d <= span; d += Math.max(1, Math.round(span / 40))) tp.push(`${x(d).toFixed(1)},${y(targetOn(addDays(S.startDate, d))).toFixed(1)}`);
  tp.push(`${x(span).toFixed(1)},${y(targetOn(endKey)).toFixed(1)}`);
  g += `<polyline class="c-target" points="${tp.join(' ')}"/>`;
  if (avgs.length > 1) g += `<polyline class="c-avg" points="${avgs.map((a) => `${x(a.d).toFixed(1)},${y(a.v).toFixed(1)}`).join(' ')}"/>`;
  pts.forEach((e) => { g += `<circle class="c-pt ${e.status === 'verified' ? '' : 'flag'}" cx="${x(daysBetween(S.startDate, e.date)).toFixed(1)}" cy="${y(e.weight).toFixed(1)}" r="4"/>`; });
  if (!pts.length) g += `<text class="c-empty" x="${(L + W - R) / 2}" y="${H / 2}" text-anchor="middle">Your first weigh-in will appear here</text>`;
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight over time against the target pace">${g}</svg>`;
}

let showAll = false;
function renderHistory(today, map) {
  const days = [];
  for (let k = today; k >= S.startDate; k = addDays(k, -1)) days.push(k);
  E.filter((e) => e.date < S.startDate).reverse().forEach((e) => days.push(e.date));
  const list = showAll ? days : days.slice(0, 21);
  const logged = E.filter((e) => e.date >= S.startDate).length;
  $('logCount').textContent = `${logged} of ${Math.max(0, daysBetween(S.startDate, today) + 1)} days logged`;
  const late = new Date().getHours() >= S.cutoffHour;
  $('history').innerHTML = list.map((k) => {
    const e = map.get(k);
    if (!e) {
      const pending = k === today && !late;
      return `<li class="${pending ? '' : 'missing'}"><span class="h-none"></span><div class="h-main"><div class="h-date">${fmtDay(k)}</div><div class="h-meta">${pending ? 'Waiting for this morning' : 'Weight not given'}</div></div><span class="chip ${pending ? 'wait' : 'miss'}">${pending ? 'Pending' : 'Not logged'}</span></li>`;
    }
    const prev = lastBefore(k); const d = prev ? e.weight - prev.weight : null;
    return `<li><button class="h-thumb" data-view="${k}" aria-label="View photo for ${fmtDay(k)}" style="background:url(${objURL(e.photo)}) center/cover"></button>
      <div class="h-main"><div class="h-date">${fmtDay(k)}</div><div class="h-meta">${fmtTime(e.photoTime)} · ${e.status === 'verified' ? '<span class="chip ok">Verified</span>' : '<span class="chip flag">Needs a look</span>'}</div></div>
      <div class="h-w">${kg(e.weight)}<span class="d ${d !== null && d < 0 ? 'down' : ''}">${d === null ? 'first' : `${d > 0 ? '+' : ''}${kg(d)}`}</span></div></li>`;
  }).join('') + (days.length > 21 ? `<li style="display:block"><button class="btn ghost block more" id="moreBtn">${showAll ? 'Show recent days only' : `Show all ${days.length} days`}</button></li>` : '');
  $('history').querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => openView(b.dataset.view); });
  if ($('moreBtn')) $('moreBtn').onclick = () => { showAll = !showAll; renderHistory(today, map); };
}

/* ---------- log dialog ---------- */
let draft = null;
function openLog() {
  draft = { file: null, takenAt: null, source: null };
  $('logForm').reset(); $('fastingInput').checked = true;
  $('photoPreview').hidden = true; $('photoEmpty').hidden = false;
  updateLive(); $('logDialog').showModal();
}
function draftState() {
  const w = parseFloat($('weightInput').value);
  return { hasPhoto: !!draft.file, takenAt: draft.takenAt, source: draft.source, weight: w > 0 ? w : null, fasting: $('fastingInput').checked, date: dayKey() };
}
function updateLive() {
  const st = draftState();
  $('liveChecks').innerHTML = draft.file || st.weight ? checksHTML(runChecks(st)) : '';
  $('saveLog').disabled = !(st.hasPhoto && st.weight && st.weight >= 20 && st.weight <= 300);
}
$('photoInput').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0]; if (!f) return;
  const t = await photoTakenAt(f);
  draft.file = f; draft.takenAt = t.time; draft.source = t.source;
  const p = $('photoPreview'); if (p.dataset.url) URL.revokeObjectURL(p.dataset.url);
  p.dataset.url = URL.createObjectURL(f); p.src = p.dataset.url; p.hidden = false; $('photoEmpty').hidden = true;
  updateLive();
});
$('weightInput').addEventListener('input', updateLive);
$('fastingInput').addEventListener('change', updateLive);
$('cancelLog').onclick = () => $('logDialog').close();
$('logForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const st = draftState(); if (!st.hasPhoto || !st.weight) return;
  $('saveLog').disabled = true; $('saveLog').textContent = 'Saving…';
  try {
    const checks = runChecks(st);
    const photo = await compress(draft.file);
    await putEntry({ date: st.date, weight: Math.round(st.weight * 10) / 10, photo, photoTime: st.takenAt.toISOString(), photoSource: st.source, loggedAt: new Date().toISOString(), fasting: st.fasting, checks, status: checks.every((c) => c.ok) ? 'verified' : 'flagged' });
    await load(); $('logDialog').close();
    toast(checks.every((c) => c.ok) ? 'Weigh-in saved and verified' : 'Weigh-in saved. Some checks need a look');
  } catch (e) { toast('Could not save. Try again.'); console.error(e); }
  finally { $('saveLog').textContent = 'Save weigh-in'; updateLive(); }
});

/* ---------- view dialog ---------- */
function openView(k) {
  const e = byDate().get(k); if (!e) return;
  const u = URL.createObjectURL(e.photo);
  $('viewBody').innerHTML = `
    <div class="view-head"><h2>${fmtDay(k, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>${e.status === 'verified' ? '<span class="chip ok">Verified</span>' : '<span class="chip flag">Needs a look</span>'}</div>
    <img class="view-img" src="${u}" alt="Scale photo">
    <div><div class="muted">Entered weight. Check it matches the display in the photo</div><div class="view-w">${kg(e.weight)} kg</div></div>
    <ul class="checks">${checksHTML(e.checks || [])}</ul>
    <p class="muted" style="margin:0">Logged at ${fmtTime(e.loggedAt)}</p>
    <div class="sheet-actions">
      ${k === dayKey() ? '<button class="btn ghost" id="redoBtn">Redo today</button>' : '<button class="btn ghost" id="delBtn">Delete entry</button>'}
      <button class="btn primary" id="closeView">Close</button>
    </div>
    <p class="muted" id="delConfirm" hidden style="margin:0">Tap Delete entry again to remove this day.</p>`;
  const dlg = $('viewDialog');
  const close = () => { URL.revokeObjectURL(u); dlg.close(); };
  $('closeView').onclick = close;
  if ($('redoBtn')) $('redoBtn').onclick = () => { close(); openLog(); };
  if ($('delBtn')) {
    let armed = false;
    $('delBtn').onclick = async () => {
      if (!armed) { armed = true; $('delConfirm').hidden = false; $('delBtn').textContent = 'Delete entry'; return; }
      await delEntry(k); close(); await load(); toast('Entry deleted');
    };
  }
  dlg.showModal();
}

/* ---------- settings ---------- */
function openSettings(first) {
  $('settingsTitle').textContent = first ? 'Set up the tracker' : 'Settings';
  $('cancelSettings').hidden = !!first; $('resetAll').hidden = !!first;
  const s = S || { name: '', startWeight: 100, startDate: dayKey(), monthlyLoss: 5, goalWeight: null, cutoffHour: 11 };
  $('sName').value = s.name || ''; $('sStart').value = s.startWeight; $('sDate').value = s.startDate;
  $('sRate').value = s.monthlyLoss; $('sGoal').value = s.goalWeight || ''; $('sCutoff').value = String(s.cutoffHour);
  $('resetAll').textContent = 'Delete all data on this phone'; $('resetAll').dataset.armed = '';
  $('settingsDialog').showModal();
}
$('openSettings').onclick = () => openSettings(false);
$('cancelSettings').onclick = () => $('settingsDialog').close();
$('settingsDialog').addEventListener('cancel', (ev) => { if (!S) ev.preventDefault(); });
$('settingsForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const goal = parseFloat($('sGoal').value);
  S = { name: $('sName').value.trim(), startWeight: parseFloat($('sStart').value), startDate: $('sDate').value || dayKey(),
        monthlyLoss: parseFloat($('sRate').value), goalWeight: goal > 0 ? goal : null, cutoffHour: parseInt($('sCutoff').value, 10) };
  await putSettings(S); $('settingsDialog').close(); render(); toast('Settings saved');
});
$('resetAll').onclick = async () => {
  const b = $('resetAll');
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again to delete every entry and photo'; return; }
  await clearAll(); S = null; E = []; $('settingsDialog').close(); toast('All data deleted'); openSettings(true);
};

/* ---------- backup ---------- */
const blobToData = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
const dataToBlob = async (d) => (await fetch(d)).blob();
$('exportBtn').onclick = async () => {
  const entries = await Promise.all(E.map(async (e) => ({ ...e, photo: await blobToData(e.photo) })));
  const blob = new Blob([JSON.stringify({ app: 'morning-scale', version: 1, exportedAt: new Date().toISOString(), settings: S, entries })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `morning-scale-backup-${dayKey()}.json`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};
$('importInput').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'morning-scale' || !data.settings || !Array.isArray(data.entries)) throw new Error('not a backup');
    await putSettings(data.settings);
    for (const e of data.entries) await putEntry({ ...e, photo: await dataToBlob(e.photo) });
    await load(); toast(`Restored ${data.entries.length} entries`);
  } catch (e) { toast('That file is not a Morning Scale backup'); }
});

/* ---------- boot ---------- */
async function load() {
  S = await getSettings() || null;
  E = ((await allEntries()) || []).sort((a, b) => a.date.localeCompare(b.date));
  if (S) render();
}
(async () => {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  await load();
  if (!S) openSettings(true);
  // refresh the "not given" state when the day changes or the app is reopened
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S) render(); });
  setInterval(() => { if (S) render(); }, 5 * 60 * 1000);
})();
})();
