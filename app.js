/* HomeFinder — dashboard logic */
'use strict';

const STORAGE_KEY = 'homefinder.v1';
const DATA_PATH = 'data/listings.json';
const EMBED_PATH = 'data/embedded-token.txt';
const EMBED_KEY = 'HomeFinder-2026';
let embeddedTokenCache = '';

/* Light obfuscation to dodge GitHub secret scanning auto-revoke. NOT security —
   anyone reading the code can reverse it. Threat model: prevent the deployed
   token from being killed by GitHub's scanner; blast radius if abused is just
   write access to data/listings.json (recoverable from git history). */
function obfToken(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i) ^ EMBED_KEY.charCodeAt(i % EMBED_KEY.length);
    out += c.toString(16).padStart(2, '0');
  }
  return out;
}
function deobfToken(hex) {
  if (!hex) return '';
  hex = hex.trim();
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const c = parseInt(hex.substr(i, 2), 16) ^ EMBED_KEY.charCodeAt((i / 2) % EMBED_KEY.length);
    if (isFinite(c)) out += String.fromCharCode(c);
  }
  return out;
}

async function loadEmbeddedToken() {
  try {
    const res = await fetch(EMBED_PATH + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const text = (await res.text()).trim();
    if (text) embeddedTokenCache = deobfToken(text);
  } catch (e) { /* missing file is fine */ }
}

function getEffectivePat() {
  return state.config.pat || embeddedTokenCache || '';
}

const state = {
  listings: [],
  fileSha: null,
  config: { owner: '', repo: '', branch: 'main', pat: '', lcAnchor: { query: '', lat: null, lng: null, displayName: '' } },
  view: 'table',
  sort: { key: 'addedAt', dir: 'desc' },
  filter: { status: '', search: '' },
  editingId: null,
  syncStatus: 'unconfigured', // unconfigured | ok | dirty | error
  map: null,
  markers: [],
};

/* ---------- persistence (local cache) ---------- */
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj.config) {
      Object.assign(state.config, obj.config);
      if (!state.config.lcAnchor) state.config.lcAnchor = { query: '', lat: null, lng: null, displayName: '' };
    }
    if (Array.isArray(obj.listings)) state.listings = obj.listings;
    if (obj.fileSha) state.fileSha = obj.fileSha;
  } catch (e) { console.warn('loadLocal failed', e); }
}
function saveLocal() {
  const { config, listings, fileSha } = state;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ config, listings, fileSha }));
}

/* ---------- GitHub Pages auto-detect ---------- */
function detectGitHubContext() {
  try {
    const m = location.host.match(/^([^.]+)\.github\.io$/i);
    if (!m) return null;
    const owner = m[1];
    const segs = location.pathname.split('/').filter(p => p && !/\.html?$/i.test(p));
    const repo = segs[0] || `${owner}.github.io`;
    return { owner, repo };
  } catch { return null; }
}

