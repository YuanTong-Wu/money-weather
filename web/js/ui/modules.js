// modules.js — loads the other agents' modules (planet.js, stock.js, words.js) by their §7 exports.
// If one is missing or incomplete, the matching piece of ui/stubs.js fills in, so the shell always runs.
// The 3D planet (planet3d.js, §22: same API as Planet) is loaded on demand by loadPlanet3D(): it pulls
// three.js through the import map in index.html, so a missing/broken 3D stack never blocks the 2D map.

const WORD_EXPORTS = ['windWord', 'tempWord', 'presWord', 'stormWord', 'frontWord', 'money', 'pct', 'describe',
  'surprise', 'attentionPicks', 'regionWeather', 'caster', 'tutorialCards', 'TERMS'];

let stubsP = null;
const stubs = () => (stubsP ||= import('./stubs.js'));

export async function loadModules() {
  const [p, s, w] = await Promise.allSettled([import('../planet.js'), import('../stock.js'), import('../words.js')]);
  const used = [];
  const out = {};

  if (p.status === 'fulfilled' && typeof p.value.Planet === 'function') out.Planet = p.value.Planet;
  else { out.Planet = (await stubs()).Planet; used.push('planet'); if (p.status === 'rejected') console.info('[shell] planet.js 未就绪:', p.reason?.message); }

  if (s.status === 'fulfilled' && typeof s.value.openStockView === 'function') out.openStockView = s.value.openStockView;
  else { out.openStockView = (await stubs()).openStockView; used.push('stock'); if (s.status === 'rejected') console.info('[shell] stock.js 未就绪:', s.reason?.message); }

  const real = w.status === 'fulfilled' ? w.value : {};
  const missing = WORD_EXPORTS.filter((k) => real[k] == null);
  if (missing.length) {
    const st = await stubs();
    out.W = Object.freeze({ ...Object.fromEntries(WORD_EXPORTS.map((k) => [k, st[k]])), ...real });
    used.push('words(' + missing.join(',') + ')');
  } else {
    out.W = real;
  }
  out.stubbed = used;
  if (used.length) console.info('[shell] 用了临时替身:', used.join(' '));
  return out;
}

let p3 = null;
/** The Planet3D class (planet3d.js), or throws with a readable reason (no WebGL2, import failed, …). */
export async function loadPlanet3D() {
  if (!p3) {
    p3 = import('../planet3d.js').then((m) => {
      const C = m.Planet3D || m.Planet || m.default;
      if (typeof C !== 'function') throw new Error('planet3d.js 没有导出 Planet3D');
      return C;
    });
    p3.catch(() => { p3 = null; });
  }
  const C = await p3;
  if (typeof C.isSupported === 'function' && !C.isSupported()) throw new Error('这台电脑的浏览器不支持 WebGL2');
  return C;
}
