import { icon } from './icons.js';
import { buildRoutes as buildRealRoutes, placePhoto, dist, pathLen } from './routing.js';

/* ============================================================
   Шагалка — clickable prototype. Static, no build step.
   Routes are generated around the user's real location (or a demo point in Khamovniki).
   ============================================================ */

const L = window.L;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem('shg:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('shg:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  clear() { try { Object.keys(localStorage).filter(k => k.startsWith('shg:')).forEach(k => localStorage.removeItem(k)); } catch { } },
};

const DEMO_CENTER = [55.7276, 37.5878]; // Khamovniki
const WALK_KMH = 4.5;
const DEMO_SPEEDUP = 15;

const PLACES = [
  { id: 'neskuchny', name: 'Нескучный сад', img: 'img/neskuchny.jpg' },
  { id: 'gorky', name: 'Парк Горького', img: 'img/gorky.jpg' },
  { id: 'vorobyovy', name: 'Воробьёвы горы', img: 'img/vorobyovy.jpg' },
  { id: 'devichye', name: 'Девичье поле', img: 'img/devichye.jpg' },
  { id: 'pushkinskaya', name: 'Пушкинская набережная', img: 'img/pushkinskaya.jpg' },
  { id: 'bridge', name: 'Андреевский мост', img: 'img/bridge.jpg' },
  { id: 'theatre', name: 'Зелёный театр', img: 'img/theatre.jpg' },
  { id: 'ponds', name: 'Новодевичьи пруды', img: 'img/ponds.jpg' },
  { id: 'khamovniki', name: 'Хамовнический парк', img: 'img/khamovniki.jpg' },
  { id: 'muzeon', name: 'Музеон', img: 'img/muzeon.jpg' },
];

const TIME_PRESETS = [30, 60, 90, 120];
const STEP_PRESETS = [3000, 5000, 8000, 10000];

/* ---------------- state ---------------- */
const state = {
  settings: store.get('settings', { goal: 'time', time: 60, steps: 5000, customTime: false, customSteps: false, shape: 'loop' }),
  favorites: store.get('favorites', []),
  history: store.get('history', []),
  profile: { height: '', weight: '', marker: 'dot', ...store.get('profile', {}) },
  me: null,
  address: '',
  geo: 'pending', // pending | ok | denied | unavailable | skipped (asked later) | off (declined for now)
  picking: false, // choosing the start point on the map by hand
  demo: false,
  routes: [],
  routesStatus: 'idle', // idle | loading | ready | error
  walk: null,
  lastWalk: null,
  draft: null,
};
const save = k => store.set(k, state[k]);

/* ---------------- formatting ---------------- */
const nf = new Intl.NumberFormat('ru-RU');
const fmtKm = km => km.toFixed(1).replace('.', ',') + ' км';
const fmtSteps = n => nf.format(Math.round(n / 100) * 100);
const plural = (n, [one, few, many]) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many; };
function fmtGoalTime(min) {
  if (min < 60) return `${min} ${plural(min, ['минута', 'минуты', 'минут'])}`;
  const h = Math.floor(min / 60), m = min % 60;
  if (m === 0) return `${h} ${plural(h, ['час', 'часа', 'часов'])}`;
  if (m === 30) return `${h},5 часа`;
  return `${h} ч ${m} мин`;
}
const fmtDur = min => (min < 60 ? `${Math.round(min)} мин` : `${Math.floor(min / 60)} ч ${String(Math.round(min % 60)).padStart(2, '0')} мин`);
/** Fits a narrow three-column tile: "63 мин" up to 99 minutes, then "1 ч 40 м". */
const fmtDurShort = min => { const m = Math.round(min); return m < 100 ? `${m} мин` : `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} м`; };
const fmtClock = ms => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0'); };
const fmtDate = iso => { const d = new Date(iso), now = new Date(); const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()); const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const diff = (day - dd) / 864e5; if (diff === 0) return 'Сегодня, ' + t; if (diff === 1) return 'Вчера, ' + t; return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); };

/* ---------------- calculations ---------------- */
/* Step length from height (≈ 41.5% of height); old profiles kept a step length directly. */
const stepLen = () => { const h = Number(state.profile.height); return Math.max(0.4, Math.min(1.2, h ? (h * 0.415) / 100 : (Number(state.profile.stepCm) || 75) / 100)); };
const weight = () => Number(state.profile.weight) || 70;
const HEIGHT = { min: 120, max: 220, def: 170 }, WEIGHT = { min: 30, max: 200, def: 70 };
/* Map markers from Figma (13 Профиль). The animals are emoji there too, for now. */
const MARKERS = [
  { id: 'dot', name: 'Точка' }, { id: 'frog', name: 'Лягушка', e: '🐸' }, { id: 'monkey', name: 'Обезьяна', e: '🐵' },
  { id: 'dog', name: 'Собака', e: '🐶' }, { id: 'cat', name: 'Кошка', e: '🐱' }, { id: 'bear', name: 'Медведь', e: '🐻' },
];
const markerOf = id => MARKERS.find(m => m.id === id) || MARKERS[0];
const kmToSteps = km => (km * 1000) / stepLen();
const kmToMin = km => (km / WALK_KMH) * 60;
const kcal = km => Math.round(0.5 * weight() * km);
const approx = () => (state.profile.weight ? '' : '≈ ');
function goalKm(s = state.settings) { return s.goal === 'time' ? (s.time / 60) * WALK_KMH : (s.steps * stepLen()) / 1000; }
const goalChip = (s = state.settings) => (s.goal === 'time' ? fmtGoalTime(s.time) : `${fmtSteps(s.steps)} шагов`);
const shapeChip = (s = state.settings) => (s.shape === 'loop' ? 'Замкнутый' : 'В одну сторону');

/* ---------------- geometry ---------------- */
function pointAt(pts, frac) {
  const total = pathLen(pts); let target = Math.max(0, Math.min(1, frac)) * total;
  for (let i = 1; i < pts.length; i++) { const d = dist(pts[i - 1], pts[i]); if (target <= d) { const t = d ? target / d : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; } target -= d; }
  return pts[pts.length - 1];
}
/* Real routes: places from OpenStreetMap, paths along real streets (see routing.js). */
const ROUTE_CACHE_MS = 6 * 3600e3;
function routesCacheKey() { const c = state.me || DEMO_CENTER; return `${c[0].toFixed(3)},${c[1].toFixed(3)}|${state.settings.shape}|${Math.round(goalKm() * 10)}`; }
const onHome = () => /^#?\/?(favorites)?$/.test(location.hash);
async function loadRoutes() {
  const token = (loadRoutes.token = (loadRoutes.token || 0) + 1); // newer request wins
  const key = routesCacheKey();
  const cached = store.get('routecache', null);
  if (cached && cached.key === key && Date.now() - cached.t < ROUTE_CACHE_MS && cached.routes.length) {
    state.routes = cached.routes; state.routesStatus = 'ready'; if (onHome()) render(); return;
  }
  state.routesStatus = 'loading'; state.routes = []; if (onHome()) render();
  const photos = [];
  // Only real photos of the place (Wikipedia / Wikimedia Commons); no stock pictures.
  const prep = ({ place, ...r }) => ({ ...r, img: place.img || '', src: place, gallery: r.gallery.map(g => ({ id: g.id, name: g.name, img: g.img || '', src: g })) });
  try {
    await buildRealRoutes({
      start: state.me || DEMO_CENTER, targetKm: goalKm(), shape: state.settings.shape,
      onRoute: raw => {
        if (token !== loadRoutes.token) return;
        const r = prep(raw);
        state.routes.push(r); state.routesStatus = 'partial'; // show cards as they come
        if (onHome()) render();
        photos.push(enrichPhotos([r]));
      },
    });
    if (token !== loadRoutes.token) return;
    state.routesStatus = 'ready';
    if (onHome()) render();
    await Promise.all(photos);
    if (token !== loadRoutes.token) return;
    if (state.routes.length) store.set('routecache', { key, t: Date.now(), routes: state.routes.map(plainRoute) });
  } catch {
    if (token !== loadRoutes.token) return;
    state.routesStatus = state.routes.length ? 'ready' : 'error';
    if (onHome()) render();
  }
}
/** Fill in real photos where the place has one; update cards in place so the carousel does not jump. */
async function enrichPhotos(routes) {
  const jobs = [];
  for (const r of routes) {
    if (!r.img && r.src) jobs.push(placePhoto(r.src).then(url => {
      if (!url) return;
      r.img = url;
      const el = document.querySelector(`.route-card[data-key="${CSS.escape(r.key)}"]`);
      if (el) { el.style.backgroundImage = `url('${url}')`; el.classList.remove('noimg'); el.querySelector('.noimg-ic')?.remove(); }
    }));
    for (const g of r.gallery || []) if (!g.img && g.src) jobs.push(placePhoto(g.src).then(url => { if (url) g.img = url; }));
  }
  await Promise.all(jobs);
}
/** Route without live source objects — safe to keep in localStorage. */
const plainRoute = ({ src, ...r }) => ({ ...r, gallery: (r.gallery || []).map(({ src: _s, ...g }) => g) });
const imgOf = x => x.img || (PLACES.find(p => p.id === x.placeId) || {}).img || '';
const routeMeta = r => `${fmtKm(r.km)} · ${fmtSteps(kmToSteps(r.km))} шагов`;
const isFav = r => state.favorites.some(f => f.key === r.key);
const favCopy = r => ({ ...plainRoute(r), img: imgOf(r) });
function toggleFav(r) {
  if (isFav(r)) { state.favorites = state.favorites.filter(f => f.key !== r.key); toast('Убрали из избранного'); }
  else { state.favorites.unshift(favCopy(r)); toast('Маршрут в избранном. Он появится на главной'); }
  save('favorites');
}