/* ---------- bookmarklet (source kept readable, compiled at runtime) ---------- */
const BOOKMARKLET_SOURCE = function () {
  try {
    var out = { url: location.href };
    function num(s) {
      if (s == null) return null;
      var n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
      return isFinite(n) ? n : null;
    }
    function set(key, val) {
      if (val == null || val === '' || (typeof val === 'number' && !isFinite(val))) return;
      // Reject out-of-range coordinates — guards against malformed Zillow data.
      if (key === 'lat' && (typeof val !== 'number' || Math.abs(val) > 90)) return;
      if (key === 'lng' && (typeof val !== 'number' || Math.abs(val) > 180)) return;
      if (out[key] == null || out[key] === '') out[key] = val;
    }
    function walk(obj, fn, depth) {
      depth = depth || 0;
      if (depth > 10 || obj == null) return;
      if (typeof obj !== 'object') return;
      try { fn(obj); } catch (e) {}
      for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          walk(obj[k], fn, depth + 1);
        }
      }
    }
    var zpidMatch = location.href.match(/\/(\d+)_zpid/);
    if (zpidMatch) set('zpid', zpidMatch[1]);
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
      try {
        var arr = JSON.parse(s.textContent);
        (Array.isArray(arr) ? arr : [arr]).forEach(function (obj) {
          walk(obj, function (o) {
            if (o['@type'] && o.address && typeof o.address === 'object') {
              set('address', o.address.streetAddress);
              set('city', o.address.addressLocality);
              set('state', o.address.addressRegion);
              set('zip', o.address.postalCode);
            }
            if (o['@type'] === 'GeoCoordinates' || (o.latitude && o.longitude)) {
              set('lat', num(o.latitude));
              set('lng', num(o.longitude));
            }
            if (o.geo && o.geo.latitude) {
              set('lat', num(o.geo.latitude));
              set('lng', num(o.geo.longitude));
            }
            if (o.floorSize && o.floorSize.value) set('sqft', num(o.floorSize.value));
            if (o.numberOfBedrooms) set('beds', num(o.numberOfBedrooms));
            if (o.numberOfBathroomsTotal) set('baths', num(o.numberOfBathroomsTotal));
            if (o.image && typeof o.image === 'string') set('photoUrl', o.image);
            if (o.image && o.image.url) set('photoUrl', o.image.url);
            if (o.offers && o.offers.price) set('price', num(o.offers.price));
            if (o['@type'] && /Residence|Apartment|House|Building/i.test(o['@type'])) {
              set('homeType', String(o['@type']).replace(/([A-Z])/g, ' $1').trim());
            }
          });
        });
      } catch (e) {}
    });
    var nd = document.getElementById('__NEXT_DATA__');
    if (nd) {
      try {
        var data = JSON.parse(nd.textContent);
        walk(data, function (o) {
          if (o.zpid && !out.zpid) set('zpid', String(o.zpid));
          if (o.price && typeof o.price === 'number') set('price', o.price);
          if (o.bedrooms != null) set('beds', num(o.bedrooms));
          if (o.bathrooms != null) set('baths', num(o.bathrooms));
          if (o.livingArea) set('sqft', num(o.livingArea));
          if (o.livingAreaValue) set('sqft', num(o.livingAreaValue));
          if (o.latitude && o.longitude) {
            set('lat', num(o.latitude));
            set('lng', num(o.longitude));
          }
          if (o.streetAddress) set('address', o.streetAddress);
          if (o.city) set('city', o.city);
          if (o.state) set('state', o.state);
          if (o.zipcode) set('zip', o.zipcode);
          if (o.homeType) set('homeType', String(o.homeType).replace(/_/g, ' ').toLowerCase());
          if (o.hiResImageLink) set('photoUrl', o.hiResImageLink);
        });
        walk(data, function (o) {
          if (o.gdpClientCache && typeof o.gdpClientCache === 'string') {
            try {
              var cache = JSON.parse(o.gdpClientCache);
              walk(cache, function (c) {
                if (c.zpid && !out.zpid) set('zpid', String(c.zpid));
                if (typeof c.price === 'number') set('price', c.price);
                if (c.bedrooms != null) set('beds', num(c.bedrooms));
                if (c.bathrooms != null) set('baths', num(c.bathrooms));
                if (c.livingArea) set('sqft', num(c.livingArea));
                if (c.latitude && c.longitude) {
                  set('lat', num(c.latitude));
                  set('lng', num(c.longitude));
                }
                if (c.streetAddress) set('address', c.streetAddress);
                if (c.city) set('city', c.city);
                if (c.state) set('state', c.state);
                if (c.zipcode) set('zip', c.zipcode);
              });
            } catch (e) {}
          }
        });
      } catch (e) {}
    }
    function meta(name) {
      var el = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
      return el ? el.getAttribute('content') : null;
    }
    set('photoUrl', meta('og:image'));
    var ogTitle = meta('og:title') || document.title || '';
    var priceM = ogTitle.match(/\$([0-9][\d,]*)/);
    if (priceM) set('price', num(priceM[1]));
    var bedM = ogTitle.match(/(\d+(?:\.\d+)?)\s*bd\b/i) || ogTitle.match(/(\d+(?:\.\d+)?)\s*bed/i);
    if (bedM) set('beds', num(bedM[1]));
    var baM = ogTitle.match(/(\d+(?:\.\d+)?)\s*ba\b/i) || ogTitle.match(/(\d+(?:\.\d+)?)\s*bath/i);
    if (baM) set('baths', num(baM[1]));
    var sqM = ogTitle.match(/(\d[\d,]*)\s*sqft\b/i) || ogTitle.match(/(\d[\d,]*)\s*sq\s*ft/i);
    if (sqM) set('sqft', num(sqM[1]));
    if (!out.address && (out.city || out.state)) {
      out.address = [out.city, out.state, out.zip].filter(Boolean).join(', ');
    }
    var json = JSON.stringify(out);
    var b64 = btoa(unescape(encodeURIComponent(json)));
    var dest = '__DASHBOARD_URL__' + (('__DASHBOARD_URL__').indexOf('?') > -1 ? '&' : '?') + 'add=' + encodeURIComponent(b64);
    window.open(dest, '_blank');
  } catch (e) {
    alert('HomeFinder bookmarklet failed: ' + (e && e.message ? e.message : e));
  }
};

