// router.js — URL hash ⇄ route.  #/world/us/ai-compute  (planet path)   #/stock/MU  (stock view)
// The first segment is the tree's root id ('world', or 'fm-world' on the full-market map).
// A hash can be anything the owner (or a stray link) typed: a malformed %-escape never throws — each segment is
// decoded on its own and a broken one is dropped, so a bad URL can never keep the app on the loading screen.
import { rootId } from '../data.js';

const dec = (seg) => { try { return decodeURIComponent(seg); } catch (e) { return null; } };

export function parseHash(hash = location.hash) {
  let raw = '';
  try { raw = String(hash || '').replace(/^#\/?/, ''); } catch (e) { raw = ''; }
  const parts = raw.split('/').map(dec).filter((x) => x != null && x !== '');
  if (parts[0] === 'stock') {
    // '#/stock/MU', '#/stock/s:mu' → 'MU' (strip the node prefix before upper-casing)
    const t = String(parts[1] || '').replace(/^s:/i, '').trim().toUpperCase();
    if (t && /^[A-Z0-9.\-^=]{1,24}$/.test(t)) return { type: 'stock', ticker: t };
  }
  const root = rootId();
  if (!parts.length || parts[0] === 'stock') return { type: 'planet', path: [root] };
  if (parts[0] === 'world' && root !== 'world') parts[0] = root;
  if (parts[0] !== root) parts.unshift(root);
  return { type: 'planet', path: parts };
}

export const planetHash = (path) => '#/' + path.map(encodeURIComponent).join('/');
export const stockHash = (ticker) => '#/stock/' + encodeURIComponent(String(ticker).replace(/^s:/i, ''));

/** Change the URL. push=true adds a history entry (fires hashchange); false replaces silently. */
export function setHash(hash, push = true) {
  if (location.hash === hash) return false;
  if (push) { location.hash = hash; return true; }
  history.replaceState(history.state, '', hash);
  return false;
}