/* ---------------- map ---------------- */
let map, meMarker, routeLayer, followMe = false;
/* Base map follows the app theme: light map in light theme, dark map in dark theme.
   Temporary: OpenStreetMap tiles, darkened with a CSS filter (styles.css → .map-dark), until the Google Maps key is connected. */
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
const appTheme = () => document.documentElement.dataset.theme || (darkMq.matches ? 'dark' : 'light');
const themedTiles = m => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
const applyMapTheme = () => document.documentElement.classList.toggle('map-dark', appTheme() === 'dark');
darkMq.addEventListener('change', applyMapTheme);
new MutationObserver(applyMapTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView(DEMO_CENTER, 15);
  themedTiles(map);
  map.attributionControl.setPrefix(false);
  routeLayer = L.layerGroup().addTo(map);
  applyMapTheme();
  map.on('click', e => { if (state.picking) pickPoint(e.latlng); });
}
function meIcon(id = state.profile.marker) {
  const m = markerOf(id);
  if (!m.e) return L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
  return L.divIcon({ className: '', html: `<div class="me-pet"><span>${m.e}</span></div>`, iconSize: [40, 40], iconAnchor: [20, 20] });
}
function setMe(latlng) {
  if (!latlng) { if (meMarker) { meMarker.remove(); meMarker = null; } return; }
  if (!meMarker) { meMarker = L.marker(latlng, { icon: meIcon(), keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(map); meMarker._kind = state.profile.marker; }
  else meMarker.setLatLng(latlng);
  if (meMarker._kind !== state.profile.marker) { meMarker.setIcon(meIcon()); meMarker._kind = state.profile.marker; }
}

/* Distances along a route (metres), cached per geometry array. */
const cumCache = new WeakMap();
function cums(g) {
  let c = cumCache.get(g);
  if (!c) { c = [0]; for (let i = 1; i < g.length; i++) c.push(c[i - 1] + dist(g[i - 1], g[i])); cumCache.set(g, c); }
  return c;
}
function pointAtM(g, m) {
  const c = cums(g), total = c[c.length - 1]; m = Math.max(0, Math.min(total, m));
  let i = 1; while (i < c.length - 1 && c[i] < m) i++;
  const d = c[i] - c[i - 1], t = d ? (m - c[i - 1]) / d : 0;
  return [g[i - 1][0] + (g[i][0] - g[i - 1][0]) * t, g[i - 1][1] + (g[i][1] - g[i - 1][1]) * t];
}
const rad = x => (x * Math.PI) / 180;
function bearingTo(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
/** Next turn ahead of position `s` (metres along the route): looks at the heading 20 m before and after each vertex. */
function nextManeuver(g, s) {
  const c = cums(g), total = c[c.length - 1];
  for (let i = 1; i < g.length - 1; i++) {
    if (c[i] < s + 8) continue;
    const b1 = bearingTo(pointAtM(g, c[i] - 20), g[i]), b2 = bearingTo(g[i], pointAtM(g, c[i] + 20));
    const turn = ((b2 - b1 + 540) % 360) - 180;
    if (Math.abs(turn) >= 40) return { at: c[i] - s, turn };
  }
  return { at: Math.max(0, total - s), finish: true };
}
const fmtDistM = m => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} м` : fmtKm(m / 1000));
function maneuverView(m, shape) {
  if (m.finish) return { ic: 'flag', dist: m.at < 15 ? 'Вы на финише' : `Финиш через ${fmtDistM(m.at)}`, text: shape === 'loop' ? 'Маршрут заканчивается там, где начался' : 'Конец маршрута' };
  const a = Math.abs(m.turn), right = m.turn > 0;
  const text = a > 150 ? 'Развернитесь' : a < 60 ? (right ? 'Держитесь правее' : 'Держитесь левее') : (right ? 'Поверните направо' : 'Поверните налево');
  return { ic: a > 150 ? 'rotateCcw' : right ? 'cornerUpRight' : 'cornerUpLeft', dist: m.at < 15 ? 'Сейчас' : `Через ${fmtDistM(m.at)}`, text };
}
/** Where the walker is along the route, in metres. GPS: nearest vertex just ahead of the last known spot. */
function walkS(w) {
  const g = w.route.geometry, c = cums(g), total = c[c.length - 1];
  if (w.mode === 'demo') return total * Math.min(1, w.km / w.route.km);
  const p = w.last || g[0], from = (w.s || 0) - 30, to = (w.s || 0) + 400;
  let best = w.s || 0, bd = Infinity;
  for (let i = 0; i < g.length; i++) { if (c[i] < from || c[i] > to) continue; const d = dist(p, g[i]); if (d < bd) { bd = d; best = c[i]; } }
  return (w.s = best);
}

function drawRoute(geom, shape, { fit = true, bottom = 360, traveled = null, arrowsFrom = null } = {}) {
  routeLayer.clearLayers();
  if (!geom) return;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#2463eb';
  L.polyline(geom, { color, weight: 6, opacity: traveled ? 0.35 : 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
  if (traveled && traveled.length > 1) L.polyline(traveled, { color, weight: 6, opacity: 1, lineCap: 'round' }).addTo(routeLayer);
  L.marker(geom[0], { icon: L.divIcon({ className: '', html: '<div class="pt-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false }).addTo(routeLayer);
  if (shape !== 'loop') L.marker(geom[geom.length - 1], { icon: L.divIcon({ className: '', html: '<div class="pt-marker finish"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false }).addTo(routeLayer);
  if (arrowsFrom != null) { // direction arrows on the part still ahead (RouteArrow in Figma)
    const total = cums(geom)[geom.length - 1];
    const mpp = (156543 * Math.cos(rad(geom[0][0]))) / 2 ** map.getZoom(); // metres per screen pixel
    const gap = Math.max(150, 110 * mpp); // keep arrows ~110 px apart on screen
    for (let m = arrowsFrom + Math.max(60, 50 * mpp), n = 0; m < total - 30 && n < 10; m += gap, n++) {
      const b = bearingTo(pointAtM(geom, m - 5), pointAtM(geom, m + 5));
      L.marker(pointAtM(geom, m), { icon: L.divIcon({ className: '', html: `<div class="route-arrow" style="transform:rotate(${(b - 90).toFixed(0)}deg)">${icon('chevronRight', 14)}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }), interactive: false, keyboard: false }).addTo(routeLayer);
    }
  }
  if (fit) map.fitBounds(L.latLngBounds(geom), { paddingTopLeft: [24, 90], paddingBottomRight: [24, bottom], maxZoom: 16 });
}
function miniMap(el, geom, shape) {
  const m = L.map(el, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false });
  themedTiles(m);
  const color = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#2463eb';
  L.polyline(geom, { color, weight: 5, lineCap: 'round' }).addTo(m);
  m.fitBounds(L.latLngBounds(geom), { padding: [20, 20] });
  return m;
}

