/* ============================================================
   Шагалка — route engine.
   Real places come from OpenStreetMap (Overpass API); walking routes are built
   along real streets and footpaths by an OSRM foot router. The app picks the
   places, chains them into a loop or a one-way walk and tunes the length to the goal.
   Data providers sit behind PROVIDERS so the place source can be swapped (e.g. Google Places).
   ============================================================ */

export const PROVIDERS = {
  // Public Overpass servers fail now and then: try them in order.
  overpass: [
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ],
  router: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- geometry ---------------- */
const R = 6371000;
const toRad = x => (x * Math.PI) / 180;
const toDeg = x => (x * 180) / Math.PI;
export function offset([lat, lng], dx, dy) {
  return [lat + toDeg(dy / R), lng + toDeg(dx / R) / Math.cos(toRad(lat))];
}
export function dist(a, b) {
  const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function pathLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }
/** Bearing from a to b in degrees, 0 = north, clockwise. */
function bearing(a, b) {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
/** Point at `meters` from p in direction `deg` (0 = north). */
function move(p, deg, meters) { return offset(p, Math.sin(toRad(deg)) * meters, Math.cos(toRad(deg)) * meters); }
const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/* ---------------- network helpers ---------------- */
async function getJSON(url, { timeout = 15000, body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, body ? { method: 'POST', body, signal: ctrl.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : { signal: ctrl.signal });
    if (!res.ok) { const err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
    return await res.json();
  } finally { clearTimeout(t); }
}
async function pool(items, size, fn) {
  const out = new Array(items.length); let next = 0;
  async function worker() { while (next < items.length) { const i = next++; try { out[i] = await fn(items[i], i); } catch { out[i] = null; } } }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/* ---------------- router ---------------- */
const routeCache = new Map();
/** Walking route through the given [lat, lng] points along real streets. */
export async function footRoute(points) {
  const coords = points.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';');
  if (routeCache.has(coords)) return routeCache.get(coords);
  const url = `${PROVIDERS.router}${coords}?overview=full&geometries=geojson&steps=false&continue_straight=false`;
  let j;
  for (let attempt = 0; ; attempt++) { // the public router is shared: back off when it says "too many requests"
    try { j = await getJSON(url); break; } catch (e) { if (attempt >= 2) throw e; await sleep(e.status === 429 ? 1200 * (attempt + 1) : 400); }
  }
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error('no route');
  const r = j.routes[0];
  const out = { distance: r.distance, geometry: r.geometry.coordinates.map(([lng, lat]) => [+lat.toFixed(6), +lng.toFixed(6)]) };
  routeCache.set(coords, out);
  return out;
}

/* ---------------- places ---------------- */
const KIND_RANK = { park: 3, garden: 3, viewpoint: 3, attraction: 2, monastery: 2, castle: 2, manor: 2, museum: 1, monument: 1, church: 1 };
const KIND_LABEL = { park: 'Парк', garden: 'Сад', viewpoint: 'Смотровая площадка', attraction: 'Достопримечательность', monastery: 'Монастырь', castle: 'Замок', manor: 'Усадьба', museum: 'Музей', monument: 'Памятник', church: 'Храм' };
const norm = s => s.toLowerCase().replace(/ё/g, 'е').replace(/\s*\(.*?\)\s*/g, '').replace(/[«»"']/g, '').trim();

/**
 * Named parks, gardens, viewpoints and sights around a point.
 * Two sources at once: OpenStreetMap (Overpass) and geotagged Wikipedia articles, which also bring real photos.
 * Either one is enough, so a public server being down does not leave the user without routes.
 */
export async function fetchPlaces(center, radius) {
  const cacheKey = `${center[0].toFixed(3)},${center[1].toFixed(3)},${Math.round(radius / 100)}`;
  if (placesCache.has(cacheKey)) return placesCache.get(cacheKey);
  const settle = p => p.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
  const osmP = settle(osmPlaces(center, radius));
  const wiki = await settle(wikiPlaces(center, radius));
  // Enough good places from Wikipedia already: give OSM only a short extra wait instead of its full timeout.
  const enough = wiki.status === 'fulfilled' && wiki.value.filter(p => p.rank > 0).length >= 5;
  const osm = enough ? await Promise.race([osmP, sleep(3000).then(() => ({ status: 'rejected', reason: new Error('slow') }))]) : await osmP;
  const a = osm.status === 'fulfilled' ? osm.value : [], b = wiki.status === 'fulfilled' ? wiki.value : [];
  // OSM down and Wikipedia gave nothing usable: that is a service failure, not "nothing around".
  if (osm.status === 'rejected' && !b.length) throw new Error('places unavailable');
  const byName = new Map(a.map(p => [norm(p.name), p]));
  for (const w of b) {
    const same = byName.get(norm(w.name));
    if (same) { if (!same.img) same.img = w.img; same.rank = Math.max(same.rank, w.rank); } // OSM place + Wikipedia photo
    else if (!a.some(p => dist(p.at, w.at) < 60 && (norm(p.name).includes(norm(w.name)) || norm(w.name).includes(norm(p.name))))) { a.push(w); byName.set(norm(w.name), w); }
  }
  if (osm.status === 'fulfilled') placesCache.set(cacheKey, a); // a Wikipedia-only answer is a stopgap: ask OSM again next time
  return a;
}

/** Geotagged Wikipedia articles nearby: notable places with a real photo and a name. */
const NOT_A_WALK = /станци|улиц|переул|проспект|шоссе|проезд|набережн|площад|район|округ|школ|гимнази|лице[йя]|больниц|поликлиник|институт|университет|академи|завод|фабрик|компани|банк|посольств|метро|депо|министерств|театр|кинотеатр|гостиниц|отел|стадион|(^|[^а-яё])дом([^а-яё]|$)|здание|жил(ой|ые)|бизнес|торгов|рынок|вокзал|мост|тоннел|линия|ресторан|кафе|клиник|курсы|холдинг|корпораци|концерн|объединени|издательств|редакци|научн|исследоват|бизнес-центр|управлени|комитет|служб|агентств|фонд|училищ|колледж|детск|спортивн|клуб|офис|штаб|трамвайн|троллейбус|автобус|архив|бирж|организаци|аптек|сеть|казарм|бани|технологи/i;
async function wikiPlaces([lat, lng], radius) {
  const url = `https://ru.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=geosearch&ggscoord=${lat.toFixed(5)}|${lng.toFixed(5)}&ggsradius=${Math.min(10000, Math.round(radius))}&ggslimit=100&prop=coordinates|pageimages|description&colimit=max&piprop=thumbnail&pithumbsize=480&pilimit=max`; // without colimit/pilimit only the first 10/50 pages get coordinates/photos
  const j = await getJSON(url, { timeout: 12000 });
  const out = [];
  for (const p of Object.values(j.query?.pages || {})) {
    const c = p.coordinates?.[0];
    const name = p.title.replace(/\s*\(.*?\)\s*$/, '');
    const text = `${p.title} ${p.description || ''}`;
    if (!c || NOT_A_WALK.test(text)) continue;
    const kind = /парк|лесопарк|сквер|бульвар|роща/i.test(text) ? 'park' : /(^|[^а-яё])сад([^а-яё]|$)/i.test(text) ? 'garden'
      : /смотров/i.test(text) ? 'viewpoint' : /монастыр/i.test(text) ? 'monastery' : /усадьб/i.test(text) ? 'manor'
        : /музей/i.test(text) ? 'museum' : /памятник|монумент|скульптур/i.test(text) ? 'monument'
          : /храм|церк|собор|часовн/i.test(text) ? 'church' : 'attraction';
    // A clear walking destination ranks normally; anything else only with a photo and at the very bottom.
    const clear = kind !== 'attraction' || /достопримечательност|архитектурн|историческ.{0,12}памятник|ансамбл/i.test(text);
    if (!clear && !p.thumbnail) continue;
    out.push({
      id: 'wp' + p.pageid, name, kind, label: KIND_LABEL[kind], at: [c.lat, c.lon],
      rank: clear ? KIND_RANK[kind] + (p.thumbnail ? 1 : 0) : 0, wikidata: '', wikipedia: '', commons: '', image: '',
      img: p.thumbnail?.source || '',
    });
  }
  return out;
}

/** Named parks, gardens, viewpoints and sights from OpenStreetMap. */
async function osmPlaces(center, radius) {
  const [lat, lng] = center;
  const a = `(around:${Math.round(radius)},${lat.toFixed(5)},${lng.toFixed(5)})`;
  const q = `[out:json][timeout:10];(
    nwr["leisure"~"^(park|garden)$"]["name"]${a};
    nwr["tourism"~"^(attraction|viewpoint|museum)$"]["name"]${a};
    nwr["historic"~"^(monument|monastery|castle|manor)$"]["name"]${a};
  );out center tags 300;`;
  const j = await overpass(q);
  const seen = new Set(), places = [];
  for (const e of j.elements || []) {
    const t = e.tags || {};
    const kind = t.leisure || t.tourism || t.historic;
    const p = e.type === 'node' ? [e.lat, e.lon] : e.center ? [e.center.lat, e.center.lon] : null;
    if (!p || !t.name || !KIND_RANK[kind]) continue;
    // Small yards and memorial plaques are not worth a walk: keep gardens only when they are notable.
    if (kind === 'garden' && !t.wikidata && !t.wikipedia && e.type === 'node') continue;
    const key = t.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({
      id: e.type[0] + e.id, name: t.name, kind, label: KIND_LABEL[kind], at: p,
      rank: KIND_RANK[kind] + (t.wikidata || t.wikipedia ? 1 : 0),
      wikidata: t.wikidata || '', wikipedia: t.wikipedia || '', commons: t.wikimedia_commons || '', image: t.image || '',
      img: '',
    });
  }
  return places;
}
const placesCache = new Map();
/**
 * Public Overpass mirrors go down and come back unpredictably (checked: often only one of four answers),
 * so ask all of them at once and take the fastest valid answer. Wikipedia covers us if all fail.
 */
async function overpass(q) {
  const body = 'data=' + encodeURIComponent(q);
  const ask = server => getJSON(server, { body, timeout: 12000 }).then(j => { if (!Array.isArray(j.elements)) throw new Error('bad answer'); return j; });
  return Promise.any(PROVIDERS.overpass.map(ask));
}

/* ---------------- photos (free fallback until a commercial place API is connected) ---------------- */
const photoCache = new Map();
const commonsUrl = file => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/^File:/i, ''))}?width=480`;
/** Real photo of the place from Wikimedia Commons / Wikipedia, or '' when there is none. */
export async function placePhoto(p) {
  if (p.img) return p.img;
  if (photoCache.has(p.id)) return photoCache.get(p.id);
  let url = '';
  try {
    if (p.commons && /^File:/i.test(p.commons)) url = commonsUrl(p.commons);
    else if (/^https:\/\/upload\.wikimedia\.org\//.test(p.image)) url = p.image;
    else if (p.wikidata) {
      const j = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${encodeURIComponent(p.wikidata)}&property=P18&format=json&origin=*`, { timeout: 8000 });
      const file = j.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (file) url = commonsUrl(file);
    }
    if (!url && p.wikipedia) {
      const [lang, ...rest] = p.wikipedia.split(':');
      const j = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(rest.join(':'))}`, { timeout: 8000 });
      url = j.thumbnail?.source || '';
    }
  } catch { url = ''; }
  photoCache.set(p.id, url);
  return url;
}

/* ---------------- route generation ---------------- */
const DETOUR = 1.3; // real walking paths are ~30% longer than a straight line

/** Loop: start → place → side point → start, side point tuned until the length fits the goal. */
async function loopVia(start, place, targetM, side) {
  const d = dist(start, place.at), brg = bearing(start, place.at);
  const mid = move(start, brg, d / 2);
  const half = targetM / DETOUR / 2;
  let s = Math.sqrt(Math.max(0, half * half - (d / 2) ** 2)) - d / 4;
  s = Math.max(80, s);
  let best = null;
  for (let it = 0; it < 3; it++) {
    const w = move(mid, brg + 90 * side, s);
    const r = await footRoute([start, place.at, w, start]);
    const err = Math.abs(r.distance - targetM) / targetM;
    if (!best || err < best.err) best = { ...r, err };
    if (err < 0.12) break;
    s = Math.max(40, s * Math.pow(targetM / r.distance, 1.4));
  }
  return best;
}
/** One way: start → place, optionally via a side point when the place is too close. */
async function onewayTo(start, place, targetM, side) {
  let r = await footRoute([start, place.at]);
  let best = { ...r, err: Math.abs(r.distance - targetM) / targetM };
  if (r.distance < targetM * 0.85) {
    const d = dist(start, place.at), brg = bearing(start, place.at);
    let s = Math.max(80, Math.sqrt(Math.max(0, (targetM / DETOUR / 2) ** 2 - (d / 2) ** 2)));
    for (let it = 0; it < 2 && best.err >= 0.1; it++) {
      const w = move(move(start, brg, d / 2), brg + 90 * side, s);
      r = await footRoute([start, w, place.at]);
      const err = Math.abs(r.distance - targetM) / targetM;
      if (err < best.err) best = { ...r, err };
      s = Math.max(40, s * Math.pow(targetM / r.distance, 1.4));
    }
  }
  return best;
}

/** Places that lie along a route, for the "what you'll see" gallery. */
function alongRoute(geometry, places, exceptId, limit = 4) {
  const step = Math.max(1, Math.floor(geometry.length / 60));
  const sample = geometry.filter((_, i) => i % step === 0);
  return places
    .filter(p => p.id !== exceptId)
    .map(p => ({ p, d: Math.min(...sample.map(g => dist(g, p.at))) }))
    .filter(x => x.d < 200)
    .sort((a, b) => b.p.rank - a.p.rank || a.d - b.d)
    .slice(0, limit)
    .map(x => x.p);
}

/**
 * Build up to `count` walking routes from `start` that fit `targetKm`.
 * Each route is named after the real place it leads to. `onRoute` gets every route as soon as it is ready.
 */
export async function buildRoutes({ start, targetKm, shape, count = 6, onRoute = () => {} }) {
  const targetM = targetKm * 1000;
  const reach = shape === 'loop' ? targetM / DETOUR / 2.2 : targetM / DETOUR;
  const radius = Math.min(8000, Math.max(1200, reach * 1.15));
  const places = await fetchPlaces(start, radius);

  // Candidates: places at a distance the goal can reach, best-ranked first, spread across directions.
  const lo = shape === 'loop' ? 120 : reach * 0.35, hi = shape === 'loop' ? reach * 1.05 : reach * 1.1;
  const cand = places
    .map(p => ({ p, d: dist(start, p.at), b: bearing(start, p.at) }))
    .filter(x => x.d >= lo && x.d <= hi)
    .sort((a, b) => b.p.rank - a.p.rank || Math.abs(a.d - reach * 0.7) - Math.abs(b.d - reach * 0.7));
  const picked = [];
  for (const x of cand) { if (picked.length >= count) break; if (picked.every(y => angleDiff(x.b, y.b) >= 28)) picked.push(x); }
  for (const x of cand) { if (picked.length >= count) break; if (!picked.includes(x)) picked.push(x); }

  const accepted = [];
  const mid = g => g[Math.floor(g.length / 2)];
  await pool(picked, 2, async (x, i) => {
    const side = i % 2 ? -1 : 1;
    const r = shape === 'loop' ? await loopVia(start, x.p, targetM, side) : await onewayTo(start, x.p, targetM, side);
    if (!r || r.err > 0.35) return;
    // Two nearby places can give the same walk: keep the first one.
    if (accepted.some(u => Math.abs(u.km * 1000 - r.distance) < 50 && dist(mid(u.geometry), mid(r.geometry)) < 60)) return;
    const route = {
      key: `${x.p.id}-${shape}-${Math.round(r.distance / 100)}`,
      placeId: x.p.id, name: x.p.name, kind: x.p.label, km: r.distance / 1000, shape,
      endName: shape === 'loop' ? '' : x.p.name,
      geometry: r.geometry, place: x.p, gallery: alongRoute(r.geometry, places, x.p.id),
    };
    accepted.push(route);
    onRoute(route);
  });
  return accepted;
}
