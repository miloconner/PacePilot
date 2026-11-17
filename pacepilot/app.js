'use strict';
const $ = id => document.getElementById(id);
const MI = 1609.344;
const CFG = { maxAcc: 30, maxSpeed: 10, win: 5, minStep: 2, paceWin: 30, coachEvery: 30 };

let S = 'idle';               // idle | running | paused | done
let watchId = null, wake = null, timer = null;
let accum = 0, segStart = 0;  // moving time (paused time excluded)
let dist = 0, raw = [], lastRaw = null, lastSm = null, samples = [], bad = 0, lastFixAt = 0;
let target = 0, targetMi = 0, targetTime = 0, nextCoach = CFG.coachEvery;
let lastSpoken = { text: '', at: -1e9 }, finishSaid = false;

/* ---------- helpers ---------- */
const mmss = s => {
  if (s == null || !isFinite(s) || s < 0 || s > 5999) return '--:--';
  s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const hms = s => {
  s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0') : m + ':' + String(x).padStart(2, '0');
};
const elapsed = () => accum + (S === 'running' ? (performance.now() - segStart) / 1000 : 0);
const toRad = x => x * Math.PI / 180;
function hav(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}
function msg(t, isErr) { $('msg').textContent = t || ''; $('msg').className = isErr ? 'err' : ''; }
const cls = d => Math.abs(d) < 10 ? 'ok' : Math.abs(d) <= 20 ? 'warn' : 'bad';

/* ---------- setup ---------- */
function readCfg() {
  const d = parseFloat($('dist').value), m = parseInt($('min').value, 10) || 0, s = parseInt($('sec').value, 10) || 0;
  const total = m * 60 + s;
  if (!(d > 0) || total <= 0) return null;
  return { d, total, pace: total / d };
}
function updateTarget() {
  const c = readCfg();
  $('tpMi').textContent = c ? mmss(c.pace) : '--:--';
  $('tpKm').textContent = c ? mmss(c.pace / 1.609344) : '--:--';
}
['dist', 'min', 'sec'].forEach(id => $(id).addEventListener('input', updateTarget));
try {
  const sv = JSON.parse(localStorage.getItem('pacepilot') || '{}');
  if (sv.d) { $('dist').value = sv.d; $('min').value = sv.m; $('sec').value = sv.s; $('voice').checked = sv.v !== false; }
} catch (e) {}
updateTarget();

/* ---------- speech ---------- */
function speak(text) {
  if (!$('voice').checked || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; u.rate = 1;
    speechSynthesis.speak(u);
  } catch (e) {}
}

/* ---------- GPS ---------- */
function setGps(acc) { $('gps').textContent = acc == null ? 'GPS off' : 'GPS \u00b1' + Math.round(acc) + ' m' + (bad ? ' (' + bad + ' rejected)' : ''); }
function resetFilter() { raw = []; lastRaw = null; lastSm = null; }
function startWatch() {
  watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
function stopWatch() { if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; }

let badStreak = 0;
function onPos(p) {
  if (S !== 'running') return;
  const { latitude: lat, longitude: lon, accuracy: acc } = p.coords, t = p.timestamp / 1000;
  lastFixAt = performance.now(); setGps(acc); msg('');
  if (acc > CFG.maxAcc) { bad++; return; }                       // inaccurate reading
  if (lastRaw) {
    const dt = t - lastRaw.t; if (dt <= 0) return;
    if (hav(lastRaw, { lat, lon }) / dt > CFG.maxSpeed) {         // unrealistic jump
      bad++; if (++badStreak >= 5) { resetFilter(); badStreak = 0; } return;
    }
  }
  badStreak = 0; lastRaw = { lat, lon, t };
  raw.push({ lat, lon }); if (raw.length > CFG.win) raw.shift();   // rolling window average
  const sm = { lat: raw.reduce((a, r) => a + r.lat, 0) / raw.length, lon: raw.reduce((a, r) => a + r.lon, 0) / raw.length };
  if (!lastSm) { lastSm = sm; samples.push({ e: elapsed(), d: dist }); return; }
  const step = hav(lastSm, sm);
  if (step < CFG.minStep) return;                                 // ignore standing-still jitter
  dist += step; lastSm = sm;
  samples.push({ e: elapsed(), d: dist });
  const e = elapsed(); samples = samples.filter(s => e - s.e < 120);
}
function onErr(err) {
  if (err.code === 1) { abort('Location permission denied. Allow location for this site in Chrome (lock icon > Permissions), then press Start again.'); }
  else if (err.code === 2) msg('GPS position unavailable. Move to open sky and check that Location is on.', true);
  else msg('GPS timed out. Still trying\u2026', true);
}
function abort(text) {
  stopWatch(); clearInterval(timer); releaseLock(); S = 'idle'; setGps(null);
  $('run').hidden = true; $('setup').hidden = false; msg(text, true);
}

/* ---------- pace ---------- */
function recentPace() {
  if (!samples.length) return null;
  const last = samples[samples.length - 1];
  if (elapsed() - last.e > 15) return null;                       // stale (stopped / no fixes)
  const first = samples.find(s => last.e - s.e <= CFG.paceWin);
  const dt = last.e - first.e, dd = last.d - first.d;
  if (dt < 8 || dd < 10) return null;
  return dt / (dd / MI);
}

/* ---------- coaching ---------- */
function coach() {
  const p = recentPace(); if (p == null) return;
  const d = p - target; let text;
  if (d > 20) text = 'Speed up.';
  else if (d >= 10) text = 'Pick up the pace slightly.';
  else if (d > -10) text = "You're on pace.";
  else if (d >= -20) text = 'Slow down slightly.';
  else text = "You're running too fast.";
  $('coach').textContent = text;
  const e = elapsed(), minGap = text === "You're on pace." ? 150 : 90;
  if (text === lastSpoken.text && e - lastSpoken.at < minGap) return;   // avoid repeating
  lastSpoken = { text, at: e }; speak(text);
}

/* ---------- loop / render ---------- */
function loop() {
  if (S === 'running') {
    const e = elapsed();
    if (e >= nextCoach) { nextCoach += CFG.coachEvery; coach(); }
    if (!finishSaid && dist / MI >= targetMi) {
      finishSaid = true; const t = Math.round(e);
      speak('Target distance reached. Time ' + Math.floor(t / 60) + ' minutes ' + (t % 60) + ' seconds.');
    }
    if (performance.now() - lastFixAt > 15000 && lastFixAt) msg('Waiting for GPS signal\u2026', true);
  }
  render();
}
function render() {
  const e = elapsed(), cur = recentPace(), avg = dist > 20 ? e / (dist / MI) : null;
  $('cur').textContent = mmss(cur);
  $('curKm').textContent = mmss(cur == null ? null : cur / 1.609344);
  $('curCard').className = 'card hero ' + (cur == null || S !== 'running' ? '' : cls(cur - target));
  $('d').textContent = (dist / MI).toFixed(2);
  $('t').textContent = hms(e);
  $('avg').textContent = mmss(avg);
  $('tp').textContent = mmss(target);
  if (dist > 50) {
    const tot = e / (dist / MI) * targetMi, diff = Math.round(tot - targetTime);
    $('eta').textContent = hms(tot);
    $('etaD').textContent = diff === 0 ? 'on target' : (diff > 0 ? '+' : '-') + mmss(Math.abs(diff)) + (diff > 0 ? ' behind' : ' ahead');
  } else { $('eta').textContent = '--:--'; $('etaD').textContent = ''; }
}

/* ---------- wake lock ---------- */
async function lock() {
  try { if ('wakeLock' in navigator && (S === 'running' || S === 'paused')) wake = await navigator.wakeLock.request('screen'); }
  catch (e) {}
}
function releaseLock() { try { wake && wake.release(); } catch (e) {} wake = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') lock(); });

/* ---------- controls ---------- */
$('start').onclick = () => {
  const c = readCfg();
  if (!c) return msg('Enter a distance and a time greater than zero.', true);
  if (!('geolocation' in navigator)) return msg('This browser has no GPS (Geolocation API) support.', true);
  if (!window.isSecureContext) return msg('GPS needs HTTPS. Open the app from an https:// address.', true);
  try { localStorage.setItem('pacepilot', JSON.stringify({ d: $('dist').value, m: $('min').value, s: $('sec').value, v: $('voice').checked })); } catch (e) {}
  target = c.pace; targetMi = c.d; targetTime = c.total;
  dist = 0; samples = []; bad = 0; badStreak = 0; resetFilter(); accum = 0; nextCoach = CFG.coachEvery;
  lastSpoken = { text: '', at: -1e9 }; finishSaid = false; lastFixAt = 0;
  speak('Run started.');                                  // unlocks speech (needs a tap)
  S = 'running'; segStart = performance.now();
  $('setup').hidden = true; $('run').hidden = false; $('again').hidden = true; $('pause').parentNode.hidden = false;
  $('pause').textContent = 'Pause'; $('coach').textContent = ''; msg('Waiting for GPS signal\u2026');
  startWatch(); lock(); clearInterval(timer); timer = setInterval(loop, 500); render();
};
$('pause').onclick = () => {
  if (S === 'running') {
    accum = elapsed(); S = 'paused'; stopWatch(); resetFilter(); samples = [];
    try { speechSynthesis.cancel(); } catch (e) {}
    $('pause').textContent = 'Resume'; msg('Paused. Time and distance are not counting.');
  } else if (S === 'paused') {
    S = 'running'; segStart = performance.now(); lastFixAt = 0; startWatch(); lock();
    $('pause').textContent = 'Pause'; msg('Waiting for GPS signal\u2026');
  }
};
$('end').onclick = () => {
  if (!confirm('End this run?')) return;
  const e = elapsed(); accum = e; S = 'done'; stopWatch(); clearInterval(timer); releaseLock();
  try { speechSynthesis.cancel(); } catch (x) {}
  render(); setGps(null);
  $('pause').parentNode.hidden = true; $('again').hidden = false;
  $('coach').textContent = 'Run finished.'; msg('');
};
$('again').onclick = () => { S = 'idle'; $('run').hidden = true; $('setup').hidden = false; msg(''); };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