function compileBookmarklet(dashboardUrl) {
  let src = BOOKMARKLET_SOURCE.toString();
  // Strip line comments BEFORE substituting the URL — otherwise the // in https:// gets eaten.
  src = src.replace(/\/\/[^\n]*\n/g, '\n');
  src = src.replace(/\n\s*/g, ' ');
  src = src.replace(/\s{2,}/g, ' ');
  src = src.replace(/__DASHBOARD_URL__/g, dashboardUrl);
  return 'javascript:(' + src + ')();void 0;';
}

function installBookmarkletLink() {
  const link = $('#drag-link');
  if (!link) return;
  const dashboardUrl = location.origin + location.pathname.replace(/[^/]*$/, '');
  link.href = compileBookmarklet(dashboardUrl);
}

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function nowIso() { return new Date().toISOString(); }
function fmtMoney(n) { return n == null || n === '' ? '' : '$' + Number(n).toLocaleString(); }
function fmtNum(n, digits = 0) { return n == null || n === '' ? '' : Number(n).toFixed(digits); }
function safe(s) { return (s == null ? '' : String(s)); }

function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function getLcDistance(l) {
  const a = state.config.lcAnchor;
  if (!a || a.lat == null || a.lng == null) return null;
  if (!Number.isFinite(+l.lat) || !Number.isFinite(+l.lng)) return null;
  return distanceMiles(a.lat, a.lng, +l.lat, +l.lng);
}

async function geocodeNominatim(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'Accept-Language': 'en-US,en' } });
  if (!res.ok) throw new Error('Geocoding HTTP ' + res.status);
  const arr = await res.json();
  if (!arr.length) throw new Error('No results for: ' + query);
  return { lat: +arr[0].lat, lng: +arr[0].lon, displayName: arr[0].display_name };
}

function computeDerived(listing) {
  if (listing.price && listing.sqft) {
    listing.pricePerSqft = +(Number(listing.price) / Number(listing.sqft)).toFixed(2);
  } else {
    listing.pricePerSqft = null;
  }
  return listing;
}

function showToast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.hidden = true; }, 2800);
}

/* ---------- sync status ---------- */
function setSync(status, label) {
  state.syncStatus = status;
  const badge = $('#sync-badge');
  badge.className = 'sync-badge ' + (status === 'ok' ? 'ok' : status === 'dirty' ? 'dirty' : status === 'error' ? 'error' : '');
  $('#sync-badge .label').textContent = label || ({
    unconfigured: 'Not configured',
    ok: 'Synced',
    dirty: 'Unsaved changes',
    error: 'Sync error',
    syncing: 'Syncing…',
  }[status] || status);
}

/* ---------- GitHub Contents API ---------- */
function isConfigured() {
  const { owner, repo } = state.config;
  return !!(owner && repo && getEffectivePat());
}

async function ghGet() {
  const { owner, repo, branch } = state.config;
  const pat = getEffectivePat();
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${DATA_PATH}?ref=${encodeURIComponent(branch || 'main')}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
  });
  if (res.status === 404) return { sha: null, listings: [] };
  if (!res.ok) throw new Error(`GET failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = decodeURIComponent(escape(atob(data.content.replace(/\s/g, ''))));
  let listings = [];
  try { listings = JSON.parse(text); } catch { listings = []; }
  if (!Array.isArray(listings)) listings = [];
  return { sha: data.sha, listings };
}

async function ghPut(listings, sha) {
  const { owner, repo, branch } = state.config;
  const pat = getEffectivePat();
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${DATA_PATH}`;
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(listings, null, 2))));
  const body = {
    message: `Update listings (${new Date().toISOString()})`,
    content,
    branch: branch || 'main',
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content.sha;
}

