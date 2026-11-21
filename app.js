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
  profile: store.get('profile', { weight: '', stepCm: 75 }),
  me: null,
  address: '',
  geo: 'pending', // pending | ok | denied | unavailable
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
const stepLen = () => Math.max(0.4, Math.min(1.2, (Number(state.profile.stepCm) || 75) / 100));
const weight = () => Number(state.profile.weight) || 70;
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
}
const divIcon = cls => L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
function setMe(latlng) {
  if (!latlng) { if (meMarker) { meMarker.remove(); meMarker = null; } return; }
  if (!meMarker) meMarker = L.marker(latlng, { icon: divIcon('me-marker'), keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(map);
  else meMarker.setLatLng(latlng);
}
function drawRoute(geom, shape, { fit = true, bottom = 360, traveled = null } = {}) {
  routeLayer.clearLayers();
  if (!geom) return;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#2463eb';
  L.polyline(geom, { color, weight: 6, opacity: traveled ? 0.35 : 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
  if (traveled && traveled.length > 1) L.polyline(traveled, { color, weight: 6, opacity: 1, lineCap: 'round' }).addTo(routeLayer);
  L.marker(geom[0], { icon: L.divIcon({ className: '', html: '<div class="pt-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false }).addTo(routeLayer);
  if (shape !== 'loop') L.marker(geom[geom.length - 1], { icon: L.divIcon({ className: '', html: '<div class="pt-marker finish"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false }).addTo(routeLayer);
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
  setMe(state.me); map.setView(state.me, 15);
  loadRoutes();
  reverseGeocode(state.me).then(text => { state.address = text; const el = $('#loc-text'); if (el) el.textContent = locLabel(); });
}
function useDemo() { state.demo = true; locate(); }
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
function messageSheet({ ic, title, text, actions }) {
  return `<section class="sheet with-tabbar pad" style="align-items:center;text-align:center;gap:12px;padding-top:12px">
    <div class="grabber"></div>
    <div style="width:56px;height:56px;border-radius:50%;background:var(--surface-subtle);display:grid;place-items:center;color:var(--fg-muted)">${icon(ic, 28)}</div>
    <h1 class="h-sm">${esc(title)}</h1><p class="muted" style="margin:0;max-width:34ch">${esc(text)}</p>
    <div class="stack" style="width:100%">${actions}</div></section>`;
}

function screenHome(tab = 'nearby') {
  ui().className = '';
  routeLayer.clearLayers();
  setMe(state.me);
  const top = `<div class="topbar"><div class="loc-chip">${icon(state.geo === 'ok' ? 'mapPin' : 'mapPinOff', 16)}<span id="loc-text">${esc(locLabel())}</span></div></div><div class="spacer"></div>`;
  const ctrls = state.me ? `<div class="map-ctrls"><button class="icon-btn map" data-action="recenter" aria-label="Показать меня на карте">${icon('locateFixed', 24)}</button></div>` : '';
  if (!navigator.onLine) return top + messageSheet({ ic: 'wifiOff', title: 'Нет связи', text: 'Не можем загрузить карту и маршруты. Проверьте интернет и попробуйте ещё раз.', actions: `<button class="btn primary block" data-action="retry">${icon('refresh', 20)}Повторить</button>` }) + tabbar('walk');
  if (state.geo === 'denied' || state.geo === 'unavailable') return top + messageSheet({ ic: 'mapPinOff', title: 'Не удалось определить геопозицию', text: state.geo === 'denied' ? 'Разрешите доступ к геопозиции для браузера в настройках телефона, затем нажмите «Повторить».' : 'Сигнал GPS слабый или выключен. Выйдите на открытое место и попробуйте снова.', actions: `<button class="btn primary block" data-action="retry">Повторить</button><button class="btn ghost block" data-action="demo">Посмотреть на демо-районе</button>` }) + tabbar('walk');

  if (state.routesStatus === 'error') return top + ctrls + messageSheet({ ic: 'route', title: 'Не получилось построить маршруты', text: 'Сервис маршрутов сейчас не отвечает. Попробуйте ещё раз через минуту.', actions: `<button class="btn primary block" data-action="reload-routes">${icon('refresh', 20)}Повторить</button>` }) + tabbar('walk');
  if (state.routesStatus === 'ready' && !state.routes.length && tab !== 'fav') return top + ctrls + messageSheet({ ic: 'mapPinOff', title: 'Рядом нет подходящих маршрутов', text: 'Не нашли парков и интересных мест на таком расстоянии. Попробуйте другую продолжительность или форму маршрута.', actions: `<a class="btn primary block" href="#/settings">Изменить настройки</a><button class="btn ghost block" data-action="reload-routes">${icon('refresh', 20)}Повторить поиск</button>` }) + tabbar('walk');
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
      <div class="row pad"><h1 class="h-sm grow" id="home-t">Маршруты для прогулки</h1><a class="icon-btn" href="#/settings" aria-label="Настройки подбора">${icon('sliders', 24)}</a></div>
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

function screenSettings() {
  ui().className = '';
  const d = state.draft || (state.draft = { ...state.settings });
  const isTime = d.goal === 'time';
  const presets = isTime ? TIME_PRESETS : STEP_PRESETS;
  const val = isTime ? d.time : d.steps;
  const custom = isTime ? d.customTime : d.customSteps;
  const label = v => (isTime ? (v < 60 ? `${v} мин` : fmtGoalTime(v)) : nf.format(v));
  const km = goalKm(d);
  const hint = isTime ? `Около ${fmtKm(km)} спокойным шагом` : `Около ${fmtKm(km)}, это примерно ${fmtDur(kmToMin(km))}`;
  const min = isTime ? 15 : 1000, max = isTime ? 180 : 30000, step = isTime ? 5 : 500;
  return `<div style="position:fixed;inset:0;background:var(--scrim);z-index:-1" data-action="close-settings"></div>
  <section class="sheet solo" role="dialog" aria-modal="true" aria-labelledby="set-t" style="gap:16px">
    <div class="grabber"></div>
    <div class="row pad"><h1 class="h-md grow" id="set-t">Настройки подбора</h1><button class="icon-btn" style="background:transparent" data-action="close-settings" aria-label="Закрыть">${icon('x', 24)}</button></div>
    <div class="stack pad" style="gap:12px">
      <h2 class="label-lg" style="margin:0">Продолжительность</h2>
      <div class="segmented"><button data-goal="time" aria-pressed="${isTime}">${icon('clock', 16)}По времени</button><button data-goal="steps" aria-pressed="${!isTime}">${icon('footprints', 16)}По шагам</button></div>
      <div class="chips" role="group" aria-label="Варианты">
        ${presets.map(v => `<button class="chip" data-preset="${v}" aria-pressed="${!custom && val === v}">${label(v)}</button>`).join('')}
        <button class="chip" data-action="custom" aria-pressed="${custom}">Своё</button>
      </div>
      ${custom ? `<div class="stack" style="gap:4px"><label class="h-md" for="rng" id="rng-v">${isTime ? (val < 60 ? val + ' мин' : fmtGoalTime(val)) : nf.format(val) + ' шагов'}</label>
        <input class="range" id="rng" type="range" min="${min}" max="${max}" step="${step}" value="${val}" aria-describedby="rng-hint">
        <div class="range-row"><span>${isTime ? '15 мин' : '1 000'}</span><span>${isTime ? '3 ч' : '30 000'}</span></div></div>` : ''}
      <p class="caption muted" id="rng-hint" style="margin:0">${hint}</p>
    </div>
    <div class="divider" role="separator"></div>
    <div class="stack pad" style="gap:12px">
      <h2 class="label-lg" style="margin:0">Форма маршрута</h2>
      <div class="shapes" role="radiogroup" aria-label="Форма маршрута">
        <button class="shape" role="radio" data-shape="loop" aria-checked="${d.shape === 'loop'}"><span class="ill">${LOOP_SVG}</span><span class="tt">Замкнутый${d.shape === 'loop' ? icon('circleCheck', 20) : ''}</span><span class="dd">Вернётесь в точку старта</span></button>
        <button class="shape" role="radio" data-shape="oneway" aria-checked="${d.shape === 'oneway'}"><span class="ill">${ONEWAY_SVG}</span><span class="tt">В одну сторону${d.shape === 'oneway' ? icon('circleCheck', 20) : ''}</span><span class="dd">Закончите в другом месте</span></button>
      </div>
    </div>
    <div class="pad"><button class="btn primary block" data-action="apply">Показать маршруты</button></div>
  </section>`;
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
      <div class="pad"><button class="btn primary block" data-action="start" data-kind="${kind}" data-i="${i}">Начать прогулку</button></div>
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
  $('#w-timer').textContent = fmtClock(w.elapsed);
  $('#w-left').textContent = `Осталось ${fmtKm(n.left)}, около ${fmtDur(kmToMin(n.left))}`;
  $('#w-bar').style.width = n.pct + '%';
  $('#w-goal').textContent = `${fmtSteps(n.steps)} из ${fmtSteps(n.goalSteps)} шагов, ${n.pct}% цели`;
  $('#w-km').textContent = fmtKm(w.km); $('#w-steps').textContent = fmtSteps(n.steps); $('#w-kcal').textContent = approx() + kcal(w.km);
  drawRoute(w.route.geometry, w.route.shape, { fit: false, traveled: w.trace });
}
function screenWalk() {
  const w = state.walk; if (!w) { location.hash = '#/'; return ''; }
  ui().className = '';
  requestAnimationFrame(() => { drawRoute(w.route.geometry, w.route.shape, { bottom: 430, traveled: w.trace }); updateWalkUI(); });
  const n = walkNumbers();
  return `<div class="topbar"><span class="badge ${w.paused ? 'warn' : 'ok'}" role="status"><span class="dot"></span>${w.paused ? 'На паузе' : 'Прогулка идёт'}${w.mode === 'demo' ? ' · демо ×' + DEMO_SPEEDUP : ''}</span></div>
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
function screenProfile() {
  ui().className = 'full';
  return `<div class="page"><h1 class="h-lg">Профиль</h1>
    <form class="card" id="pf" novalidate>
      <h2 class="h-sm">Данные для расчёта</h2>
      <div class="field"><label for="pf-w">Вес, кг</label><input id="pf-w" inputmode="decimal" type="number" min="30" max="250" placeholder="Например, 70" value="${esc(state.profile.weight)}" aria-describedby="pf-wh"><span class="hint" id="pf-wh">Нужен для калорий. Без веса считаем для 70 кг и ставим знак ≈.</span></div>
      <div class="field"><label for="pf-s">Длина шага, см</label><input id="pf-s" inputmode="numeric" type="number" min="40" max="120" value="${esc(state.profile.stepCm)}" aria-describedby="pf-sh"><span class="hint" id="pf-sh">Обычно 65–80 см. Влияет на количество шагов.</span></div>
      <button class="btn primary block" type="submit">Сохранить</button>
    </form>
    <div class="card"><h2 class="h-sm">Демо</h2><p class="body-sm muted" style="margin:0">Маршруты идут по реальным улицам и тропинкам. Места и пути — из OpenStreetMap, фото — из Википедии, если они там есть. На демо-районе прогулка идёт в ускоренном режиме ×${DEMO_SPEEDUP}.</p>
      <button class="btn secondary block" data-action="seed">Добавить примеры в историю</button></div>
    <button class="btn ghost block" style="color:var(--danger)" data-action="wipe">${icon('trash', 20)}Удалить все данные</button>
  </div>${tabbar('profile')}`;
}

/* ---------------- router ---------------- */
function render() {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  $('#modal').innerHTML = '';
  if (a !== 'settings') state.draft = null;
  let html = '';
  if (a === 'settings') html = screenSettings();
  else if (a === 'route') html = screenPreview('nearby', +b);
  else if (a === 'fav') html = screenPreview('fav', +b);
  else if (a === 'favorites') html = screenHome(state.favorites.length ? 'fav' : 'nearby');
  else if (a === 'walk') html = screenWalk();
  else if (a === 'results') html = screenResults();
  else if (a === 'history' && b) html = screenDetails(b);
  else if (a === 'history') html = screenHistory();
  else if (a === 'profile') html = screenProfile();
  else html = state.walk ? (location.hash = '#/walk', '') : screenHome('nearby');
  if (html === '' && a !== '' && a !== undefined) return;
  const sameScreen = render.last === h, keepX = sameScreen ? ($('.carousel') || {}).scrollLeft : 0;
  render.last = h;
  ui().innerHTML = html;
  ui().scrollTop = 0;
  if (keepX) { const c = $('.carousel'); if (c) c.scrollLeft = keepX; } // re-render while routes arrive: keep the user's place
  if (sameScreen) $$('#ui > .sheet').forEach(s => (s.style.animation = 'none')); // no slide-in on a refresh of the same screen
  if (a === 'history' && !b) bindSwipe();
  if (a === 'profile') bindProfile();
  if (a === 'settings') bindSettings();
  if (['settings', 'route', 'fav'].includes(a)) bindSheetDismiss();
  if (!['route', 'fav', 'walk'].includes(a)) routeLayer && a !== 'walk' && routeLayer.clearLayers();
  setTimeout(() => map.invalidateSize(), 0);
}

function bindSettings() {
  const rng = $('#rng');
  if (rng) rng.addEventListener('input', () => {
    const d = state.draft, v = +rng.value;
    if (d.goal === 'time') d.time = v; else d.steps = v;
    $('#rng-v').textContent = d.goal === 'time' ? (v < 60 ? v + ' мин' : fmtGoalTime(v)) : nf.format(v) + ' шагов';
    const km = goalKm(d); $('#rng-hint').textContent = d.goal === 'time' ? `Около ${fmtKm(km)} спокойным шагом` : `Около ${fmtKm(km)}, это примерно ${fmtDur(kmToMin(km))}`;
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

function bindProfile() {
  $('#pf').addEventListener('submit', e => { e.preventDefault(); const w = $('#pf-w').value.trim(), s = $('#pf-s').value.trim();
    if (w && (+w < 30 || +w > 250)) { toast('Вес должен быть от 30 до 250 кг'); $('#pf-w').focus(); return; }
    if (s && (+s < 40 || +s > 120)) { toast('Длина шага — от 40 до 120 см'); $('#pf-s').focus(); return; }
    const stepChanged = String(s || 75) !== String(state.profile.stepCm);
    state.profile = { weight: w, stepCm: s || 75 }; save('profile');
    if (stepChanged && state.settings.goal === 'steps' && state.me) loadRoutes(); // goal in steps → distance changed
    toast('Сохранили'); });
}

/* ---------------- actions ---------------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action], [data-goal], [data-preset], [data-shape]'); if (!el) return;
  const d = state.draft;
  if (el.dataset.goal) { d.goal = el.dataset.goal; render(); return; }
  if (el.dataset.preset) { const v = +el.dataset.preset; if (d.goal === 'time') { d.time = v; d.customTime = false; } else { d.steps = v; d.customSteps = false; } render(); return; }
  if (el.dataset.shape) { d.shape = el.dataset.shape; render(); return; }
  switch (el.dataset.action) {
    case 'demo': useDemo(); location.hash = '#/'; break;
    case 'retry': locate(); break;
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
locate({ quiet: true }); // геопозиция определяется сразу при входе
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
