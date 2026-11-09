// planet3d/assets.js — props made in the Blender workshop (web/assets/3d/*.glb, §22), with procedural
// low-poly toon stand-ins until those files exist. Only the geometry of the .glb is used: every prop is
// re-shaded with the planet's own toon material so the lighting stays one consistent system.
//
// Discovery: web/assets/3d/manifest.json, e.g.
//   {"clouds":["cloud_1.glb",…], "storm":"storm_cloud.glb", "arrowHead":"arrow_head.glb", "bolt":"bolt.glb"}
// (missing manifest → procedural props, no further requests).

import { THREE } from './core.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BASE = new URL('../../assets/3d/', import.meta.url).href;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A cumulus made of a few toon puffs, flat-bottomed, ~1 unit wide, origin at the base centre. */
function puffCloud(seed, { storm = false } = {}) {
  const rnd = rng(seed * 7919 + 17);
  const geos = [];
  const nBase = storm ? 5 : 3 + Math.floor(rnd() * 2);
  const spread = storm ? 0.5 : 0.42;
  for (let i = 0; i < nBase; i++) {
    const u = nBase === 1 ? 0 : i / (nBase - 1) - 0.5;
    const r = (storm ? 0.2 : 0.2) + rnd() * 0.07 + (0.5 - Math.abs(u)) * 0.12;
    const g = new THREE.IcosahedronGeometry(r, 3);
    g.translate(u * spread * 2 * 0.9, r * 0.55, (rnd() - 0.5) * 0.14);
    geos.push(g);
  }
  const nTop = storm ? 3 : 1 + Math.floor(rnd() * 2);
  for (let i = 0; i < nTop; i++) {
    const r = 0.2 + rnd() * 0.08;
    const g = new THREE.IcosahedronGeometry(r, 3);
    g.translate((rnd() - 0.5) * 0.36, 0.32 + rnd() * 0.12, (rnd() - 0.5) * 0.1);
    geos.push(g);
  }
  const geo = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  geos.forEach((g) => { if (g !== geo) g.dispose(); });
  // flatten the underside (classic anime cumulus); keep the puff normals for the 2-tone shading
  const p = geo.attributes.position, nrm = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < 0.05) {
      p.setY(i, 0.05 + (y - 0.05) * 0.18);
      nrm.setXYZ(i, nrm.getX(i) * 0.5, -0.85, nrm.getZ(i) * 0.5);
    }
    if (storm) p.setY(i, p.getY(i) * 0.78);
  }
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const w = bb.max.x - bb.min.x;
  geo.translate(-(bb.max.x + bb.min.x) / 2, -bb.min.y, -(bb.max.z + bb.min.z) / 2);
  geo.scale(1 / w, 1 / w, 1 / w);
  geo.computeBoundingSphere();
  return geo;
}

function arrowHead() {
  // a slightly flattened 4-sided arrow head reads crisper than a round cone in toon shading
  const g = new THREE.ConeGeometry(0.5, 1, 20, 1);
  g.translate(0, 0.5, 0); // base at y = 0, tip at y = 1
  return g;
}

let loaded = null;

/** Resolve the prop set: {clouds:[geo×5], storm: geo, arrowHead: geo, source:'glb'|'procedural'} */
export function loadProps() {
  if (loaded) return loaded;
  const proc = {
    clouds: [1, 2, 3, 4, 5].map((s) => puffCloud(s)),
    storm: puffCloud(11, { storm: true }),
    arrowHead: arrowHead(),
    source: 'procedural',
  };
  loaded = { now: proc, ready: Promise.resolve(proc) };
  loaded.ready = (async () => {
    let man = null;
    try {
      const r = await fetch(BASE + 'manifest.json', { cache: 'no-cache' });
      if (r.ok) man = await r.json();
    } catch (e) { /* no assets yet */ }
    if (!man) return proc;
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      // the art3d manifest: {assets: {"cloud_1.glb": {kind, nodes: {body, ink}}, …}}; older/simple form also accepted
      const entries = man.assets ? Object.entries(man.assets).map(([file, a]) => ({ file, ...a })) : [
        ...(man.clouds || []).map((file) => ({ file, kind: 'cloud' })),
        ...(man.storm ? [{ file: man.storm, kind: 'storm' }] : []),
        ...(man.arrowHead ? [{ file: man.arrowHead, kind: 'channel' }] : []),
      ];
      /** geometry of the body mesh only (the toon shading + ink hull are ours) */
      const geoOf = async (e, normalise = true) => {
        const gltf = await loader.loadAsync(BASE + e.file);
        gltf.scene.updateMatrixWorld(true);
        const bodyName = e.nodes && e.nodes.body;
        const inkName = e.nodes && e.nodes.ink;
        const gs = [];
        gltf.scene.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          let n = o, isInk = false, isBody = false;
          while (n) { if (inkName && n.name === inkName) isInk = true; if (bodyName && n.name === bodyName) isBody = true; n = n.parent; }
          if (isInk || /_ink$/.test(o.name)) return;
          if (bodyName && !isBody && gs.length) return;
          const g = o.geometry.clone();
          g.applyMatrix4(o.matrixWorld);
          for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
          if (!g.attributes.normal) g.computeVertexNormals();
          gs.push(g.index ? g.toNonIndexed() : g);
        });
        if (!gs.length) return null;
        const g = gs.length === 1 ? gs[0] : mergeGeometries(gs, false);
        if (normalise) {
          g.computeBoundingBox();
          const bb = g.boundingBox;
          const w = Math.max(1e-6, bb.max.x - bb.min.x);
          g.translate(-(bb.max.x + bb.min.x) / 2, -bb.min.y, -(bb.max.z + bb.min.z) / 2);
          g.scale(1 / w, 1 / w, 1 / w);
        }
        g.computeBoundingSphere();
        return g;
      };
      const safe = (p) => p.catch((e) => { console.warn('[planet3d] glb', e && e.message); return null; });
      // cloud_2 is too flat (reads as a squashed blob from the 3/4 view): left out of the Polymarket set
      const clouds = (await Promise.all(entries.filter((e) => e.kind === 'cloud' && !/cloud_2\.glb$/.test(e.file)).slice(0, 8).map((e) => safe(geoOf(e))))).filter(Boolean);
      const se = entries.find((e) => e.kind === 'storm');
      const storm = se ? await safe(geoOf(se)) : null;
      const he = entries.find((e) => e.kind === 'channel');
      const head = he ? await safe(geoOf(he, false)) : null; // origin = back edge middle, tip at +Z, +Y up
      const out = {
        clouds: clouds.length ? clouds : proc.clouds,
        storm: storm || proc.storm,
        arrowHead: head || proc.arrowHead,
        arrowFlat: !!head,
        source: clouds.length || storm || head ? 'glb' : 'procedural',
      };
      loaded.now = out;
      return out;
    } catch (e) {
      console.warn('[planet3d] assets/3d not usable, using procedural props:', e && e.message);
      return proc;
    }
  })();
  return loaded;
}