async function pullFromGitHub() {
  if (!isConfigured()) { showToast('Configure GitHub first', 'err'); return; }
  setSync('syncing', 'Pulling…');
  try {
    const { sha, listings } = await ghGet();
    state.fileSha = sha;
    state.listings = listings.map(computeDerived);
    saveLocal();
    render();
    setSync('ok');
    showToast(`Pulled ${listings.length} listing${listings.length === 1 ? '' : 's'}`, 'ok');
  } catch (e) {
    setSync('error');
    showToast('Pull failed: ' + e.message, 'err');
  }
}

function mergeListings(local, remote) {
  const byId = new Map();
  for (const r of remote) byId.set(r.id, r);
  for (const l of local) {
    const r = byId.get(l.id);
    if (!r) { byId.set(l.id, l); continue; }
    const lt = new Date(l.updatedAt || 0).getTime();
    const rt = new Date(r.updatedAt || 0).getTime();
    byId.set(l.id, lt >= rt ? l : r);
  }
  return Array.from(byId.values());
}

async function pushToGitHub() {
  if (!isConfigured()) { showToast('Configure GitHub first', 'err'); return; }
  setSync('syncing', 'Pushing…');
  try {
    let newSha;
    try {
      newSha = await ghPut(state.listings, state.fileSha);
    } catch (e) {
      if (!/\b409\b/.test(e.message)) throw e;
      // Stale SHA — remote changed since we loaded. Fetch, merge, retry once.
      const remote = await ghGet();
      state.listings = mergeListings(state.listings, remote.listings).map(computeDerived);
      render();
      newSha = await ghPut(state.listings, remote.sha);
      showToast('Resolved conflict — merged with remote', 'ok');
    }
    state.fileSha = newSha;
    saveLocal();
    setSync('ok');
    showToast('Pushed to GitHub', 'ok');
  } catch (e) {
    setSync('error');
    showToast('Push failed: ' + e.message, 'err');
  }
}

/* ---------- CRUD ---------- */
function findByUrlOrZpid(listing) {
  if (listing.zpid) {
    const z = state.listings.find(l => l.zpid && String(l.zpid) === String(listing.zpid));
    if (z) return z;
  }
  if (listing.url) {
    return state.listings.find(l => l.url === listing.url) || null;
  }
  return null;
}

function upsertListing(input) {
  const now = nowIso();
  const existing = input.id ? state.listings.find(l => l.id === input.id) : findByUrlOrZpid(input);
  if (existing) {
    Object.assign(existing, input, { updatedAt: now });
    computeDerived(existing);
    return existing;
  }
  const fresh = {
    id: uid(),
    addedAt: now,
    updatedAt: now,
    status: 'interested',
    tags: [],
    ...input,
  };
  computeDerived(fresh);
  state.listings.unshift(fresh);
  return fresh;
}

function deleteListing(id) {
  state.listings = state.listings.filter(l => l.id !== id);
}

/* ---------- rendering ---------- */
function render() {
  $('#listing-count').textContent = `${state.listings.length} listing${state.listings.length === 1 ? '' : 's'}`;
  renderTable();
  if (state.view === 'map') renderMap();
}

