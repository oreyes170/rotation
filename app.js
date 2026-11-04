/* Rotation — offline wardrobe and wear tracker. All data lives in this browser (IndexedDB),
   with optional backup to the user's own Google Drive. */
'use strict';
const VERSION = 48; // shown in the header; bump with CACHE in sw.js

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const fmt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => fmt(new Date());
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return fmt(d); };
const addMonths = (s, n) => { const d = parseD(s); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + Number(n)); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return fmt(d); };
const prettyDate = s => s ? parseD(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const longDate = s => parseD(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const money = n => n == null ? '—' : '$' + n.toFixed(2);
const initials = s => (s || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const splitTags = s => [...new Set(String(s || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean))];

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- storage ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('rotation', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  get(k) {
    return new Promise((res, rej) => {
      const q = this.db.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  },
  setMany(obj) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction('kv', 'readwrite'); const st = tx.objectStore('kv');
      for (const [k, v] of Object.entries(obj)) st.put(v, k);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  }
};

const COLLS = ['types', 'items', 'entries', 'templates', 'days', 'filters', 'locations', 'purchases', 'settings'];
let S = {};

function defaults() {
  const tee = n => /tee|jersey/i.test(n);
  const mk = name => ({ id: uid(), name, limit: null, defaultSize: tee(name) ? 'XL' : '', group: tee(name) ? 'Tees' : '' });
  const types = ['Short-sleeve tee', 'Long-sleeve tee', 'Jersey', 'Work shirt', 'Cap', 'Tie', 'Shoes', 'Pants', 'Jacket', 'Other'].map(mk);
  const id = n => types.find(t => t.name === n).id;
  return {
    types, items: [], entries: [], days: {}, filters: [], purchases: [],
    locations: [{ id: uid(), name: 'Home' }],
    templates: [{ id: uid(), name: 'Daily', slots: [id('Short-sleeve tee'), id('Work shirt'), id('Cap'), id('Tie')] }],
    settings: { recentDays: 30, cpwIncludesEstimate: true, clientId: '', driveFileId: '', autoBackup: true, lastChange: 0, lastBackup: 0, logLocation: '', tagLibrary: [], theme: 'auto', glass: true, cols: 3, schema: 4 }
  };
}

async function load() {
  await DB.open();
  const d = defaults(); let any = false;
  for (const k of COLLS) { const v = await DB.get(k); if (v !== undefined) { S[k] = v; any = true; } else S[k] = d[k]; }
  S.settings = { ...d.settings, schema: 1, ...S.settings };
  if (!any) await DB.setMany(Object.fromEntries(COLLS.map(k => [k, S[k]])));
  if (S.settings.schema < 2) {
    // v2: T-shirts default to XL unless a size was already chosen
    const tee = S.types.find(t => t.name.toLowerCase() === 't-shirt'); if (tee && !tee.defaultSize) tee.defaultSize = 'XL';
    S.settings.schema = 2; await DB.setMany({ types: S.types, settings: S.settings });
  }
  if (S.settings.schema < 3) {
    // v3: T-shirt becomes Short-sleeve tee, plus Long-sleeve tee and Jersey, grouped as "Tees" on the calendar.
    // Sizes drop a "Men's"/"Women's" prefix.
    const named = n => S.types.find(t => t.name.toLowerCase() === n);
    const tee = named('t-shirt') || named('short-sleeve tee');
    if (tee) { if (tee.name.toLowerCase() === 't-shirt') tee.name = 'Short-sleeve tee'; tee.group ||= 'Tees'; }
    for (const n of ['Long-sleeve tee', 'Jersey']) {
      const t = named(n.toLowerCase());
      if (t) t.group ||= 'Tees';
      else S.types.splice(tee ? S.types.indexOf(tee) + 1 + (n === 'Jersey') : S.types.length, 0, { id: uid(), name: n, limit: tee?.limit ? { ...tee.limit } : null, defaultSize: tee?.defaultSize || 'XL', group: 'Tees' });
    }
    S.items.forEach(i => { if (i.size) i.size = cleanSize(i.size); });
    S.settings.schema = 3; await DB.setMany({ types: S.types, items: S.items, settings: S.settings });
  }
  if (S.settings.schema < 4) {
    // v4: an item's single `brand` becomes a list, `brands`
    S.items.forEach(i => { i.brands = brandsOf(i); delete i.brand; });
    S.settings.schema = 4; await DB.setMany({ items: S.items, settings: S.settings });
  }
}

async function save(...keys) {
  S.settings.lastChange = Date.now();
  const out = {}; for (const k of new Set([...keys, 'settings'])) out[k] = S[k];
  await DB.setMany(out);
  renderSync(); scheduleBackup();
}

/* ---------- lookups and calculations ---------- */
const itemById = id => S.items.find(i => i.id === id);
const typeById = id => S.types.find(t => t.id === id);
const typeName = id => typeById(id)?.name || 'Item';
/* types can share a calendar group (e.g. three kinds of tee shown as "Tees"); ungrouped types stand alone */
const groupKey = id => { const g = typeById(id)?.group?.trim(); return g ? 'g:' + g.toLowerCase() : 't:' + id; };
const groupName = key => key.startsWith('g:') ? S.types.find(t => groupKey(t.id) === key)?.group.trim() || key.slice(2) : typeName(key.slice(2));
const groupKeys = () => [...new Set(S.types.map(t => groupKey(t.id)))];
const cleanSize = s => String(s || '').replace(/^\s*(wo)?men[’']?s\b\s*/i, '').trim();

/* planned outfits ({planned: true}) never count as wears until they're marked worn */
const worn = () => S.entries.filter(e => !e.planned);
/* entry.noWear: items the owner marked "don't count as a wear" (e.g. a shirt kept on overnight).
   They show on the calendar and the day's outfit, but never count toward wears, limits, last worn or pairings. */
const counts = (e, id) => e.itemIds.includes(id) && !(e.noWear || []).includes(id);
function wearDates(itemId) {
  const set = new Set();
  for (const e of worn()) if (counts(e, itemId)) set.add(e.date);
  return [...set].sort();
}
function effPrice(i) { const d = num(i.discountPrice), p = num(i.price); return d != null ? d : p; }
function limitOf(i) {
  if (i.limit && num(i.limit.wears)) return i.limit;
  const t = typeById(i.typeId); return t && t.limit && num(t.limit.wears) ? t.limit : null;
}
/* Wear limit: after N tracked wears the item rests for M months, then a new cycle starts.
   Derived from the wear log, so editing history keeps it correct. */
function rotation(dates, lim, asOf = today()) {
  if (!lim) return { resting: false, cycleWears: dates.length, restUntil: null };
  const N = num(lim.wears), M = num(lim.restMonths) || 0;
  let count = 0, restUntil = null;
  for (const d of dates) {
    if (restUntil && d >= restUntil) { restUntil = null; count = 0; }
    if (restUntil) continue;            // worn during a rest: counted in totals, not in the cycle
    count++;
    if (count >= N) restUntil = addMonths(d, M);
  }
  const t = asOf;
  if (restUntil && t < restUntil) return { resting: true, cycleWears: count, restUntil };
  if (restUntil) return { resting: false, cycleWears: 0, restUntil: null };
  return { resting: false, cycleWears: count, restUntil: null };
}
function wornWithin(dates, days, end = today()) {
  const start = addDays(end, -(days - 1));
  return dates.filter(d => d >= start && d <= end).length;
}
function stats(item) {
  const dates = wearDates(item.id), tracked = dates.length, est = Math.max(0, num(item.estWears) || 0);
  const total = tracked + est, cost = effPrice(item);
  const base = S.settings.cpwIncludesEstimate ? total : tracked;
  const lim = limitOf(item), rot = rotation(dates, lim);
  return {
    dates, tracked, est, total, cost, lim, ...rot,
    recent: wornWithin(dates, Number(S.settings.recentDays) || 30),
    cpw: cost != null && base > 0 ? cost / base : null,
    last: dates[dates.length - 1] || null,
    status: item.retired ? 'retired' : rot.resting ? 'resting' : 'active'
  };
}
function combos(itemId, from, to) {
  const m = new Map();
  for (const e of worn()) {
    if (!counts(e, itemId)) continue;
    if (from && e.date < from) continue; if (to && e.date > to) continue;
    for (const o of e.itemIds) if (o !== itemId && counts(e, o)) { if (!m.has(o)) m.set(o, new Set()); m.get(o).add(e.date); }
  }
  return [...m].map(([id, ds]) => ({ item: itemById(id), n: ds.size, last: [...ds].sort().pop() }))
    .filter(x => x.item).sort((a, b) => b.n - a.n || (b.last > a.last ? 1 : -1));
}
function pairCount(a, b) {
  const s = new Set(); for (const e of worn()) if (counts(e, a) && counts(e, b)) s.add(e.date); return s.size;
}
/* availability on a given day. For a future day, earlier plans count too, so a plan can't break a wear limit. */
function statusOn(item, date) {
  if (item.retired) return 'retired';
  if (date <= today()) return rotation(wearDates(item.id), limitOf(item), date).resting ? 'resting' : 'active';
  const dates = [...new Set(S.entries.filter(e => counts(e, item.id) && (!e.planned || e.date < date)).map(e => e.date))].sort();
  return rotation(dates, limitOf(item), date).resting ? 'resting' : 'active';
}
const nextPlan = itemId => S.entries.filter(e => e.planned && e.date >= today() && e.itemIds.includes(itemId)).map(e => e.date).sort()[0];
const FITS = [['too-tight', 'Too tight', -2], ['snug', 'Snug', -1], ['good', 'Just right', 0], ['loose', 'Loose', 1], ['too-loose', 'Too loose', 2]];
const fitLabel = r => FITS.find(f => f[0] === r)?.[1] || '';
const fitScore = r => FITS.find(f => f[0] === r)?.[2];
const locName = id => S.locations.find(l => l.id === id)?.name || '';
const locOptions = sel => `<option value="">Not set</option>${S.locations.map(l => `<option value="${l.id}" ${l.id === sel ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}<option value="+new">＋ New place…</option>`;
/* "＋ New place…" in a location menu asks for a name, saves the place and selects it */
function wireLocSelect(sel, onPick) {
  let prev = sel.value;
  sel.onchange = async () => {
    if (sel.value === '+new') {
      const name = (prompt('Name of the new place') || '').trim();
      if (!name) { sel.value = prev; return; }
      let l = S.locations.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (!l) { l = { id: uid(), name }; S.locations.push(l); await save('locations'); toast('Added ' + name); }
      sel.innerHTML = locOptions(l.id);
    }
    prev = sel.value; onPick && onPick(sel.value);
  };
}
/* every fit note for an item: from logged wears and from try-ons (try-ons do not count as wears) */
function fitHistory(itemId) {
  const out = [];
  for (const e of worn()) { const f = e.fits?.[itemId]; if (f?.r && e.itemIds.includes(itemId)) out.push({ date: e.date, r: f.r, note: f.note || '', kind: 'wear', entryId: e.id }); }
  for (const t of (itemById(itemId)?.tryOns || [])) out.push({ date: t.date, r: t.r, note: t.note || '', kind: 'try-on', id: t.id });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
function fitSummary(itemId) {
  const h = fitHistory(itemId); if (!h.length) return null;
  const last = h[h.length - 1];
  const avg = a => a.reduce((x, y) => x + fitScore(y.r), 0) / a.length;
  const recent = h.slice(-3), before = h.slice(-6, -3);
  let trend = '';
  if (before.length) { const d = avg(recent) - avg(before); if (d >= 0.5) trend = 'looser than before'; else if (d <= -0.5) trend = 'tighter than before'; else trend = 'about the same as before'; }
  return { last, trend, count: h.length };
}
const TYPE_WORDS = [
  [/\b(neck)?ties?\b|bow ?tie/i, 'tie'], [/\b(caps?|hats?|snapback|beanie|fitted|dad hat|trucker)\b/i, 'cap'], [/\bjerseys?\b/i, 'jersey'],
  [/\blong[- ]?sleeve/i, 'long-sleeve tee'], [/\b(tees?|t-?shirts?|ringer|graphic)\b/i, 'short-sleeve tee|t-shirt'], [/\b(oxford|button[- ]?(down|up)|dress shirt|flannel|polo|work shirt|shirt)\b/i, 'work shirt'],
  [/\b(shoes?|sneakers?|boots?|loafers?|slippers?|sandals?|trainers?|clogs?)\b/i, 'shoes'], [/\b(pants?|jeans?|chinos?|trousers?|shorts|joggers?|slacks)\b/i, 'pants'],
  [/\b(jackets?|coats?|hoodies?|sweaters?|cardigans?|fleece|blazers?|parka|sweatshirt|crewneck)\b/i, 'jacket']
];
/* What a product link says by itself (the app can't read store pages: browsers block that).
   e.g. zappos.com/p/mens-hoka-gaviota-6-black-black/... → Zappos, Hoka, "Hoka Gaviota 6", black */
const STORE_NAMES = { jcrew: 'J.Crew', '6pm': '6pm', hm: 'H&M', bananarepublic: 'Banana Republic', oldnavy: 'Old Navy', llbean: 'L.L.Bean', rei: 'REI', asos: 'ASOS' };
const SHOE_STORES = ['zappos', '6pm', 'footlocker', 'finishline', 'dsw'];
function parseStoreLink(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i); if (!m) return null;
  let u; try { u = new URL(m[0]); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|shop|store|us)\./, '').split('.'), site = host.length > 1 ? host[host.length - 2] : host[0];
  const title = w => w.length <= 2 && /\d/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1);
  const known = (list, v) => list.find(x => x.toLowerCase().replace(/[^a-z0-9]/g, '') === v.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const store = known(distinct('store'), site) || STORE_NAMES[site] || title(site);
  // the product slug: the longest path part made of words joined by hyphens
  const parts = u.pathname.split('/').map(p => decodeURIComponent(p).replace(/\.html?$/, '')).filter(p => /[a-z]{3}/i.test(p) && p.includes('-'));
  let words = (parts.sort((a, b) => b.length - a.length)[0] || '').toLowerCase().split(/[-_]+/).filter(Boolean);
  if (/^(mens|men|womens|women|unisex|kids|boys|girls)$/.test(words[0])) words.shift(); if (words[0] === 's') words.shift();
  const colours = [];
  while (words.length > 1 && PALETTE.some(p => p[0] === words[words.length - 1])) { const c = words.pop(); if (!colours.includes(c)) colours.unshift(c); }
  // brand: one already in the closet, or on shoe stores, the first word of the slug
  let brand = '';
  for (const n of [2, 1]) { const b = words.length > n && known(allBrands(), words.slice(0, n).join(' ')); if (b) { brand = b; break; } }
  if (!brand && SHOE_STORES.includes(site) && words.length > 1) brand = title(words[0]);
  const name = words.map(title).join(' ');
  return { link: m[0], store, brand, name, colours, typeId: guessType(name) || (SHOE_STORES.includes(site) ? guessType('shoes') : null) };
}
/* Reading screenshots (store pages, receipts) on the device with tesseract.js from vendor/tesseract.
   Loaded on first use (~7 MB once), then cached by the service worker for offline use. */
const OCR = {
  worker: null,
  async read(src, onProgress) {
    if (!this.worker) {
      if (!window.Tesseract) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/tesseract/tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('Couldn’t load the screenshot reader. The first time, you need to be online.')); document.head.appendChild(s); });
      const base = new URL('vendor/tesseract/', location.href).href;
      this.worker = await Tesseract.createWorker('eng', 1, { workerPath: base + 'worker.min.js', corePath: base, langPath: base, workerBlobURL: false, logger: m => onProgress && onProgress(m) });
    }
    const { data } = await this.worker.recognize(src);
    return this.recheckPrices(src, data);
  },
  // A small raised "$" can swallow the digit next to it ("$179.95" read as "$79.95"). Each price is read again
  // close up, enlarged, digits only; the close-up wins only when it's the same price with digits added in front.
  async recheckPrices(src, data) {
    let text = data.text;
    const found = (data.words || []).filter(w => /\d+[.,]\d{2}/.test(w.text)).slice(0, 8);
    if (!found.length) return text;
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const crop = ({ x0, y0, x1, y1 }, scale) => {
      const h = y1 - y0, L = Math.max(0, x0 - h * 1.2), T = Math.max(0, y0 - h * 0.4), W = Math.min(img.width - L, x1 - L + h * 0.4), H = Math.min(img.height - T, h * 1.8), k = scale * 48 / h;
      const c = document.createElement('canvas'); c.width = Math.round(W * k) + 40; c.height = Math.round(H * k) + 40;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'high'; g.drawImage(img, L, T, W, H, 20, 20, W * k, H * k);
      return c.toDataURL('image/png');
    };
    await this.worker.setParameters({ tessedit_char_whitelist: '$0123456789.,', tessedit_pageseg_mode: '7' });
    try {
      for (const w of found) {
        const orig = w.text.replace(/[^\d.,]/g, ''), reads = [];
        for (const scale of [2, 3]) reads.push((await this.worker.recognize(crop(w.bbox, scale))).data.text.replace(/[^\d.,]/g, ''));
        const best = reads.filter(r => r.length > orig.length && r.endsWith(orig)).sort((a, b) => b.length - a.length)[0];
        if (best) text = text.replace(w.text, '$' + best);
      }
    } finally { await this.worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '6' }); }
    return text;
  }
};
const KNOWN_STORES = ['Zappos', 'Amazon', 'Uniqlo', 'J.Crew', 'Nike', 'Adidas', 'Target', 'Macy’s', 'Nordstrom', 'Old Navy', 'Gap', 'Everlane', 'Fanatics', 'HOMAGE', 'Etsy', 'eBay', 'H&M', 'Banana Republic', 'Walmart', 'Kohl’s', 'REI', 'ASOS'];
const SHOT_NOISE = /^(men|women|unisex|kids)['’]?s?$|\$|%|https?:|www\.|\b(size|colou?r|qty|quantity|add to|bag|cart|checkout|ship|shipping|deliver|free|return|review|rating|stars?|sold|order|total|subtotal|tax|menu|search|sign in|account|details|description|select|pickup|width|wishlist|favorite|share|similar|you may|recommended|sale|off|save|payment|card|visa|address|track|item #|sku|style)\b/i;
const esc_re = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function parseShotText(text) {
  // a small raised "$" right against the first digit is easy to misread: "1$79.95" / "$1 79.95" → "$179.95"
  text = text.replace(/(^|[^\d.,$])(\d)\s?[$§]\s?(?=\d{2})/gm, '$1$$$2').replace(/\$\s?(\d)\s(\d{1,3}\.\d{2})\b/g, '$$$1$2');
  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean), low = ' ' + text.toLowerCase().replace(/\s+/g, ' ') + ' ';
  const has = name => name.length >= 3 && new RegExp('(^|[^a-z0-9])' + esc_re(name.toLowerCase()) + '([^a-z0-9]|$)').test(low);
  const priceIn = l => (l.match(/\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)\s*$/) || [])[1]?.replace(/,/g, '') || '';
  const sizeIn = l => { const m = l.match(/\bsize\b\s*[:\-]?\s*(.+)/i); if (!m) return ''; const v = m[1].split(/\s[|·•-]\s|,|\s{2,}|\bcolou?r\b|\bqty\b|\bwidth\b/i)[0].trim();
    return /^(one size|[2-5]?x{0,3}[sml]|\d?xl|\d{1,2}(\.5)?|\d{2}\s?x\s?\d{2})$/i.test(v) ? cleanSize(/one size/i.test(v) ? 'One size' : v.toUpperCase()) : ''; };
  const coloursIn = l => { const m = l.match(/\bcolou?r\b\s*[:\-]?\s*(?:\d+\s+)?([a-z][a-z \/&-]{2,40})/i); if (!m) return [];
    return [...new Set(m[1].split(/\/|&|,|\band\b|\s-\s|\s\|/i).map(c => c.trim().toLowerCase()).filter(c => c && c.length < 20 && !/size|qty|width/.test(c)))].slice(0, 3); };
  // prices: "$12.34" anywhere, or a line that is just a price whose "$" was misread or dropped ("S179.95", "179.95")
  const prices = [...new Set(lines.flatMap(l => {
    const own = l.match(/^[^\w]*[$§S]?\s?(\d{1,4}(?:,\d{3})*\.\d{2})\s*$/);
    return own ? [own[1]] : [...l.matchAll(/\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/g)].map(m => m[1]);
  }).map(p => p.replace(/,/g, '')))].filter(p => +p > 0).slice(0, 6);
  const size = lines.map(sizeIn).find(Boolean) || '', colours = lines.map(coloursIn).find(c => c.length) || [];
  let date = '';
  const dm = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i) || text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (dm) { const d = /\d/.test(dm[1]) ? new Date(+(dm[3].length === 2 ? '20' + dm[3] : dm[3]), dm[1] - 1, +dm[2]) : new Date(`${dm[1]} ${dm[2]} ${dm[3]}`); if (!isNaN(d)) date = fmt(d); }
  const stores = [...distinct('store'), ...S.purchases.map(p => p.retailer.replace(/\s*\(.*\)\s*$/, '')), ...KNOWN_STORES];
  const store = stores.filter(has).sort((a, b) => b.length - a.length)[0] || '';
  let brand = allBrands().filter(has).sort((a, b) => b.length - a.length)[0] || '';
  // name ideas: short, wordy lines that aren't page furniture. A receipt line "Name $19.90" keeps its price, and the
  // size and colour on the next lines, so picking one receipt item fills all of them.
  const names = [];
  lines.forEach((l, i) => {
    const price = priceIn(l), t = l.replace(/\s*\$\s?[\d,.]+\s*$/, '').trim(), words = t.split(' ').length;
    if (t.length < 6 || t.length > 70 || (words < 2 && !/\d/.test(t)) || words > 10 || SHOT_NOISE.test(t) || (t.match(/[a-z]/gi) || []).length / t.length < 0.6) return;
    const next = lines.slice(i + 1, i + 3).filter(n => !priceIn(n) || /\bsize\b|\bcolou?r\b/i.test(n));
    names.push({ name: t, price, size: next.map(sizeIn).find(Boolean) || '', colours: next.map(coloursIn).find(c => c.length) || [],
      score: (brand && t.toLowerCase().includes(brand.toLowerCase()) ? 4 : 0) + (guessType(t) ? 3 : 0) + (price ? 2 : 0) + (/^[A-Z0-9]/.test(t) ? 1 : 0) - i * 0.01 });
  });
  // product pages put the brand on its own short line just above the name ("HOKA" / "Gaviota 6")
  if (!brand) lines.forEach((l, i) => {
    const nx = lines[i + 1] || '';
    if (!brand && /^[A-Za-z][A-Za-z&.'’ -]{1,24}$/.test(l) && l.split(' ').length <= 3 && l === l.toUpperCase() && /[A-Z]{2}/.test(l) && /[a-z]/.test(nx) && !SHOT_NOISE.test(l) && !/^(men|women|kids|sale|new)/i.test(l))
      brand = l.length > 3 ? l[0] + l.slice(1).toLowerCase().replace(/([ &.-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : l;
  });
  if (brand) names.forEach(n => { if (n.name.toLowerCase().includes(brand.toLowerCase())) n.score += 4; });
  names.sort((a, b) => b.score - a.score);
  const top = names.filter((n, i) => names.findIndex(m => m.name === n.name) === i && n.name.toLowerCase() !== brand.toLowerCase()).slice(0, 6);
  // a short product name gets the brand in front ("Gaviota 6" → "Hoka Gaviota 6")
  const sure = top.length && (brand || guessType(top[0].name)) ? { ...top[0], name: brand && !top[0].name.toLowerCase().includes(brand.toLowerCase()) ? brand + ' ' + top[0].name : top[0].name } : null;
  return { prices, size, colours, date, store, brand, names: top, sure, typeId: (sure && guessType(sure.name)) || guessType(text) };
}
function guessType(text) {
  for (const [re, words] of TYPE_WORDS) if (re.test(text)) for (const word of words.split('|')) { const t = S.types.find(x => x.name.toLowerCase() === word || x.name.toLowerCase().replace(/s$/, '') === word); if (t) return t.id; }
  return null;
}
const PALETTE = [['black', 20, 20, 22], ['white', 245, 245, 242], ['grey', 140, 140, 140], ['light grey', 200, 200, 200], ['navy', 28, 38, 80], ['blue', 40, 90, 190],
  ['light blue', 140, 180, 225], ['teal', 20, 130, 130], ['green', 40, 140, 60], ['olive', 110, 110, 50], ['yellow', 235, 205, 50], ['gold', 190, 150, 50], ['orange', 230, 120, 40],
  ['red', 200, 35, 40], ['burgundy', 110, 25, 40], ['pink', 235, 140, 170], ['purple', 110, 60, 150], ['brown', 110, 70, 40], ['tan', 200, 170, 120], ['cream', 240, 230, 205]];
function nearestColour(r, g, b) {
  let best = null, bd = 1e9;
  for (const [n, R, G, B] of PALETTE) { const d = 2 * (r - R) ** 2 + 4 * (g - G) ** 2 + 3 * (b - B) ** 2; if (d < bd) { bd = d; best = n; } }
  return best;
}
/* main colours in a photo, ignoring the background colour around the edges */
/* main colours in a photo. The background is the shade around the edges (median of the border pixels); everything
   connected to the border that's close to it (soft shadows and gradients too) is dropped before counting. If almost
   nothing is left, the item is the background's colour (a white tee on white), so that colour is the answer. */
function detectColours(dataUrl) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const N = 64, c = document.createElement('canvas'); c.width = N; c.height = N;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, N, N);
      const px = g.getImageData(0, 0, N, N).data, at = (x, y) => (y * N + x) * 4;
      const dist = (i, b) => Math.hypot(px[i] - b[0], px[i + 1] - b[1], px[i + 2] - b[2]);
      const border = []; for (let k = 0; k < N; k++) border.push([k, 0], [k, N - 1], [0, k], [N - 1, k]);
      const med = ch => { const v = border.map(([x, y]) => px[at(x, y) + ch]).sort((a, b) => a - b); return v[v.length >> 1]; };
      const bg = [med(0), med(1), med(2)];
      const isBg = new Uint8Array(N * N);
      if (border.filter(([x, y]) => dist(at(x, y), bg) < 40).length / border.length > 0.5) {
        // flood fill the background in from the border
        const stack = border.filter(([x, y]) => dist(at(x, y), bg) < 50);
        while (stack.length) {
          const [x, y] = stack.pop(), k = y * N + x;
          if (x < 0 || y < 0 || x >= N || y >= N || isBg[k] || dist(k * 4, bg) >= 50) continue;
          isBg[k] = 1; stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
      }
      const all = new Map(); let kept = 0;
      for (let k = 0; k < N * N; k++) {
        if (isBg[k] || (isBg.some(Boolean) && dist(k * 4, bg) < 22)) continue;   // also drop background showing through gaps
        const n = nearestColour(px[k * 4], px[k * 4 + 1], px[k * 4 + 2]); all.set(n, (all.get(n) || 0) + 1); kept++;
      }
      if (kept < N * N * 0.06) return res([nearestColour(...bg)]);
      res([...all].sort((a, b) => b[1] - a[1]).filter(([, v]) => v / kept >= 0.15).slice(0, 3).map(([n]) => n));
    };
    img.onerror = () => res([]);
    img.src = dataUrl;
  });
}
function purchaseMatches(q) {
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
  if (!words.length || !S.purchases.length) return [];
  return S.purchases.map(p => { const hay = (p.item + ' ' + p.retailer + ' ' + p.color).toLowerCase(); return { p, score: words.filter(w => hay.includes(w)).length }; })
    .filter(x => x.score >= Math.min(2, words.length)).sort((a, b) => b.score - a.score || b.p.date.localeCompare(a.p.date)).slice(0, 6).map(x => x.p);
}
function sizeFor(typeId) {
  const t = typeById(typeId); if (t?.defaultSize) return t.defaultSize;
  const n = {}; S.items.forEach(i => { if (i.typeId === typeId && i.size) n[i.size] = (n[i.size] || 0) + 1; });
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
/* items can have several brands (a collab, or a print brand on a blank like Comfort Colors); old data had one `brand` */
const brandsOf = i => i.brands || (i.brand ? [i.brand] : []);
const allBrands = () => [...new Set(S.items.flatMap(brandsOf))].sort((a, b) => a.localeCompare(b));
function allTags() { const s = new Set(); S.items.forEach(i => (i.tags || []).forEach(t => s.add(t))); return [...s].sort(); }
/* tags on items plus the saved tag list from Setup */
function knownTags() { return [...new Set([...allTags(), ...(S.settings.tagLibrary || [])])].sort(); }
const COUNTRIES = ['Bangladesh', 'Cambodia', 'Canada', 'China', 'Egypt', 'El Salvador', 'Guatemala', 'Haiti', 'Honduras', 'India', 'Indonesia', 'Italy', 'Japan', 'Jordan', 'Mexico', 'Nicaragua', 'Pakistan', 'Peru', 'Portugal', 'Sri Lanka', 'Turkey', 'USA', 'Vietnam'];
const MATERIALS = ['acrylic', 'cashmere', 'cotton', 'denim', 'elastane', 'fleece', 'leather', 'linen', 'merino', 'modal', 'nylon', 'organic cotton', 'polyester', 'rayon', 'recycled polyester', 'silk', 'spandex', 'suede', 'tri-blend', 'viscose', 'wool'];
function editDist(a, b) {
  let row = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) { let prev = row[0]; row[0] = i; for (let j = 1; j <= b.length; j++) { const t = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
  return row[b.length];
}
/* tag entry: each tag becomes a chip. Known tags are suggested as you type (close spellings too),
   and a tag that matches nothing known is marked "new" so typos stand out. Returns a getter.
   Also used for materials, with field 'materials' and the common materials as extras. */
function tagField(box, initial, { field = 'tags', extra = S.settings.tagLibrary || [], noun = 'tag', keepCase = false, values = i => i[field] || [] } = {}) {
  // keepCase (brands): spelling is kept and matched case-insensitively; otherwise everything is lowercase
  const tags = [...initial], counts = {}, L = s => s.toLowerCase();
  S.items.forEach(i => values(i).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  const known = [...new Set([...Object.keys(counts), ...extra])].sort(), isKnown = t => known.some(k => L(k) === L(t)), has = t => tags.some(x => L(x) === L(t));
  box.innerHTML = `<div class="tagbox"><span class="tagchips"></span><input class="taginput" placeholder="Type a ${noun}" autocomplete="off" autocapitalize="${keepCase ? 'words' : 'off'}" autocorrect="off" spellcheck="false" enterkeyhint="done"></div><div class="tagsugg"></div>`;
  const chips = $('.tagchips', box), inp = $('.taginput', box), sugg = $('.tagsugg', box);
  const push = t => { t = t.trim(); if (!keepCase) t = L(t); else t = known.find(k => L(k) === L(t)) || t; if (t && !has(t)) tags.push(t); };
  const draw = () => {
    chips.innerHTML = tags.map((t, i) => `<button type="button" class="tagchip ${isKnown(t) ? '' : 'new'}" data-i="${i}" aria-label="Remove ${esc(t)}">${esc(t)}${isKnown(t) ? '' : ' <small>new</small>'} <span aria-hidden="true">✕</span></button>`).join('');
    const q = inp.value.trim().toLowerCase();
    let list, close = [];
    if (q) {
      list = known.filter(t => L(t).includes(q)).sort((a, b) => L(b).startsWith(q) - L(a).startsWith(q) || a.localeCompare(b));
      if (q.length >= 3) close = known.filter(t => !L(t).includes(q) && editDist(q, L(t)) <= (q.length > 5 ? 2 : 1));
    } else list = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    list = [...list, ...close].filter(t => !has(t)).slice(0, 12);
    sugg.innerHTML = (q && !list.length ? '' : `<span class="muted small">${q ? (close.length && !list.some(t => L(t).includes(q)) ? 'Did you mean' : `Your ${noun}s`) : list.length ? 'Most used' : `Start typing to see your ${noun}s`} </span>`)
      + list.map(t => `<button class="tag" data-add="${esc(t)}" type="button">+ ${esc(t)}</button>`).join('')
      + (q && !isKnown(q) && !has(q) ? `<button class="tag new" data-add="${esc(inp.value.trim())}" type="button">+ new ${noun} “${esc(inp.value.trim())}”</button>` : '');
  };
  chips.onclick = e => { const b = e.target.closest('[data-i]'); if (b) { tags.splice(Number(b.dataset.i), 1); draw(); } };
  sugg.onclick = e => { const b = e.target.closest('[data-add]'); if (b) { push(b.dataset.add); inp.value = ''; draw(); inp.focus(); } };
  inp.oninput = () => { if (inp.value.includes(',')) { const parts = inp.value.split(','); inp.value = parts.pop().trimStart(); parts.forEach(push); } draw(); };
  inp.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); push(inp.value); inp.value = ''; draw(); }
    else if (e.key === 'Backspace' && !inp.value && tags.length) { tags.pop(); draw(); }
  };
  draw();
  const get = () => { push(inp.value); inp.value = ''; return [...tags]; };
  get.add = t => { push(t); draw(); }; get.count = () => tags.length; get.clear = () => { tags.length = 0; draw(); };
  return get;
}
/* single-value field (brand, store, size, made in): tappable suggestions under it as you type,
   close spellings included; with the box empty, the most used values */
function suggestField(inp, values, used = []) {
  const box = document.createElement('div'); box.className = 'tagsugg sugg1'; inp.after(box);
  const n = {}; used.filter(Boolean).forEach(v => { n[v] = (n[v] || 0) + 1; });
  const all = [...new Set([...Object.keys(n), ...values.filter(Boolean)])];
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    let list = q ? all.filter(v => v.toLowerCase().includes(q) && v.toLowerCase() !== q).sort((a, b) => b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q) || (n[b] || 0) - (n[a] || 0) || a.localeCompare(b))
      : Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b));
    if (q.length >= 3 && list.length < 3) list = [...list, ...all.filter(v => !list.includes(v) && v.toLowerCase() !== q && editDist(q, v.toLowerCase()) <= (q.length > 5 ? 2 : 1))];
    box.innerHTML = list.slice(0, 6).map(v => `<button class="tag" data-v="${esc(v)}" type="button">${esc(v)}</button>`).join('');
  };
  box.onpointerdown = e => e.preventDefault();   // keep the keyboard up while tapping a suggestion
  box.onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; e.preventDefault(); inp.value = b.dataset.v; box.innerHTML = ''; inp.dispatchEvent(new Event('change')); };
  inp.addEventListener('input', draw); inp.addEventListener('focus', draw);
  inp.addEventListener('blur', () => setTimeout(() => { box.innerHTML = ''; }, 150));
}
function distinct(field) { return [...new Set(S.items.map(i => (i[field] || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
function allColours() { const s = new Set(PALETTE.map(p => p[0])); S.items.forEach(i => (i.colors || []).forEach(c => s.add(c))); return [...s].sort(); }

/* ---------- small renderers ---------- */
function thumb(item, cls = '') {
  if (!item) return `<div class="thumb ${cls}"><span class="ph">—</span></div>`;
  return `<div class="thumb ${cls}">${item.photo ? `<img src="${item.photo}" alt="" loading="lazy">` : `<span class="ph">${esc(initials(item.name))}</span>`}</div>`;
}
function photoThumb(src) { return `<div class="thumb">${src ? `<img src="${src}" alt="">` : '<span class="ph">—</span>'}</div>`; }
function statusBadge(st, item) {
  if (st.status === 'retired') return '<span class="badge ret">Retired</span>';
  if (st.status === 'resting') return `<span class="badge">Resting · ${prettyDate(st.restUntil).replace(/, \d{4}$/, '')}</span>`;
  if (st.lim && st.cycleWears >= num(st.lim.wears) - 1 && st.cycleWears > 0) return `<span class="badge near">${st.cycleWears}/${num(st.lim.wears)}</span>`;
  return '';
}
function itemCard(item, extra = '') {
  const st = stats(item); const days = Number(S.settings.recentDays) || 30;
  return `<button class="item" data-item="${item.id}" type="button">
    <div class="thumb">${item.photo ? `<img src="${item.photo}" alt="" loading="lazy">` : `<span class="ph">${esc(initials(item.name))}</span>`}${statusBadge(st, item)}</div>
    <div class="body"><div class="name">${esc(item.name || 'Untitled')}</div>
      <div class="meta">${esc([typeName(item.typeId), brandsOf(item).join(' / ')].filter(Boolean).join(' · '))}</div>
      <div class="nums">${st.total} wear${st.total === 1 ? '' : 's'} · ${st.recent} in ${days}d${st.cpw != null ? ' · ' + money(st.cpw) + '/wear' : ''}</div>${extra}
    </div></button>`;
}

/* ---------- modal ---------- */
/* top: open the sheet from the top of the screen, for sheets you type into (the iPhone keyboard covers the bottom) */
function openModal(html, mount, { top = false } = {}) {
  const m = $('#modal'); m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false; m.classList.toggle('attop', top);
  m.onclick = e => { if (e.target === m) closeModal(); };
  const sheet = m.firstElementChild; $$('[data-x]', sheet).forEach(b => b.onclick = closeModal);
  mount && mount(sheet); return sheet;
}
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; m.classList.remove('attop'); }
const head = title => `<div class="sheet-head"><h2>${esc(title)}</h2><button class="icon" data-x type="button" aria-label="Close">✕</button></div>`;
function twoStep(btn, label, fn) {
  btn.onclick = () => { if (btn.dataset.armed) return fn(); btn.dataset.armed = 1; const o = btn.textContent; btn.textContent = label; setTimeout(() => { delete btn.dataset.armed; btn.textContent = o; }, 3000); };
}

/* ---------- photos ---------- */
/* crop part of an image (rect in 0–1 fractions of its width/height) and scale it to an item photo */
function cropImage(src, rect = { x: 0, y: 0, w: 1, h: 1 }, max = 720) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const sx = rect.x * img.width, sy = rect.y * img.height, sw = rect.w * img.width, sh = rect.h * img.height, s = Math.min(1, max / Math.max(sw, sh));
      const c = document.createElement('canvas'); c.width = Math.round(sw * s); c.height = Math.round(sh * s);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => rej(new Error('Could not read that image'));
    img.src = src;
  });
}
function readImage(file, max = 720) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that image')); };
    img.src = url;
  });
}

/* ---------- navigation ---------- */
let tab = 'log';
const view = () => $('#view');
function go(t) {
  tab = t; $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  saveDock(null);
  ({ log: renderLog, closet: renderCloset, calendar: renderCalendar, settings: renderSettings })[t]();
  view().scrollTo(0, 0);
}
function refresh() { go(tab); }
/* Log's save bar, docked just above the tab bar while an outfit being built has items ("Jul 30 · 2 items  [Save outfit]").
   Its buttons press the form's own (hidden) buttons, so there's one set of handlers. null removes it. */
function saveDock(info) {
  let d = $('#savedock'); document.body.classList.toggle('docked', !!info);   // extra room at the bottom of the page while it shows
  if (!info) { if (d) d.remove(); return; }
  if (!d) { d = document.createElement('div'); d.id = 'savedock'; document.body.appendChild(d); }
  d.innerHTML = `<span class="small"><b>${esc(info.label)}</b> · ${info.count} item${info.count === 1 ? '' : 's'}</span><span class="row">${info.editing ? '<button class="ghost" data-dock="canceledit" type="button">Cancel</button>' : ''}<button class="primary" data-dock="saveentry" type="button">${esc(info.button)}</button></span>`;
  $$('[data-dock]', d).forEach(b => b.onclick = () => $(`[data-a=${b.dataset.dock}]`, view())?.click());
  const place = () => { const t = $('.tabs').getBoundingClientRect(); d.style.bottom = Math.round(innerHeight - t.top + 8) + 'px'; };
  place(); requestAnimationFrame(place);
}
addEventListener('resize', () => { const d = $('#savedock'); if (d) { const t = $('.tabs').getBoundingClientRect(); d.style.bottom = Math.round(innerHeight - t.top + 8) + 'px'; } });

/* ================= LOG ================= */
const slotName = typeId => groupKey(typeId).startsWith('g:') ? groupName(groupKey(typeId)) : typeName(typeId);
const logState = { date: today(), draft: null };
function newDraft(templateId) {
  const tpl = S.templates.find(t => t.id === templateId) || (templateId === '' ? null : S.templates[0]);
  return { templateId: tpl ? tpl.id : '', slots: tpl ? tpl.slots.map(typeId => ({ typeId, itemId: null })) : [], extra: [], noWear: false, editingId: null };
}
function dayCoverSrc(date) {
  const c = S.days[date]?.cover;
  if (c?.kind === 'photo') return c.data;
  if (c?.kind === 'item') { const it = itemById(c.itemId); if (it?.photo) return it.photo; }
  for (const e of S.entries.filter(e => e.date === date)) for (const id of e.itemIds) { const it = itemById(id); if (it?.photo) return it.photo; }
  return null;
}
function coverLabel(date) {
  const c = S.days[date]?.cover;
  if (c?.kind === 'photo') return 'Your photo';
  if (c?.kind === 'item') return itemById(c.itemId)?.name || 'Item';
  return 'Automatic (first item with a photo)';
}
function renderLog() {
  const d = logState.date, ents = S.entries.filter(e => e.date === d), future = d > today();
  const wornE = ents.filter(e => !e.planned), planE = ents.filter(e => e.planned);
  const overdue = S.entries.filter(e => e.planned && e.date < today()).map(e => e.date).sort();
  if (!logState.draft) logState.draft = newDraft();
  const dr = logState.draft;
  const slotHtml = (s, i) => {
    const it = itemById(s.itemId);
    return `<button class="slot ${it ? 'filled' : ''}" data-slot="${i}" type="button"><span class="st">${esc(slotName(s.typeId))}</span>${it ? thumb(it) : '<div class="thumb"><span class="ph">＋</span></div>'}<span>${it ? esc(it.name) : 'Choose'}</span></button>`;
  };
  const extraHtml = (id, i) => { const it = itemById(id); return `<button class="slot filled" data-extra="${i}" type="button"><span class="st">${esc(typeName(it?.typeId))}</span>${thumb(it)}<span>${esc(it?.name)}</span></button>`; };
  const chosen = [...dr.slots.map(s => s.itemId), ...dr.extra].filter(Boolean);
  const pairs = [];
  for (let a = 0; a < chosen.length; a++) for (let b = a + 1; b < chosen.length; b++) {
    const n = pairCount(chosen[a], chosen[b]); if (n) pairs.push(`<b>${esc(itemById(chosen[a]).name)}</b> + <b>${esc(itemById(chosen[b]).name)}</b>: ${n}×`);
  }
  view().innerHTML = `
    <section class="daybar"><button class="icon" data-a="prev" type="button" aria-label="Previous day">‹</button>
      <input type="date" id="logDate" value="${d}"><button class="icon" data-a="next" type="button" aria-label="Next day">›</button>
      <button class="ghost" data-a="today" type="button">Today</button></section>
    <div class="spread" style="margin:6px 2px 0"><span class="muted small">${longDate(d)}</span>
      ${S.locations.length ? `<label class="recent small muted" style="display:flex;gap:6px;align-items:center">Dressing at <select id="logLoc" style="width:auto;padding:5px 8px"><option value="">Anywhere</option>${S.locations.map(l => `<option value="${l.id}" ${l.id === S.settings.logLocation ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` : ''}</div>
    <section class="card daycover">${photoThumb(dayCoverSrc(d))}<div class="grow"><div class="label">Day cover</div><div class="muted small">${esc(coverLabel(d))}</div></div>
      <button class="ghost" data-a="cover" type="button">Change</button></section>
    ${overdue.length && d === today() ? `<section class="card spread" style="margin-top:12px"><span class="small">${overdue.length} past plan${overdue.length > 1 ? 's' : ''} not marked as worn yet</span><button class="ghost" data-a="overdue" type="button">Review</button></section>` : ''}
    ${planE.length ? `<h2>Planned</h2>${planE.map(e => `<section class="card entry plan"><div class="spread"><div class="label">${esc(S.templates.find(t => t.id === e.templateId)?.name || 'Outfit')} <span class="muted small">· planned</span></div>
        <div class="row">${future ? '' : `<button class="primary" data-wore="${e.id}" type="button">Wore it</button>`}<button class="ghost" data-edit="${e.id}" type="button">Edit</button><button class="danger" data-del="${e.id}" type="button">Delete</button></div></div>
        <div class="pieces">${e.itemIds.map(id => { const it = itemById(id); return it ? `<div class="piece">${thumb(it)}<span>${esc(it.name)}</span></div>` : ''; }).join('')}</div></section>`).join('')}` : ''}
    ${future ? (planE.length ? '' : '<h2>Nothing planned yet</h2>') + '<p class="help">Planned outfits don’t count as wears. On the day, open it here and tap “Wore it”.</p>' : `<h2>${wornE.length ? 'Worn this day' : 'Nothing logged this day'}</h2>`}
    ${wornE.map(e => `<section class="card entry"><div class="spread"><div class="label">${esc(S.templates.find(t => t.id === e.templateId)?.name || 'Outfit')}</div>
        <div class="row"><button class="ghost" data-edit="${e.id}" type="button">Edit</button><button class="danger" data-del="${e.id}" type="button">Delete</button></div></div>
        <div class="pieces">${e.itemIds.map(id => { const it = itemById(id); if (!it) return ''; const f = e.fits?.[id]; return `<button class="piece" data-fit="${id}" data-entry="${e.id}" type="button">${thumb(it)}<span>${esc(it.name)}</span>${(e.noWear || []).includes(id) ? '<span class="nowear">not counted</span>' : ''}<span class="fit ${f?.r ? 'f-' + f.r : ''}">${f?.r ? esc(fitLabel(f.r)) : 'Rate fit'}</span></button>`; }).join('')}</div></section>`).join('')}
    <h2>${dr.editingId ? (planE.some(e => e.id === dr.editingId) ? 'Edit plan' : 'Edit outfit') : future ? 'Plan an outfit' : 'Log an outfit'}</h2>
    <section class="card">
      <label class="field"><span>Template</span><select id="tpl">${S.templates.map(t => `<option value="${t.id}" ${t.id === dr.templateId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}<option value="" ${!dr.templateId ? 'selected' : ''}>No template</option></select></label>
      <div class="slots">${dr.slots.map(slotHtml).join('')}${dr.extra.map(extraHtml).join('')}<button class="slot add" data-a="addextra" type="button">＋ Add item</button></div>
      ${pairs.length ? `<div class="pairs">Worn together before: ${pairs.join(' · ')}</div>` : ''}
      ${future ? '' : `<label class="check small" style="margin-top:10px"><input type="checkbox" id="noWear" ${dr.noWear ? 'checked' : ''}> Don’t count as a wear (still shows on the calendar)</label>`}
      <div class="row end savebar ${chosen.length ? 'docked' : ''}">${dr.editingId ? '<button class="ghost" data-a="canceledit" type="button">Cancel</button>' : ''}<button class="primary" data-a="saveentry" type="button">${dr.editingId ? 'Save changes' : future ? 'Save plan' : 'Save outfit'}</button></div>
    </section>`;
  saveDock(chosen.length ? { label: d === today() ? 'Today' : prettyDate(d).replace(/, \d{4}$/, ''), count: chosen.length, editing: !!dr.editingId,
    button: dr.editingId ? 'Save changes' : future ? 'Save plan' : 'Save outfit' } : null);
  const v = view();
  const setDate = nd => { logState.date = nd; if (!logState.draft.editingId) logState.draft = newDraft(logState.draft.templateId); renderLog(); };
  $('#logDate', v).onchange = e => e.target.value && setDate(e.target.value);
  $('[data-a=prev]', v).onclick = () => setDate(addDays(d, -1));
  $('[data-a=next]', v).onclick = () => setDate(addDays(d, 1));
  $('[data-a=today]', v).onclick = () => setDate(today());
  $('[data-a=cover]', v).onclick = () => chooseCover(d);
  const ll = $('#logLoc', v); if (ll) ll.onchange = async () => { S.settings.logLocation = ll.value; await save(); };
  $$('[data-fit]', v).forEach(b => b.onclick = () => openFit({ itemId: b.dataset.fit, entryId: b.dataset.entry }));
  $('#tpl', v).onchange = e => { const keepEdit = dr.editingId; logState.draft = newDraft(e.target.value); logState.draft.editingId = keepEdit; renderLog(); };
  $$('[data-slot]', v).forEach(b => b.onclick = () => {
    const s = dr.slots[b.dataset.slot];
    pick({ typeId: s.typeId, title: 'Choose ' + slotName(s.typeId).toLowerCase(), current: s.itemId, date: d }, id => { s.itemId = id; renderLog(); });
  });
  $$('[data-extra]', v).forEach(b => b.onclick = () => { dr.extra.splice(Number(b.dataset.extra), 1); renderLog(); toast('Removed from outfit'); });
  $('[data-a=addextra]', v).onclick = () => pick({ typeId: null, title: 'Add an item', date: d }, id => { if (id && !chosen.includes(id)) dr.extra.push(id); renderLog(); });
  const ce = $('[data-a=canceledit]', v); if (ce) ce.onclick = () => { logState.draft = newDraft(); renderLog(); };
  $('[data-a=saveentry]', v).onclick = async () => {
    const ids = [...new Set([...dr.slots.map(s => s.itemId), ...dr.extra].filter(Boolean))];
    if (!ids.length) return toast('Pick at least one item');
    const nw = $('#noWear', v)?.checked;
    if (dr.editingId) {
      const e = S.entries.find(x => x.id === dr.editingId);
      // the box covers the whole outfit; leaving it unticked keeps any single pieces marked from the day's view
      Object.assign(e, { templateId: dr.templateId, slots: dr.slots.map(s => ({ ...s })), itemIds: ids, noWear: nw ? ids : (e.noWear || []).filter(id => ids.includes(id) && !dr.noWear) });
    } else S.entries.push({ id: uid(), date: d, templateId: dr.templateId, slots: dr.slots.map(s => ({ ...s })), itemIds: ids, ...(nw ? { noWear: ids } : {}), created: Date.now(), ...(future ? { planned: true } : {}) });
    const wasEdit = !!dr.editingId;
    logState.draft = newDraft(dr.templateId); await save('entries'); renderLog();
    toast(wasEdit ? 'Outfit updated' : future ? 'Plan saved' : 'Outfit saved');
    if (!future && !nw) restToast(ids, d);
  };
  $$('[data-wore]', v).forEach(b => b.onclick = async () => {
    const e = S.entries.find(x => x.id === b.dataset.wore); delete e.planned;
    await save('entries'); renderLog(); toast('Marked as worn'); restToast(e.itemIds, e.date);
  });
  const od = $('[data-a=overdue]', v); if (od) od.onclick = () => setDate(overdue[0]);
  function restToast(ids, d) {
    const rested = ids.map(itemById).filter(i => { const st = stats(i); return st.resting && st.dates[st.dates.length - 1] === d && st.restUntil > d; });
    if (rested.length) setTimeout(() => toast(`${rested.map(i => i.name).join(', ')} hit its wear limit and is now resting`), 2700);
  }
  $$('[data-edit]', v).forEach(b => b.onclick = () => {
    const e = S.entries.find(x => x.id === b.dataset.edit);
    const tpl = S.templates.find(t => t.id === e.templateId);
    const slots = (e.slots && e.slots.length) ? e.slots.map(s => ({ ...s })) : (tpl ? tpl.slots.map(typeId => ({ typeId, itemId: null })) : []);
    const inSlots = new Set(slots.map(s => s.itemId));
    logState.draft = { templateId: e.templateId || '', slots, extra: e.itemIds.filter(id => !inSlots.has(id)), noWear: e.itemIds.every(id => (e.noWear || []).includes(id)), editingId: e.id };
    renderLog(); $('#tpl').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $$('[data-del]', v).forEach(b => twoStep(b, 'Tap to confirm', async () => {
    S.entries = S.entries.filter(x => x.id !== b.dataset.del); await save('entries'); renderLog(); toast('Outfit deleted');
  }));
}

function chooseCover(date) {
  const worn = [...new Set(S.entries.filter(e => e.date === date).flatMap(e => e.itemIds))].map(itemById).filter(Boolean);
  openModal(`${head('Cover for ' + prettyDate(date))}
    <p class="muted small">Pick an item you wore, or use your own photo (like a mirror shot).</p>
    <div class="grid">${worn.map(i => itemCard(i)).join('') || '<div class="empty">Log an outfit for this day to pick one of its items.</div>'}</div>
    <div class="row end"><button class="ghost" data-a="auto" type="button">Automatic</button>
      <label class="primary" style="border-radius:10px;padding:9px 14px;cursor:pointer;background:var(--accent);color:var(--accent-fg)">Upload photo<input type="file" accept="image/*" id="coverFile" hidden></label></div>`, sh => {
    const set = async cover => { S.days[date] = { ...(S.days[date] || {}), cover }; if (!cover) delete S.days[date].cover; await save('days'); closeModal(); refresh(); };
    $$('[data-item]', sh).forEach(b => b.onclick = () => set({ kind: 'item', itemId: b.dataset.item }));
    $('[data-a=auto]', sh).onclick = () => set(null);
    $('#coverFile', sh).onchange = async e => { const f = e.target.files[0]; if (!f) return; try { set({ kind: 'photo', data: await readImage(f, 900) }); } catch (err) { toast(err.message); } };
  });
}

/* item picker (used by the outfit builder) */
function pick({ typeId, title, current, date }, cb) {
  let showAll = false, q = '', typeFilter = typeId, here = !!S.settings.logLocation;
  openModal(`${head(title)}
    ${typeId ? '' : `<div class="chips" id="pkChips"></div>`}
    <input type="search" id="pkQ" placeholder="Search name, brand, tag" enterkeyhint="go">
    <label class="check" style="margin:8px 0 2px"><input type="checkbox" id="pkAll"> Show resting and retired items</label>
    ${S.settings.logLocation ? `<label class="check" style="margin:2px 0 8px"><input type="checkbox" id="pkHere" checked> Only items at ${esc(locName(S.settings.logLocation))}</label>` : ''}
    <div class="grid" id="pkGrid"></div>
    <div class="row end">${current ? '<button class="ghost" data-a="none" type="button">Clear slot</button>' : ''}<button class="ghost" data-a="new" type="button">＋ New item</button></div>`, sh => {
    const drawChips = () => {
      const c = $('#pkChips', sh); if (!c) return;
      c.innerHTML = [`<button class="chip ${!typeFilter ? 'on' : ''}" data-t="" type="button">All</button>`, ...S.types.map(t => `<button class="chip ${typeFilter === t.id ? 'on' : ''}" data-t="${t.id}" type="button">${esc(t.name)}</button>`)].join('');
      $$('[data-t]', c).forEach(b => b.onclick = () => { typeFilter = b.dataset.t || null; drawChips(); draw(); });
    };
    const draw = () => {
      let items = S.items.filter(i => !typeFilter || (typeId && typeFilter === typeId ? groupKey(i.typeId) === groupKey(typeId) : i.typeId === typeFilter));
      if (!showAll) items = items.filter(i => statusOn(i, date || today()) === 'active');
      if (here) items = items.filter(i => i.location === S.settings.logLocation);
      if (q) items = items.filter(i => matchQ(i, q));
      // least recently worn first, so the rotation stays even
      items.sort((a, b) => (stats(a).last || '').localeCompare(stats(b).last || '') || a.name.localeCompare(b.name));
      $('#pkGrid', sh).innerHTML = items.map(i => { const fs = fitSummary(i.id); return itemCard(i, `<div class="meta">Last worn ${stats(i).last ? prettyDate(stats(i).last) : 'never'}</div>${fs ? `<div class="meta">Fit: ${esc(fitLabel(fs.last.r))}</div>` : ''}`); }).join('')
        || `<div class="empty">No ${showAll ? '' : 'available '}items${typeFilter ? ' of this type' : ''} yet.</div>`;
      $$('[data-item]', sh).forEach(b => b.onclick = () => { closeModal(); cb(b.dataset.item); });
    };
    $('#pkQ', sh).oninput = e => { q = e.target.value.trim().toLowerCase(); draw(); };
    // return on the keyboard picks the first match
    $('#pkQ', sh).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); const first = $('#pkGrid [data-item]', sh); if (first) first.click(); } };
    $('#pkAll', sh).onchange = e => { showAll = e.target.checked; draw(); };
    const ph = $('#pkHere', sh); if (ph) ph.onchange = e => { here = e.target.checked; draw(); };
    const none = $('[data-a=none]', sh); if (none) none.onclick = () => { closeModal(); cb(null); };
    $('[data-a=new]', sh).onclick = () => openEditor(null, { typeId: typeFilter, onSave: id => cb(id) });
    drawChips(); draw();
  }, { top: true });
}
const matchQ = (i, q) => [i.name, ...brandsOf(i), i.store, i.size, locName(i.location), typeName(i.typeId), ...(i.tags || []), ...(i.colors || []), ...(i.materials || []), i.madeIn].join(' ').toLowerCase().includes(q);

/* ================= CLOSET ================= */
const closet = { chip: 'all', q: '', sort: 'last', status: 'active', loc: '', fit: '', photo: '' };
function matchChip(item, chip) {
  if (chip === 'all') return true;
  if (chip.startsWith('t:')) return item.typeId === chip.slice(2);
  const f = S.filters.find(x => 'f:' + x.id === chip); if (!f) return true;
  const typeOk = !f.typeIds?.length || f.typeIds.includes(item.typeId);
  const tagOk = !f.tags?.length || f.tags.some(t => (item.tags || []).includes(t));
  return typeOk && tagOk;
}
function renderCloset() {
  const days = Number(S.settings.recentDays) || 30;
  if (closet.chip !== 'all' && !closet.chip.startsWith('t:') && !S.filters.some(f => 'f:' + f.id === closet.chip)) closet.chip = 'all';
  const chips = [{ id: 'all', name: 'All' }, ...S.filters.map(f => ({ id: 'f:' + f.id, name: f.name })), ...S.types.map(t => ({ id: 't:' + t.id, name: t.name }))];
  view().innerHTML = `
    <div class="chips" id="chips">${chips.map(c => `<button class="chip ${closet.chip === c.id ? 'on' : ''}" data-c="${c.id}" type="button">${esc(c.name)}</button>`).join('')}
      <button class="chip add" data-a="newfilter" type="button">＋ Filter</button></div>
    <button class="ghost laundrybtn" data-a="laundry" type="button">🧺 Laundry check: pack it or put it away?</button>
    <div class="toolbar">
      <input class="q" type="search" id="cq" placeholder="Search name, brand, store, tag" value="${esc(closet.q)}">
      <select id="cstatus" aria-label="Status">
        ${[['active', 'Available'], ['resting', 'Resting'], ['retired', 'Retired'], ['owned', 'All owned'], ['any', 'Everything']].map(([v, l]) => `<option value="${v}" ${closet.status === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <select id="csort" aria-label="Sort">
        ${[['last', 'Last worn'], ['least', 'Longest since worn'], ['most', 'Most worn'], ['fewest', 'Fewest wears'], ['recent', `Most worn in ${days}d`], ['cpw', 'Cost per wear'], ['name', 'Name'], ['added', 'Recently added']].map(([v, l]) => `<option value="${v}" ${closet.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="toolbar" style="grid-template-columns:1fr 1fr">
      <select id="cloc" aria-label="Location"><option value="">Any location</option>${S.locations.map(l => `<option value="${l.id}" ${closet.loc === l.id ? 'selected' : ''}>At ${esc(l.name)}</option>`).join('')}<option value="none" ${closet.loc === 'none' ? 'selected' : ''}>Location not set</option></select>
      <select id="cfit" aria-label="Fit">${[['', 'Any fit'], ['tight', 'Last fit: tight'], ['good', 'Last fit: just right'], ['loose', 'Last fit: loose'], ['unrated', 'Fit not rated']].map(([v, l]) => `<option value="${v}" ${closet.fit === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="cphoto" aria-label="Photo">${[['', 'Any photo'], ['none', 'No photo'], ['has', 'Has photo']].map(([v, l]) => `<option value="${v}" ${closet.photo === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="spread" style="margin:4px 0 10px"><span class="muted small" id="ccount"></span>
      <span class="toolbar" style="margin:0;display:flex"><span class="recent">Worn in past <input type="number" min="1" id="cdays" value="${days}"> days</span></span></div>
    <div class="grid" id="cgrid"></div>
    <button class="primary fab" data-a="add" type="button">＋ Add item</button>`;
  const v = view();
  const draw = () => {
    let items = S.items.filter(i => matchChip(i, closet.chip));
    const st = new Map(items.map(i => [i.id, stats(i)]));
    if (closet.status === 'owned') items = items.filter(i => !i.retired);
    else if (closet.status !== 'any') items = items.filter(i => st.get(i.id).status === closet.status);
    if (closet.q) items = items.filter(i => matchQ(i, closet.q));
    if (closet.loc) items = items.filter(i => closet.loc === 'none' ? !i.location : i.location === closet.loc);
    if (closet.photo) items = items.filter(i => closet.photo === 'none' ? !i.photo : !!i.photo);
    if (closet.fit) items = items.filter(i => { const f = fitSummary(i.id); if (closet.fit === 'unrated') return !f; if (!f) return false; const sc = fitScore(f.last.r); return closet.fit === 'tight' ? sc < 0 : closet.fit === 'loose' ? sc > 0 : sc === 0; });
    const by = {
      last: (a, b) => (st.get(b.id).last || '').localeCompare(st.get(a.id).last || ''),
      least: (a, b) => (st.get(a.id).last || '').localeCompare(st.get(b.id).last || ''),
      most: (a, b) => st.get(b.id).total - st.get(a.id).total,
      fewest: (a, b) => st.get(a.id).total - st.get(b.id).total,
      recent: (a, b) => st.get(b.id).recent - st.get(a.id).recent,
      cpw: (a, b) => (st.get(b.id).cpw ?? -1) - (st.get(a.id).cpw ?? -1),
      name: (a, b) => a.name.localeCompare(b.name),
      added: (a, b) => (b.created || 0) - (a.created || 0)
    }[closet.sort];
    items.sort((a, b) => by(a, b) || a.name.localeCompare(b.name));
    $('#ccount', v).textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
    $('#cgrid', v).innerHTML = items.map(i => itemCard(i)).join('') ||
      `<div class="empty">${S.items.length ? 'Nothing matches this view.' : 'No items yet. Add your first piece below.'}</div>`;
    $$('[data-item]', v).forEach(b => b.onclick = () => openDetail(b.dataset.item));
  };
  $$('[data-c]', v).forEach(b => b.onclick = () => { closet.chip = b.dataset.c; renderCloset(); });
  $('[data-a=newfilter]', v).onclick = () => editFilter(null);
  $('#cq', v).oninput = e => { closet.q = e.target.value.trim().toLowerCase(); draw(); };
  $('#cstatus', v).onchange = e => { closet.status = e.target.value; draw(); };
  $('#csort', v).onchange = e => { closet.sort = e.target.value; draw(); };
  $('#cloc', v).onchange = e => { closet.loc = e.target.value; draw(); };
  $('#cfit', v).onchange = e => { closet.fit = e.target.value; draw(); };
  $('#cphoto', v).onchange = e => { closet.photo = e.target.value; draw(); };
  $('#cdays', v).onchange = async e => { const n = Math.max(1, parseInt(e.target.value) || 30); S.settings.recentDays = n; await save(); renderCloset(); };
  $('[data-a=laundry]', v).onclick = openLaundry;
  $('[data-a=add]', v).onclick = () => openEditor(null, { typeId: closet.chip.startsWith('t:') ? closet.chip.slice(2) : null });
  draw();
}

/* Laundry check: look up clothes coming out of the wash and see whether each one is resting (pack it) or can go back
   in the drawer. Starts with what was worn in the last two weeks; search covers everything, resting and retired too. */
function laundryVerdict(it) {
  const st = stats(it);
  if (st.status === 'retired') return { cls: 'ret', text: 'Retired', sub: 'gone for good' };
  if (st.status === 'resting') return { cls: 'pack', text: '🧳 Pack it', sub: `resting until ${prettyDate(st.restUntil).replace(/, \d{4}$/, '')}` };
  if (st.lim) { const left = num(st.lim.wears) - st.cycleWears;
    return { cls: 'drawer', text: 'Drawer', sub: left <= 1 ? 'last wear before it rests' : `${st.cycleWears} of ${num(st.lim.wears)} wears this cycle` }; }
  return { cls: 'drawer', text: 'Drawer', sub: 'no wear limit' };
}
function openLaundry() {
  openModal(`${head('Laundry check')}
    <input type="search" id="lq" placeholder="Search name, brand, tag" enterkeyhint="search">
    <div class="muted small" id="lnote" style="margin:8px 2px"></div>
    <ul class="list laundry" id="llist"></ul>`, sh => {
    const draw = () => {
      const q = $('#lq', sh).value.trim().toLowerCase(), since = addDays(today(), -14);
      const items = q ? S.items.filter(i => matchQ(i, q)).sort((a, b) => a.name.localeCompare(b.name))
        : S.items.filter(i => (stats(i).last || '') >= since).sort((a, b) => (stats(b).last || '').localeCompare(stats(a).last || ''));
      $('#lnote', sh).textContent = q ? `${items.length} match${items.length === 1 ? '' : 'es'}` : 'Worn in the last two weeks, newest first. Search for anything else.';
      $('#llist', sh).innerHTML = items.slice(0, 60).map(i => { const v = laundryVerdict(i);
        return `<li data-lid="${i.id}">${thumb(i)}<div class="grow"><div>${esc(i.name)}</div><div class="muted small">${esc([typeName(i.typeId), stats(i).last ? 'worn ' + prettyDate(stats(i).last).replace(/, \d{4}$/, '') : ''].filter(Boolean).join(' · '))}</div>
          <select class="lloc" data-lloc="${i.id}" aria-label="Kept at">${locOptions(i.location).replace('>Not set<', '>Kept at: not set<')}</select></div>
          <div class="verdict ${v.cls}"><b>${v.text}</b><span>${esc(v.sub)}</span></div></li>`; }).join('') || '<li class="muted small">Nothing found.</li>';
      $$('[data-lloc]', sh).forEach(sel => wireLocSelect(sel, async val => { const it = itemById(sel.dataset.lloc); it.location = val; await save('items'); toast(val ? `${it.name}: kept at ${locName(val)}` : 'Location cleared'); }));
    };
    $('#lq', sh).oninput = draw; draw();
  }, { top: true });
}

/* item detail */
function openDetail(id, range = { from: '', to: '' }) {
  const it = itemById(id); if (!it) return;
  const st = stats(it), days = Number(S.settings.recentDays) || 30;
  const cb = combos(id, range.from, range.to);
  const groups = {}; cb.forEach(c => { (groups[c.item.typeId] ||= []).push(c); });
  const limTxt = st.lim ? `Wear ${num(st.lim.wears)}× then rest ${num(st.lim.restMonths) || 0} mo${it.limit && num(it.limit.wears) ? '' : ' (type default)'}` : 'No wear limit';
  const rotTxt = st.status === 'retired' ? 'Retired' : st.resting ? `Resting until ${prettyDate(st.restUntil)}` : st.lim ? `${st.cycleWears} of ${num(st.lim.wears)} wears this cycle` : 'Available';
  openModal(`${head(it.name || 'Item')}
    <div class="detail-top">${thumb(it)}<div class="stack" style="gap:4px">
      <div class="muted small">${esc([typeName(it.typeId), it.size, brandsOf(it).join(' / '), it.store].filter(Boolean).join(' · '))}</div>
      ${(it.colors || []).length ? `<div class="small">${esc(it.colors.join(', '))}</div>` : ''}
      ${(it.materials || []).length || it.madeIn ? `<div class="small">${esc([(it.materials || []).join(', '), it.madeIn && 'made in ' + it.madeIn].filter(Boolean).join(' · '))}</div>` : ''}
      ${/^https?:\/\//i.test(it.link || '') ? `<a class="small" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">Open link ↗</a>` : ''}
      <div>${(it.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <label class="small muted" style="display:flex;gap:6px;align-items:center">Kept at <select id="dLoc" style="width:auto;padding:4px 8px">${locOptions(it.location)}</select></label>
      <div class="small">${effPrice(it) != null ? `Paid ${money(effPrice(it))}${num(it.discountPrice) != null && num(it.price) != null ? ` <span class="muted">(list ${money(num(it.price))})</span>` : ''}` : '<span class="muted">No price yet</span>'}${it.purchaseDate ? ` · bought ${prettyDate(it.purchaseDate)}` : ''}</div>
      <div class="small">${esc(limTxt)}</div><div class="small"><b>${esc(rotTxt)}</b>${nextPlan(id) ? ` · planned for ${prettyDate(nextPlan(id))}` : ''}</div>
      ${it.notes ? `<div class="small muted">${esc(it.notes)}</div>` : ''}
    </div></div>
    <div class="statgrid">
      <div class="stat"><div class="k">Total wears</div><div class="v">${st.total}</div></div>
      <div class="stat"><div class="k">Tracked</div><div class="v">${st.tracked}</div></div>
      <div class="stat"><div class="k">Estimated before</div><div class="v">${st.est}</div></div>
      <div class="stat"><div class="k">Past ${days} days</div><div class="v">${st.recent}</div></div>
      <div class="stat"><div class="k">Cost per wear</div><div class="v">${money(st.cpw)}</div></div>
      <div class="stat"><div class="k">Last worn</div><div class="v" style="font-size:15px">${st.last ? prettyDate(st.last) : 'Never'}</div></div>
    </div>
    <div class="row end"><button class="ghost" data-a="edit" type="button">Edit</button><button class="primary" data-a="wore" type="button">Wore it today</button></div>
    <h2>Fit</h2>
    ${(() => { const fs = fitSummary(id), h = fitHistory(id).reverse();
      return (fs ? `<p class="small" style="margin:0 0 6px">Latest: <b class="fit f-${fs.last.r}">${esc(fitLabel(fs.last.r))}</b> on ${prettyDate(fs.last.date)}${fs.trend ? ` · recent fits are ${fs.trend}` : ''}</p>
        <ul class="list">${h.slice(0, 12).map(f => `<li ${f.kind === 'wear' ? `data-fe="${f.entryId}"` : `data-ft="${f.id}"`} style="grid-template-columns:90px 1fr auto"><span class="small">${prettyDate(f.date)}</span><span class="small">${esc(f.note) || '<span class="muted">' + (f.kind === 'try-on' ? 'Try-on' : 'Worn') + '</span>'}</span><b class="fit f-${f.r}">${esc(fitLabel(f.r))}</b></li>`).join('')}</ul>`
        : '<p class="muted small">No fit notes yet. Tap an item in a logged outfit to rate the fit, or record a try-on.</p>') + '<div class="row end" style="margin-top:8px"><button class="ghost" data-a="tryon" type="button">Record a try-on</button></div>';
    })()}
    <h2>Worn with</h2>
    <div class="fields"><label class="field"><span>From</span><input type="date" id="cbFrom" value="${range.from}"></label><label class="field"><span>To</span><input type="date" id="cbTo" value="${range.to}"></label></div>
    ${cb.length ? Object.entries(groups).map(([tid, list]) => `<h2 style="margin-top:14px">${esc(typeName(tid))}</h2><ul class="list">${list.map(c => `<li data-item="${c.item.id}">${thumb(c.item)}<div class="grow"><div>${esc(c.item.name)}</div><div class="muted small">last together ${prettyDate(c.last)}</div></div><b>${c.n}×</b></li>`).join('')}</ul>`).join('')
      : '<p class="muted small">No pairings logged in this range.</p>'}
    <h2>Wear history</h2>
    ${st.dates.length ? `<div class="hist">${[...st.dates].reverse().map(prettyDate).join('<br>')}</div>` : '<p class="muted small">No tracked wears yet.</p>'}`, sh => {
    $('[data-a=edit]', sh).onclick = () => openEditor(it);
    wireLocSelect($('#dLoc', sh), async v => { it.location = v; await save('items'); toast(it.location ? 'Now kept at ' + locName(it.location) : 'Location cleared'); if (tab === 'closet') refresh(); });
    $('[data-a=tryon]', sh).onclick = () => openFit({ itemId: id });
    $$('[data-fe]', sh).forEach(li => li.onclick = () => openFit({ itemId: id, entryId: li.dataset.fe }));
    $$('[data-ft]', sh).forEach(li => li.onclick = () => openFit({ itemId: id, tryOnId: li.dataset.ft }));
    $('[data-a=wore]', sh).onclick = async () => {
      const t = today(), ents = worn().filter(e => e.date === t);
      if (ents.length) { const e = ents[ents.length - 1]; if (!e.itemIds.includes(id)) e.itemIds.push(id); }
      else S.entries.push({ id: uid(), date: t, templateId: '', slots: [], itemIds: [id], created: Date.now() });
      await save('entries'); toast(ents.length ? 'Added to today’s outfit' : 'Logged for today'); openDetail(id, range); if (tab !== 'settings') refresh();
    };
    const upd = () => openDetail(id, { from: $('#cbFrom', sh).value, to: $('#cbTo', sh).value });
    $('#cbFrom', sh).onchange = upd; $('#cbTo', sh).onchange = upd;
    $$('[data-item]', sh).forEach(li => li.onclick = () => openDetail(li.dataset.item));
  });
}

/* item editor */
function openEditor(item, { typeId = null, onSave } = {}) {
  const isNew = !item;
  const startType = typeId || S.types[0]?.id;
  const it = item ? { ...item } : { id: uid(), name: '', typeId: startType, brands: [], store: '', size: sizeFor(startType), colors: [], location: S.settings.logLocation || '', tags: [], materials: [], madeIn: '', link: '', price: '', discountPrice: '', purchaseDate: '', estWears: '', limit: null, notes: '', retired: false, photo: null, tryOns: [], created: Date.now() };
  let photo = it.photo, typeTouched = !isNew || !!typeId;
  openModal(`${head(isNew ? 'New item' : 'Edit item')}
    <div class="photo-in"><div id="edPhoto">${photoThumb(photo)}</div><div class="stack" style="gap:6px">
      <label class="ghost" style="border:1px solid var(--line);border-radius:10px;padding:9px 14px;cursor:pointer;text-align:center;background:var(--surface)">${photo ? 'Change photo' : 'Add photo'}<input type="file" accept="image/*" id="edFile" hidden></label>
      <button class="ghost" data-a="nophoto" type="button" ${photo ? '' : 'hidden'}>Remove photo</button></div></div>
    <div class="fields" style="margin-top:12px">
      <div class="full row"><label class="ghost" style="border:1px solid var(--line);border-radius:10px;padding:9px 14px;cursor:pointer;background:var(--surface)">Read screenshots<input type="file" accept="image/*" id="fShots" multiple hidden></label><span class="muted small grow" id="shotMsg">A store page or receipt. Pick several for a long page.</span></div>
      <div class="full" id="shotOut"></div>
      <label class="field full"><span>Store link (optional)</span><input id="fFromLink" type="url" inputmode="url" autocomplete="off" placeholder="Paste a product page link to fill in what it can"></label>
      <label class="field full"><span>Name</span><input id="fName" value="${esc(it.name)}" placeholder="e.g. Navy dot oxford" autocomplete="off"></label>
      <div class="full" id="edSugg"></div>
      <label class="field"><span>Type</span><select id="fType">${S.types.map(t => `<option value="${t.id}" ${t.id === it.typeId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Size</span><input id="fSize" autocomplete="off" value="${esc(it.size)}" placeholder="${esc(sizeFor(it.typeId) || 'e.g. XL')}"></label>

      <label class="field"><span>Store purchased</span><input id="fStore" autocomplete="off" value="${esc(it.store)}"></label>
      <div class="field full"><span>Brands</span><div id="fBrands"></div></div>
      <div class="field full"><span>Colours</span><div id="fColors"></div></div>
      <div class="full tagsugg" id="colSugg"></div>
      <div class="field full"><span>Materials</span><div id="fMats"></div></div>
      <label class="field full"><span>Made in</span><input id="fMade" value="${esc(it.madeIn || '')}" placeholder="e.g. Honduras" autocomplete="off"></label>
      <label class="field"><span>Kept at</span><select id="fLoc">${locOptions(it.location)}</select></label>
      <label class="field"><span>Purchase date</span><input type="date" id="fDate" value="${esc(it.purchaseDate)}"></label>
      <label class="field"><span>Purchase price ($)</span><input type="number" step="0.01" min="0" id="fPrice" value="${esc(it.price)}"></label>
      <label class="field"><span>Discount price paid ($)</span><input type="number" step="0.01" min="0" id="fDisc" value="${esc(it.discountPrice)}"></label>
      <div class="field full"><span>Tags</span><div id="fTags"></div></div>
      <label class="field full"><span>Estimated wears before you started tracking</span><input type="number" min="0" step="1" id="fEst" value="${esc(it.estWears)}" placeholder="0"></label>
      <label class="field"><span>Wear limit (wears)</span><input type="number" min="1" step="1" id="fLimW" value="${esc(it.limit?.wears ?? '')}" placeholder="type default"></label>
      <label class="field"><span>Then rest (months)</span><input type="number" min="0" step="1" id="fLimM" value="${esc(it.limit?.restMonths ?? '')}" placeholder="type default"></label>
      <label class="field full"><span>Link (product page, old app…)</span><input id="fLink" type="url" inputmode="url" value="${esc(it.link || '')}" placeholder="https://"></label>
      <label class="field full"><span>Notes</span><textarea id="fNotes">${esc(it.notes)}</textarea></label>
      <label class="check full"><input type="checkbox" id="fRet" ${it.retired ? 'checked' : ''}> Retired: gone for good (given away, worn out). Not the same as resting after a wear limit.</label>
    </div>
    <p class="help">Estimated wears count toward total wears${S.settings.cpwIncludesEstimate ? ' and cost per wear' : ''}. They never change your tracked history, recent-day counts or wear limits.</p>
    <div class="row end sheetbar">${isNew ? '' : '<button class="danger" data-a="del" type="button">Delete</button>'}<button class="ghost" data-x type="button">Cancel</button><button class="primary" data-a="save" type="button">Save</button></div>`, sh => {
    $$('[data-x]', sh).forEach(b => b.onclick = closeModal);
    const typeSel = $('#fType', sh), sizeIn = $('#fSize', sh), nameIn = $('#fName', sh);
    const cols = tagField($('#fColors', sh), it.colors || [], { field: 'colors', extra: allColours(), noun: 'colour' });
    const field = f => S.items.map(i => (i[f] || '').trim());
    const brands = tagField($('#fBrands', sh), brandsOf(it), { noun: 'brand', keepCase: true, extra: [], values: brandsOf });
    suggestField($('#fStore', sh), S.purchases.map(p => p.retailer.replace(/\s*\((in-store|online)\)\s*$/i, '')), field('store'));
    suggestField(sizeIn, S.types.map(t => t.defaultSize), field('size'));
    suggestField($('#fMade', sh), COUNTRIES, field('madeIn'));
    const showColours = (found, note) => {
      const box = $('#colSugg', sh);
      box.innerHTML = (note ? `<span class="muted small">${esc(note)} </span>` : '') + found.map(c => `<button class="tag" data-col="${esc(c)}" type="button">+ ${esc(c)}</button>`).join('');
      $$('[data-col]', box).forEach(b => b.onclick = () => cols.add(b.dataset.col));
    };
    const setType = id => {
      const oldDef = sizeFor(typeSel.value);
      typeSel.value = id;
      if (!sizeIn.value || sizeIn.value === oldDef) sizeIn.value = sizeFor(id);
      sizeIn.placeholder = sizeFor(id) || 'e.g. XL';
    };
    typeSel.onchange = () => { typeTouched = true; const id = typeSel.value; typeSel.value = it.typeId; setType(id); it.typeId = id; };
    const sugg = () => {
      const box = $('#edSugg', sh), q = nameIn.value.trim();
      if (isNew && !typeTouched) { const g = guessType(q); if (g && g !== typeSel.value) { setType(g); it.typeId = g; } }
      const m = q.length >= 3 ? purchaseMatches(q) : [];
      box.innerHTML = m.length ? `<div class="muted small" style="margin-bottom:4px">From your purchase history (tap to fill in):</div><ul class="list">${m.map((p, i) => `<li data-p="${i}" style="grid-template-columns:1fr auto"><div class="grow"><div>${esc(p.item)}</div><div class="muted small">${esc([p.retailer, p.size, p.color].filter(Boolean).join(' · '))} · ${prettyDate(p.date)}</div></div><b>${p.price != null ? money(p.price) : ''}</b></li>`).join('')}</ul>` : '';
      $$('[data-p]', box).forEach(li => li.onclick = () => {
        const p = m[li.dataset.p];
        nameIn.value = p.item;
        if (p.retailer) $('#fStore', sh).value = p.retailer.replace(/\s*\((in-store|online)\)\s*$/i, '');
        if (p.price != null) $('#fPrice', sh).value = p.price;
        if (p.date) $('#fDate', sh).value = p.date;
        if (p.size) sizeIn.value = cleanSize(p.size);
        if (p.color) splitTags(p.color.replace(/\//g, ',')).forEach(c => cols.add(c));
        if (!typeTouched) { const g = guessType(p.item); if (g) { setType(g); it.typeId = g; } }
        box.innerHTML = `<p class="muted small">Filled in from your ${esc(p.retailer)} purchase on ${prettyDate(p.date)}. Check it and add anything missing.</p>`;
      });
    };
    nameIn.oninput = sugg;
    // a pasted store link fills empty fields, then looks for the purchase in the history
    $('#fFromLink', sh).oninput = () => {
      const r = parseStoreLink($('#fFromLink', sh).value); if (!r) return;
      const fill = (sel, v) => { const el = $(sel, sh); if (v && !el.value.trim()) el.value = v; };
      $('#fLink', sh).value = r.link; fill('#fStore', r.store); if (r.brand && !brands.count()) brands.add(r.brand); fill('#fName', r.name);
      r.colours.forEach(c => cols.add(c));
      if (r.typeId && !typeTouched) { setType(r.typeId); it.typeId = r.typeId; typeTouched = true; }
      sugg(); toast('Filled in from the link. Check it and add a photo.');
    };
    wireLocSelect($('#fLoc', sh));
    const setPhoto = async url => {
      photo = url; $('#edPhoto', sh).innerHTML = photoThumb(photo); $('[data-a=nophoto]', sh).hidden = false;
      const found = await detectColours(photo);
      if (found.length && !cols.count()) found.forEach(c => cols.add(c));
      showColours(found, found.length ? 'Colours spotted in the photo:' : '');
    };
    $('#edFile', sh).onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { await setPhoto(await readImage(f)); } catch (err) { toast(err.message); }
    };
    // screenshots: read the text on the device, fill empty fields, offer the rest as taps, and crop a photo from them
    const shotOut = $('#shotOut', sh), shotMsg = $('#shotMsg', sh);
    const fillIn = (sel, v) => { const el = $(sel, sh); if (v && !el.value.trim()) { el.value = v; return true; } };
    const showShots = (r, shots, raw) => {
      const row = (label, html) => html ? `<div class="shotrow"><span class="muted small">${label}</span> ${html}</div>` : '';
      shotOut.innerHTML = `<div class="shotbox">
        ${row(r.names.some(n => n.price) ? 'Item (tap to fill its details):' : 'Name:', r.names.map((n, i) => `<button class="tag" data-sn="${i}" type="button">${esc(n.name)}${n.price ? ' · $' + esc(n.price) : ''}</button>`).join(''))}
        ${row('Price:', r.prices.map(p => `<button class="tag" data-sp="${p}" type="button">$${esc(p)}</button>`).join(''))}
        ${row('Photo:', shots.map((u, i) => `<button class="shotthumb" data-crop="${i}" type="button"><img src="${u}" alt="Screenshot ${i + 1}"></button>`).join('') + '<span class="muted small"> tap one to crop</span>')}
        <div id="cropper"></div>
        <details class="small"><summary class="muted">Show what it read</summary><pre class="shottext">${esc(raw)}</pre></details></div>`;
      $$('[data-sn]', shotOut).forEach(b => b.onclick = () => useItem(r.names[b.dataset.sn], true));
      $$('[data-sp]', shotOut).forEach(b => b.onclick = () => { $('#fPrice', sh).value = b.dataset.sp; toast('Price set to $' + b.dataset.sp); });
      $$('[data-crop]', shotOut).forEach(b => b.onclick = () => openCropper(shots[b.dataset.crop]));
    };
    const openCropper = src => {
      const box = $('#cropper', shotOut); let sel = null, start = null;
      box.innerHTML = `<div class="crop"><img src="${src}" alt="" draggable="false"><div class="crop-sel" hidden></div></div>
        <p class="help">Drag a box around the item.</p>
        <div class="row end"><button class="ghost" data-c="whole" type="button">Use whole screenshot</button><button class="primary" data-c="use" type="button" disabled>Use this part</button></div>`;
      const area = $('.crop', box), selEl = $('.crop-sel', box);
      const at = e => { const r = area.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
      const draw = () => Object.assign(selEl.style, { left: sel.x * 100 + '%', top: sel.y * 100 + '%', width: sel.w * 100 + '%', height: sel.h * 100 + '%' });
      area.onpointerdown = e => { start = at(e); area.setPointerCapture(e.pointerId); e.preventDefault(); };
      area.onpointermove = e => { if (!start) return; const p = at(e); sel = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; selEl.hidden = false; draw(); };
      area.onpointerup = () => { start = null; $('[data-c=use]', box).disabled = !(sel && sel.w > 0.03 && sel.h > 0.03); };
      $('[data-c=use]', box).onclick = async () => { await setPhoto(await cropImage(src, sel)); box.innerHTML = ''; toast('Photo set'); };
      $('[data-c=whole]', box).onclick = async () => { await setPhoto(await cropImage(src)); box.innerHTML = ''; toast('Photo set'); };
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    // fill from one recognised item; `force` (a tap) replaces what's there, otherwise only empty or default fields change
    const useItem = (n, force) => {
      const set = (sel, v) => { const el = $(sel, sh); if (v && (force || !el.value.trim())) el.value = v; };
      set('#fName', n.name); set('#fPrice', n.price);
      if (!typeTouched) { const t = guessType(n.name); if (t) { setType(t); it.typeId = t; } }
      if (n.size && (force || !sizeIn.value.trim() || sizeIn.value === sizeFor(typeSel.value))) sizeIn.value = n.size;
      if (n.colours.length && (force || !cols.count())) { if (force) cols.clear(); n.colours.forEach(c => cols.add(c)); }
      sugg();
    };
    $('#fShots', sh).onchange = async e => {
      const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
      const shots = [], texts = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const n = files.length > 1 ? ` ${i + 1} of ${files.length}` : '';
          shotMsg.textContent = `Reading screenshot${n}…`;
          shots.push(await readImage(files[i], 2000));
          texts.push(await OCR.read(shots[i], m => { if (m.status === 'recognizing text') shotMsg.textContent = `Reading screenshot${n}… ${Math.round(m.progress * 100)}%`; else if (/load/.test(m.status)) shotMsg.textContent = 'Getting the screenshot reader ready (the first time downloads about 7 MB)…'; }));
        }
        const r = parseShotText(texts.join('\n'));
        const before = { name: nameIn.value, size: sizeIn.value, price: $('#fPrice', sh).value, colours: cols.count(), type: typeSel.value };
        if (r.typeId && !typeTouched) { setType(r.typeId); it.typeId = r.typeId; }
        useItem(r.sure || { name: '', price: r.prices[0], size: r.size, colours: r.colours });
        if (!$('#fPrice', sh).value) fillIn('#fPrice', r.prices[0]);
        if (sizeIn.value === sizeFor(typeSel.value) || !sizeIn.value) { if (r.size) sizeIn.value = r.size; }
        if (!cols.count() && r.colours.length) r.colours.forEach(c => cols.add(c));
        const filled = [nameIn.value !== before.name && 'name', (r.brand && !brands.count() ? (brands.add(r.brand), 'brand') : ''), fillIn('#fStore', r.store) && 'store', sizeIn.value !== before.size && 'size',
          $('#fPrice', sh).value !== before.price && 'price', fillIn('#fDate', r.date) && 'date', cols.count() !== before.colours && 'colours', typeSel.value !== before.type && 'type'].filter(Boolean);
        sugg(); showShots(r, shots, texts.join('\n— next screenshot —\n'));
        shotMsg.textContent = filled.length ? `Filled in ${filled.join(', ')}. Tap below to change or add more.` : 'Couldn’t pick out details for sure. Tap what fits below.';
      } catch (err) { shotMsg.textContent = err.message || 'Couldn’t read that screenshot'; }
    };
    $('[data-a=nophoto]', sh).onclick = e => { photo = null; $('#edPhoto', sh).innerHTML = photoThumb(null); e.target.hidden = true; };
    const getTags = tagField($('#fTags', sh), it.tags || []);
    const getMats = tagField($('#fMats', sh), it.materials || [], { field: 'materials', extra: MATERIALS, noun: 'material' });
    $('[data-a=save]', sh).onclick = async () => {
      const name = nameIn.value.trim(); if (!name) { nameIn.focus(); return toast('Give it a name'); }
      const lw = num($('#fLimW', sh).value), lm = num($('#fLimM', sh).value);
      Object.assign(it, {
        name, typeId: typeSel.value, brands: brands(), store: $('#fStore', sh).value.trim(), size: cleanSize(sizeIn.value),
        materials: getMats(), madeIn: $('#fMade', sh).value.trim(), link: $('#fLink', sh).value.trim(),
        colors: cols(), location: $('#fLoc', sh).value,
        purchaseDate: $('#fDate', sh).value, price: $('#fPrice', sh).value, discountPrice: $('#fDisc', sh).value,
        tags: getTags(), estWears: $('#fEst', sh).value, notes: $('#fNotes', sh).value.trim(),
        limit: lw ? { wears: lw, restMonths: lm || 0 } : null, retired: $('#fRet', sh).checked, photo
      });
      delete it.brand;
      if (isNew) S.items.push(it); else S.items[S.items.findIndex(x => x.id === it.id)] = it;
      await save('items'); closeModal(); toast(isNew ? 'Item added' : 'Saved');
      if (onSave) onSave(it.id); else refresh();
    };
    const del = $('[data-a=del]', sh);
    if (del) twoStep(del, 'Delete for good?', async () => {
      S.items = S.items.filter(x => x.id !== it.id);
      S.entries.forEach(e => { e.itemIds = e.itemIds.filter(x => x !== it.id); (e.slots || []).forEach(s => { if (s.itemId === it.id) s.itemId = null; }); if (e.fits) delete e.fits[it.id]; });
      S.entries = S.entries.filter(e => e.itemIds.length);
      Object.values(S.days).forEach(d => { if (d.cover?.kind === 'item' && d.cover.itemId === it.id) delete d.cover; });
      await save('items', 'entries', 'days'); closeModal(); refresh(); toast('Item deleted');
    });
  });
}

/* fit for one item on one logged day, or a try-on that does not count as a wear */
function openFit({ itemId, entryId = null, date = today(), tryOnId = null }) {
  const it = itemById(itemId); if (!it) return;
  const e = entryId && S.entries.find(x => x.id === entryId);
  const t = tryOnId && (it.tryOns || []).find(x => x.id === tryOnId);
  const cur = e ? (e.fits?.[itemId] || {}) : (t || {});
  let r = cur.r || '';
  const title = e ? `How did it fit on ${prettyDate(e.date)}?` : t ? `Try-on, ${prettyDate(t.date)}` : 'Record a try-on';
  openModal(`${head(title)}
    <div class="row" style="gap:12px;align-items:center;margin-bottom:12px"><div style="width:64px">${thumb(it)}</div><div class="grow"><div class="label">${esc(it.name)}</div><div class="muted small">${esc([typeName(it.typeId), it.size].filter(Boolean).join(' · '))}</div></div></div>
    ${e ? '' : `<label class="field"><span>Date</span><input type="date" id="foDate" value="${esc(t?.date || date)}"></label><p class="help">A try-on records fit without counting as a wear.</p>`}
    <div class="chips" style="flex-wrap:wrap" id="fitChips">${FITS.map(([k, l]) => `<button class="chip ${r === k ? 'on' : ''}" data-r="${k}" type="button">${l}</button>`).join('')}</div>
    <label class="field"><span>Note (optional)</span><input id="foNote" value="${esc(cur.note || '')}" placeholder="e.g. tight across the chest, sleeves fine"></label>
    ${e && !e.planned ? `<label class="check" style="margin-top:10px"><input type="checkbox" id="foNoWear" ${(e.noWear || []).includes(itemId) ? 'checked' : ''}> Don’t count as a wear (still shows on the calendar)</label>` : ''}
    <div class="row end">${(e && cur.r) || t ? '<button class="danger" data-a="clear" type="button">Remove</button>' : ''}<button class="ghost" data-a="item" type="button">Open item</button><button class="primary" data-a="save" type="button">Save</button></div>`, sh => {
    $$('[data-r]', sh).forEach(b => b.onclick = () => { r = b.dataset.r; $$('[data-r]', sh).forEach(x => x.classList.toggle('on', x === b)); });
    $('[data-a=item]', sh).onclick = () => openDetail(itemId);
    const nw = $('#foNoWear', sh);
    if (nw) nw.onchange = async () => {
      e.noWear = (e.noWear || []).filter(x => x !== itemId); if (nw.checked) e.noWear.push(itemId);
      await save('entries'); toast(nw.checked ? 'Not counted as a wear' : 'Counted as a wear'); refresh();
    };
    $('[data-a=save]', sh).onclick = async () => {
      if (!r) return nw ? closeModal() : toast('Pick how it fit');
      const note = $('#foNote', sh).value.trim();
      if (e) { e.fits = e.fits || {}; e.fits[itemId] = { r, note }; await save('entries'); }
      else {
        const d = $('#foDate', sh).value || today(); it.tryOns = it.tryOns || [];
        if (t) Object.assign(t, { date: d, r, note }); else it.tryOns.push({ id: uid(), date: d, r, note });
        await save('items');
      }
      closeModal(); toast('Fit saved'); refresh();
    };
    const clr = $('[data-a=clear]', sh);
    if (clr) clr.onclick = async () => {
      if (e) { delete e.fits[itemId]; await save('entries'); } else { it.tryOns = it.tryOns.filter(x => x.id !== tryOnId); await save('items'); }
      closeModal(); refresh();
    };
  });
}

/* saved filters */
function editFilter(f) {
  const isNew = !f; const x = f ? { ...f, typeIds: [...(f.typeIds || [])], tags: [...(f.tags || [])] } : { id: uid(), name: '', typeIds: [], tags: [] };
  openModal(`${head(isNew ? 'New quick filter' : 'Edit filter')}
    <p class="help">A quick filter shows items matching any of the chosen types and, if you add tags, any of those tags. Types already have their own chips.</p>
    <label class="field"><span>Name</span><input id="flName" value="${esc(x.name)}" placeholder="e.g. Concert tees"></label>
    <h2>Types</h2><div class="chips" style="flex-wrap:wrap">${S.types.map(t => `<button class="chip ${x.typeIds.includes(t.id) ? 'on' : ''}" data-t="${t.id}" type="button">${esc(t.name)}</button>`).join('')}</div>
    <div class="field" style="margin-top:12px"><span>Tags (optional)</span><div id="flTags"></div></div>
    <div class="row end sheetbar">${isNew ? '' : '<button class="danger" data-a="del" type="button">Delete</button>'}<button class="primary" data-a="save" type="button">Save</button></div>`, sh => {
    $$('[data-t]', sh).forEach(b => b.onclick = () => { const i = x.typeIds.indexOf(b.dataset.t); i < 0 ? x.typeIds.push(b.dataset.t) : x.typeIds.splice(i, 1); b.classList.toggle('on'); });
    const getTags = tagField($('#flTags', sh), x.tags);
    $('[data-a=save]', sh).onclick = async () => {
      x.name = $('#flName', sh).value.trim(); x.tags = getTags();
      if (!x.name) return toast('Name the filter');
      if (!x.typeIds.length && !x.tags.length) return toast('Pick a type or add a tag');
      if (isNew) S.filters.push(x); else S.filters[S.filters.findIndex(y => y.id === x.id)] = x;
      await save('filters'); closeModal(); if (tab === 'closet') closet.chip = 'f:' + x.id; refresh();
    };
    const del = $('[data-a=del]', sh); if (del) twoStep(del, 'Tap to confirm', async () => { S.filters = S.filters.filter(y => y.id !== x.id); await save('filters'); closeModal(); refresh(); });
  });
}

/* ================= CALENDAR ================= */
const cal = { month: today().slice(0, 7), mode: 'cover' };
function renderCalendar() {
  if (cal.mode !== 'cover' && !groupKeys().includes(cal.mode)) cal.mode = 'cover';
  const [y, m] = cal.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1), pad = first.getDay(), daysIn = new Date(y, m, 0).getDate(), t = today();
  const monthName = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const tally = new Map();
  let cells = '';
  for (let i = 0; i < pad; i++) cells += '<div class="cal-cell out"></div>';
  for (let d = 1; d <= daysIn; d++) {
    const ds = `${cal.month}-${String(d).padStart(2, '0')}`;
    const dayE = S.entries.filter(e => e.date === ds), plan = dayE.length > 0 && dayE.every(e => e.planned);
    const ids = [...new Set(dayE.flatMap(e => e.itemIds))];
    let inner = '', has = ids.length > 0;
    if (cal.mode === 'cover') {
      const src = dayCoverSrc(ds);
      inner = src ? `<img src="${src}" alt="">` : (has ? `<span class="txt">${esc(ids.map(itemById).filter(Boolean).map(i => i.name).join(', '))}</span>` : '');
    } else {
      const its = ids.map(itemById).filter(i => i && groupKey(i.typeId) === cal.mode);
      if (!plan) its.forEach(i => { if (dayE.some(e => !e.planned && counts(e, i.id))) tally.set(i.id, (tally.get(i.id) || 0) + 1); });
      has = its.length > 0;
      if (its.length) inner = (its[0].photo ? `<img src="${its[0].photo}" alt="">` : `<span class="txt">${esc(its[0].name)}</span>`) + (its.length > 1 ? `<span class="more">+${its.length - 1}</span>` : '');
    }
    cells += `<button class="cal-cell ${has ? 'has' : ''} ${has && plan ? 'plan' : ''} ${ds === t ? 'today' : ''}" data-d="${ds}" type="button" aria-label="${prettyDate(ds)}${has && plan ? ', planned' : ''}"><span class="n">${d}</span>${inner}</button>`;
  }
  const sum = cal.mode === 'cover' ? '' : (() => {
    const list = [...tally].map(([id, n]) => ({ it: itemById(id), n })).sort((a, b) => b.n - a.n);
    return `<section class="card calsum"><div class="label">${esc(groupName(cal.mode))} this month</div>${list.length ? `<ul>${list.map(x => `<li data-item="${x.it.id}" style="cursor:pointer"><span>${esc(x.it.name)}</span><b>${x.n}×</b></li>`).join('')}</ul>` : '<p class="muted small">None worn this month.</p>'}</section>`;
  })();
  view().innerHTML = `
    <section class="calhead"><button class="icon" data-a="pm" type="button" aria-label="Previous month">‹</button><div class="mname">${monthName}</div><button class="icon" data-a="nm" type="button" aria-label="Next month">›</button></section>
    <div class="chips calmode">${[{ id: 'cover', name: 'Day covers' }, ...groupKeys().map(k => ({ id: k, name: groupName(k) }))].map(x => `<button class="chip ${cal.mode === x.id ? 'on' : ''}" data-m="${x.id}" type="button">${esc(x.name)}</button>`).join('')}</div>
    <div class="cal">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(x => `<div class="dow">${x}</div>`).join('')}${cells}</div>
    ${sum}`;
  const v = view();
  const shift = n => { const d = new Date(y, m - 1 + n, 1); cal.month = fmt(d).slice(0, 7); renderCalendar(); };
  $('[data-a=pm]', v).onclick = () => shift(-1); $('[data-a=nm]', v).onclick = () => shift(1);
  $$('[data-m]', v).forEach(b => b.onclick = () => { cal.mode = b.dataset.m; renderCalendar(); });
  $$('[data-d]', v).forEach(b => b.onclick = () => { logState.date = b.dataset.d; logState.draft = null; go('log'); });
  $$('[data-item]', v).forEach(b => b.onclick = () => openDetail(b.dataset.item));
}

/* ================= SETTINGS ================= */
function renderSettings() {
  const used = id => S.items.filter(i => i.typeId === id).length;
  const st = S.settings;
  view().innerHTML = `
    <h2>Clothing types</h2>
    <section class="card"><p class="help" style="margin-top:0">Each type gets its own filter chip and calendar view. <b>Size</b> fills in automatically when you add an item of that type. Types with the same <b>Group</b> (like Tees) share one calendar view and fill the same outfit slot. A wear limit (wears, then months of rest) applies to every item of the type unless the item sets its own.</p>
      ${S.types.map(t => `<div class="set-row" data-type="${t.id}">
        <label class="field"><span>Name</span><input data-f="name" value="${esc(t.name)}"></label>
        <label class="field"><span>Size</span><input data-f="size" value="${esc(t.defaultSize || '')}" placeholder="—"></label>
        <label class="field"><span>Group</span><input data-f="group" list="dlGroup" value="${esc(t.group || '')}" placeholder="—"></label>
        <label class="field"><span>Limit</span><input type="number" min="1" data-f="w" value="${esc(t.limit?.wears ?? '')}" placeholder="none"></label>
        <label class="field"><span>Rest mo</span><input type="number" min="0" data-f="m" value="${esc(t.limit?.restMonths ?? '')}" placeholder="0"></label>
        <button class="icon" data-deltype="${t.id}" type="button" title="${used(t.id) ? 'In use by ' + used(t.id) + ' items' : 'Delete type'}" aria-label="Delete type" ${used(t.id) ? 'disabled' : ''}>✕</button></div>`).join('')}
      <datalist id="dlGroup">${[...new Set(S.types.map(t => t.group).filter(Boolean))].map(g => `<option value="${esc(g)}">`).join('')}</datalist>
      <div class="row end"><button class="ghost" data-a="addtype" type="button">＋ Add type</button></div></section>

    <h2>Locations</h2>
    <section class="card">${S.locations.map(l => `<div class="row" data-loc="${l.id}" style="padding:4px 0"><input class="grow" value="${esc(l.name)}" style="flex:1"><span class="muted small" style="min-width:60px;text-align:right">${S.items.filter(i => i.location === l.id).length} items</span><button class="icon" data-delloc="${l.id}" type="button" aria-label="Delete location">✕</button></div>`).join('')}
      <div class="row end"><button class="ghost" data-a="addloc" type="button">＋ Add location</button></div></section>

    <h2>Tags</h2>
    <section class="card stack"><p class="help" style="margin:0">Tags you’ve used on items are always suggested. Add more here (for example from an old app) so they’re suggested before you’ve used them. Separate them with commas.</p>
      <div class="row"><input id="libIn" class="grow" placeholder="knicks, concert, nintendo" autocapitalize="off" style="flex:1"><button class="ghost" data-a="addlib" type="button">Add</button></div>
      ${(st.tagLibrary || []).length ? `<div><span class="muted small">${st.tagLibrary.length} saved · tap one to remove it </span>${st.tagLibrary.map(t => `<button class="tag" data-libdel="${esc(t)}" type="button" style="cursor:pointer;background:none">${esc(t)} ✕</button>`).join('')}</div>` : ''}
    </section>

    <h2>Outfit templates</h2>
    ${S.templates.map(tp => `<section class="card" data-tpl="${tp.id}" style="margin-bottom:10px">
      <label class="field"><span>Template name</span><input data-f="tname" value="${esc(tp.name)}"></label>
      <div class="tpl-slots">${tp.slots.map((sid, i) => `<div class="row"><select data-slot="${i}">${S.types.map(t => `<option value="${t.id}" ${t.id === sid ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><button class="icon" data-rmslot="${i}" type="button" aria-label="Remove slot">✕</button></div>`).join('')}</div>
      <div class="spread"><button class="ghost" data-a="addslot" type="button">＋ Slot</button><button class="danger" data-a="deltpl" type="button">Delete template</button></div></section>`).join('')}
    <div class="row end" style="margin-top:0"><button class="ghost" data-a="addtpl" type="button">＋ New template</button></div>

    <h2>Quick filters</h2>
    <section class="card">${S.filters.length ? `<div class="chips" style="flex-wrap:wrap">${S.filters.map(f => `<button class="chip" data-filter="${f.id}" type="button">${esc(f.name)} ✎</button>`).join('')}</div>` : '<p class="muted small" style="margin-top:0">No custom filters yet. Every type already has a chip; add filters for groups like “Concert tees” or “Work wear”.</p>'}
      <div class="row end"><button class="ghost" data-a="addfilter" type="button">＋ New filter</button></div></section>

    <h2>Purchase history (for auto-fill)</h2>
    <section class="card stack"><p class="help" style="margin:0">Import a spreadsheet of past purchases. When you type a new item’s name, matching purchases appear so you can fill in store, price, date, size and colour with one tap. Columns used: <code>date, retailer, item, size, color, price</code>.</p>
      <div class="row"><label class="ghost" style="border:1px solid var(--line);border-radius:10px;padding:9px 14px;cursor:pointer;background:var(--surface)">Import purchases CSV<input type="file" accept=".csv,text/csv" id="purchIn" hidden></label>
        ${S.purchases.length ? `<span class="muted small">${S.purchases.length} purchases loaded</span><button class="danger" data-a="clearpurch" type="button">Clear</button>` : '<span class="muted small">None loaded</span>'}</div></section>

    <h2>Photos</h2>
    <section class="card stack"><p class="help" style="margin:0">Add photos to many items at once. Pick image files named after the item (like <code>Navy oxford.jpg</code>), or named with the ID at the end of the item’s link. A Rotation photo pack (<code>.json</code>) works too.</p>
      <label class="check"><input type="checkbox" id="phReplace"> Replace photos items already have</label>
      <div class="row"><button class="ghost" data-a="dewhite" type="button">Remove background white</button><span class="muted small" id="dewhiteMsg">Takes “white” off items whose photo shows it’s only the background.</span></div>
      <div class="row"><label class="ghost" style="border:1px solid var(--line);border-radius:10px;padding:9px 14px;cursor:pointer;background:var(--surface)">Import photos<input type="file" accept="image/*,.json,application/json" id="phIn" multiple hidden></label><span class="muted small" id="phMsg"></span></div></section>

    <h2>Look</h2>
    <section class="card"><label class="field"><span>Theme</span><select id="sTheme">${[['auto', 'Match phone (light or dark)'], ['light', 'Light'], ['dark', 'Dark'], ['brown', 'Chocolate'], ['ipod', 'Click Wheel'], ['aqua', 'Aqua'], ['luna', 'Luna'], ['blades', 'Blades'], ['aero', 'Aero'], ['w98', 'Retro 98']].map(([v, l]) => `<option value="${v}" ${(st.theme || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field" style="margin-top:12px"><span>Items per row (phone)</span><select id="sCols">${[2, 3].map(n => `<option value="${n}" ${(st.cols || 3) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="sGlass" ${st.glass !== false ? 'checked' : ''}> Glass tab bar (floating, see-through)</label></section>

    <h2>Counting</h2>
    <section class="card stack">
      <label class="field"><span>“Worn in the past X days” window</span><input type="number" min="1" id="sDays" value="${st.recentDays}"></label>
      <label class="check"><input type="checkbox" id="sCpw" ${st.cpwIncludesEstimate ? 'checked' : ''}> Include estimated past wears in cost per wear</label>
    </section>

    <h2>Google Drive backup</h2>
    <section class="card stack">
      <div class="small" id="drvStatus">${driveStatusText()}</div>
      <label class="field"><span>Google OAuth client ID</span><input id="sClient" value="${esc(st.clientId)}" placeholder="1234…apps.googleusercontent.com"></label>
      <label class="check"><input type="checkbox" id="sAuto" ${st.autoBackup ? 'checked' : ''}> Back up automatically after changes while connected</label>
      <div class="row"><button class="primary" data-a="drvconnect" type="button">${Drive.ok() ? 'Reconnect' : 'Connect Google Drive'}</button>
        <button class="ghost" data-a="drvbackup" type="button">Back up now</button><button class="ghost" data-a="drvrestore" type="button">Restore from Drive</button></div>
      <details class="help"><summary>How to get a client ID (one time, about 5 minutes)</summary><ol>
        <li>Go to <code>console.cloud.google.com</code>, create a project, and enable the <b>Google Drive API</b>.</li>
        <li>Under <b>OAuth consent screen</b>, choose External, add yourself as a test user.</li>
        <li>Under <b>Credentials</b>, create an <b>OAuth client ID</b> of type <b>Web application</b>. Add <code>${esc(location.origin)}</code> as an <b>authorised JavaScript origin</b>, and <code>${esc(Drive.redirectUri())}</code> as an <b>authorised redirect URI</b> (the iPhone home-screen app needs it).</li>
        <li>Paste the client ID above and tap Connect. Rotation only sees the one backup file it creates in your Drive.</li></ol></details>
    </section>

    <h2>Backup file</h2>
    <section class="card"><div class="row"><button class="ghost" data-a="export" type="button">Export backup file</button>
      <label class="ghost" style="border:1px solid var(--line);border-radius:10px;padding:9px 14px;cursor:pointer;background:var(--surface)">Import backup file<input type="file" accept="application/json,.json" id="importFile" hidden></label></div>
      <p class="help">${S.items.length} items · ${S.entries.length} outfits logged. Importing or restoring replaces what is on this device.</p></section>

    <h2>Spreadsheet (CSV)</h2>
    <section class="card stack">
      <div class="row"><button class="ghost" data-a="csvitems" type="button">Export items CSV</button><button class="ghost" data-a="csvwears" type="button">Export wear log CSV</button></div>
      <div class="row">
        <label class="ghost" style="border:1px solid var(--line);border-radius:10px;padding:9px 14px;cursor:pointer;background:var(--surface)">Import items CSV<input type="file" accept=".csv,text/csv" id="csvItemsIn" hidden></label>
        <label class="ghost" style="border:1px solid var(--line);border-radius:10px;padding:9px 14px;cursor:pointer;background:var(--surface)">Import wear log CSV<input type="file" accept=".csv,text/csv" id="csvWearsIn" hidden></label>
        <button class="ghost" data-a="csvtemplate" type="button">Blank items template</button></div>
      <label class="check"><input type="checkbox" id="csvWearsEst"> When importing a wear log, take those wears off each item’s estimated past wears (they were already counted)</label>
      <p class="help"><b>Items CSV</b> columns: <code>name, type, size, colors, materials, made_in, location, brand, store, tags, link, purchase_price, discount_price, purchase_date, estimated_past_wears, wear_limit, rest_months, retired, notes</code>. Only <code>name</code> is required; tags, colours, materials and brands are separated by <code>;</code>. Rows that match an existing item (same <code>id</code>, same <code>link</code>, or same name and type) update it instead of adding a copy. A row with no <code>name</code> only updates the item it matches by <code>id</code> or <code>link</code>, changing just the columns it has, and new types are created automatically. Export also includes wear counts and cost per wear for reference; on import those are ignored except <code>total_wears</code>, which sets the estimate to whatever logged wears don’t cover (only counting wears up to <code>as_of</code>, if given). Photos stay in the app.<br>
      <b>Wear log CSV</b> columns: <code>date, item_name</code> (or <code>item_id</code>, or the item’s <code>link</code>), optionally <code>outfit</code> to group rows into one outfit, <code>fit, fit_note</code>, and <code>not_counted</code> (yes for a day that isn’t a wear). Rows with the same date and outfit become one outfit. Imported wears are added to what you already have; a wear already logged for that item and day is skipped.</p>
    </section>`;
  const v = view();
  // types
  $$('[data-type]', v).forEach(row => {
    const t = typeById(row.dataset.type);
    $$('input', row).forEach(inp => inp.onchange = async () => {
      const name = $('[data-f=name]', row).value.trim(); if (name) t.name = name;
      t.defaultSize = $('[data-f=size]', row).value.trim(); t.group = $('[data-f=group]', row).value.trim();
      const w = num($('[data-f=w]', row).value), m = num($('[data-f=m]', row).value);
      t.limit = w ? { wears: w, restMonths: m || 0 } : null; await save('types');
    });
  });
  $$('[data-deltype]', v).forEach(b => twoStep(b, '?', async () => {
    const id = b.dataset.deltype; S.types = S.types.filter(t => t.id !== id);
    S.templates.forEach(tp => tp.slots = tp.slots.filter(s => s !== id));
    S.filters.forEach(f => f.typeIds = (f.typeIds || []).filter(s => s !== id));
    await save('types', 'templates', 'filters'); renderSettings();
  }));
  $$('[data-loc]', v).forEach(row => { const l = S.locations.find(x => x.id === row.dataset.loc); $('input', row).onchange = async e => { l.name = e.target.value.trim() || l.name; await save('locations'); }; });
  $$('[data-delloc]', v).forEach(b => twoStep(b, '?', async () => { const id = b.dataset.delloc; S.locations = S.locations.filter(l => l.id !== id); S.items.forEach(i => { if (i.location === id) i.location = ''; }); if (S.settings.logLocation === id) S.settings.logLocation = ''; await save('locations', 'items'); renderSettings(); }));
  $('[data-a=addloc]', v).onclick = async () => { S.locations.push({ id: uid(), name: 'New place' }); await save('locations'); renderSettings(); $$('[data-loc] input').pop().select(); };
  $('#phIn', v).onchange = async e => {
    const files = [...e.target.files]; if (!files.length) return;
    const msg = $('#phMsg', v); msg.textContent = 'Importing…';
    try { const r = await importPhotos(files, $('#phReplace', v).checked); msg.textContent = `${r.added} added${r.kept ? `, ${r.kept} kept (item already had one)` : ''}${r.unmatched.length ? `, ${r.unmatched.length} not matched: ${r.unmatched.slice(0, 8).join(', ')}${r.unmatched.length > 8 ? '…' : ''}` : ''}`; }
    catch (err) { msg.textContent = err.message; }
    e.target.value = '';
  };
  $('[data-a=dewhite]', v).onclick = async () => {
    const msg = $('#dewhiteMsg', v), list = S.items.filter(i => i.photo && (i.colors || []).includes('white'));
    if (!list.length) return msg.textContent = 'No items with a photo are tagged white.';
    let removed = 0, kept = 0;
    for (const [n, i] of list.entries()) {
      msg.textContent = `Checking ${n + 1} of ${list.length}…`;
      if ((await detectColours(i.photo)).includes('white')) kept++; else { i.colors = i.colors.filter(c => c !== 'white'); removed++; }
    }
    if (removed) await save('items');
    msg.textContent = `Removed white from ${removed} item${removed === 1 ? '' : 's'}${kept ? `; kept it on ${kept} that look white` : ''}.`;
  };
  $('#purchIn', v).onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const n = await importPurchasesCSV(await f.text()); toast(`${n} purchases loaded for auto-fill`); renderSettings(); } catch (err) { toast(err.message); } };
  const cp = $('[data-a=clearpurch]', v); if (cp) twoStep(cp, 'Tap to confirm', async () => { S.purchases = []; await save('purchases'); renderSettings(); });
  $('[data-a=addlib]', v).onclick = async () => {
    const add = splitTags($('#libIn', v).value).filter(t => !S.settings.tagLibrary.includes(t)); if (!add.length) return;
    S.settings.tagLibrary = [...S.settings.tagLibrary, ...add].sort(); await save(); toast(`${add.length} tag${add.length > 1 ? 's' : ''} added`); renderSettings();
  };
  $$('[data-libdel]', v).forEach(b => b.onclick = async () => { S.settings.tagLibrary = S.settings.tagLibrary.filter(t => t !== b.dataset.libdel); await save(); renderSettings(); });
  $('[data-a=addtype]', v).onclick = async () => { S.types.push({ id: uid(), name: 'New type', limit: null, defaultSize: '', group: '' }); await save('types'); renderSettings(); $$('[data-type] [data-f=name]').pop().select(); };
  // templates
  $$('[data-tpl]', v).forEach(card => {
    const tp = S.templates.find(x => x.id === card.dataset.tpl);
    $('[data-f=tname]', card).onchange = async e => { tp.name = e.target.value.trim() || tp.name; await save('templates'); };
    $$('[data-slot]', card).forEach(sel => sel.onchange = async () => { tp.slots[sel.dataset.slot] = sel.value; await save('templates'); });
    $$('[data-rmslot]', card).forEach(b => b.onclick = async () => { tp.slots.splice(Number(b.dataset.rmslot), 1); await save('templates'); renderSettings(); });
    $('[data-a=addslot]', card).onclick = async () => { tp.slots.push(S.types[0].id); await save('templates'); renderSettings(); };
    twoStep($('[data-a=deltpl]', card), 'Tap to confirm', async () => { S.templates = S.templates.filter(x => x.id !== tp.id); logState.draft = null; await save('templates'); renderSettings(); });
  });
  $('[data-a=addtpl]', v).onclick = async () => { S.templates.push({ id: uid(), name: 'New template', slots: [S.types[0].id] }); await save('templates'); renderSettings(); };
  // filters
  $$('[data-filter]', v).forEach(b => b.onclick = () => editFilter(S.filters.find(f => f.id === b.dataset.filter)));
  $('[data-a=addfilter]', v).onclick = () => editFilter(null);
  // counting
  $('#sTheme', v).onchange = async e => { S.settings.theme = e.target.value; applyTheme(); await save(); };
  $('#sCols', v).onchange = async e => { S.settings.cols = Number(e.target.value); applyTheme(); await save(); };
  $('#sGlass', v).onchange = async e => { S.settings.glass = e.target.checked; applyTheme(); await save(); };
  $('#sDays', v).onchange = async e => { S.settings.recentDays = Math.max(1, parseInt(e.target.value) || 30); await save(); };
  $('#sCpw', v).onchange = async e => { S.settings.cpwIncludesEstimate = e.target.checked; await save(); };
  // drive
  $('#sClient', v).onchange = async e => { S.settings.clientId = e.target.value.trim(); await save(); };
  $('#sAuto', v).onchange = async e => { S.settings.autoBackup = e.target.checked; await save(); };
  $('[data-a=drvconnect]', v).onclick = async () => { try { await Drive.signIn(); toast('Connected to Google Drive'); renderSettings(); renderSync(); scheduleBackup(); } catch (e) { toast(e.message); } };
  $('[data-a=drvbackup]', v).onclick = () => backupNow(true);
  $('[data-a=drvrestore]', v).onclick = restoreFromDrive;
  // file backup
  $('[data-a=export]', v).onclick = () => download(`rotation-backup-${today()}.json`, JSON.stringify(snapshot()), 'application/json');
  $('[data-a=csvitems]', v).onclick = () => download(`rotation-items-${today()}.csv`, itemsCSV(), 'text/csv');
  $('[data-a=csvwears]', v).onclick = () => download(`rotation-wears-${today()}.csv`, wearsCSV(), 'text/csv');
  $('[data-a=csvtemplate]', v).onclick = () => download('rotation-items-template.csv', toCSV([ITEM_COLS, ['Navy oxford', 'Work shirt', 'XL', 'navy;white', 'cotton', 'Vietnam', 'Home', 'Uniqlo', 'Uniqlo SoHo', 'work;oxford', '', '39.90', '29.90', '2025-03-14', '20', '', '', '', '']]), 'text/csv');
  $('#csvItemsIn', v).onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const r = await importItemsCSV(await f.text()); toast(`Items: ${r.added} added, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ''}`); renderSettings(); } catch (err) { toast(err.message); } };
  $('#csvWearsIn', v).onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const r = await importWearsCSV(await f.text(), { fromEstimates: $('#csvWearsEst', v).checked }); toast(`Wear log: ${r.outfits} outfits added${r.dupes ? `, ${r.dupes} wears already logged` : ''}${r.missing ? `, ${r.missing} rows skipped (item not found)` : ''}`); renderSettings(); } catch (err) { toast(err.message); } };
  $('#importFile', v).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const data = JSON.parse(await f.text()); await applySnapshot(data); toast('Backup imported'); refresh(); } catch (err) { toast('That file is not a Rotation backup'); }
  };
}

/* ---------- CSV ---------- */
const ITEM_COLS = ['name', 'type', 'size', 'colors', 'materials', 'made_in', 'location', 'brand', 'store', 'tags', 'link', 'purchase_price', 'discount_price', 'purchase_date', 'estimated_past_wears', 'wear_limit', 'rest_months', 'retired', 'notes'];
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCSV = rows => '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
function parseCSV(text) {
  text = text.replace(/^\ufeff/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter(r => r.some(x => x.trim() !== ''));
  if (!clean.length) throw new Error('That CSV is empty');
  const hdr = clean[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return clean.slice(1).map(r => Object.fromEntries(hdr.map((h, i) => [h, (r[i] ?? '').trim()])));
}
const csvDate = v => { if (!v) return ''; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v; const d = new Date(v); return isNaN(d) ? '' : fmt(d); };
const truthy = v => /^(y|yes|true|1|x)$/i.test(String(v || '').trim());
function itemsCSV() {
  const days = Number(S.settings.recentDays) || 30;
  const hdr = ['id', ...ITEM_COLS, 'tracked_wears', 'total_wears', `wears_past_${days}_days`, 'cost_per_wear', 'last_worn', 'status'];
  return toCSV([hdr, ...S.items.map(i => {
    const st = stats(i);
    return [i.id, i.name, typeName(i.typeId), i.size || '', (i.colors || []).join(';'), (i.materials || []).join(';'), i.madeIn || '', locName(i.location), brandsOf(i).join(';'), i.store, (i.tags || []).join(';'), i.link || '', i.price, i.discountPrice, i.purchaseDate, i.estWears,
      i.limit?.wears ?? '', i.limit?.restMonths ?? '', i.retired ? 'yes' : '', i.notes,
      st.tracked, st.total, st.recent, st.cpw != null ? st.cpw.toFixed(2) : '', st.last || '', st.status];
  })]);
}
function wearsCSV() {
  const rows = [['date', 'outfit', 'template', 'item_id', 'item_name', 'type', 'fit', 'fit_note', 'not_counted']];
  [...worn()].sort((a, b) => a.date.localeCompare(b.date)).forEach(e => e.itemIds.forEach(id => {
    const it = itemById(id), f = e.fits?.[id]; rows.push([e.date, e.id, S.templates.find(t => t.id === e.templateId)?.name || '', id, it?.name || '', typeName(it?.typeId), f?.r ? fitLabel(f.r) : '', f?.note || '', counts(e, id) ? '' : 'yes']);
  }));
  return toCSV(rows);
}
function typeFor(name) {
  const n = (name || '').trim(); if (!n) return S.types[0].id;
  let t = S.types.find(x => x.name.toLowerCase() === n.toLowerCase());
  if (!t) { t = { id: uid(), name: n, limit: null, defaultSize: '', group: '' }; S.types.push(t); }
  return t.id;
}
async function importItemsCSV(text) {
  const rows = parseCSV(text); let added = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    const name = r.name || r.item_name || r.item;
    const byKey = (r.id && itemById(r.id)) || ((r.link || r.url) && itemForPhoto({ link: r.link || r.url }));
    // a row without a name only updates the item it matches by id or link (e.g. just link + estimated_past_wears)
    if (!name && !byKey) { skipped++; continue; }
    const typeId = r.type || r.category || !byKey ? typeFor(r.type || r.category) : byKey.typeId;
    let it = byKey || S.items.find(i => i.name.toLowerCase() === name.toLowerCase() && i.typeId === typeId);
    const isNew = !it;
    if (isNew) { it = { id: uid(), name, typeId, size: sizeFor(typeId), colors: [], location: '', tryOns: [], brands: [], store: '', tags: [], materials: [], madeIn: '', link: '', price: '', discountPrice: '', purchaseDate: '', estWears: '', limit: null, notes: '', retired: false, photo: null, created: Date.now() }; }
    const has = k => k in r && r[k] !== '';
    if (name) it.name = name; it.typeId = typeId;
    if (has('brand') || has('brands')) { it.brands = (r.brands || r.brand).split(';').map(b => b.trim()).filter(Boolean); delete it.brand; }
    if (has('size')) it.size = cleanSize(r.size);
    if (has('materials') || has('material')) it.materials = splitTags((r.materials || r.material).replace(/;/g, ','));
    if (has('link') || has('url')) it.link = r.link || r.url;
    if (has('made_in') || has('country')) it.madeIn = r.made_in || r.country;
    if (has('colors') || has('colours') || has('color') || has('colour')) it.colors = splitTags((r.colors || r.colours || r.color || r.colour).replace(/;/g, ','));
    if (has('location')) { const ln = r.location.trim(); let l = S.locations.find(x => x.name.toLowerCase() === ln.toLowerCase()); if (!l) { l = { id: uid(), name: ln }; S.locations.push(l); } it.location = l.id; }
    if (has('store') || has('store_purchased') || has('retailer')) it.store = r.store || r.store_purchased || r.retailer;
    if (has('tags')) it.tags = splitTags(r.tags.replace(/;/g, ','));
    const price = r.purchase_price ?? r.price; if (price) it.price = String(num(price.replace(/[$,]/g, '')) ?? '');
    const disc = r.discount_price ?? r.price_paid; if (disc) it.discountPrice = String(num(disc.replace(/[$,]/g, '')) ?? '');
    if (has('purchase_date') || has('date')) it.purchaseDate = csvDate(r.purchase_date || r.date);
    if (has('estimated_past_wears')) it.estWears = String(parseInt(r.estimated_past_wears) || 0);
    // a known total (e.g. from another app, as of the day it was exported): the estimate is whatever logged wears up to then don't cover
    if (has('total_wears')) { const asOf = csvDate(r.as_of) || '9999-12-31', logged = wearDates(it.id).filter(d => d <= asOf).length; it.estWears = String(Math.max(0, (parseInt(r.total_wears) || 0) - logged)); }
    if (has('wear_limit')) it.limit = num(r.wear_limit) ? { wears: num(r.wear_limit), restMonths: num(r.rest_months) || 0 } : null;
    if ('retired' in r) it.retired = truthy(r.retired);
    if (has('notes')) it.notes = r.notes;
    if (isNew) { S.items.push(it); added++; } else updated++;
  }
  await save('items', 'types', 'locations'); return { added, updated, skipped };
}
/* photos for many items at once: image files named after an item (or the ID at the end of its link),
   or a photo pack {app:'rotation-photos', photos:[{link?, name?, data}]} */
const normKey = s => String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
function itemForPhoto({ link, name }) { // also used to match wear log rows by link
  const lk = String(link || '').trim(), id = lk.split(/[/?#]/).filter(Boolean).pop() || '';
  if (lk) { const it = S.items.find(i => i.link && (i.link === lk || (id.length >= 8 && i.link.includes(id)))); if (it) return it; }
  const n = normKey(name); if (!n) return null;
  return S.items.find(i => normKey(i.name) === n) || (n.length >= 8 && S.items.find(i => i.link && normKey(i.link).split(' ').includes(n))) || null;
}
async function importPhotos(files, replace) {
  const r = { added: 0, kept: 0, unmatched: [] };
  const put = (it, data, label) => {
    if (!it) return r.unmatched.push(label);
    if (it.photo && !replace) return r.kept++;
    it.photo = data; r.added++;
  };
  for (const f of files) {
    if (/\.json$/i.test(f.name) || f.type === 'application/json') {
      let pack; try { pack = JSON.parse(await f.text()); } catch { throw new Error(f.name + ' isn’t a photo pack'); }
      if (pack?.app !== 'rotation-photos' || !Array.isArray(pack.photos)) throw new Error(f.name + ' isn’t a photo pack');
      for (const p of pack.photos) if (/^data:image\/(jpeg|png|webp);base64,/.test(p.data || '')) put(itemForPhoto(p), p.data, p.name || p.link);
    } else put(itemForPhoto({ name: f.name }), await readImage(f), f.name);
  }
  if (r.added) await save('items');
  return r;
}
async function importPurchasesCSV(text) {
  const rows = parseCSV(text);
  if (rows.length && 'type' in rows[0] && !('item' in rows[0]) && !('retailer' in rows[0])) throw new Error('That looks like an items file. Use Import items CSV under Spreadsheet (CSV).');
  const list = rows.map(r => ({ date: csvDate(r.date), retailer: r.retailer || r.store || '', item: r.item || r.name || '', size: r.size || '', color: r.color || r.colour || '', price: num((r.price || '').replace(/[$,]/g, '')) }))
    .filter(p => p.item);
  if (!list.length) throw new Error('No rows with an item column found');
  S.purchases = list; await save('purchases'); return list.length;
}
/* wears that are already logged (same item, same day) are skipped, so importing a file twice is harmless.
   fromEstimates: these wears were already counted in estimated past wears, so take them off. */
async function importWearsCSV(text, { fromEstimates = false } = {}) {
  const rows = parseCSV(text); const groups = new Map(); let missing = 0, dupes = 0;
  const had = new Set(worn().flatMap(e => e.itemIds.map(id => e.date + '|' + id)));
  for (const r of rows) {
    const date = csvDate(r.date); if (!date) { missing++; continue; }
    let it = r.item_id && itemById(r.item_id);
    const nm = (r.item_name || r.name || r.item || '').toLowerCase();
    if (!it && nm) it = S.items.find(i => i.name.toLowerCase() === nm);
    if (!it && (r.link || r.url)) it = itemForPhoto({ link: r.link || r.url });
    if (!it) { missing++; continue; }
    if (had.has(date + '|' + it.id)) { dupes++; continue; }
    had.add(date + '|' + it.id);
    if (fromEstimates && !truthy(r.not_counted)) it.estWears = String(Math.max(0, (parseInt(it.estWears) || 0) - 1));
    const key = date + '|' + (r.outfit || r.outfit_id || '');
    if (!groups.has(key)) groups.set(key, { date, ids: new Set(), tpl: r.template, fits: {}, noWear: [] });
    groups.get(key).ids.add(it.id);
    if (truthy(r.not_counted)) groups.get(key).noWear.push(it.id);
    const fr = FITS.find(f => f[1].toLowerCase() === (r.fit || '').toLowerCase() || f[0] === (r.fit || '').toLowerCase());
    if (fr) groups.get(key).fits[it.id] = { r: fr[0], note: r.fit_note || '' };
  }
  for (const g of groups.values()) {
    const tpl = S.templates.find(t => t.name.toLowerCase() === (g.tpl || '').toLowerCase());
    S.entries.push({ id: uid(), date: g.date, templateId: tpl?.id || '', slots: [], itemIds: [...g.ids], fits: g.fits, ...(g.noWear.length ? { noWear: g.noWear } : {}), created: Date.now(), imported: true });
  }
  await save('entries', 'items'); return { outfits: groups.size, missing, dupes };
}

/* ---------- backup ---------- */
function snapshot() { return { app: 'rotation', version: 1, exportedAt: new Date().toISOString(), data: Object.fromEntries(COLLS.map(k => [k, S[k]])) }; }
async function applySnapshot(snap) {
  if (!snap || snap.app !== 'rotation' || !snap.data) throw new Error('bad');
  const keep = { clientId: S.settings.clientId, driveFileId: S.settings.driveFileId, autoBackup: S.settings.autoBackup };
  const d = defaults();
  for (const k of COLLS) S[k] = snap.data[k] ?? d[k];
  S.settings = { ...d.settings, ...S.settings, ...keep, lastBackup: Date.now() };
  logState.draft = null;
  await DB.setMany(Object.fromEntries(COLLS.map(k => [k, S[k]])));
  renderSync();
}

const Drive = {
  token: null, exp: 0,
  ok() { return !!this.token && Date.now() < this.exp; },
  async loadLib() {
    if (window.google?.accounts?.oauth2) return;
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.onload = res; s.onerror = () => rej(new Error('Could not reach Google. Are you online?')); document.head.appendChild(s); });
  },
  // An iPhone home-screen app can't use Google's sign-in popup, so it signs in by leaving the page and
  // coming back with the token in the address (see fromRedirect). `after` says what to do on return.
  redirectMode() { return navigator.standalone === true; },
  redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); },
  async signIn(after = 'connect') {
    if (!S.settings.clientId) throw new Error('Add your Google client ID in Setup first');
    if (this.redirectMode()) {
      const state = uid(); try { localStorage.setItem('rotation-oauth', JSON.stringify({ state, after, tab })); } catch { }
      location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: S.settings.clientId, redirect_uri: this.redirectUri(),
        response_type: 'token', scope: 'https://www.googleapis.com/auth/drive.file', state, include_granted_scopes: 'true' });
      return new Promise(() => { });
    }
    await this.loadLib();
    return new Promise((res, rej) => {
      const c = google.accounts.oauth2.initTokenClient({
        client_id: S.settings.clientId, scope: 'https://www.googleapis.com/auth/drive.file',
        callback: r => { if (r.error) return rej(new Error('Google sign-in: ' + r.error)); this.token = r.access_token; this.exp = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000; res(); },
        error_callback: e => rej(new Error('Google sign-in was closed'))
      });
      c.requestAccessToken({ prompt: '' });
    });
  },
  fromRedirect() {
    const h = new URLSearchParams(location.hash.slice(1)); if (!h.has('access_token') && !h.has('error')) return null;
    history.replaceState(null, '', location.pathname + location.search);
    let saved = {}; try { saved = JSON.parse(localStorage.getItem('rotation-oauth') || '{}'); localStorage.removeItem('rotation-oauth'); } catch { }
    if (h.has('error')) { toast('Google sign-in: ' + h.get('error')); return null; }
    if (!saved.state || h.get('state') !== saved.state) return null;
    this.token = h.get('access_token'); this.exp = Date.now() + (Number(h.get('expires_in') || 3600) - 60) * 1000;
    return { after: saved.after || 'connect', tab: saved.tab };
  },
  async api(url, opt = {}) {
    const r = await fetch(url, { ...opt, headers: { ...(opt.headers || {}), Authorization: 'Bearer ' + this.token } });
    if (r.status === 401) { this.token = null; throw new Error('Google session expired. Connect again.'); }
    if (!r.ok) throw new Error('Google Drive error ' + r.status);
    return r;
  },
  async find() {
    const q = encodeURIComponent("name='rotation-backup.json' and trashed=false");
    const j = await (await this.api(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime%20desc&fields=files(id,modifiedTime)`)).json();
    return j.files?.[0] || null;
  },
  async upload(body) {
    let id = S.settings.driveFileId || (await this.find())?.id;
    if (id) {
      try { await this.api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }); return id; }
      catch (e) { if (!/ 404$/.test(e.message)) throw e; }
    }
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify({ name: 'rotation-backup.json', mimeType: 'application/json' })], { type: 'application/json' }));
    fd.append('file', new Blob([body], { type: 'application/json' }));
    return (await (await this.api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: fd })).json()).id;
  },
  async download() {
    const f = await this.find(); if (!f) return null;
    return { snap: await (await this.api(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`)).json(), modified: f.modifiedTime, id: f.id };
  }
};
function driveStatusText() {
  const st = S.settings;
  if (!st.clientId) return 'Not set up yet. Your data is saved on this device only.';
  const last = st.lastBackup ? new Date(st.lastBackup).toLocaleString() : 'never';
  return `${Drive.ok() ? 'Connected.' : 'Not connected right now.'} Last backup: ${last}.`;
}
let backupTimer = null, backingUp = false;
function scheduleBackup() {
  // also runs right after connecting, so changes made while disconnected get backed up
  if (!S.settings.autoBackup || !Drive.ok() || S.settings.lastBackup >= S.settings.lastChange) return;
  clearTimeout(backupTimer); backupTimer = setTimeout(() => backupNow(false), 4000);
}
async function backupNow(interactive) {
  if (backingUp) return;
  try {
    if (!navigator.onLine) throw new Error('You’re offline. Backup will wait until you’re back online.');
    if (!Drive.ok()) { if (!interactive) return; await Drive.signIn('backup'); }
    backingUp = true; renderSync('Backing up…');
    S.settings.driveFileId = await Drive.upload(JSON.stringify(snapshot()));
    S.settings.lastBackup = Date.now(); await DB.setMany({ settings: S.settings });
    if (interactive) toast('Backed up to Google Drive');
  } catch (e) { if (interactive) toast(e.message); }
  finally { backingUp = false; renderSync(); if (tab === 'settings' && $('#drvStatus')) $('#drvStatus').textContent = driveStatusText(); }
}
async function restoreFromDrive() {
  try {
    if (!Drive.ok()) await Drive.signIn('restore');
    const r = await Drive.download(); if (!r) return toast('No backup found in your Drive yet');
    const n = r.snap.data?.items?.length ?? 0, e = r.snap.data?.entries?.length ?? 0;
    openModal(`${head('Restore from Drive?')}<p>The Drive backup from <b>${new Date(r.modified).toLocaleString()}</b> has ${n} items and ${e} outfits.</p>
      <p class="muted small">This replaces everything on this device (${S.items.length} items, ${S.entries.length} outfits).</p>
      <div class="row end"><button class="ghost" data-x type="button">Cancel</button><button class="primary" data-a="go" type="button">Replace with Drive backup</button></div>`, sh => {
      $('[data-a=go]', sh).onclick = async () => { S.settings.driveFileId = r.id; await applySnapshot(r.snap); closeModal(); toast('Restored from Drive'); refresh(); };
    });
  } catch (err) { toast(err.message); }
}
function renderSync(label) {
  const b = $('#sync'), st = S.settings;
  b.className = 'sync';
  if (label) { b.textContent = label; return; }
  if (!st.clientId) { b.textContent = navigator.onLine ? 'On this device' : 'Offline'; return; }
  if (st.lastBackup >= st.lastChange) { b.textContent = 'Backed up'; b.classList.add('done'); }
  else { b.textContent = Drive.ok() ? 'Backup pending' : 'Not backed up'; b.classList.add('pending'); }
}

/* ---------- theme ---------- */
/* the iPhone status bar area is painted this colour (the app no longer draws under it, so iOS has nothing to blur): match each header */
const THEME_BAR = { light: '#f4f2ee', dark: '#13161d', brown: '#2b1913', ipod: '#c9d0bf', aqua: '#f0f0f0', luna: '#2a7cf0', blades: '#a2dc5a', aero: '#3a4852', w98: '#000080' };
function applyTheme() {
  const t = S.settings.theme || 'auto', root = document.documentElement;
  if (t === 'auto') delete root.dataset.theme; else root.dataset.theme = t;
  if (S.settings.glass !== false) root.dataset.glass = ''; else delete root.dataset.glass;
  root.dataset.cols = S.settings.cols || 3;
  try { localStorage.setItem('rotation-glass', S.settings.glass !== false ? '1' : '0'); } catch { }
  $('meta[name=theme-color]').content = THEME_BAR[t] || THEME_BAR[matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'];
  try { localStorage.setItem('rotation-theme', t); } catch { }   // read by index.html before first paint
}

/* ---------- start ---------- */
(async function start() {
  try { await load(); } catch (e) { view().innerHTML = `<div class="empty">This browser blocked local storage, so Rotation can’t save. (${esc(e.message || e)})</div>`; return; }
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);   // "Match phone" follows the phone's light/dark switch
  // The page never scrolls (main does). If iOS nudges it anyway when the keyboard opens, put it back when focus leaves.
  // (Sizing sheets from window.visualViewport was tried and dropped: the iPhone home-screen app reported wrong sizes.)
  document.addEventListener('focusout', () => setTimeout(() => { if (scrollY || document.documentElement.scrollTop) scrollTo(0, 0); }, 60));
  $$('.tabs button').forEach(b => b.onclick = () => go(b.dataset.tab));
  $('#sync').onclick = () => { if (S.settings.clientId) backupNow(true); else go('settings'); };
  window.addEventListener('online', () => { renderSync(); scheduleBackup(); });
  window.addEventListener('offline', () => renderSync());
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
  renderSync(); go(S.items.length ? 'log' : 'closet');
  const back = Drive.fromRedirect(), after = back?.after;
  // back from Google: return to the screen the sign-in started from, then finish what it was for
  if (after) { go(back.tab || 'settings'); renderSync(); if (after === 'backup') backupNow(true); else if (after === 'restore') restoreFromDrive(); else { toast('Connected to Google Drive'); scheduleBackup(); } }
  $('#title').insertAdjacentHTML('beforeend', ` <button class="ver" id="ver" type="button" title="Check for updates">v${VERSION}</button>`);
  $('#ver').onclick = async () => { toast('Version ' + VERSION + ' · checking for updates…'); try { await (await navigator.serviceWorker?.getRegistration())?.update(); } catch { } };
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // when a new version takes over, reload into it (unless a sheet is open, so nothing typed is lost)
    const hadController = !!navigator.serviceWorker.controller; let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      if ($('#modal').hidden) { reloading = true; location.reload(); } else toast('Update ready. Close this and reopen the app to get it.');
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // swipe left/right: next/previous day on Log, month on Calendar (not on sideways-scrolling chips or fields)
  let swipe = null;
  view().addEventListener('touchstart', e => {
    swipe = e.touches.length === 1 && !e.target.closest('.chips, input, textarea, select') ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp } : null;
  }, { passive: true });
  view().addEventListener('touchend', e => {
    if (!swipe || !$('#modal').hidden) return;
    const t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y, quick = e.timeStamp - swipe.t < 800; swipe = null;
    if (!quick || Math.abs(dx) < 60 || Math.abs(dx) < 2 * Math.abs(dy)) return;
    const step = dx < 0 ? 1 : -1;
    if (tab === 'log') { logState.date = addDays(logState.date, step); if (!logState.draft?.editingId) logState.draft = newDraft(logState.draft?.templateId); renderLog(); }
    else if (tab === 'calendar') { const [y, m] = cal.month.split('-').map(Number); cal.month = fmt(new Date(y, m - 1 + step, 1)).slice(0, 7); renderCalendar(); }
  }, { passive: true });
  // iOS can still zoom on a quick double tap: stop the zoom but keep the second tap as a tap
  let lastTap = 0, startXY = null;
  document.addEventListener('touchstart', e => { const t = e.touches[0]; startXY = e.touches.length === 1 ? [t.clientX, t.clientY] : null; }, { passive: true });
  document.addEventListener('touchend', e => {
    const t = e.changedTouches[0], still = startXY && Math.hypot(t.clientX - startXY[0], t.clientY - startXY[1]) < 10;
    if (!still) return;
    if (e.timeStamp - lastTap < 350 && !e.target.closest('input, textarea, select')) { e.preventDefault(); e.target.click(); }
    lastTap = e.timeStamp;
  }, { passive: false });
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
})();