/* ---------------- geolocation ---------------- */
function locate({ quiet = false } = {}) {
  if (state.demo) { state.me = DEMO_CENTER; state.geo = 'ok'; afterLocated(); return; }
  if (!('geolocation' in navigator)) { state.geo = 'unavailable'; render(); return; }
  state.geo = 'pending'; if (!quiet) render();
  navigator.geolocation.getCurrentPosition(
    pos => { state.me = [pos.coords.latitude, pos.coords.longitude]; state.geo = 'ok'; afterLocated(); },
    err => { state.geo = err.code === 1 ? 'denied' : 'unavailable'; render(); },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}
function afterLocated() {
  store.set('geoAsk', true);
  setMe(state.me); map.setView(state.me, 15);
  loadRoutes();
  reverseGeocode(state.me).then(text => { state.address = text; const el = $('#loc-text'); if (el) el.textContent = locLabel(); });
}
/** "Выбрать точку на карте": the next tap on the map becomes the start point. */
function startPicking() { state.picking = true; location.hash = '#/'; render(); }
function pickPoint(latlng) {
  state.picking = false; state.me = [latlng.lat, latlng.lng]; state.geo = 'ok'; state.address = '';
  render(); afterLocated();
}
const addrCache = new Map();
async function reverseGeocode([lat, lng]) {
  const key = lat.toFixed(4) + ',' + lng.toFixed(4);
  if (addrCache.has(key)) return addrCache.get(key);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=ru&lat=${lat}&lon=${lng}`);
    const j = await r.json(); const a = j.address || {};
    const street = a.road || a.pedestrian || a.footway || a.square || a.neighbourhood || a.suburb || '';
    const text = [street, a.house_number].filter(Boolean).join(', ') || (j.display_name || '').split(',')[0];
    addrCache.set(key, text); return text;
  } catch { return ''; }
}

/* ---------------- UI helpers ---------------- */
const ui = () => $('#ui');
function toast(msg, action) {
  const el = $('#toast'); clearTimeout(toast.t);
  el.innerHTML = `<div class="toast" role="status">${esc(msg)}${action ? `<button type="button">${esc(action.label)}</button>` : ''}</div>`;
  if (action) el.querySelector('button').onclick = () => { el.innerHTML = ''; action.run(); };
  toast.t = setTimeout(() => (el.innerHTML = ''), action ? 5000 : 2600);
}
function confirmDialog({ title, text, confirm, cancel = 'Отмена', danger = false }) {
  return new Promise(res => {
    const el = $('#modal');
    el.innerHTML = `<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-d">
      <h2 class="h-sm" id="dlg-t">${esc(title)}</h2><p id="dlg-d">${esc(text)}</p>
      <div class="actions"><button class="btn secondary sm" data-r="0">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'} sm" data-r="1">${esc(confirm)}</button></div></div>`;
    const close = v => { el.innerHTML = ''; document.removeEventListener('keydown', onKey); res(v); };
    const onKey = e => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    el.onclick = e => { const b = e.target.closest('[data-r]'); if (b) close(b.dataset.r === '1'); else if (e.target === el) close(false); };
    el.querySelector('[data-r="1"]').focus();
  });
}
function tabbar(active) {
  const t = (href, name, label, ic) => `<a href="${href}" ${active === name ? 'aria-current="page"' : ''}>${icon(ic, 24)}<span>${label}</span></a>`;
  return `<nav class="tabbar" aria-label="Разделы">${t('#/history', 'history', 'История', 'history')}${t('#/', 'walk', 'Прогулка', 'footprints')}${t('#/profile', 'profile', 'Профиль', 'user')}</nav>`;
}
const tile = (ic, label, value) => `<div class="tile"><span class="l">${icon(ic, 16)}${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
const locLabel = () => (state.demo ? 'Хамовники, Москва · демо' : state.geo === 'ok' ? (state.address || 'Определяем адрес…') : state.geo === 'pending' ? 'Определяем местоположение…' : 'Местоположение не найдено');

/* ---------------- screens ---------------- */
/* Centred message in a sheet (Figma MessageSheet: NoLocation / NoConnection / NoRoutes). */
function messageSheet({ ic, title, text, actions, after = '' }) {
  return `<section class="sheet with-tabbar msg-sheet">
    <div class="grabber"></div>
    <div class="msg-body"><span class="msg-ic">${icon(ic, 20)}</span>
      <h1 class="h-sm">${esc(title)}</h1><p>${esc(text)}</p>${actions}</div>${after}</section>`;
}
/* 12 «Невыполнимые параметры»: say why, offer concrete fixes. */
function noRoutesSheet() {
  const s = state.settings, isTime = s.goal === 'time';
  const smaller = isTime ? Math.max(15, Math.round((s.time * 0.5) / 15) * 15) : Math.max(1000, Math.round((s.steps * 0.6) / 1000) * 1000);
  const what = isTime ? `гулять ${fmtGoalTime(s.time)}` : `пройти ${fmtSteps(s.steps)} шагов`;
  const reduce = (isTime ? s.time : s.steps) > smaller
    ? `<button class="option-row" data-action="reduce-goal" data-v="${smaller}">${icon(isTime ? 'clock' : 'footprints', 20)}<span class="grow stack" style="gap:2px"><span class="label-md">Уменьшить до ${isTime ? fmtGoalTime(smaller) : fmtSteps(smaller) + ' шагов'}</span><span class="body-sm secondary-text">Поищем маршруты покороче рядом с вами</span></span>${icon('chevronRight', 20)}</button>` : '';
  const oneway = s.shape === 'loop'
    ? `<button class="option-row" data-action="go-oneway">${icon('arrowRight', 20)}<span class="grow stack" style="gap:2px"><span class="label-md">Идти в одну сторону</span><span class="body-sm secondary-text">Финиш в другом месте, не нужно возвращаться</span></span>${icon('chevronRight', 20)}</button>` : '';
  return `<section class="sheet with-tabbar pad" aria-labelledby="nr-t" style="gap:16px">
    <div class="grabber"></div>
    <h1 class="h-md" id="nr-t">Не нашли подходящий маршрут</h1>
    <div class="warn-box" role="status"><strong class="label-md">Условия не сходятся</strong><span>Рядом мало пешеходных дорожек, чтобы ${what}${s.shape === 'loop' ? ' по кругу и вернуться к старту' : ' в одну сторону'}.</span></div>
    ${reduce || oneway ? `<div class="stack" style="gap:4px"><h2 class="label-lg" style="margin:0">Что можно изменить</h2>${reduce}${oneway}</div>` : ''}
    <a class="btn secondary block" href="#/settings">${icon('settings', 20)}Открыть настройки</a></section>`;
}

function screenHome(tab = 'nearby') {
  ui().className = '';
  routeLayer.clearLayers();
  setMe(state.me);
  const top = `<div class="topbar center"><div class="loc-chip">${icon(state.geo === 'ok' ? 'mapPin' : 'mapPinOff', 16)}<span id="loc-text">${esc(locLabel())}</span></div></div><div class="spacer"></div>`;
  const ctrls = state.me ? `<div class="map-ctrls"><button class="icon-btn map" data-action="recenter" aria-label="Показать меня на карте">${icon('locateFixed', 24)}</button></div>` : '';
  if (state.picking) {
    return `<div class="topbar center"><div class="loc-chip" role="status">${icon('mapPin', 16)}<span>Нажмите на карту, чтобы выбрать старт</span></div></div><div class="spacer"></div>
      <div class="pick-bar"><button class="btn secondary block" data-action="cancel-pick">Отмена</button></div>`;
  }
  if (!navigator.onLine) return top + messageSheet({ ic: 'wifiOff', title: 'Нет связи с интернетом', text: 'Маршруты строятся онлайн. Как только связь появится, обновим список сами.', actions: `<button class="btn primary sm" data-action="retry">${icon('refresh', 20)}Повторить</button>` }) + tabbar('walk');
  if (state.geo === 'skipped') {
    return `<div class="spacer"></div><section class="sheet solo pad" aria-labelledby="ga-t" style="gap:16px;padding-top:24px">
      <span class="ask-ic">${icon('locateFixed', 32)}</span>
      <div class="stack" style="gap:8px"><h1 class="h-md" id="ga-t">Покажем маршруты рядом с вами</h1>
      <p class="secondary-text" style="margin:0">По геопозиции мы подбираем прогулки от вашей точки и ведём по маршруту. Трек хранится только на телефоне.</p></div>
      <div class="stack"><button class="btn primary block" data-action="retry">Разрешить доступ</button><button class="btn ghost block" data-action="geo-later">Не сейчас</button></div></section>`;
  }
  if (['denied', 'unavailable', 'off'].includes(state.geo)) {
    const text = state.geo === 'denied' ? 'Разрешите доступ к геолокации в настройках браузера или выберите точку старта на карте вручную.'
      : state.geo === 'unavailable' ? 'Сигнал GPS слабый. Выйдите на открытое место или выберите точку старта на карте вручную.'
      : 'Разрешите доступ к геолокации или выберите точку старта на карте вручную.';
    return top + messageSheet({ ic: 'mapPinOff', title: 'Не удалось определить, где вы', text, actions: `<button class="btn primary sm" data-action="retry">${icon('mapPin', 20)}Разрешить доступ</button>`,
      after: `<button class="btn ghost block" data-action="pick">${icon('mapPin', 20)}Выбрать точку на карте</button>` }) + tabbar('walk');
  }

  if (state.routesStatus === 'error') return top + ctrls + messageSheet({ ic: 'route', title: 'Не получилось построить маршруты', text: 'Сервис маршрутов сейчас не отвечает. Попробуйте ещё раз через минуту.', actions: `<button class="btn primary sm" data-action="reload-routes">${icon('refresh', 20)}Повторить</button>` }) + tabbar('walk');
  if (state.routesStatus === 'ready' && !state.routes.length && tab !== 'fav') return top + ctrls + noRoutesSheet() + tabbar('walk');
  const loading = state.geo === 'pending' || state.routesStatus === 'loading' || state.routesStatus === 'idle';
  const hasFav = state.favorites.length > 0;
  const tabs = hasFav ? `<div class="pad"><div class="segmented" role="tablist">
      <a href="#/" role="tab" ${tab === 'nearby' ? 'aria-current="page" aria-selected="true"' : 'aria-selected="false"'}>${icon('locateFixed', 16)}Рядом</a>
      <a href="#/favorites" role="tab" ${tab === 'fav' ? 'aria-current="page" aria-selected="true"' : 'aria-selected="false"'}>${icon('heart', 16)}Избранное</a></div></div>` : '';
  let body;
  if (loading) {
    body = `<div class="pad chips" aria-hidden="true"><span class="chip skeleton" style="width:72px"></span><span class="chip skeleton" style="width:104px"></span></div>
      <div class="carousel" aria-busy="true" aria-label="Подбираем маршруты">${'<div class="route-card skeleton"></div>'.repeat(3)}</div>`;
  } else if (tab === 'fav' && hasFav) {
    body = `<div class="carousel" role="list" aria-label="Избранные маршруты">${state.favorites.map((f, i) => card(f, `#/fav/${i}`, true)).join('')}</div>`;
  } else {
    body = `<div class="pad chips"><a class="chip" href="#/settings" aria-label="Цель: ${esc(goalChip())}. Изменить">${esc(goalChip())}</a><a class="chip" href="#/settings" aria-label="Форма: ${esc(shapeChip())}. Изменить">${esc(shapeChip())}</a></div>
      <div class="carousel" role="list" aria-label="Маршруты рядом" ${state.routesStatus === 'partial' ? 'aria-busy="true"' : ''}>${state.routes.map((r, i) => card(r, `#/route/${i}`, isFav(r))).join('')}${state.routesStatus === 'partial' ? '<div class="route-card skeleton" aria-hidden="true"></div>' : ''}</div>`;
  }
  return `${top}${ctrls}<section class="sheet with-tabbar" aria-labelledby="home-t">
      <div class="row pad"><h1 class="h-sm grow" id="home-t">Маршруты для прогулки</h1><a class="icon-btn ghost" href="#/settings" aria-label="Настройки подбора">${icon('sliders', 24)}</a></div>
      ${tabs}${body}</section>${tabbar('walk')}`;
}
function card(r, href, fav) {
  const img = imgOf(r);
  return `<a class="route-card${img ? '' : ' noimg'}" role="listitem" href="${href}" data-key="${esc(r.key)}" ${img ? `style="background-image:url('${esc(img)}')"` : ''} aria-label="${esc(r.name)}, ${esc(routeMeta(r))}${fav ? ', в избранном' : ''}">
    ${img ? '' : `<span class="noimg-ic" aria-hidden="true">${icon('mapPin', 32)}</span>`}
    ${fav ? `<span class="fav-badge">${icon('heart', 16, { filled: true })}</span>` : ''}<span class="t">${esc(r.name)}</span><span class="m">${esc(routeMeta(r))}</span></a>`;
}

const LOOP_SVG = '<svg width="132" height="64" viewBox="0 0 132 64" fill="none" aria-hidden="true"><path d="M26 40C26 22 46 11 66 13C86 15 100 7 110 19C120 31 107 45 90 47C72 49 60 59 42 55C32 53 26 48 26 40Z" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="26" cy="40" r="6" fill="var(--surface-card)" stroke="currentColor" stroke-width="3"/></svg>';
const ONEWAY_SVG = '<svg width="132" height="64" viewBox="0 0 132 64" fill="none" aria-hidden="true"><path d="M18 50C38 50 40 22 62 24C84 26 86 46 104 42C114 40 118 30 118 18" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="18" cy="50" r="6" fill="var(--surface-card)" stroke="currentColor" stroke-width="3"/><circle cx="118" cy="16" r="7" fill="currentColor"/></svg>';

/* Goal controls: segmented time/steps, preset chips, custom slider. Shared by settings and onboarding. */
const presetLabel = (isTime, v) => (isTime ? (v < 60 ? `${v} мин` : `${String(v / 60).replace('.', ',')} ч`) : nf.format(v));
const customLabel = (isTime, v) => (isTime ? (v < 60 ? v + ' мин' : fmtGoalTime(v)) : nf.format(v) + ' шагов');
const goalHint = d => { const km = goalKm(d); return d.goal === 'time' ? `Около ${fmtKm(km)} спокойным шагом` : `Около ${fmtKm(km)}, это примерно ${fmtDur(kmToMin(km))} спокойным шагом`; };
function goalBlock(d) {
  const isTime = d.goal === 'time';
  const presets = isTime ? TIME_PRESETS : STEP_PRESETS;
  const val = isTime ? d.time : d.steps;
  const custom = isTime ? d.customTime : d.customSteps;
  const min = isTime ? 15 : 1000, max = isTime ? 180 : 30000, step = isTime ? 5 : 500;
  return `<div class="segmented"><button data-goal="time" aria-pressed="${isTime}">${icon('clock', 20)}По времени</button><button data-goal="steps" aria-pressed="${!isTime}">${icon('footprints', 20)}По шагам</button></div>
      <div class="chips" role="group" aria-label="Варианты">
        ${presets.map(v => `<button class="chip" data-preset="${v}" aria-pressed="${!custom && val === v}">${presetLabel(isTime, v)}</button>`).join('')}
        <button class="chip" data-action="custom" aria-pressed="${custom}">Своё</button>
      </div>
      <p class="caption muted" id="rng-hint" style="margin:0">${goalHint(d)}</p>
      ${custom ? `<div class="stack" style="gap:8px"><label class="h-md" for="rng" id="rng-v">${customLabel(isTime, val)}</label>
        <input class="range" id="rng" type="range" min="${min}" max="${max}" step="${step}" value="${val}" aria-describedby="rng-hint">
        <div class="range-row"><span>${isTime ? '15 мин' : '1 000'}</span><span>${isTime ? '3 ч' : '30 000'}</span></div></div>` : ''}`;
}
function shapeBlock(d) {
  return `<div class="shapes" role="radiogroup" aria-label="Форма маршрута">
        <button class="shape" role="radio" data-shape="loop" aria-checked="${d.shape === 'loop'}"><span class="ill">${LOOP_SVG}</span><span class="tt">Замкнутый${d.shape === 'loop' ? icon('circleCheck', 20) : ''}</span><span class="dd">Вернётесь в точку старта</span></button>
        <button class="shape" role="radio" data-shape="oneway" aria-checked="${d.shape === 'oneway'}"><span class="ill">${ONEWAY_SVG}</span><span class="tt">В одну сторону${d.shape === 'oneway' ? icon('circleCheck', 20) : ''}</span><span class="dd">Закончите в другом месте</span></button>
      </div>`;
}
function screenSettings() {
  ui().className = '';
  const d = state.draft || (state.draft = { ...state.settings });
  return `<div class="scrim" data-action="close-settings"></div>
  <section class="sheet solo" role="dialog" aria-modal="true" aria-labelledby="set-t" style="gap:16px">
    <div class="grabber"></div>
    <div class="row pad"><h1 class="h-md grow" id="set-t">Настройки подбора</h1><button class="icon-btn ghost" data-action="close-settings" aria-label="Закрыть">${icon('x', 24)}</button></div>
    <div class="stack pad" style="gap:12px">
      <h2 class="label-lg" style="margin:0">Продолжительность</h2>
      ${goalBlock(d)}
    </div>
    <div class="divider" role="separator"></div>
    <div class="stack pad" style="gap:12px">
      <h2 class="label-lg" style="margin:0">Форма маршрута</h2>
      ${shapeBlock(d)}
    </div>
    <div class="pad"><button class="btn primary block" data-action="apply">Показать маршруты</button></div>
  </section>`;
}

/* ---------------- wheel picker (Figma: WheelPicker / ParamPicker) ---------------- */
const ROW = 44; // px per wheel row; CSS uses the same value
function wheel({ id, label, unit, unitWord, min, max, value }) {
  let items = '';
  for (let v = min; v <= max; v++) items += `<div class="wheel-item" data-v="${v}"><span>${v}</span><span class="u">${unit}</span></div>`;
  return `<div class="wheel-col"><div class="wheel" id="${id}" role="slider" tabindex="0" aria-label="${label}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${value}" aria-valuetext="${value} ${unitWord(value)}" data-min="${min}" data-value="${value}">${items}</div></div>`;
}
function paramPicker() {
  const p = state.profile;
  return `<div class="picker"><div class="picker-labels" aria-hidden="true"><span>Рост</span><span>Вес</span></div>
    <div class="picker-wheels"><div class="picker-band" aria-hidden="true"></div>
      ${wheel({ id: 'wh-h', label: 'Рост', unit: 'см', unitWord: n => plural(n, ['сантиметр', 'сантиметра', 'сантиметров']), ...HEIGHT, value: Number(p.height) || HEIGHT.def })}
      ${wheel({ id: 'wh-w', label: 'Вес', unit: 'кг', unitWord: n => plural(n, ['килограмм', 'килограмма', 'килограммов']), ...WEIGHT, value: Number(p.weight) || WEIGHT.def })}
    </div></div>`;
}
function bindWheels() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const el of $$('.wheel')) {
    const min = +el.dataset.min, max = +el.getAttribute('aria-valuemax');
    const word = el.id === 'wh-h' ? n => plural(n, ['сантиметр', 'сантиметра', 'сантиметров']) : n => plural(n, ['килограмм', 'килограмма', 'килограммов']);
    const items = [...el.children];
    let idx = -1, t = 0;
    const mark = () => {
      const i = Math.max(0, Math.min(items.length - 1, Math.round(el.scrollTop / ROW)));
      if (i === idx) return;
      if (idx >= 0) for (let k = Math.max(0, idx - 2); k <= Math.min(items.length - 1, idx + 2); k++) items[k].className = 'wheel-item';
      for (let k = Math.max(0, i - 2); k <= Math.min(items.length - 1, i + 2); k++) items[k].className = 'wheel-item d' + Math.abs(k - i);
      if (idx >= 0 && navigator.vibrate) try { navigator.vibrate(4); } catch { }
      idx = i;
      const v = min + i; el.dataset.value = v;
      el.setAttribute('aria-valuenow', v); el.setAttribute('aria-valuetext', `${v} ${word(v)}`);
    };
    const go = (v, smooth = !reduce) => el.scrollTo({ top: (Math.max(min, Math.min(max, v)) - min) * ROW, behavior: smooth ? 'smooth' : 'auto' });
    el.addEventListener('scroll', () => { cancelAnimationFrame(t); t = requestAnimationFrame(mark); }, { passive: true });
    el.addEventListener('click', e => { const it = e.target.closest('.wheel-item'); if (it) go(+it.dataset.v); });
    el.addEventListener('keydown', e => {
      const v = +el.dataset.value, step = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[e.key];
      if (step) { e.preventDefault(); go(v + step); }
      else if (e.key === 'Home') { e.preventDefault(); go(min); } else if (e.key === 'End') { e.preventDefault(); go(max); }
    });
    go(+el.dataset.value, false); mark();
  }
}
const pickedParams = () => ({ height: +$('#wh-h').dataset.value, weight: +$('#wh-w').dataset.value });

/* ---------------- onboarding (Figma: Splashscreen → 5 steps) ---------------- */
const ONB = 5;
function screenOnboarding(n) {
  n = Math.max(1, Math.min(ONB, n || 1));
  ui().className = 'full onb';
  const d = state.draft || (state.draft = { ...state.settings });
  const head = `<header class="onb-head"><div class="onb-nav">${n > 1 ? `<a class="onb-back" href="#/onboarding/${n - 1}">${icon('chevronLeft', 16)}Назад</a>` : ''}<span class="onb-count" aria-label="Шаг ${n} из ${ONB}">${String(n).padStart(2, '0')} / ${String(ONB).padStart(2, '0')}</span></div>
    <div class="onb-progress" aria-hidden="true">${Array.from({ length: ONB }, (_, i) => `<span class="${i < n ? 'on' : ''}"></span>`).join('')}</div></header>`;
  const S = {
    1: { ill: 'welcome', t: 'Привет, это Шагалка', p: 'Маршруты для прогулок рядом, под ваше время или количество шагов.', actions: `<a class="btn primary block" href="#/onboarding/2">Начать</a>` },
    2: { ill: d.goal === 'time' ? 'time' : 'steps', t: 'Как подбирать маршрут?', p: 'Выберите время прогулки или цель по шагам. Способ можно поменять позже.', content: goalBlock(d), actions: `<button class="btn primary block" data-action="onb-next" data-n="3">Дальше</button>` },
    3: { ill: 'shape', t: 'Какой маршрут удобнее?', p: 'Можно вернуться в точку старта или закончить прогулку в другом месте.', content: shapeBlock(d), actions: `<button class="btn primary block" data-action="onb-next" data-n="4">Дальше</button>` },
    4: { ill: 'params', t: 'Уточним расчёты', p: 'Рост и вес помогут точнее считать шаги и калории. Можно пропустить — тогда расчёты будут примерными.', content: paramPicker(), actions: `<button class="btn primary block" data-action="onb-params">Дальше</button><a class="btn ghost sm block" href="#/onboarding/5">Пропустить</a>` },
    5: { ill: 'geo', t: 'Нужна геопозиция', p: 'Разрешите доступ, чтобы находить прогулки рядом. Трек хранится только на телефоне.', actions: `<button class="btn primary block" data-action="onb-geo">Разрешить</button><button class="btn ghost sm block" data-action="onb-skip-geo">Пропустить</button>` },
  }[n];
  return `<div class="onb-page">${head}
    <div class="onb-body"><img class="onb-ill${n === 4 ? ' sm' : ''}" src="img/onb-${S.ill}.webp" alt="" width="400" height="400">
      <h1 class="h-lg" id="onb-t">${esc(S.t)}</h1><p>${esc(S.p)}</p></div>
    <section class="onb-sheet" aria-labelledby="onb-t">${S.content ? `<div class="stack" style="gap:12px">${S.content}</div>` : ''}<div class="stack" style="gap:8px">${S.actions}</div></section></div>`;
}
function finishOnboarding(allowGeo) {
  store.set('onboarded', true);
  state.draft = null;
  location.hash = '#/';
  if (allowGeo) locate();
  else { store.set('geoAsk', false); state.geo = 'skipped'; render(); }
}

function getRoute(kind, i) { return kind === 'fav' ? state.favorites[i] : state.routes[i]; }
function screenPreview(kind, i) {
  const r = getRoute(kind, i);
  if (!r) { location.hash = '#/'; return ''; }
  ui().className = '';
  setMe(state.me);
  requestAnimationFrame(() => drawRoute(r.geometry, r.shape, { bottom: Math.min(560, window.innerHeight * 0.62) }));
  const fav = isFav(r);
  const sub = r.shape === 'loop' ? (r.kind ? `${esc(r.kind)} · замкнутый маршрут, старт и финиш у вас` : 'Замкнутый маршрут, старт и финиш у вас') : `В одну сторону, финиш у места «${esc(r.endName || r.name)}»`;
  const gallery = r.gallery || [];
  return `<div class="topbar"><a class="icon-btn map" href="${kind === 'fav' ? '#/favorites' : '#/'}" aria-label="Назад">${icon('chevronLeft', 24)}</a>
      <button class="icon-btn map ${fav ? 'active' : ''}" data-action="fav" aria-pressed="${fav}" aria-label="${fav ? 'Убрать из избранного' : 'Добавить в избранное'}">${icon('heart', 24, { filled: fav })}</button></div>
    <div class="spacer"></div>
    <section class="sheet solo" aria-labelledby="pv-t" style="gap:16px">
      <div class="grabber"></div>
      <div class="pad stack" style="gap:4px"><h1 class="h-md" id="pv-t">${esc(r.name)}</h1><p class="body-sm muted" style="margin:0">${sub}</p></div>
      ${gallery.length ? `<div class="stack" style="gap:8px"><h2 class="label-lg pad" style="margin:0">Что увидите по пути</h2>
        <div class="gallery">${gallery.map(p => `<figure>${p.img ? `<img src="${esc(p.img)}" alt="${esc(p.name)}" loading="lazy">` : `<span class="ph" aria-hidden="true">${icon('mapPin', 24)}</span>`}<figcaption>${esc(p.name)}</figcaption></figure>`).join('')}</div></div>` : ''}
      <div class="tiles pad">${tile('clock', 'Время', fmtDurShort(kmToMin(r.km)))}${tile('footprints', 'Шаги', fmtSteps(kmToSteps(r.km)))}${tile('route', 'Путь', fmtKm(r.km))}</div>
      <div class="pad"><button class="btn primary block" data-action="start" data-kind="${kind}" data-i="${i}">${icon('footprints', 20)}Начать прогулку</button></div>
    </section>`;
}

/* ---------------- walk ---------------- */
let walkTimer = null, watchId = null;
function startWalk(r) {
  const gps = !state.demo && state.me && dist(state.me, r.geometry[0]) < 300;
  state.walk = { route: r, startedAt: Date.now(), elapsed: 0, km: 0, paused: false, mode: gps ? 'gps' : 'demo', last: gps ? state.me : null, trace: [r.geometry[0]], finishedPrompted: false };
  if (gps && 'geolocation' in navigator) {
    watchId = navigator.geolocation.watchPosition(pos => {
      const w = state.walk; if (!w || w.paused) return;
      const p = [pos.coords.latitude, pos.coords.longitude]; const d = dist(w.last, p);
      if (d > 3 && d < 80 && pos.coords.accuracy < 60) { w.km += d / 1000; w.last = p; w.trace.push(p); setMe(p); }
    }, () => {}, { enableHighAccuracy: true, maximumAge: 2000 });
  }
  clearInterval(walkTimer);
  walkTimer = setInterval(tickWalk, 1000);
  location.hash = '#/walk';
}
function tickWalk() {
  const w = state.walk; if (!w || w.paused) return;
  if (w.mode === 'demo') {
    w.elapsed += 1000 * DEMO_SPEEDUP; w.km = Math.min(w.route.km, w.km + (WALK_KMH / 3600) * DEMO_SPEEDUP);
    const p = pointAt(w.route.geometry, w.km / w.route.km); w.trace.push(p); setMe(p);
  } else { w.elapsed += 1000; }
  updateWalkUI();
  if (w.km >= w.route.km * 0.99 && !w.finishedPrompted) { w.finishedPrompted = true; askFinish(true); }
}
function walkNumbers() { const w = state.walk, r = w.route; const left = Math.max(0, r.km - w.km); const steps = kmToSteps(w.km), goalSteps = kmToSteps(r.km); return { left, steps, goalSteps, pct: Math.min(100, Math.round((w.km / r.km) * 100)) }; }
function updateWalkUI() {
  const w = state.walk; if (!w || !$('#w-timer')) return;
  const n = walkNumbers();
  const s = walkS(w);
  const mv = maneuverView(nextManeuver(w.route.geometry, s), w.route.shape);
  if ($('#nav-dist')) {
    $('#nav-dist').textContent = mv.dist;
    if ($('#nav-text').textContent !== mv.text) $('#nav-text').textContent = mv.text; // live region: speak only when the manoeuvre changes
    if ($('#nav-ic').dataset.ic !== mv.ic) { $('#nav-ic').dataset.ic = mv.ic; $('#nav-ic').innerHTML = icon(mv.ic, 32); }
  }
  $('#w-timer').textContent = fmtClock(w.elapsed);
  $('#w-left').textContent = w.paused ? 'Прогулка на паузе' : `Осталось ${fmtKm(n.left)}, около ${fmtDur(kmToMin(n.left))}`;
  $('#w-bar').style.width = n.pct + '%';
  $('#w-goal').textContent = `${fmtSteps(n.steps)} из ${fmtSteps(n.goalSteps)} шагов, ${n.pct}% цели`;
  $('#w-km').textContent = fmtKm(w.km); $('#w-steps').textContent = fmtSteps(n.steps); $('#w-kcal').textContent = approx() + kcal(w.km);
  drawRoute(w.route.geometry, w.route.shape, { fit: false, traveled: w.trace, arrowsFrom: s });
}
function screenWalk() {
  const w = state.walk; if (!w) { location.hash = '#/'; return ''; }
  ui().className = '';
  requestAnimationFrame(() => { drawRoute(w.route.geometry, w.route.shape, { bottom: 430, traveled: w.trace, arrowsFrom: walkS(w) }); updateWalkUI(); });
  const n = walkNumbers();
  const mv = maneuverView(nextManeuver(w.route.geometry, walkS(w)), w.route.shape);
  // Walking: direction hint (NavHint). Paused: the address chip, as in Figma 08.
  const top = w.paused
    ? `<div class="topbar center"><div class="loc-chip">${icon('mapPin', 16)}<span>${esc(state.address || w.route.name)}</span></div></div>`
    : `<div class="topbar"><div class="nav-hint"><span class="nav-ic" id="nav-ic" data-ic="${mv.ic}">${icon(mv.ic, 32)}</span>
        <span class="grow stack" style="gap:2px"><span class="h-sm" id="nav-dist">${esc(mv.dist)}</span><span class="body-sm" id="nav-text" aria-live="polite">${esc(mv.text)}</span></span></div></div>`;
  return `${top}
    <div class="spacer"></div>
    <div class="map-ctrls"><button class="icon-btn map" data-action="follow" aria-label="Показать меня на карте">${icon('locateFixed', 24)}</button></div>
    <section class="sheet solo" aria-label="Прогулка" style="gap:16px">
      <div class="grabber"></div>
      <div class="pad"><p class="body-sm muted" style="margin:0" id="w-left">${w.paused ? 'Прогулка на паузе' : ''}</p><p class="timer" id="w-timer">${fmtClock(w.elapsed)}</p></div>
      <div class="pad stack" style="gap:8px"><div class="progress ${w.paused ? 'warn' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${n.pct}"><div id="w-bar" style="width:${n.pct}%"></div></div><span class="caption muted" id="w-goal"></span></div>
      <div class="tiles pad"><div class="tile"><span class="l">${icon('route', 16)}Пройдено</span><span class="v" id="w-km"></span></div><div class="tile"><span class="l">${icon('footprints', 16)}Шаги</span><span class="v" id="w-steps"></span></div><div class="tile"><span class="l">${icon('flame', 16)}Ккал</span><span class="v" id="w-kcal"></span></div></div>
      ${w.paused ? '<p class="caption muted pad" style="margin:0">Пока прогулка на паузе, время и шаги не считаются.</p>' : ''}
      <div class="pad row" style="gap:8px">
        ${w.paused ? `<button class="btn primary grow" data-action="resume">${icon('play', 20)}Продолжить</button>` : `<button class="btn secondary grow" data-action="pause">${icon('pause', 20)}Пауза</button>`}
        <button class="btn danger grow" data-action="stop">${icon('square', 20)}${w.paused ? 'Завершить' : 'Стоп'}</button>
      </div>
    </section>`;
}
async function askFinish(atFinish = false) {
  const w = state.walk; if (!w) return;
  const tooShort = w.elapsed < 60000 || w.km < 0.1;
  const ok = await confirmDialog({
    title: atFinish ? 'Вы дошли до финиша' : 'Завершить прогулку?',
    text: tooShort ? 'Прогулка слишком короткая, в историю она не попадёт.' : `Пройдено ${fmtKm(w.km)} за ${fmtDur(w.elapsed / 60000)}. Прогулка сохранится в истории.`,
    confirm: tooShort ? 'Завершить без сохранения' : 'Завершить', cancel: 'Продолжить', danger: !atFinish,
  });
  if (!ok) return;
  clearInterval(walkTimer); if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null;
  if (tooShort) { state.walk = null; location.hash = '#/'; toast('Прогулка не сохранена'); return; }
  const entry = { id: 'w' + Date.now(), date: new Date().toISOString(), placeId: w.route.placeId, routeKey: w.route.key, name: w.route.name, img: imgOf(w.route), km: +w.km.toFixed(2), minutes: Math.round(w.elapsed / 60000), steps: Math.round(kmToSteps(w.km)), kcal: kcal(w.km), shape: w.route.shape, geometry: w.route.geometry, routeKm: w.route.km };
  state.history.unshift(entry); save('history');
  state.lastWalk = entry; state.walk = null;
  location.hash = '#/results';
}

function screenResults() {
  const e = state.lastWalk; if (!e) { location.hash = '#/'; return ''; }
  ui().className = 'full';
  requestAnimationFrame(() => miniMap($('#mm'), e.geometry, e.shape));
  return `<div class="page page-top">
    <div class="mini-map" id="mm" role="img" aria-label="Пройденный маршрут на карте"></div>
    <div class="stack" style="gap:8px"><span class="badge ok" style="align-self:flex-start;box-shadow:none">${icon('circleCheck', 16)}Цель выполнена</span>
      <h1 class="h-lg">Прогулка завершена</h1><p class="muted" style="margin:0">${esc(e.name)}. Отличная прогулка — сохранили её в историю.</p></div>
    <div class="tiles two">${tile('clock', 'Время', fmtDur(e.minutes))}${tile('footprints', 'Шаги', nf.format(e.steps))}${tile('route', 'Путь', fmtKm(e.km))}${tile('flame', 'Калории', approx() + e.kcal + ' ккал')}</div>
    <a class="btn primary block" href="#/">Готово</a></div>`;
}

/* ---------------- history ---------------- */
function screenHistory() {
  ui().className = 'full';
  if (!state.history.length) {
    return `<div class="page"><h1 class="h-lg">История</h1>
      <div class="empty"><div class="circle">${icon('footprints', 48)}</div><h2 class="h-sm">Здесь появятся ваши прогулки</h2><p>Выберите маршрут на главной и пройдите его. Время, шаги и путь сохранятся здесь.</p>
      <a class="btn primary block" href="#/">Выбрать маршрут</a></div></div>${tabbar('history')}`;
  }
  const weekAgo = Date.now() - 7 * 864e5; const week = state.history.filter(h => new Date(h.date).getTime() > weekAgo);
  const sum = (k) => week.reduce((s, h) => s + h[k], 0);
  const mins = sum('minutes');
  const groups = {}; for (const h of state.history) { const k = new Date(h.date).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }); (groups[k] = groups[k] || []).push(h); }
  return `<div class="page"><h1 class="h-lg">История</h1>
    <div class="stack"><h2 class="section-label">За эту неделю</h2><div class="tiles">${tile('clock', 'Время', mins >= 60 ? (mins / 60).toFixed(1).replace('.', ',') + ' ч' : mins + ' мин')}${tile('footprints', 'Шаги', nf.format(sum('steps')))}${tile('route', 'Путь', fmtKm(sum('km')))}</div></div>
    ${Object.entries(groups).map(([m, list]) => `<div class="stack"><h2 class="section-label">${esc(m[0].toUpperCase() + m.slice(1))}</h2><div class="walks">${list.map(walkRow).join('')}</div></div>`).join('')}
    <p class="caption muted" style="margin:0;text-align:center">Смахните прогулку влево, чтобы удалить</p>
  </div>${tabbar('history')}`;
}
function walkRow(h) {
  const img = imgOf(h);
  return `<div class="swipe" data-id="${h.id}"><button class="del" data-action="delete" data-id="${h.id}" tabindex="-1" aria-label="Удалить прогулку «${esc(h.name)}»">${icon('trash', 20)}Удалить</button>
    <a class="walk-row" href="#/history/${h.id}" draggable="false">${img ? `<img src="${esc(img)}" alt="" draggable="false">` : `<span class="thumb-ph" aria-hidden="true">${icon('mapPin', 24)}</span>`}<span class="grow stack" style="gap:0"><span class="t">${esc(h.name)}</span><span class="caption muted">${esc(fmtDate(h.date))} · ${fmtDur(h.minutes)}</span><span class="body-sm secondary-text">${fmtKm(h.km)} · ${nf.format(h.steps)} шагов</span></span><span class="chev">${icon('chevronRight', 16)}</span></a></div>`;
}
function bindSwipe() {
  for (const wrap of $$('.swipe')) {
    const row = wrap.querySelector('.walk-row'), del = wrap.querySelector('.del');
    let x0 = 0, y0 = 0, dx = 0, drag = false, open = false, moved = false;
    const set = (v, anim = true) => { row.classList.toggle('dragging', !anim); row.style.transform = `translateX(${v}px)`; if (v < 0) wrap.classList.add('reveal'); else if (anim) setTimeout(() => { if (!open) wrap.classList.remove('reveal'); }, 260); else wrap.classList.remove('reveal'); };
    row.addEventListener('dragstart', e => e.preventDefault());
    row.addEventListener('pointerdown', e => { x0 = e.clientX; y0 = e.clientY; drag = true; moved = false; dx = 0; });
    row.addEventListener('pointermove', e => {
      if (!drag) return; const mx = e.clientX - x0, my = e.clientY - y0;
      if (!moved && Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) { moved = true; try { row.setPointerCapture(e.pointerId); } catch { } }
      if (moved) { dx = Math.min(0, Math.max(-120, (open ? -88 : 0) + mx)); set(dx, false); }
    });
    const end = () => { if (!drag) return; drag = false; if (!moved) return; open = dx < -44; set(open ? -88 : 0); del.tabIndex = open ? 0 : -1; };
    row.addEventListener('pointerup', end); row.addEventListener('pointercancel', end);
    row.addEventListener('click', e => { if (moved || open) { e.preventDefault(); if (open && !moved) { open = false; set(0); del.tabIndex = -1; } } });
    row.addEventListener('keydown', e => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteWalk(wrap.dataset.id); } });
  }
}
function deleteWalk(id) {
  const idx = state.history.findIndex(h => h.id === id); if (idx < 0) return;
  const [removed] = state.history.splice(idx, 1); save('history'); render();
  toast('Прогулка удалена', { label: 'Отменить', run: () => { state.history.splice(idx, 0, removed); save('history'); render(); } });
}
/** A history entry as a route, so it can go to favorites. Key matches the one routing.js gives. */
const historyRoute = h => ({ key: h.routeKey || `${h.placeId}-${h.shape}-${Math.round(h.routeKm * 10)}`, placeId: h.placeId, name: h.name, img: imgOf(h), km: h.routeKm, shape: h.shape, geometry: h.geometry, gallery: [] });
function screenDetails(id) {
  const h = state.history.find(x => x.id === id); if (!h) { location.hash = '#/history'; return ''; }
  ui().className = 'full';
  const fav = isFav(historyRoute(h));
  requestAnimationFrame(() => miniMap($('#mm'), h.geometry, h.shape));
  return `<div class="page page-top" style="gap:16px">
    <a class="icon-btn" href="#/history" aria-label="Назад к истории">${icon('chevronLeft', 24)}</a>
    <div class="mini-map" id="mm" role="img" aria-label="Маршрут на карте"></div>
    <div class="stack" style="gap:4px"><h1 class="h-lg">${esc(h.name)}</h1><p class="muted" style="margin:0">${esc(fmtDate(h.date))} · ${h.shape === 'loop' ? 'замкнутый маршрут' : 'в одну сторону'}</p></div>
    <div class="tiles two">${tile('clock', 'Время', fmtDur(h.minutes))}${tile('footprints', 'Шаги', nf.format(h.steps))}${tile('route', 'Путь', fmtKm(h.km))}${tile('flame', 'Калории', approx() + h.kcal + ' ккал')}</div>
    <div class="row" style="gap:8px;margin-top:auto">
      <button class="btn ${fav ? 'secondary' : 'primary'} grow" data-action="fav-h" data-id="${h.id}" aria-pressed="${fav}">${icon('heart', 20, { filled: fav })}${fav ? 'В избранном' : 'В избранное'}</button>
      <button class="icon-btn lg" data-action="share" data-id="${h.id}" aria-label="Поделиться маршрутом">${icon('share', 24)}</button>
    </div></div>`;
}

/* ---------------- profile ---------------- */
function screenProfile(withSheet = false) {
  ui().className = 'full';
  const p = state.profile;
  const ptile = (label, v, unit) => `<button class="param-tile" data-action="edit-params" aria-label="${label}: ${v ? `${v} ${unit}` : 'не указан'}. Изменить">
      <span class="grow stack" style="gap:2px"><span class="l">${label}</span><span class="v">${v ? `${v} ${unit}` : 'Не указан'}</span></span>${icon('chevronRight', 20)}</button>`;
  const opts = MARKERS.map(m => `<button class="marker-opt" role="radio" aria-checked="${p.marker === m.id}" data-marker="${m.id}">
      <span class="mk">${m.e ? `<span class="pet" aria-hidden="true">${m.e}</span>` : '<span class="dot"></span>'}</span><span>${m.name}</span></button>`).join('');
  requestAnimationFrame(markerPreview);
  return `<div class="page profile">
    <h1 class="h-lg">Профиль</h1>
    <section class="stack" style="gap:12px" aria-labelledby="pp-t">
      <div class="stack" style="gap:4px"><h2 class="h-sm" id="pp-t">Рост и вес</h2><p class="body-sm secondary-text" style="margin:0">Нужны, чтобы точнее считать шаги и калории${p.weight ? '' : '. Пока считаем для 70 кг и ставим знак ≈'}</p></div>
      <div class="param-tiles">${ptile('Рост', p.height, 'см')}${ptile('Вес', p.weight, 'кг')}</div>
    </section>
    <section class="stack" style="gap:12px" aria-labelledby="mk-t">
      <div class="stack" style="gap:4px"><h2 class="h-sm" id="mk-t">Маркер на карте</h2><p class="body-sm secondary-text" style="margin:0">Так вы будете видеть себя на карте во время прогулки</p></div>
      <div class="marker-preview" id="mkp" role="img" aria-label="Маркер «${esc(markerOf(p.marker).name)}» на карте"></div>
      <div class="markers" role="radiogroup" aria-label="Маркер на карте">${opts}</div>
    </section>
    <section class="card" aria-labelledby="demo-t"><h2 class="label-lg" id="demo-t" style="margin:0">Для прототипа</h2><p class="body-sm muted" style="margin:0">Маршруты идут по реальным улицам: места и пути из OpenStreetMap, фото из Википедии. На демо-районе (?demo) прогулка ускорена ×${DEMO_SPEEDUP}.</p>
      <button class="btn secondary block" data-action="seed">Добавить примеры в историю</button>
      <button class="btn secondary block" data-action="restart-onb">Пройти знакомство заново</button>
      <button class="btn ghost block" style="color:var(--danger)" data-action="wipe">${icon('trash', 20)}Удалить все данные</button></section>
  </div>${tabbar('profile')}${withSheet ? paramsSheet() : ''}`;
}
function paramsSheet() {
  return `<div class="scrim fixed" data-action="close-params"></div>
  <section class="sheet solo overlay" role="dialog" aria-modal="true" aria-labelledby="ps-t" style="gap:16px">
    <div class="grabber"></div>
    <div class="row pad"><h2 class="h-sm grow" id="ps-t">Рост и вес</h2><button class="icon-btn ghost" data-action="close-params" aria-label="Закрыть">${icon('x', 24)}</button></div>
    <div class="pad">${paramPicker()}</div>
    <div class="pad"><button class="btn primary block" data-action="save-params">Сохранить</button></div></section>`;
}
let mkMap = null;
function markerPreview() {
  const el = $('#mkp'); if (!el) return;
  if (mkMap) { mkMap.remove(); mkMap = null; }
  const c = state.me || DEMO_CENTER;
  mkMap = L.map(el, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false }).setView(c, 16);
  themedTiles(mkMap);
  L.marker(c, { icon: meIcon(), interactive: false, keyboard: false }).addTo(mkMap);
}

/* ---------------- router ---------------- */
function render() {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  $('#modal').innerHTML = '';
  if (a !== 'settings' && a !== 'onboarding') state.draft = null;
  if (a !== 'onboarding' && !store.get('onboarded', false)) { location.replace('#/onboarding/1'); return; }
  let html = '';
  if (a === 'onboarding') html = screenOnboarding(+b);
  else if (a === 'settings') html = screenSettings();
  else if (a === 'route') html = screenPreview('nearby', +b);
  else if (a === 'fav') html = screenPreview('fav', +b);
  else if (a === 'favorites') html = screenHome(state.favorites.length ? 'fav' : 'nearby');
  else if (a === 'walk') html = screenWalk();
  else if (a === 'results') html = screenResults();
  else if (a === 'history' && b) html = screenDetails(b);
  else if (a === 'history') html = screenHistory();
  else if (a === 'profile') html = screenProfile(b === 'params');
  else html = state.walk ? (location.hash = '#/walk', '') : screenHome('nearby');
  if (html === '' && a !== '' && a !== undefined) return;
  const sameScreen = render.last === h, keepX = sameScreen ? ($('.carousel') || {}).scrollLeft : 0;
  render.last = h;
  ui().innerHTML = html;
  ui().scrollTop = 0;
  if (keepX) { const c = $('.carousel'); if (c) c.scrollLeft = keepX; } // re-render while routes arrive: keep the user's place
  if (sameScreen) $$('#ui > .sheet').forEach(s => (s.style.animation = 'none')); // no slide-in on a refresh of the same screen
  if (a === 'history' && !b) bindSwipe();
  if (a === 'settings' || a === 'onboarding') bindSettings();
  if ($('.wheel')) bindWheels();
  if (['settings', 'route', 'fav'].includes(a)) bindSheetDismiss();
  if (a === 'profile' && b === 'params') $('#wh-h')?.focus({ preventScroll: true });
  if (!['route', 'fav', 'walk'].includes(a)) routeLayer && a !== 'walk' && routeLayer.clearLayers();
  setTimeout(() => map.invalidateSize(), 0);
}

function bindSettings() {
  const rng = $('#rng');
  if (rng) rng.addEventListener('input', () => {
    const d = state.draft, v = +rng.value;
    if (d.goal === 'time') d.time = v; else d.steps = v;
    $('#rng-v').textContent = customLabel(d.goal === 'time', v);
    $('#rng-hint').textContent = goalHint(d);
  });
}
/* Dismissable sheets: X button, system back gesture, and swipe down from the grabber area. */
let prevHash = '';
function closeSheet() {
  const from = prevHash.replace(/^#\/?/, '');
  if (from && !/^(walk|results)/.test(from) && history.length > 1) history.back();
  else location.hash = '#/';
}
function bindSheetDismiss() {
  const sheet = $('#ui > .sheet');
  if (!sheet) return;
  let y0 = 0, dy = 0, t0 = 0, drag = false;
  sheet.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button, a, input, label')) return;
    if (e.clientY - sheet.getBoundingClientRect().top > 56) return;
    drag = true; y0 = e.clientY; dy = 0; t0 = Date.now();
    sheet.style.transition = 'none';
  });
  sheet.addEventListener('pointermove', e => {
    if (!drag) return;
    dy = Math.max(0, e.clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!drag) return; drag = false;
    const speed = dy / Math.max(1, Date.now() - t0);
    sheet.style.transition = 'transform var(--t-base) var(--ease-out)';
    if (dy > 96 || (speed > 0.6 && dy > 30)) {
      sheet.style.transform = `translateY(${window.innerHeight}px)`;
      setTimeout(closeSheet, 250);
    } else {
      sheet.style.transform = '';
    }
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
}

/** Save height and weight from the wheels. A new height changes step length → routes by steps change too. */
function saveParams() {
  const { height, weight: w } = pickedParams();
  const stepChanged = height !== Number(state.profile.height);
  state.profile = { ...state.profile, height, weight: w }; delete state.profile.stepCm; save('profile');
  if (stepChanged && state.settings.goal === 'steps' && state.me) loadRoutes();
}

/* ---------------- actions ---------------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action], [data-goal], [data-preset], [data-shape], [data-marker]'); if (!el) return;
  const d = state.draft;
  if (el.dataset.marker) {
    state.profile.marker = el.dataset.marker; save('profile');
    $$('.marker-opt').forEach(b => b.setAttribute('aria-checked', String(b === el)));
    $('#mkp')?.setAttribute('aria-label', `Маркер «${markerOf(el.dataset.marker).name}» на карте`);
    markerPreview(); setMe(state.me); return;
  }
  if (el.dataset.goal) { d.goal = el.dataset.goal; render(); return; }
  if (el.dataset.preset) { const v = +el.dataset.preset; if (d.goal === 'time') { d.time = v; d.customTime = false; } else { d.steps = v; d.customSteps = false; } render(); return; }
  if (el.dataset.shape) { d.shape = el.dataset.shape; render(); return; }
  switch (el.dataset.action) {
    case 'demo': state.demo = true; locate(); location.hash = '#/'; break;
    case 'retry': locate(); break;
    case 'geo-later': state.geo = 'off'; render(); break;
    case 'pick': startPicking(); break;
    case 'cancel-pick': state.picking = false; render(); break;
    case 'onb-next': state.settings = { ...d }; save('settings'); location.hash = '#/onboarding/' + el.dataset.n; break;
    case 'onb-params': saveParams(); location.hash = '#/onboarding/5'; break;
    case 'onb-geo': finishOnboarding(true); break;
    case 'onb-skip-geo': finishOnboarding(false); break;
    case 'restart-onb': store.set('onboarded', false); location.hash = '#/onboarding/1'; break;
    case 'edit-params': location.hash = '#/profile/params'; break;
    case 'close-params': location.hash = '#/profile'; break;
    case 'save-params': saveParams(); location.hash = '#/profile'; toast('Сохранили рост и вес'); break;
    case 'reduce-goal': { const v = +el.dataset.v; state.settings = { ...state.settings, ...(state.settings.goal === 'time' ? { time: v, customTime: !TIME_PRESETS.includes(v) } : { steps: v, customSteps: !STEP_PRESETS.includes(v) }) }; save('settings'); loadRoutes(); break; }
    case 'go-oneway': state.settings = { ...state.settings, shape: 'oneway' }; save('settings'); loadRoutes(); break;
    case 'recenter': if (state.me) map.setView(state.me, 16); break;
    case 'follow': { const w = state.walk; const p = w && (w.mode === 'demo' ? pointAt(w.route.geometry, w.km / w.route.km) : w.last); if (p) map.setView(p, 17); break; }
    case 'custom': if (d.goal === 'time') d.customTime = true; else d.customSteps = true; render(); break;
    case 'close-settings': closeSheet(); break;
    case 'apply': state.settings = { ...d }; save('settings'); location.hash = '#/'; loadRoutes(); break;
    case 'fav': { const [, kind, i] = location.hash.match(/#\/(route|fav)\/(\d+)/) || []; const r = getRoute(kind === 'fav' ? 'fav' : 'nearby', +i); if (r) { toggleFav(r); if (kind === 'fav') location.hash = '#/favorites'; else render(); } break; }
    case 'start': startWalk(getRoute(el.dataset.kind, +el.dataset.i)); break;
    case 'pause': state.walk.paused = true; render(); break;
    case 'resume': state.walk.paused = false; render(); break;
    case 'stop': askFinish(false); break;
    case 'delete': deleteWalk(el.dataset.id); break;
    case 'fav-h': { const h = state.history.find(x => x.id === el.dataset.id); toggleFav(historyRoute(h)); render(); break; }
    case 'reload-routes': loadRoutes(); break;
    case 'share': { const h = state.history.find(x => x.id === el.dataset.id); const text = `${h.name}: ${fmtKm(h.km)}, ${nf.format(h.steps)} шагов за ${fmtDur(h.minutes)}. Маршрут из Шагалки`;
      try { if (navigator.share) await navigator.share({ title: 'Шагалка', text, url: location.origin + location.pathname }); else { await navigator.clipboard.writeText(text); toast('Скопировали описание маршрута'); } } catch { /* cancelled */ } break; }
    case 'seed': { const n = seedHistory(); toast(n ? `Добавили ${n} ${plural(n, ['прогулку', 'прогулки', 'прогулок'])} в историю` : 'Сначала дождитесь, пока построятся маршруты на главной'); break; }
    case 'wipe': if (await confirmDialog({ title: 'Удалить все данные?', text: 'История, избранное и настройки сотрутся с этого телефона. Отменить это нельзя.', confirm: 'Удалить', danger: true })) { store.clear(); location.hash = '#/'; location.reload(); } break;
  }
});
/** Sample history from the real routes built around the user. Returns how many were added. */
function seedHistory() {
  const now = Date.now(), ago = [0.1, 1, 2.3, 4.2, 6.1];
  const src = state.routes.slice(0, ago.length);
  src.forEach((r, i) => {
    state.history.push({ id: 'seed' + i + now, date: new Date(now - ago[i] * 864e5).toISOString(), placeId: r.placeId, routeKey: r.key, name: r.name, img: imgOf(r), km: +r.km.toFixed(2), minutes: Math.round(kmToMin(r.km) * 1.05), steps: Math.round(kmToSteps(r.km)), kcal: kcal(r.km), shape: r.shape, geometry: r.geometry, routeKm: r.km });
  });
  state.history.sort((a, b) => new Date(b.date) - new Date(a.date)); save('history');
  return src.length;
}

/* ---------------- boot ---------------- */
window.addEventListener('hashchange', e => { prevHash = e.oldURL ? new URL(e.oldURL).hash : ''; render(); });
window.addEventListener('online', render);
window.addEventListener('offline', render);
initMap();
if (new URLSearchParams(location.search).has('demo')) state.demo = true;
render();
/* Location at start: not during onboarding (its last step asks), and not if the user said "skip" there,
   unless the browser already has permission. */
(async () => {
  if (!store.get('onboarded', false)) return;
  if (state.demo || store.get('geoAsk', true)) { locate({ quiet: true }); return; }
  let granted = false;
  try { granted = (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'; } catch { }
  if (granted) locate({ quiet: true }); else { state.geo = 'skipped'; render(); }
})();
/* Splash: shown by index.html before anything loads, removed once the first screen is drawn. */
setTimeout(() => { const s = $('#splash'); if (!s) return; s.classList.add('out'); setTimeout(() => s.remove(), 300); }, 700);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