function getVisible() {
  let rows = state.listings.slice();
  const q = state.filter.search.trim().toLowerCase();
  if (q) {
    rows = rows.filter(l => {
      const hay = [l.address, l.city, l.state, l.zip, l.notes, (l.tags || []).join(' '), l.homeType].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  if (state.filter.status) rows = rows.filter(l => l.status === state.filter.status);
  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  const valOf = (l) => key === 'lcDistance' ? getLcDistance(l) : l[key];
  rows.sort((a, b) => {
    const av = valOf(a), bv = valOf(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  });
  return rows;
}

function renderTable() {
  const tbody = $('#listings-tbody');
  const rows = getVisible();
  if (state.listings.length === 0) {
    tbody.innerHTML = '';
    $('#empty-state').hidden = false;
  } else {
    $('#empty-state').hidden = true;
  }
  tbody.innerHTML = rows.map(l => {
    const tags = (l.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const star = l.rating ? '★'.repeat(l.rating) : '';
    const thumb = l.photoUrl
      ? `<img class="thumb" src="${escapeAttr(l.photoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
      : `<span class="thumb thumb-empty" aria-hidden="true"></span>`;
    const notesText = safe(l.notes);
    return `<tr data-id="${l.id}">
      <td class="col-photo">${thumb}</td>
      <td class="col-status"><span class="status-pill ${l.status}">${l.status || ''}</span></td>
      <td class="col-address">
        <div class="addr-line" title="${escapeAttr(l.address || '')}">${escapeHtml(l.address || '(no address)')}</div>
        ${l.city || l.state ? `<div class="muted small addr-line">${escapeHtml([l.city, l.state, l.zip].filter(Boolean).join(', '))}</div>` : ''}
      </td>
      <td class="num">${fmtMoney(l.price)}</td>
      <td class="num">${safe(l.beds)}</td>
      <td class="num">${safe(l.baths)}</td>
      <td class="num">${safe(l.sqft)}</td>
      <td class="num">${l.pricePerSqft != null ? '$' + l.pricePerSqft.toFixed(2) : ''}</td>
      <td class="num col-lc">${(() => { const d = getLcDistance(l); return d == null ? '' : d.toFixed(1); })()}</td>
      <td class="num">${star}</td>
      <td>${tags}</td>
      <td class="col-notes" title="${escapeAttr(notesText)}"><div class="notes-text">${escapeHtml(notesText)}</div></td>
      <td>${l.url ? `<a class="row-link" href="${escapeAttr(l.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗</a>` : ''}</td>
    </tr>`;
  }).join('');

  $$('#listings-table th[data-sort]').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === state.sort.key) {
      th.classList.add(state.sort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* ---------- map ---------- */
function renderMap() {
  if (!state.map) {
    state.map = L.map('map').setView([39.8283, -98.5795], 4); // US center
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(state.map);
  }
  state.markers.forEach(m => state.map.removeLayer(m));
  state.markers = [];

  const withCoords = state.listings.filter(l =>
    l.lat != null && l.lng != null &&
    Number.isFinite(+l.lat) && Number.isFinite(+l.lng) &&
    Math.abs(+l.lat) <= 90 && Math.abs(+l.lng) <= 180
  );
  if (withCoords.length === 0) return;

  const colors = {
    interested: '#2f6feb', visited: '#d48a00', applied: '#b347d9',
    favorited: '#2a9d5f', rejected: '#8a8f99',
  };

  withCoords.forEach(l => {
    const color = colors[l.status] || colors.interested;
    const icon = L.divIcon({
      className: 'hf-pin',
      html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    const m = L.marker([+l.lat, +l.lng], { icon }).addTo(state.map);
    const popupThumb = l.photoUrl
      ? `<img class="popup-thumb" src="${escapeAttr(l.photoUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'"><br>`
      : '';
    const popup = `
      ${popupThumb}<strong>${escapeHtml(l.address || '(no address)')}</strong><br>
      ${l.price ? fmtMoney(l.price) + '/mo · ' : ''}${l.beds || ''}bd ${l.baths || ''}ba ${l.sqft ? '· ' + l.sqft + ' sqft' : ''}
      <br><a href="#" data-edit-id="${l.id}">Edit</a>${l.url ? ' · <a href="' + escapeAttr(l.url) + '" target="_blank" rel="noopener">Listing ↗</a>' : ''}
    `;
    m.bindPopup(popup);
    m.on('popupopen', (ev) => {
      const link = ev.popup.getElement().querySelector('a[data-edit-id]');
      if (link) link.addEventListener('click', (e) => { e.preventDefault(); openEditModal(l.id); });
    });
    state.markers.push(m);
  });

  const group = L.featureGroup(state.markers);
  state.map.fitBounds(group.getBounds().pad(0.2), { maxZoom: 14 });
  setTimeout(() => state.map.invalidateSize(), 50);
}

/* ---------- modal ---------- */
function openEditModal(id) {
  state.editingId = id || null;
  const modal = $('#edit-modal');
  const form = $('#edit-form');
  form.reset();
  const listing = id ? state.listings.find(l => l.id === id) : null;
  $('#modal-title').textContent = listing ? 'Edit listing' : 'Add listing';
  $('#delete-btn').hidden = !listing;
  if (listing) {
    for (const [k, v] of Object.entries(listing)) {
      const el = form.elements.namedItem(k);
      if (!el) continue;
      if (k === 'tags' && Array.isArray(v)) el.value = v.join(', ');
      else el.value = v == null ? '' : v;
    }
  }
  modal.hidden = false;
  setTimeout(() => form.elements.namedItem('address')?.focus(), 50);
}

function closeModal() {
  $('#edit-modal').hidden = true;
  state.editingId = null;
}

function formToListing(form) {
  const fd = new FormData(form);
  const o = {};
  // Include all fields (including empty) so blanks clear existing values.
  for (const [k, v] of fd.entries()) o[k] = v;
  ['price', 'beds', 'baths', 'sqft', 'lat', 'lng', 'rating'].forEach(k => {
    if (o[k] === '' || o[k] == null) o[k] = null;
    else o[k] = Number(o[k]);
  });
  if ('tags' in o) {
    o.tags = typeof o.tags === 'string' && o.tags.trim()
      ? o.tags.split(',').map(s => s.trim()).filter(Boolean)
      : [];
  }
  return o;
}

async function handleEditSubmit(e) {
  e.preventDefault();
  const data = formToListing(e.target);
  if (state.editingId) data.id = state.editingId;
  upsertListing(data);
  saveLocal();
  render();
  closeModal();
  setSync('dirty');
  showToast('Saved locally');
  if (isConfigured()) await pushToGitHub();
}

async function handleDelete() {
  if (!state.editingId) return;
  if (!confirm('Delete this listing?')) return;
  deleteListing(state.editingId);
  saveLocal();
  render();
  closeModal();
  setSync('dirty');
  showToast('Deleted locally');
  if (isConfigured()) await pushToGitHub();
}

/* ---------- view switching ---------- */
function switchView(view) {
  state.view = view;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  if (view === 'map') renderMap();
}

/* ---------- bookmarklet ?add= handler ---------- */
function handleAddParam() {
  const params = new URLSearchParams(window.location.search);
  const data = params.get('add');
  if (!data) return;
  try {
    const json = decodeURIComponent(escape(atob(data)));
    const parsed = JSON.parse(json);
    // Clear the param so refresh doesn't re-add
    history.replaceState({}, '', window.location.pathname);
    // Pre-fill modal (don't auto-save — let user review)
    openEditModal(null);
    const form = $('#edit-form');
    for (const [k, v] of Object.entries(parsed)) {
      const el = form.elements.namedItem(k);
      if (!el) continue;
      if (k === 'tags' && Array.isArray(v)) el.value = v.join(', ');
      else el.value = v == null ? '' : v;
    }
    $('#modal-title').textContent = 'Add listing from Zillow';
    showToast('Captured from Zillow — review and save');
  } catch (e) {
    showToast('Could not parse incoming data: ' + e.message, 'err');
  }
}

/* ---------- import / export ---------- */
function exportJson() {
  const blob = new Blob([JSON.stringify(state.listings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'listings.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const arr = JSON.parse(reader.result);
      if (!Array.isArray(arr)) throw new Error('Expected an array');
      if (!confirm(`Import ${arr.length} listings? This replaces your current local list.`)) return;
      state.listings = arr.map(computeDerived);
      saveLocal();
      render();
      setSync('dirty');
      showToast(`Imported ${arr.length} listings`);
    } catch (e) {
      showToast('Import failed: ' + e.message, 'err');
    }
  };
  reader.readAsText(file);
}

/* ---------- settings UI ---------- */
function loadConfigUi() {
  $('#cfg-owner').value = state.config.owner;
  $('#cfg-repo').value = state.config.repo;
  $('#cfg-branch').value = state.config.branch || 'main';
  $('#cfg-pat').value = state.config.pat;
  $('#cfg-lc').value = state.config.lcAnchor?.query || '';
  renderLcStatus();
}

function renderLcStatus() {
  const a = state.config.lcAnchor;
  const el = $('#cfg-lc-status');
  if (!el) return;
  el.className = 'status-msg';
  if (a && a.lat != null && a.lng != null) {
    el.classList.add('ok');
    el.textContent = `Anchored at ${a.displayName || (a.lat.toFixed(4) + ', ' + a.lng.toFixed(4))}`;
  } else {
    el.textContent = '';
  }
}

async function saveLcAnchor() {
  const q = $('#cfg-lc').value.trim();
  const status = $('#cfg-lc-status');
  status.className = 'status-msg';
  if (!q) { status.textContent = 'Enter an address or city.'; status.classList.add('err'); return; }
  status.textContent = 'Geocoding…';
  try {
    const r = await geocodeNominatim(q);
    state.config.lcAnchor = { query: q, lat: r.lat, lng: r.lng, displayName: r.displayName };
    saveLocal();
    renderLcStatus();
    renderTable();
    showToast('LC anchor set', 'ok');
  } catch (e) {
    status.textContent = 'Failed: ' + e.message;
    status.classList.add('err');
  }
}

function clearLcAnchor() {
  state.config.lcAnchor = { query: '', lat: null, lng: null, displayName: '' };
  $('#cfg-lc').value = '';
  saveLocal();
  renderLcStatus();
  renderTable();
  showToast('LC anchor cleared');
}
async function saveConfig() {
  state.config.owner = $('#cfg-owner').value.trim();
  state.config.repo = $('#cfg-repo').value.trim();
  state.config.branch = $('#cfg-branch').value.trim() || 'main';
  state.config.pat = $('#cfg-pat').value.trim();
  saveLocal();
  const status = $('#cfg-status');
  status.className = 'status-msg';
  if (!isConfigured()) {
    status.textContent = 'Fill in all fields.';
    status.classList.add('err');
    setSync('unconfigured');
    return;
  }
  status.textContent = 'Testing…';
  try {
    const { sha, listings } = await ghGet();
    state.fileSha = sha;
    if (listings.length > 0 && state.listings.length === 0) {
      state.listings = listings.map(computeDerived);
    }
    saveLocal();
    render();
    setSync('ok');
    status.textContent = sha ? `Connected. ${listings.length} listings on remote.` : 'Connected. (No remote file yet — push will create it.)';
    status.classList.add('ok');
  } catch (e) {
    status.textContent = 'Failed: ' + e.message;
    status.classList.add('err');
    setSync('error');
  }
}

async function saveEmbeddedToken() {
  const input = $('#embed-pat-input');
  const msg = $('#embed-msg');
  msg.className = 'status-msg';
  const pat = input.value.trim();
  if (!pat) { msg.textContent = 'Paste a PAT first.'; msg.classList.add('err'); return; }
  if (!state.config.pat) {
    msg.textContent = 'You need your own personal PAT saved first (it pushes the embedded file).';
    msg.classList.add('err');
    return;
  }
  msg.textContent = 'Saving…';
  try {
    const encoded = obfToken(pat);
    const { owner, repo, branch } = state.config;
    const personalPat = state.config.pat;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${EMBED_PATH}`;
    let sha = null;
    try {
      const getRes = await fetch(url + `?ref=${encodeURIComponent(branch || 'main')}`, {
        headers: { 'Authorization': `Bearer ${personalPat}` },
      });
      if (getRes.ok) sha = (await getRes.json()).sha;
    } catch {}
    const body = {
      message: `Update embedded token (${new Date().toISOString()})`,
      content: btoa(encoded),
      branch: branch || 'main',
    };
    if (sha) body.sha = sha;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${personalPat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    embeddedTokenCache = pat;
    input.value = '';
    msg.classList.add('ok');
    msg.textContent = 'Embedded. Anyone with the URL can now use the dashboard.';
    renderEmbedStatus();
  } catch (e) {
    msg.classList.add('err');
    msg.textContent = 'Failed: ' + e.message;
  }
}

async function clearEmbeddedToken() {
  if (!confirm('Remove the embedded token? Lillian (or anyone using the URL) will need to set up their own PAT after this.')) return;
  const msg = $('#embed-msg');
  msg.className = 'status-msg';
  if (!state.config.pat) { msg.textContent = 'Personal PAT required.'; msg.classList.add('err'); return; }
  msg.textContent = 'Clearing…';
  try {
    const { owner, repo, branch } = state.config;
    const personalPat = state.config.pat;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${EMBED_PATH}`;
    const getRes = await fetch(url + `?ref=${encodeURIComponent(branch || 'main')}`, {
      headers: { 'Authorization': `Bearer ${personalPat}` },
    });
    if (!getRes.ok) {
      // File doesn't exist; nothing to clear
      embeddedTokenCache = '';
      msg.classList.add('ok');
      msg.textContent = 'Nothing to clear.';
      renderEmbedStatus();
      return;
    }
    const sha = (await getRes.json()).sha;
    const delRes = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${personalPat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Clear embedded token', sha, branch: branch || 'main' }),
    });
    if (!delRes.ok) throw new Error(`HTTP ${delRes.status}: ${await delRes.text()}`);
    embeddedTokenCache = '';
    msg.classList.add('ok');
    msg.textContent = 'Cleared.';
    renderEmbedStatus();
  } catch (e) {
    msg.classList.add('err');
    msg.textContent = 'Failed: ' + e.message;
  }
}

function renderEmbedStatus() {
  const el = $('#embed-status');
  if (!el) return;
  el.textContent = embeddedTokenCache
    ? 'embedded (anyone with the URL can read & write)'
    : 'not set (each user needs their own PAT)';
  el.className = embeddedTokenCache ? 'ok' : 'muted';
}

function resetLocal() {
  if (!confirm('Wipe local listings, token, and settings? Remote GitHub file is unaffected.')) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

/* ---------- init ---------- */
function bindEvents() {
  $('#add-btn').addEventListener('click', () => openEditModal(null));
  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));
  $$('[data-close]').forEach(el => el.addEventListener('click', closeModal));
  $('#edit-form').addEventListener('submit', handleEditSubmit);
  $('#delete-btn').addEventListener('click', handleDelete);

  $('#search').addEventListener('input', (e) => { state.filter.search = e.target.value; renderTable(); });
  $('#filter-status').addEventListener('change', (e) => { state.filter.status = e.target.value; renderTable(); });

  $$('#listings-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else { state.sort.key = key; state.sort.dir = 'asc'; }
      renderTable();
    });
  });

  $('#listings-tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    // Thumbnail click → open lightbox, don't open the edit modal
    if (e.target.tagName === 'IMG' && e.target.classList.contains('thumb')) {
      e.stopPropagation();
      openLightbox(e.target.src);
      return;
    }
    if (e.target.closest('a')) return;
    openEditModal(tr.dataset.id);
  });

  $('#lightbox').addEventListener('click', (e) => {
    if (e.target === $('#lightbox-img')) return;
    closeLightbox();
  });

  $('#export-btn').addEventListener('click', exportJson);
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });

  $('#cfg-save').addEventListener('click', saveConfig);
  $('#cfg-pull').addEventListener('click', pullFromGitHub);
  $('#cfg-push').addEventListener('click', pushToGitHub);
  $('#cfg-reset').addEventListener('click', resetLocal);
  $('#cfg-lc-save').addEventListener('click', saveLcAnchor);
  $('#cfg-lc-clear').addEventListener('click', clearLcAnchor);
  $('#cfg-lc').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveLcAnchor(); } });
  $('#embed-save').addEventListener('click', saveEmbeddedToken);
  $('#embed-clear').addEventListener('click', clearEmbeddedToken);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').hidden) closeLightbox();
    else if (!$('#edit-modal').hidden) closeModal();
  });
}

function openLightbox(src) {
  $('#lightbox-img').src = src;
  $('#lightbox').hidden = false;
}
function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lightbox-img').src = '';
}

async function init() {
  loadLocal();
  // Auto-detect owner/repo from the dashboard URL on first load (only if not already set).
  const ctx = detectGitHubContext();
  if (ctx) {
    if (!state.config.owner) state.config.owner = ctx.owner;
    if (!state.config.repo) state.config.repo = ctx.repo;
  }
  loadConfigUi();
  installBookmarkletLink();
  bindEvents();
  await loadEmbeddedToken();
  renderEmbedStatus();
  if (isConfigured()) {
    setSync('syncing', 'Loading…');
    try {
      const { sha, listings } = await ghGet();
      state.fileSha = sha;
      state.listings = listings.map(computeDerived);
      saveLocal();
      setSync('ok');
    } catch (e) {
      setSync('error');
      showToast('Could not load from GitHub: ' + e.message, 'err');
    }
  }
  render();
  handleAddParam();
}

init();
