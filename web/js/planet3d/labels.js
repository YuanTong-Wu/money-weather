// planet3d/labels.js — crisp HTML labels riding the 3D planet (CSS2DRenderer): territory names with a
// season glyph and an in/out mark, ①②③ spotlight cards (≤ 3, §6), the 主航道 caption (§8.1), 估 (§14),
// scenario badges (§9), pins. Greedy de-cluttering by priority every frame; nothing is a blurry texture.

import { THREE, darkAt, frame3, offsetDir } from './core.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { esc } from './fx.js';

const SW = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
function snow() {
  let d = '';
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 - Math.PI / 2, ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    const P = (r, s) => `${(10 + ux * r + px * s).toFixed(2)} ${(10 + uy * r + py * s).toFixed(2)}`;
    d += `M10 10L${P(7.3, 0)}M${P(6.9, 1.9)}L${P(5.0, 0)}L${P(6.9, -1.9)}`;
  }
  return `<path d="${d}"/>`;
}
const SEASON_SVG = {
  spring: '<path d="M10 17.2V9.8"/><path d="M10 11.4C10 8 7.6 6 4 6c0 3.4 2.4 5.4 6 5.4z"/><path d="M10 9.6c0-2.9 2.1-4.8 5.6-4.8 0 2.9-2.1 4.8-5.6 4.8z"/><path d="M6.4 17.2h7.2"/>',
  summer: '<circle cx="10" cy="10" r="3.3"/><path d="M10 2.4v1.9M10 15.7v1.9M2.4 10h1.9M15.7 10h1.9M4.6 4.6l1.35 1.35M14.05 14.05l1.35 1.35M4.6 15.4l1.35-1.35M14.05 5.95l1.35-1.35"/>',
  autumn: '<path d="M10 2.6l1.3 2.9 2.3-1.2-.4 3.4 2.9-.8-1.1 2.5 2.4 1-3.4 1.6.7 1.6-3.7-.6.3 2.7h-2.6l.3-2.7-3.7.6.7-1.6-3.4-1.6 2.4-1-1.1-2.5 2.9.8-.4-3.4 2.3 1.2z"/><path d="M10 15.7v2.4"/>',
  winter: snow(),
};
const SEASON_ZH = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
const ic = (key, size = 13) => `<svg class="p3-ic p3-${key}" viewBox="0 0 20 20" width="${size}" height="${size}" ${SW} aria-hidden="true">${SEASON_SVG[key]}</svg>`;

let styleDone = false;
export function injectStyle() {
  if (styleDone || typeof document === 'undefined') return;
  styleDone = true;
  const s = document.createElement('style');
  s.id = 'planet3d-style';
  s.textContent = `
.p3-layer{position:fixed;left:0;top:0;pointer-events:none;overflow:hidden;
  font-family:"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;font-feature-settings:"tnum" 1}
.p3-layer>div{pointer-events:none}
.p3-nw{white-space:nowrap}
.p3-lab{white-space:nowrap;transition:opacity .28s ease}
.p3-lab.p3-off{opacity:0!important}
.p3-in{display:flex;align-items:center;gap:3px;font-size:12.5px;font-weight:600;line-height:1.2;color:var(--p3-ink);letter-spacing:.02em;
  text-shadow:0 0 2px var(--p3-halo),0 0 2px var(--p3-halo),0 0 4px var(--p3-halo),0 0 1px var(--p3-halo)}
.p3-lab.p3-dk .p3-in{color:var(--p3-ink-dk);text-shadow:0 0 2px var(--p3-halo-dk),0 0 3px var(--p3-halo-dk),0 0 5px var(--p3-halo-dk)}
.p3-lab.p3-minor .p3-in{font-size:11.5px;font-weight:500}
.p3-lab.p3-tiny .p3-in{font-size:10.5px;font-weight:500}
.p3-city{white-space:nowrap;transition:opacity .4s ease}
.p3-city.p3-off{opacity:0!important}
.p3-city .p3-in{font-size:10.5px;font-weight:500;letter-spacing:.06em;opacity:.56;gap:4px}
.p3-city .p3-cdot{width:3px;height:3px;border-radius:50%;background:currentColor;flex:none;opacity:.8}
.p3-lab.p3-dim .p3-in{opacity:.38}
.p3-tk{font-size:.86em;font-weight:500;opacity:.72;margin-left:2px;letter-spacing:.03em;font-family:"SF Pro Text","Helvetica Neue",Inter,system-ui,sans-serif}
.p3-ic{flex:none;margin-right:1px}
.p3-spring{color:var(--p3-in)}.p3-summer{color:var(--p3-gold)}.p3-autumn{color:var(--p3-hot)}.p3-winter{color:var(--p3-cold)}
.p3-lab.p3-dk .p3-spring,.p3-lab.p3-dk .p3-summer,.p3-lab.p3-dk .p3-autumn,.p3-lab.p3-dk .p3-winter{color:var(--p3-ink-dk)}
.p3-tri{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;margin-left:2px}
.p3-tri.p3-up{border-bottom:6px solid var(--p3-in)}.p3-tri.p3-dn{border-top:6px solid var(--p3-out)}
.p3-est{font-size:10px;font-weight:600;line-height:1;padding:2px 3px;border-radius:3px;border:1px dashed currentColor;opacity:.85;margin-left:2px;text-shadow:none;background:var(--p3-halo)}
.p3-lab.p3-dk .p3-est{background:var(--p3-halo-dk)}
.p3-pin{font-size:10px;color:var(--p3-gold);margin-left:1px}
.p3-crowd{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;box-sizing:border-box;
  font-size:10.5px;font-weight:700;line-height:1;background:var(--p3-card);border:1.4px solid currentColor;text-shadow:none;margin-right:2px}
.p3-crowd.p3-hi{color:var(--p3-hot)}.p3-crowd.p3-lo{color:var(--p3-cold)}
.p3-badge{font-size:10.5px;font-weight:600;padding:1px 5px;border-radius:9px;margin-left:3px;text-shadow:none;background:var(--p3-card);border:1px solid var(--p3-card-line);color:var(--p3-card-ink)}
.p3-badge.p3-gapb{background:var(--p3-gold);color:#1f2a44;border-color:transparent}
.p3-lab.p3-spot .p3-in{flex-direction:column;align-items:flex-start;gap:1px;padding:5px 9px 6px 7px;border-radius:7px;
  background:var(--p3-card);border:1px solid var(--p3-card-line);box-shadow:0 1px 0 var(--p3-card-shadow);text-shadow:none;color:var(--p3-card-ink)}
.p3-lead{position:absolute;left:50%;top:50%;width:1px;height:1px;overflow:visible;pointer-events:none}
.p3-lead line{stroke:var(--p3-card-ink);stroke-width:1.4;stroke-opacity:.55;stroke-linecap:round}
.p3-lead circle{fill:var(--p3-card-ink);stroke:var(--p3-card);stroke-width:2}
.p3-lead .p3-ea{display:none;fill:var(--p3-card-ink);stroke:var(--p3-card);stroke-width:1.5;stroke-linejoin:round}
.p3-lab.p3-edge .p3-lead circle{display:none}
.p3-lab.p3-edge .p3-lead .p3-ea{display:inline}
.p3-lab.p3-edge .p3-lead line{stroke-dasharray:2 3}
.p3-to{display:none;white-space:nowrap;color:var(--p3-card-ink);font-weight:600}
.p3-lab.p3-edge .p3-to{display:inline}
.p3-lab .p3-in .p3-sfx{font-weight:450;opacity:.78;margin-left:1px}
.p3-lab .p3-in .p3-sfx:empty{display:none}
.p3-chan .p3-lead line{stroke:var(--p3-chan-lead);stroke-opacity:.7;stroke-width:1.3}
.p3-nlead line{stroke:var(--p3-ink);stroke-width:.9;stroke-opacity:.62}
.p3-nlead circle{fill:var(--p3-ink);stroke:none;opacity:.7}
.p3-lab.p3-part .p3-in{font-size:10.5px;font-weight:500;opacity:.78}
.p3-lab.p3-part .p3-pc{font-weight:400;opacity:.8;margin-left:1px}
.p3-clu .p3-in{display:block;padding:4px 8px 5px;border-radius:6px;background:var(--p3-card);border:1px solid var(--p3-card-line);
  box-shadow:0 1px 0 var(--p3-card-shadow);text-shadow:none;color:var(--p3-card-ink);font-size:11.5px;font-weight:500;max-width:260px;white-space:normal;line-height:1.45}
.p3-clu .p3-cc{font-weight:650;margin-right:3px}
.p3-clu .p3-cn{white-space:nowrap}
.p3-clu .p3-in{overflow-wrap:anywhere}
.p3-clu .p3-cn b{font-weight:650}
.p3-clu .p3-cn i{font-style:normal;display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;
  background:var(--p3-num);color:var(--p3-num-fg);font:700 9px/1 "SF Pro Text","Helvetica Neue",Inter,system-ui,sans-serif;margin-left:2px;position:relative;top:-1px}
.p3-clu .p3-sep{opacity:.45;margin:0 3px}
.p3-clu .p3-lead line{stroke:var(--p3-card-ink);stroke-width:.9;stroke-opacity:.5}
.p3-chan .p3-lead circle{fill:var(--p3-chan-lead)}
.p3-row{display:flex;align-items:center;gap:4px;font-size:13px;font-weight:650}
.p3-why{font-size:11.5px;font-weight:450;color:var(--p3-card-mute);max-width:210px;white-space:normal;line-height:1.38;text-wrap:balance;text-wrap:pretty;word-break:normal;line-break:strict}
.p3-num{flex:none;display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;
  background:var(--p3-num);color:var(--p3-num-fg);font:700 11px/1 "SF Pro Text","Helvetica Neue",Inter,system-ui,sans-serif;margin-right:1px}
.p3-lab.p3-spot.p3-pulse .p3-num{animation:p3pulse 2.4s ease-in-out infinite}
@keyframes p3pulse{0%,100%{box-shadow:0 0 0 0 var(--p3-pulse)}50%{box-shadow:0 0 0 5px transparent}}
.p3-lab.p3-hov .p3-in{filter:contrast(1.08)}
.p3-chan{white-space:nowrap;transition:opacity .35s ease}
.p3-chan .p3-cin{display:flex;align-items:baseline;gap:7px;padding:6px 11px 7px 8px;border-radius:7px;background:var(--p3-card);color:var(--p3-chan-ink);
  border:1.5px solid var(--p3-chan-ink);font-size:13px;font-weight:600;box-shadow:0 1px 0 var(--p3-card-shadow);max-width:300px;white-space:normal;line-height:1.4;
  text-wrap:balance;text-wrap:pretty;line-break:strict}
.p3-chan .p3-tag{white-space:nowrap;flex:none;font-size:11px;font-weight:700;padding:1px 5px;border-radius:4px;border:1.3px solid var(--p3-chan-ink);color:var(--p3-chan-ink);letter-spacing:.04em;background:transparent;position:relative;top:-1px}
.p3-bolt{opacity:0;transition:opacity .05s linear}
.p3-bolt.p3-on{opacity:1}
.p3-intel{display:flex;align-items:center;gap:3px;font-size:10.5px;font-weight:550;color:var(--p3-ink);white-space:nowrap;
  text-shadow:0 0 2px var(--p3-halo),0 0 2px var(--p3-halo),0 0 4px var(--p3-halo);transition:opacity .28s ease}
.p3-intel.p3-dk{color:var(--p3-ink-dk);text-shadow:0 0 2px var(--p3-halo-dk),0 0 3px var(--p3-halo-dk),0 0 5px var(--p3-halo-dk)}
.p3-intel svg{flex:none;filter:drop-shadow(0 0 1.5px var(--p3-halo))}
.p3-intel .p3-iw{opacity:.72}
.p3-intel.p3-quiet .p3-iw{display:none}
.p3-intel.p3-off{opacity:0!important}
.p3-liq{position:absolute;left:0;top:0;display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:10.5px;font-weight:550;
  color:var(--p3-card-mute);text-shadow:0 0 2px var(--p3-sky),0 0 2px var(--p3-sky),0 0 4px var(--p3-sky);
  transition:opacity .35s ease;pointer-events:none}
.p3-liq>*{opacity:.75}
.p3-liq.p3-liq-news>*{opacity:.95}
.p3-liq.p3-off{opacity:0!important}
.p3-liq b{font-weight:650;color:var(--p3-card-ink)}
.p3-liq-k{font-weight:600;letter-spacing:.04em}
.p3-liq-p{font-feature-settings:"tnum" 1}
.p3-liq-say{font-weight:450;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.p3-liq-dot{width:8px;height:8px;border-radius:50%;flex:none;box-sizing:border-box;border:1.5px solid currentColor}
.p3-liq-in{color:var(--p3-in);background:var(--p3-in)}.p3-liq-out{color:var(--p3-out);background:var(--p3-out)}.p3-liq-calm{color:var(--p3-cold)}
.p3-cloudlab{font-size:10.5px;font-weight:550;color:var(--p3-ink);white-space:nowrap;
  text-shadow:0 0 2px var(--p3-halo),0 0 2px var(--p3-halo),0 0 4px var(--p3-halo),0 0 1px var(--p3-halo)}
.p3-cloudlab>span{opacity:.72}
.p3-lab.p3-dk .p3-cloudlab{color:var(--p3-ink-dk);text-shadow:0 0 2px var(--p3-halo-dk),0 0 3px var(--p3-halo-dk),0 0 5px var(--p3-halo-dk)}
`;
  document.head.appendChild(s);
}

/** CSS custom properties for a look (day/night). */
export function cssVars(look) {
  const th = look.th, day = look.day;
  return {
    '--p3-sky': th.sky0, '--p3-ink': th.surfInk, '--p3-halo': th.surfHalo, '--p3-ink-dk': th.surfInkDark, '--p3-halo-dk': th.surfHaloDark,
    '--p3-card': th.card, '--p3-card-line': th.cardLine, '--p3-card-ink': th.cardText, '--p3-card-mute': th.cardMuted,
    '--p3-card-shadow': day ? 'rgba(31,42,68,0.08)' : 'rgba(0,0,0,0.22)',
    '--p3-num': th.badge, '--p3-num-fg': th.badgeText, '--p3-in': th.in, '--p3-out': th.out, '--p3-gold': th.gold,
    '--p3-hot': day ? '#b8452c' : '#e78a5c', '--p3-cold': day ? '#33628a' : '#8fc4c9', '--p3-bolt': th.bolt, '--p3-bolt-line': th.boltLine,
    // 主航道 caption: a light card (the arc stays the darkest navy object), navy-outline tag — never 若竹 green
    '--p3-chan-ink': day ? '#22304f' : '#f3ecdc', '--p3-chan-lead': day ? '#22304f' : '#f3ead6',
    '--p3-pulse': day ? 'rgba(31,42,68,0.35)' : 'rgba(239,231,214,0.4)',
  };
}

/** Escape, and keep numbers+units, percentages and 【names】 (with the character before) on one line. */
export function nwrap(text) {
  return esc(text).replace(/([㐀-鿿]?【[^】]{1,14}】|[+\-−–~约]?\d[\d.,]*\s*(?:%|％|亿美元|万美元|美元|亿|万|天|个点|个|倍|年|月|日|号|bp)?)/g, '<span class="p3-nw">$1</span>');
}

const V = () => new THREE.Vector3();
const hit = (r, q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0;
const SHOW_FACING = 0.4; // names, captions and tags only where the ground faces the viewer

export class Labels {
  constructor(ctx, world) {
    this.ctx = ctx;
    this.w = world;
    this.group = new THREE.Group();
    this.items = [];
    this.rects = [];
    this.hover = -1;
    for (let k = 0; k < world.n; k++) {
      const el = document.createElement('div');
      el.className = 'p3-lab p3-off';
      const obj = new CSS2DObject(el);
      this.group.add(obj);
      this.items.push({ k, el, obj, html: '', cls: '', size: null, show: false });
    }
    // 主航道 caption
    const cel = document.createElement('div');
    cel.className = 'p3-chan p3-off';
    this.chan = { el: cel, obj: new CSS2DObject(cel), html: '', size: null };
    this.group.add(this.chan.obj);
    // cloud captions (Polymarket)
    this.cloudLabs = new Map();
    this._p = V(); this._p2 = V(); this._n = V(); this._n2 = V(); this._c = V();
    this.obstacles = [];
    this.blockers = [];
    this._cands = new Map();
    this.cities = []; // §26 faint atlas context: [{d (unit), name, pop}] — placed last, never over anything
    this.cityBudget = 0;
    this.cityLabs = [];
  }

  /** Faint city names for a zoomed real Earth (the planet passes the biggest ones in view). */
  setCities(list, budget) {
    this.cities = list || [];
    this.cityBudget = budget || 0;
    while (this.cityLabs.length < Math.min(this.cities.length, 24)) {
      const el = document.createElement('div');
      el.className = 'p3-city p3-off';
      const obj = new CSS2DObject(el);
      this.group.add(obj);
      this.cityLabs.push({ el, obj, html: '', size: null, inner: null });
    }
  }

  /** Content for every label. spec: {k → {name, ticker, season, dir, num, why, est, pin, dim, badges, major, crowd}} */
  sync(spec, chan, clouds) {
    const w = this.w;
    for (const it of this.items) {
      const s = spec[it.k];
      if (!s) { it.html = ''; continue; }
      let html = '';
      const tri = s.dir > 0 ? '<i class="p3-tri p3-up"></i>' : s.dir < 0 ? '<i class="p3-tri p3-dn"></i>' : '';
      const extra = (s.est ? '<span class="p3-est">估</span>' : '') + (s.pin ? '<span class="p3-pin">★</span>' : '') +
        (s.badges || []).map((b) => `<span class="p3-badge ${b.cls ? 'p3-' + b.cls + 'b' : ''}">${esc(b.text)}</span>`).join('');
      const nm = `<span class="p3-nm">${esc(s.name)}${s.ticker && s.ticker !== s.name ? `<span class="p3-tk">${esc(s.ticker)}</span>` : ''}</span>`;
      const crowd = s.crowd ? `<span class="p3-crowd p3-${s.crowd}" title="${s.crowd === 'hi' ? '人挤人' : '冷清洼地'}">${s.crowd === 'hi' ? '挤' : '空'}</span>` : '';
      // one weather mark per name: the 挤/空 stamp wins over the season glyph (both would say "cold" twice)
      const sea = s.season && !(crowd && !s.num) ? ic(s.season, s.num ? 14 : 13) : '';
      const nameHtml = `<svg class="p3-lead p3-nlead" aria-hidden="true"><line x1="0" y1="0" x2="0" y2="0"/><circle cx="0" cy="0" r="0"/></svg><div class="p3-in">${crowd}${sea}${nm}<span class="p3-sfx"></span>${tri}${extra}</div>`;
      if (s.num) {
        // the card's caption already carries 挤 and in/out: the row is number, season, name (+ ★ / 估 / badge)
        const keep = (s.est ? '<span class="p3-est">估</span>' : '') + (s.pin ? '<span class="p3-pin">★</span>' : '') +
          (s.badges || []).map((b) => `<span class="p3-badge ${b.cls ? 'p3-' + b.cls + 'b' : ''}">${esc(b.text)}</span>`).join('');
        // refine: '→ 奥斯汀' — shown only while the card waits at the screen's edge (its money is off the screen)
        const to = s.to && !String(s.why || '').includes(s.to) ? `<span class="p3-to">${s.why ? ' ' : ''}→ ${esc(s.to)}</span>` : '';
        html = `<svg class="p3-lead" aria-hidden="true"><line x1="0" y1="0" x2="0" y2="0"/><circle cx="0" cy="0" r="3.2"/><path class="p3-ea" d="M7,0 L-3,-5 L-1,0 L-3,5 Z"/></svg><div class="p3-in"><div class="p3-row"><span class="p3-num">${s.num}</span>${sea}${nm}${keep}</div>${s.why || to ? `<div class="p3-why">${s.why ? nwrap(s.why) : ''}${to}</div>` : ''}</div>`;
        // refine (#11): a card that points away from its own land (a deeper place, or money that sits in another
        // sector's unit) leaves the territory unnamed — a twin plain name goes on the territory itself
        if (!it.twin) {
          const el2 = document.createElement('div');
          el2.className = 'p3-lab p3-off';
          const obj2 = new CSS2DObject(el2);
          this.group.add(obj2);
          it.twin = { k: it.k, el: el2, obj: obj2, html: '', cls: '', size: null, show: false, isTwin: true };
        }
        const tw = it.twin;
        if (tw.html !== nameHtml) { tw.el.innerHTML = nameHtml; tw.html = nameHtml; tw.size = null; tw.sizeT = null; cacheParts(tw); }
        tw.spec = Object.assign({}, s, { num: 0, why: '', major: true, hideName: false });
        tw.base = 'p3-lab' + (s.dim ? ' p3-dim' : '') + (this.hover === it.k ? ' p3-hov' : '');
        if (tw.cls !== tw.base) { tw.size = null; tw.sizeT = null; }
        tw.cls = tw.base;
        tw.prio = 0;
      } else html = nameHtml;
      // knock-out (cream) text on dark ground is decided per frame in update() (lit / mid / shadow tone)
      const base = 'p3-lab' + (s.num ? ' p3-spot' + (s.pulse ? ' p3-pulse' : '') : '') + (s.dim ? ' p3-dim' : '') + (this.hover === it.k ? ' p3-hov' : '');
      if (html !== it.html) { it.el.innerHTML = html; it.html = html; it.size = null; it.sizeT = null; cacheParts(it); }
      const cls = base + (s.major || s.num ? '' : ' p3-minor');
      if (it.base !== base || it.cls !== cls) { it.size = null; it.sizeT = null; }
      it.base = base;
      it.cls = cls;
      it.prio = (s.num ? 1000 - s.num * 10 : 0) + (s.chanEnd ? 300 : 0) + (s.major ? 100 : 0) + (s.pin ? 60 : 0) + (s.crowd ? 40 : 0) + w.L.areas[it.k] * 50 + (s.dim ? -200 : 0) +
        (s.point ? 60 * (s.dvRank != null ? 1 - s.dvRank : 0) : 0);
      it.spec = s;
    }
    // channel caption
    const ch = this.chan;
    const chtml = chan ? `<svg class="p3-lead" aria-hidden="true"><line x1="0" y1="0" x2="0" y2="0"/><circle cx="0" cy="0" r="3"/></svg><div class="p3-cin"><span class="p3-tag">主航道</span><span>${nwrap(chan.say || '')}</span></div>` : '';
    if (chtml !== ch.html) { ch.el.innerHTML = chtml; ch.html = chtml; ch.size = null; cacheParts(ch); }
    ch.on = !!chan;
    this.chanFk = chan ? chan.fk : -1;
    this.chanTk = chan ? chan.tk : -1;
    // cloud captions
    const seen = new Set();
    for (const c of clouds || []) {
      if (!c.label && !c.tip) continue;
      const key = c.k;
      seen.add(key);
      let o = this.cloudLabs.get(key);
      if (!o) {
        const el = document.createElement('div');
        el.className = 'p3-lab p3-off';
        const obj = new CSS2DObject(el);
        this.group.add(obj);
        o = { el, obj, html: '', size: null };
        this.cloudLabs.set(key, o);
      }
      const lab = c.label || c.tip;
      const t = lab.length > 22 ? lab.slice(0, 21) + '…' : lab;
      const html = `<div class="p3-cloudlab"><span>${nwrap(t)}</span></div>`;
      if (html !== o.html) { o.el.innerHTML = html; o.html = html; o.size = null; cacheParts(o); }
      o.strength = c.strength;
      o.k = key;
    }
    for (const [key, o] of this.cloudLabs) if (!seen.has(key)) { o.el.remove(); this.group.remove(o.obj); this.cloudLabs.delete(key); }
  }

  setHover(k) { this.hover = k; }

  /** Is the ground at object-space point pos dark (the land's band there, in its lit / mid / shadow tone)? The sea never is. */
  _darkUnder(pos) {
    const w = this.w, look = this.ctx.look;
    const n = this._n.copy(pos).normalize();
    const band = w.bandAt(n);
    if (band < 0) return false;
    return darkAt(look, band, n.dot(this.ctx.U.uLobj.value));
  }

  _size(o) {
    const key = 'size';
    if (!o[key]) {
      const inner = o.inner || o.el.firstElementChild;
      if (!inner) return { w: 0, h: 0 };
      const r = inner.getBoundingClientRect();
      if (!r.width) return { w: 60, h: 18 };
      o[key] = { w: r.width, h: r.height };
    }
    return o[key];
  }

  /** Size of a name label in its normal or tiny style (measured once per content change). */
  _sizeFor(it, tiny) {
    const key = tiny ? 'sizeT' : 'size';
    if (!it[key]) {
      // (final check: sizes are kept per text variant — '科技 · 海淀区' vs '科技' — so a name whose unit spot is tried and
      // not taken is not re-measured every frame; and a name on screen is measured without p3-off: its 0.28 s opacity
      // transition, restarted by this forced layout every frame, left such names as ~5 % ghosts)
      const ck = (tiny ? 'T|' : 'N|') + (it.cls || '') + '|' + (it.base || '') + '|' + (it.html || '') + '|' + (it.sfxT || '');
      const got = it._szc && it._szc.get(ck);
      if (got) return (it[key] = got);
      const prev = it.el.className;
      it.el.className = (tiny ? it.base + ' p3-tiny' : it.cls) + (prev.includes('p3-off') ? ' p3-off' : '');
      const r = (it.inner || it.el).getBoundingClientRect();
      it.el.className = prev;
      // not measurable yet (hidden by the CSS2D renderer while its object is invisible): guess, don't cache
      if (!r.width) return { w: Math.max(40, (it.el.textContent || '').length * 9 + 14), h: 18 };
      it[key] = { w: r.width, h: r.height };
      if (!it._szc || it._szc.size > 24) it._szc = new Map();
      it._szc.set(ck, it[key]);
    }
    return it[key];
  }

  _setOff(o, ox, oy) {
    if (!o.off || Math.abs(o.off[0] - ox) > 0.6 || Math.abs(o.off[1] - oy) > 0.6) {
      o.off = [ox, oy];
      if (o.inner) o.inner.style.transform = ox || oy ? `translate(${ox.toFixed(1)}px,${oy.toFixed(1)}px)` : '';
    }
  }

  /**
   * Callout placement: try offsets around the anchor (the preferred direction first, default outward
   * from the planet); move the card there and draw its leader.
   */
  _callout(o, x, y, cx, cy, fits, gap, pref, cost) {
    const sz = this._size(o);
    let dx = pref ? pref[0] : x - cx, dy = pref ? pref[1] : y - cy;
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-6) { dx = 0; dy = -1; } else { dx /= dl; dy /= dl; }
    const rot = (a) => [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
    const cands = [[dx, dy], rot(0.5), rot(-0.5), rot(1.0), rot(-1.0), [0, -1], [0, 1], rot(1.6), rot(-1.6), [1, 0], [-1, 0]];
    let best = null;
    for (const g of [gap, gap * 1.8, gap * 2.8]) {
      for (const [ux, uy] of cands) {
        const ext = Math.abs(ux) * sz.w / 2 + Math.abs(uy) * sz.h / 2;
        const ox = ux * (g + ext), oy = uy * (g + ext);
        const r = { x0: x + ox - sz.w / 2 - 3, x1: x + ox + sz.w / 2 + 3, y0: y + oy - sz.h / 2 - 3, y1: y + oy + sz.h / 2 + 3 };
        if (fits(r)) { best = { ox, oy, r }; break; }
        // nowhere free: keep the spot that covers the least of what is already there (never a card on a card)
        const c = cost ? cost(r) : 0;
        if (!best || (best.bad && c < best.c)) best = { ox, oy, r, bad: true, c };
      }
      if (best && !best.bad) break;
    }
    this._setOff(o, best.ox, best.oy);
    if (o.line) {
      // leader from the anchor to the card edge
      const ex = Math.abs(best.ox) > 1e-3 ? (sz.w / 2) / Math.abs(best.ox) : Infinity;
      const ey = Math.abs(best.oy) > 1e-3 ? (sz.h / 2) / Math.abs(best.oy) : Infinity;
      const f = Math.max(0, 1 - Math.min(ex, ey));
      const lx = (best.ox * f).toFixed(1), ly = (best.oy * f).toFixed(1);
      if (o.lx !== lx || o.ly !== ly) { o.lx = lx; o.ly = ly; o.line.setAttribute('x2', lx); o.line.setAttribute('y2', ly); }
    }
    return best.r;
  }

  /**
   * What lies under canvas px (x, y): k ≥ 0 a territory, −1 sea, −2 unclaimed land, −3 off the globe (sky).
   * A ray from the camera against the unit sphere, in the planet's object space.
   */
  _groundAt(x, y) {
    const cam = this._cam;
    if (!cam) return -3;
    const o = this._ro || (this._ro = new THREE.Vector3()), d = this._rd || (this._rd = new THREE.Vector3());
    const nx = (x / this._W) * 2 - 1, ny = -((y / this._H) * 2 - 1);
    o.set(nx, ny, -1).unproject(cam).applyMatrix4(this._Minv);
    d.set(nx, ny, 1).unproject(cam).applyMatrix4(this._Minv).sub(o).normalize();
    const b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c;
    if (disc < 0) return -3;
    const t = -b - Math.sqrt(disc);
    o.addScaledVector(d, t);
    const w = this.w;
    const k = w.ownerAtXYZ(o.x, o.y, o.z);
    if (k !== -1) return k;
    return w.globeLand && w.globeLand(o) ? -2 : -1;
  }

  /**
   * refine-names: does territory k own the ground at unit vector d — the raster, or on the real Earth the raster within
   * ~4 px of it (a money place on the very coast: 星港)? One rule with 2D names2d _owns.
   */
  _ownsNear(k, d) {
    const w = this.w;
    if (w.ownerAtXYZ(d.x, d.y, d.z) === k) return true;
    if (!w.real) return false;
    const fr = frame3(d), a = 4 / Math.max(60, this._Rpx || 300), q = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      const t = (i * Math.PI) / 4;
      offsetDir(d, fr[0], fr[1], Math.cos(t) * a, Math.sin(t) * a, q);
      if (w.ownerAtXYZ(q.x, q.y, q.z) === k) return true;
    }
    return false;
  }

  /** How much of a screen rect covers places that matter: territories (heavy) and land (light). Per 1000 px². */
  _groundPen(r, wT = 3, wL = 0.4, nx = 4, ny = 3, wS = 0, own = -9) {
    let t = 0, l = 0, sea = 0;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const g = this._groundAt(r.x0 + ((i + 0.5) / nx) * (r.x1 - r.x0), r.y0 + ((j + 0.5) / ny) * (r.y1 - r.y0));
      if (g === own) continue; else if (g >= 0) t++; else if (g === -2) l++; else if (g === -1) sea++;
    }
    const n = nx * ny, a = ((r.x1 - r.x0) * (r.y1 - r.y0)) / 1000;
    return a * (wT * (t / n) + wL * (l / n) + wS * (sea / n));
  }

  /**
   * ①②③ card placement by score: off territories (−3 per 1000 px² covered), off the shell's UI (gauges, holdings,
   * panel, top bar, time machine: never), preferably over the ocean or empty ground 60–160 px from its place, a
   * hairline leader back. While the camera moves the last choice is kept (re-scored once it settles).
   */
  _calloutScored(o, x, y, cx, cy, fits, pref, cost, settled) {
    const sz = this._size(o);
    let dx = pref ? pref[0] : x - cx, dy = pref ? pref[1] : y - cy;
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-6) { dx = 0; dy = -1; } else { dx /= dl; dy /= dl; }
    const rectAt = (ux, uy, g) => {
      const ext = Math.abs(ux) * sz.w / 2 + Math.abs(uy) * sz.h / 2;
      const ox = ux * (g + ext), oy = uy * (g + ext);
      return { ox, oy, r: { x0: x + ox - sz.w / 2 - 3, x1: x + ox + sz.w / 2 + 3, y0: y + oy - sz.h / 2 - 3, y1: y + oy + sz.h / 2 + 3 } };
    };
    // refine (#9): a leader never runs across the shell's floating UI (the gauges …)
    const segHits = (x0, y0, x1, y1) => {
      for (const q of this.obstacles || []) {
        let t0 = 0, t1 = 1;
        const dx = x1 - x0, dy = y1 - y0;
        let ok = true;
        for (const [pp, qq] of [[-dx, x0 - q.x0], [dx, q.x1 - x0], [-dy, y0 - q.y0], [dy, q.y1 - y0]]) {
          if (Math.abs(pp) < 1e-9) { if (qq < 0) { ok = false; break; } continue; }
          const t = qq / pp;
          if (pp < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; } else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
        }
        if (ok && t0 <= t1) return true;
      }
      return false;
    };
    const scoreOf = (ux, uy, g, r) => {
      let sc = fits(r) ? 0 : 1e5 + (cost ? cost(r) : 0);
      if (segHits(x, y, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)) sc += 5e4;
      sc += this._groundPen(r);
      sc += g < 60 ? (60 - g) * 0.05 : g > 125 ? (g - 125) * 0.025 : 0;
      sc += 0.006 * g + (1 - (ux * dx + uy * dy)) * 0.45;
      return sc;
    };
    let best = null;
    const P = o._pick;
    if (P && (!settled || o._pickT > (this._settleT || 0)) && performance.now() - (o._pickAt || 0) < 1500) {
      const c = rectAt(P[0], P[1], P[2]);
      if (fits(c.r)) best = { ...c, ux: P[0], uy: P[1], g: P[2] };
    }
    if (!best) {
      for (const g of [60, 90, 125, 160, 34]) {
        for (let i = 0; i < 16; i++) {
          const a = (i * Math.PI) / 8, ux = Math.cos(a), uy = Math.sin(a);
          const c = rectAt(ux, uy, g);
          let sc = scoreOf(ux, uy, g, c.r);
          if (P && Math.abs(P[0] - ux) < 1e-6 && Math.abs(P[1] - uy) < 1e-6 && P[2] === g) sc -= 0.8; // hysteresis
          if (!best || sc < best.sc) best = { ...c, ux, uy, g, sc };
        }
      }
      o._pick = [best.ux, best.uy, best.g];
      o._pickT = performance.now();
      o._pickAt = o._pickT;
    }
    this._setOff(o, best.ox, best.oy);
    if (o.line) {
      const ex = Math.abs(best.ox) > 1e-3 ? (sz.w / 2) / Math.abs(best.ox) : Infinity;
      const ey = Math.abs(best.oy) > 1e-3 ? (sz.h / 2) / Math.abs(best.oy) : Infinity;
      const f = Math.max(0, 1 - Math.min(ex, ey));
      const lx = (best.ox * f).toFixed(1), ly = (best.oy * f).toFixed(1);
      if (o.lx !== lx || o.ly !== ly) { o.lx = lx; o.ly = ly; o.line.setAttribute('x2', lx); o.line.setAttribute('y2', ly); }
    }
    return best.r;
  }

  /** A name's leader: a 0.75 px ink line from its place to the label's edge when it sits > 24 px away (else none). */
  _nameLeader(o, ox, oy, sz) {
    if (!o.line) return;
    const ex = Math.abs(ox) > 1e-3 ? (sz.w / 2) / Math.abs(ox) : Infinity;
    const ey = Math.abs(oy) > 1e-3 ? (sz.h / 2) / Math.abs(oy) : Infinity;
    const f = Math.max(0, 1 - Math.min(ex, ey));
    const far = Math.hypot(ox * f, oy * f) > 24;
    const lx = far ? (ox * f).toFixed(1) : '0', ly = far ? (oy * f).toFixed(1) : '0';
    if (o.lx !== lx || o.ly !== ly) {
      o.lx = lx; o.ly = ly;
      o.line.setAttribute('x2', lx); o.line.setAttribute('y2', ly);
      if (o.dot) o.dot.setAttribute('r', far ? '1.8' : '0');
    }
  }

  _hideName(it) {
    const off = it.cls + ' p3-off';
    if (it.el.className !== off) it.el.className = off;
    it.show = false;
  }

  /**
   * A name with no room on its own place: the best spot 28–120 px away (12 directions), scored toward open water or
   * empty ground and short leaders; null when nothing fits. Returns the same shape as the in-place choice (+ moved).
   */
  _displace(it, c, fits, proj, inDisc) {
    if (!c || c.f < SHOW_FACING) return null;
    const [x, y] = proj(c.pos);
    let best = null;
    for (const tiny of [false, true]) {
      const sz = this._sizeFor(it, tiny);
      for (const g of [28, 44, 64, 90, 120]) {
        for (let i = 0; i < 12; i++) {
          const a = (i * Math.PI) / 6, ux = Math.cos(a), uy = Math.sin(a);
          const ext = Math.abs(ux) * sz.w / 2 + Math.abs(uy) * sz.h / 2;
          const ox = ux * (g + ext), oy = uy * (g + ext);
          const r = { x0: x + ox - sz.w / 2 - 3, x1: x + ox + sz.w / 2 + 3, y0: y + oy - sz.h / 2 - 2, y1: y + oy + sz.h / 2 + 2, k: it.k, nm: true };
          if (!inDisc(r, 1.02) || !fits(r)) continue;
          // (refine #16: neither out at sea — it would read as a sea area — nor on another country's land: the nearest
          // free spot wins, with a visible leader back)
          const sc = this._groundPen(r, 2.2, 0.3, 3, 2, 0.3) + 0.03 * g + Math.abs(uy) * 0.25 + (tiny ? 0.6 : 0);
          if (!best || sc < best.sc) best = { c, ox, oy, r, tiny, sc, moved: true };
        }
      }
      if (best) break;
    }
    return best;
  }

  /**
   * Names whose places sit within 30 px of each other on screen (one metro: five sectors in the Bay Area) stand as a
   * column beside the metro — money first, each with its leader — instead of being scattered or dropped.
   */
  _metroColumns(w, list, placed, rects, fits, proj, cam, op, done, smallPlanet) {
    const p = this._p;
    const pts = [];
    for (const it of list) {
      const s = it.spec;
      if (s.point || (smallPlanet && !s.major) || (s.hideName && it.k !== this.hover)) continue;
      if (it.k === this.chanTk || it.k === this.chanFk) continue;
      const d = this._candidates(it.k)[0];
      w.surfPos(d, 0.006 * (w.ws || 1), p);
      const f = p.clone().normalize().dot(cam);
      if (f < SHOW_FACING) continue;
      const [x, y] = proj(p);
      pts.push({ it, x, y, pos: p.clone(), dv: +s.dv || 0 });
    }
    const n = pts.length, par = pts.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    // (refine-names, one rule with 2D: one metro means ≤ ~65 km on the ground too — at continent zoom two neighbouring
    // countries a few px closer than 30 are each named on their own land)
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y) < 30 && pts[a].pos.angleTo(pts[b].pos) < 0.0105) par[find(a)] = find(b);
    const groups = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(pts[i]); }
    const order = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => Math.max(...b.map((q) => q.it.prio)) - Math.max(...a.map((q) => q.it.prio)));
    for (const g of order) {
      g.sort((a, b) => b.dv - a.dv || b.it.prio - a.it.prio);
      const tiny = g.length > 4;
      const sizes = g.map((q) => this._sizeFor(q.it, tiny));
      const cw = Math.max(...sizes.map((z) => z.w)), gap = 2;
      const chH = sizes.reduce((a, z) => a + z.h + gap, -gap);
      const gy = g.reduce((a, q) => a + q.y, 0) / g.length;
      const gx0 = Math.min(...g.map((q) => q.x)), gx1 = Math.max(...g.map((q) => q.x));
      let best = null;
      for (const side of [1, -1]) for (const dxp of [30, 52, 80]) for (const va of [0, -0.5, 0.5, -1, 1]) {
        const left = side > 0 ? gx1 + dxp : gx0 - dxp - cw;
        let top = gy - chH / 2 + va * chH * 0.5;
        const rows = [];
        let ok = true;
        for (let i = 0; i < g.length; i++) {
          const z = sizes[i];
          const r = { x0: left - 3, x1: left + z.w + 3, y0: top - 2, y1: top + z.h + 2, k: g[i].it.k, nm: true };
          if (!fits(r) || r.x0 < 6 || r.x1 > this._W - 6) { ok = false; break; }
          rows.push(r);
          top += z.h + gap;
        }
        if (!ok) continue;
        const col = { x0: left, x1: left + cw, y0: rows[0].y0, y1: rows[rows.length - 1].y1 };
        // (refine #16: a land territory's name never floats out at sea, where it reads as a sea area — empty land first)
        const sc = this._groundPen(col, 2.2, 0.3, 3, 3, 0.3) + 0.03 * dxp + Math.abs(va) * 0.4 + (side < 0 ? 0.15 : 0);
        if (!best || sc < best.sc) best = { rows, sc, left };
      }
      if (!best) continue;
      g.forEach((q, i) => {
        const it = q.it, r = best.rows[i], z = sizes[i];
        const cxr = best.left + z.w / 2, cyr = (r.y0 + r.y1) / 2;
        const ox = cxr - q.x, oy = cyr - q.y;
        it.obj.position.copy(q.pos);
        this._setOff(it, ox, oy);
        this._nameLeader(it, ox, oy, z);
        placed.push(r); rects.push(r);
        const cls = (tiny ? it.base + ' p3-tiny' : it.cls);
        if (it.el.className !== cls) it.el.className = cls;
        it.el.style.opacity = op;
        it.show = true;
        done.add(it);
      });
    }
  }

  /** A part's town in Chinese: the nearest sizeable city with a Chinese name (≤ ~45 km), else the HQ file's name. */
  _zhCity(pt) {
    if (!pt || !pt.cityLL) return pt ? pt.city : null;
    if (pt._zh !== undefined) return pt._zh;
    if (!this.cityIndex) return pt.city;
    const [lon, lat] = pt.cityLL, cl = Math.cos((lat * Math.PI) / 180);
    let best = null, bd = 0.42 * 0.42;
    for (const c of this.cityIndex) {
      const dx = (((c.lon - lon + 540) % 360) - 180) * cl, dy = c.lat - lat, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = c; }
    }
    pt._zh = best ? best.zh : /[\u3400-\u9fff]/.test(pt.city || '') ? pt.city : null;
    return pt._zh || pt.city;
  }

  /** Quiet names for the other pieces of each region when zoomed in (> 3×): '金融 · 纽约', biggest on screen first. */
  _partNames(w, placed, fits, proj, cam, op, smallPlanet) {
    if (!this.partLabs) this.partLabs = [];
    const z = this.zoom || 1;
    const list = [];
    if (w.real && z > 3 && !smallPlanet && w.parts) {
      const Rpx = this._Rpx || 300;
      for (let k = 0; k < w.n; k++) {
        const s = this.items[k] && this.items[k].spec;
        if (!s || s.point || s.dim) continue;
        for (const pt of w.parts[k]) {
          if (pt.main) continue;
          // (the part its name already stands on, '科技 · 海淀区', is not named twice)
          if ((this._namedAt || []).some((q) => q.k === k && q.d.angleTo(pt.d) < Math.max(0.0005, 1.3 * Math.sqrt(pt.area / Math.PI)))) continue;
          const dpx = 2 * Math.sqrt(pt.area / Math.PI) * Rpx;
          if (dpx < 40) continue;
          if (pt.d.dot(cam) < 0.5) continue;
          list.push({ k, pt, dpx, name: s.name });
        }
      }
      list.sort((a, b) => b.dpx - a.dpx);
      // (refine-names, one rule with 2D: only pieces on the free screen compete — off-screen ones no longer use up the 24
      // label slots — at most 2 per region, so a zoomed map never reads as a wall of the same sector word)
      const E = this.edgeBox || { x0: 0, y0: 0, x1: this._W || 0, y1: this._H || 0 }, per = new Map(), q = new THREE.Vector3(), keep = [];
      for (const L of list) {
        w.surfPos(L.pt.d, 0.006 * (w.ws || 1), q);
        const [x, y] = proj(q);
        if (x < E.x0 || x > E.x1 || y < E.y0 || y > E.y1 || (per.get(L.k) || 0) >= 2) continue;
        per.set(L.k, (per.get(L.k) || 0) + 1);
        keep.push(L);
      }
      list.length = 0;
      list.push(...keep);
    }
    const budget = Math.min(10, 3 + Math.round(1.2 * Math.sqrt(z)));
    let shown = 0;
    const p = this._p;
    for (let i = 0; i < Math.max(list.length, this.partLabs.length); i++) {
      let o = this.partLabs[i];
      const L = list[i];
      if (!o) {
        if (!L || i >= 24) continue;
        const el = document.createElement('div');
        el.className = 'p3-lab p3-part p3-off';
        o = { el, obj: new CSS2DObject(el), html: '', size: null };
        this.group.add(o.obj);
        this.partLabs[i] = o;
      }
      if (!L || shown >= budget) { if (!o.el.classList.contains('p3-off')) o.el.classList.add('p3-off'); continue; }
      const city = this._zhCity(L.pt);
      const html = `<div class="p3-in"><span>${esc(L.name)}</span>${city ? `<span class="p3-pc">· ${esc(city)}</span>` : ''}</div>`;
      if (o.html !== html) { o.el.innerHTML = html; o.html = html; o.size = null; cacheParts(o); }
      w.surfPos(L.pt.d, 0.006 * (w.ws || 1), p);
      const [x, y] = proj(p);
      const sz = this._size(o);
      let ok = false;
      for (const [ox, oy] of [[0, 0], [0, -(sz.h + 2)], [0, sz.h + 2]]) {
        const r = { x0: x + ox - sz.w / 2 - 2, x1: x + ox + sz.w / 2 + 2, y0: y + oy - sz.h / 2 - 1, y1: y + oy + sz.h / 2 + 1, nm: true };
        if (!fits(r)) continue;
        o.obj.position.copy(p);
        this._setOff(o, ox, oy);
        placed.push(r);
        o.el.classList.toggle('p3-dk', this._darkUnder(p));
        o.el.classList.remove('p3-off');
        o.el.style.opacity = op;
        ok = true;
        shown++;
        break;
      }
      if (!ok) o.el.classList.add('p3-off');
    }
  }

  /**
   * §26 company clusters (NYC 投行券商): markers that fan out together (≥ 3 within ~60 px) are named by one compact
   * callout — '纽约 · 高盛 · 摩根士丹利① · 杰富瑞 …' sorted by money, ①②③ inline — instead of a few lucky names.
   */
  _clusters(w, items, placed, rects, fits, cost, cx, cy, op, inClu, proj) {
    if (!this.cluLabs) this.cluLabs = [];
    const P = w.real && w.pointScr ? w.pointScr.filter((q) => q.vis) : [];
    const byK = new Map(items.map((it) => [it.k, it]));
    const n = P.length, par = P.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      if (Math.hypot(P[a].tx - P[b].tx, P[a].ty - P[b].ty) < P[a].r + P[b].r + 9) par[find(a)] = find(b);
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(P[i]); }
    const clus = [...groups.values()].filter((g) => {
      if (g.length < 3) return false;
      const xs = g.map((q) => q.tx), ys = g.map((q) => q.ty);
      return Math.max(...xs) - Math.min(...xs) <= 70 && Math.max(...ys) - Math.min(...ys) <= 70;
    });
    let used = 0;
    for (const g of clus) {
      const mem = g.map((q) => ({ q, it: byK.get(q.k) })).filter((m) => m.it && m.it.spec);
      if (mem.length < 3) continue;
      mem.sort((a, b) => (+b.it.spec.dv || 0) - (+a.it.spec.dv || 0));
      let o = this.cluLabs[used];
      if (!o) {
        const el = document.createElement('div');
        el.className = 'p3-clu p3-off';
        o = { el, obj: new CSS2DObject(el), html: '', size: null };
        this.group.add(o.obj);
        this.cluLabs[used] = o;
      }
      // (refine #12: one city only when they all are in it — NXP / ST / SEALSQ are not in Cambridge; else their common
      // country; else no place word at all)
      const cs = new Set(mem.map((m) => (w.city && w.city[m.q.k]) || '?'));
      const ccs = new Set(mem.map((m) => (w.S && w.S.terr[m.q.k] && w.S.terr[m.q.k].cc) || '?'));
      if (this._homeCC === undefined) {
        // the map's own country (most of its companies): a cluster there needs no country word ('美国 · …' on 美股 says nothing)
        const cnt = new Map();
        for (let k = 0; k < w.n; k++) { const c = w.S && w.S.terr[k] && w.S.terr[k].cc; if (c) cnt.set(c, (cnt.get(c) || 0) + 1); }
        let hc = null, hn = 0;
        for (const [c, m] of cnt) if (m > hn) { hn = m; hc = c; }
        this._homeCC = hn >= 3 ? hc : null;
      }
      const cc1 = ccs.size === 1 && !ccs.has('?') ? [...ccs][0] : null;
      // one metro (all within ~65 km — Tokyo's wards spell their towns differently): the heaviest member's town
      let spread = 0;
      for (let a = 0; a < mem.length && spread < 0.012; a++) for (let b = a + 1; b < mem.length; b++) spread = Math.max(spread, w.anchorDir[mem[a].q.k].angleTo(w.anchorDir[mem[b].q.k]));
      const town = mem.map((m) => w.city && w.city[m.q.k]).find(Boolean) || '';
      const city = cs.size === 1 && !cs.has('?') ? [...cs][0] : spread < 0.0105 && town ? town : cc1 && cc1 !== this._homeCC ? CC_ZH[cc1] || '' : '';
      const top = mem.slice(0, 5);
      const short = (t) => { const a = [...String(t)]; return a.length > 13 ? a.slice(0, 12).join('') + '…' : String(t); };
      const parts = top.map((m) => {
        const sp = m.it.spec;
        return `<span class="p3-cn">${sp.num ? '<b>' : ''}${esc(short(sp.name))}${sp.num ? `</b><i>${sp.num}</i>` : ''}</span>`;
      });
      const more = mem.length > top.length ? `<span class="p3-sep">·</span><span class="p3-cn">等 ${mem.length} 家</span>` : '';
      const html = `<svg class="p3-lead" aria-hidden="true"><line x1="0" y1="0" x2="0" y2="0"/></svg><div class="p3-in">${city ? `<span class="p3-cc">${esc(city)}</span><span class="p3-sep">·</span>` : ''}${parts.join('<span class="p3-sep">·</span>')}${more}</div>`;
      if (o.html !== html) { o.el.innerHTML = html; o.html = html; o.size = null; cacheParts(o); }
      // anchored at the heaviest member's place; the card goes out toward open ground with a hairline back
      const k0 = mem[0].q.k;
      const pos = w.surfPos(w.anchorDir[k0], 0.003 * (w.ws || 1), new THREE.Vector3());
      o.obj.position.copy(pos);
      const [ax, ay] = proj(pos);
      const mx = g.reduce((a, q) => a + q.tx, 0) / g.length, my = g.reduce((a, q) => a + q.ty, 0) / g.length;
      // the fan itself is taken (no card on the markers)
      placed.push({ x0: Math.min(...g.map((q) => q.tx - q.r)) - 3, x1: Math.max(...g.map((q) => q.tx + q.r)) + 3, y0: Math.min(...g.map((q) => q.ty - q.r)) - 3, y1: Math.max(...g.map((q) => q.ty + q.r)) + 3 });
      const r = this._calloutScored(o, ax, ay, cx, cy, fits, [mx - cx, my - cy], cost, this._settled);
      placed.push(r); rects.push(Object.assign({ k: k0 }, r));
      o.el.classList.remove('p3-off');
      o.el.style.opacity = op;
      for (const m of mem) inClu.add(m.q.k);
      used++;
    }
    for (let i = used; i < this.cluLabs.length; i++) this.cluLabs[i].el.classList.add('p3-off');
  }

  /** Candidate points (directions) inside territory k for its name: the anchor first, then around it. */
  _candidates(k) { return this.w.cands(k); }

  /**
   * Where a ①②③ card waits when its place is off the screen: on the ray from the screen's middle toward the place,
   * just inside the free area (this.edgeBox, canvas px). Returns {x, y, dx, dy, pos (object space)} or null when
   * the place is on screen.
   */
  _edgeSpot(k, pos, proj, camera, W, H, dir = null) {
    const w = this.w, E = this.edgeBox;
    const a = dir || w.anchorDir[k]; // (§26 amendment 4: a card about a deeper place waits toward that place)
    const facing = a.dot(w.camObj) > 0.03;
    let x = 0, y = 0;
    if (facing) {
      const p = pos || w.surfPos(a, 0, this._p.clone());
      [x, y] = proj(p);
      // (refine #9: a place under the shell's floating UI — the gauges, 我的持仓 — counts as off the screen: no card
      // leader runs across the gauges to a dot drawn on top of them)
      const under = (this.obstacles || []).some((q) => q.id !== 'hero-ring' && q.id !== 'hero-cap' && x > q.x0 - 6 && x < q.x1 + 6 && y > q.y0 - 6 && y < q.y1 + 6);
      if (x >= E.x0 && x <= E.x1 && y >= E.y0 && y <= E.y1 && !under) return null;
    }
    const mx = (E.x0 + E.x1) / 2, my = (E.y0 + E.y1) / 2;
    let dx, dy;
    if (facing) { dx = x - mx; dy = y - my; } else {
      // over the horizon: its direction as seen from the camera
      const v = a.clone().applyQuaternion(this.group.parent ? this.group.parent.quaternion : new THREE.Quaternion());
      dx = v.x; dy = -v.y;
    }
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) return null;
    dx /= l; dy /= l;
    const m = 22;
    const tx = dx > 0 ? (E.x1 - m - mx) / dx : dx < 0 ? (E.x0 + m - mx) / dx : Infinity;
    const ty = dy > 0 ? (E.y1 - m - my) / dy : dy < 0 ? (E.y0 + m - my) / dy : Infinity;
    const t = Math.max(0, Math.min(tx, ty));
    let ex = mx + dx * t, ey = my + dy * t;
    // never on the shell's floating UI (the gauges in the top-left corner, 我的持仓 …): step just past it, along
    // the free area's edge, the nearer way round (the arrow keeps pointing at the place)
    const obs = this.obstacles || [];
    const inObs = (x, y) => obs.some((q) => x > q.x0 - 12 && x < q.x1 + 12 && y > q.y0 - 12 && y < q.y1 + 12);
    if (inObs(ex, ey)) {
      let best = null;
      for (const q of obs) {
        if (!(ex > q.x0 - 12 && ex < q.x1 + 12 && ey > q.y0 - 12 && ey < q.y1 + 12)) continue;
        for (const [x, y] of [[ex, q.y1 + 16], [ex, q.y0 - 16], [q.x1 + 16, ey], [q.x0 - 16, ey]]) {
          if (x < E.x0 + m || x > E.x1 - m || y < E.y0 + m || y > E.y1 - m || inObs(x, y)) continue;
          const d = Math.hypot(x - ex, y - ey);
          if (!best || d < best.d) best = { x, y, d };
        }
      }
      if (best) { ex = best.x; ey = best.y; }
    }
    const v3 = new THREE.Vector3((ex / W) * 2 - 1, -((ey / H) * 2 - 1), 0.2).unproject(camera);
    const Minv = this._minv || (this._minv = new THREE.Matrix4());
    Minv.copy(this.group.matrixWorld).invert();
    return { x: ex, y: ey, dx, dy, pos: v3.applyMatrix4(Minv) };
  }

  /**
   * Position, facing test and greedy de-cluttering. Returns rects (canvas px) for hit-testing.
   * reveal: 0…1 visibility of this world's labels; Rpx: planet radius on screen;
   * chanGeo: the arc (object space) so nothing covers it; intelObjs: fx intel tags (placed here too).
   */
  update(camera, W, H, reveal, Rpx, cloudObjs, chanGeo, intelObjs) {
    const w = this.w;
    const placed = [];
    const rects = [];
    const M = this.group.matrixWorld;
    const tmpV = this._p2;
    const proj = (v) => { const q = tmpV.copy(v).applyMatrix4(M).project(camera); return [(q.x * 0.5 + 0.5) * W, (-q.y * 0.5 + 0.5) * H, q.z]; };
    const show = reveal > 0.02;
    this.group.visible = show;
    if (!show) {
      if (intelObjs) for (const o of intelObjs.values()) o.el.classList.add('p3-off');
      return (this.rects = []);
    }
    const op = String(Math.min(1, reveal));
    this._cam = camera; this._W = W; this._H = H;
    this._Minv = (this._Minv || new THREE.Matrix4()).copy(M).invert();
    {
      // camera settle: card spots are re-scored once the view stops moving (kept while it moves)
      const e = M.elements, key = e[0].toFixed(4) + e[1].toFixed(4) + e[2].toFixed(4) + e[5].toFixed(4) + e[6].toFixed(4) + e[12].toFixed(2) + '|' + camera.zoom.toFixed(3) + '|' + W + 'x' + H;
      const now = performance.now();
      if (key !== this._camKey) { this._camKey = key; this._movedAt = now; }
      const settled = now - (this._movedAt || 0) > 180;
      if (settled && !this._settled) this._settleT = now;
      this._settled = settled;
    }
    const centre = this.group.getWorldPosition(this._c).clone();
    const cq = centre.clone().project(camera);
    const cx = (cq.x * 0.5 + 0.5) * W, cy = (-cq.y * 0.5 + 0.5) * H;
    const inDisc = (r, m = 0.975) => {
      const R2 = (Rpx * m) * (Rpx * m);
      for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]]) if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > R2) return false;
      return true;
    };
    const fits = (r, ignoreObs) => {
      if (r.x0 < 6 || r.y0 < 6 || r.x1 > W - 6 || r.y1 > H - 6) return false;
      for (const q of placed) if (hit(r, q)) return false;
      if (!ignoreObs) for (const q of this.obstacles || []) if (hit(r, q)) return false;
      for (const q of this.blockers || []) if (hit(r, q)) return false;
      return true;
    };
    const area = (r, q) => Math.max(0, Math.min(r.x1, q.x1) - Math.max(r.x0, q.x0)) * Math.max(0, Math.min(r.y1, q.y1) - Math.max(r.y0, q.y0));
    /** how bad a spot that does not fit is: cards and captions weigh most, the arc and names less, off-screen worst */
    const cost = (r) => {
      let a = r.x0 < 6 || r.y0 < 6 || r.x1 > W - 6 || r.y1 > H - 6 ? 1e7 : 0;
      for (const q of placed) a += area(r, q) * (q.arc ? 0.6 : q.k != null ? 4 : 1.5);
      for (const q of this.obstacles || []) a += area(r, q) * 3;
      for (const q of this.blockers || []) a += area(r, q) * 3;
      return a;
    };
    const cam = w.camObj;
    for (const q of this.pre || []) placed.push(q); // e.g. the liquidity caption (placed by the planet)
    // ---- the 主航道 first: its body, arrowhead and both ends are obstacles for every label
    const ch = this.chan;
    let tipS = null, tipDir = null, tailS = null, tailDir = null;
    const arcPx = []; // the arc (and branch) on screen: ①②③ leader dots never land on it
    const br = chanGeo && chanGeo.branch;
    if (ch.on && br && br.prog > 0.02) {
      const tube = Math.max(3, (br.R0 || 0.012) * Rpx * 1.2);
      for (const p of br.poly || br.samples || []) {
        const [x, y] = proj(p);
        arcPx.push([x, y]);
        placed.push({ x0: x - tube - 5, x1: x + tube + 5, y0: y - tube - 5, y1: y + tube + 5, arc: true });
      }
      const [tx, ty] = proj(br.tip);
      const hw = Math.max(7, (br.R0 || 0.012) * 3.4 * Rpx);
      placed.push({ x0: tx - hw - 14, x1: tx + hw + 14, y0: ty - hw - 14, y1: ty + hw + 14, arc: true });
      arcPx.push([tx, ty]);
    }
    if (ch.on && chanGeo && chanGeo.tip && chanGeo.prog > 0.02 && chanGeo.apex && chanGeo.apex.clone().normalize().dot(cam) > 0) {
      const tube = Math.max(3, (chanGeo.R0 || 0.02) * Rpx * 1.2);
      for (const p of chanGeo.samples || []) {
        const [x, y] = proj(p);
        placed.push({ x0: x - tube - 6, x1: x + tube + 6, y0: y - tube - 6, y1: y + tube + 6, arc: true });
      }
      for (const p of chanGeo.poly || chanGeo.samples || []) arcPx.push(proj(p));
      const [tx, ty] = proj(chanGeo.tip), [bx, by] = proj(chanGeo.base);
      arcPx.push([tx, ty], [bx, by]);
      const hw = Math.max(8, (chanGeo.R0 || 0.02) * 3.4 * Rpx);
      placed.push({ x0: Math.min(tx, bx) - hw - 24, x1: Math.max(tx, bx) + hw + 24, y0: Math.min(ty, by) - hw - 24, y1: Math.max(ty, by) + hw + 24, arc: true });
      const [ax0, ay0] = proj(chanGeo.start);
      placed.push({ x0: ax0 - 10, x1: ax0 + 10, y0: ay0 - 10, y1: ay0 + 10, arc: true });
      tipS = [tx, ty];
      const dl = Math.hypot(tx - bx, ty - by) || 1;
      tipDir = [(tx - bx) / dl, (ty - by) / dl];
      const [s1x, s1y] = proj(chanGeo.samples[0]);
      const sl = Math.hypot(ax0 - s1x, ay0 - s1y) || 1;
      tailS = [ax0, ay0];
      tailDir = [(ax0 - s1x) / sl, (ay0 - s1y) / sl];
    }
    // (final check: zoomed in, the arc's top point can lie off the screen — the caption then hangs on the visible part
    // of the arc nearest to it, inside the free screen; no visible part → no caption, never one under the top bar)
    let chAt = null;
    if (ch.on && chanGeo && chanGeo.apex && chanGeo.prog > 0.5 && chanGeo.apex.clone().normalize().dot(cam) > 0.22) {
      const [x, y] = proj(chanGeo.apex);
      const E1 = this.edgeBox || { x0: 0, y0: 0, x1: W, y1: H };
      const freeAt = (qx, qy, m) => qx > E1.x0 + m && qx < E1.x1 - m && qy > E1.y0 + m && qy < E1.y1 - m &&
        !(this.obstacles || []).some((q) => q.id !== 'hero-ring' && q.id !== 'hero-cap' && qx > q.x0 - 8 && qx < q.x1 + 8 && qy > q.y0 - 8 && qy < q.y1 + 8);
      if (freeAt(x, y, 30)) chAt = { pos: chanGeo.apex, x, y };
      else {
        let bd = Infinity;
        for (const p of chanGeo.poly || chanGeo.samples || []) {
          if (p.clone().normalize().dot(cam) < 0.22) continue;
          const [qx, qy] = proj(p);
          if (!freeAt(qx, qy, 60)) continue;
          const d = Math.hypot(qx - x, qy - y);
          if (d < bd) { bd = d; chAt = { pos: p, x: qx, y: qy }; }
        }
      }
    }
    if (chAt) {
      ch.obj.position.copy(chAt.pos);
      const { x, y } = chAt;
      // caption on the outer (convex) side of the arc's top point
      const [sx, sy] = proj(chanGeo.start), [ex, ey] = proj(chanGeo.tip);
      let px = x - (sx + ex) / 2, py = y - (sy + ey) / 2;
      // (refine-names, one rule with 2D: a nearly straight arc — its bow and its lift about cancel, and the toon relief
      // tips the balance — hangs it outward from the planet's centre)
      if (Math.hypot(px, py) < Math.max(6, 0.08 * Math.hypot(ex - sx, ey - sy))) { px = x - cx; py = y - cy; }
      placed.push(this._callout(ch, x, y, cx, cy, fits, 22, [px, py], cost));
      ch.el.classList.remove('p3-off');
      ch.el.style.opacity = op;
    } else ch.el.classList.add('p3-off');

    const order = this.items.filter((it) => it.html).sort((a, b) => b.prio - a.prio);
    const smallPlanet = Rpx < 230;
    const p = this._p;
    // (refine-names, one rule with 2D: the cards are placed ① ② ③ — the first number gets the best spot, never a ② that
    // outranks it by area or a 挤 stamp)
    const nums = order.filter((it) => it.spec.num).sort((a, b) => a.spec.num - b.spec.num), names = order.filter((it) => !it.spec.num);
    // ---- ①②③ cards
    /** distance (px) from a screen point to the arc polyline / its head */
    const distArc = (x, y) => {
      let m = Infinity;
      const n = arcPx.length;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = arcPx[i];
        m = Math.min(m, Math.hypot(ax - x, ay - y));
        if (i + 1 < n) {
          const [bx, by] = arcPx[i + 1];
          const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
          if (l2 > 1 && l2 < 900 * 900) {
            const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2));
            m = Math.min(m, Math.hypot(ax + vx * t - x, ay + vy * t - y));
          }
        }
      }
      return m;
    };
    const E0 = this.edgeBox;
    // (the shell's own 主航道 ring / card sit ON a place on purpose: a place under them is still on the screen)
    const obsAt = (x, y, m = 0) => (this.obstacles || []).some((q) => q.id !== 'hero-ring' && q.id !== 'hero-cap' && x > q.x0 - m && x < q.x1 + m && y > q.y0 - m && y < q.y1 + m);
    /** a place on the free screen (inside the edge box, facing, not under the shell's UI) → its px, else null */
    const onScreen = (d, lift = 0.006) => {
      w.surfPos(d, lift * (w.ws || 1), p);
      if (p.clone().normalize().dot(cam) < 0.25) return null;
      const [x, y] = proj(p);
      if (E0 ? x < E0.x0 || x > E0.x1 || y < E0.y0 || y > E0.y1 : x < 0 || y < 0 || x > W || y > H) return null;
      if (obsAt(x, y, 6)) return null;
      return [x, y];
    };
    const twinWant = new Set();
    for (const it of nums) {
      const k = it.k;
      let best = null, bestFree = null, farthest = null;
      // §26 amendment 4: a card about a deeper place (海外股市 › 印度) points at that place (item.childAt), not at
      // the biggest visible part of its territory
      const deepDir = it.spec && it.spec.deepDir ? it.spec.deepDir : null;
      // refine (#6): on the real Earth a card points where the sector's MONEY is (layout.focus[].at = item.hub): on
      // the screen → there (nudged ≤ 26 px off the 主航道); off it → the edge chip toward it ('→ 奥斯汀'), unless the
      // units it owns on screen hold ≥ half of its money (then its own land on screen is the honest place)
      const mo = !deepDir && w.real && it.spec && it.spec.money ? it.spec.money : null;
      let targets = null, edgeDir = deepDir;
      if (mo) {
        if (onScreen(mo.hub)) {
          targets = [mo.hub];
          const fr = frame3(mo.hub, new THREE.Vector3(), new THREE.Vector3()), ang = 26 / Math.max(60, Rpx);
          // (refine-names, one rule with 2D: a dot nudged off the 主航道 stays on land — its own territory first, never
          // out at sea)
          const own = [], land = [];
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2, q = offsetDir(mo.hub, fr[0], fr[1], Math.cos(a) * ang, Math.sin(a) * ang), o = w.ownerAtXYZ(q.x, q.y, q.z);
            if (o === k) own.push(q); else if (o >= 0 || (w.globeLand && w.globeLand(q))) land.push(q);
          }
          targets.push(...own, ...land);
        } else {
          let vis = 0;
          for (const u of mo.units) if (u.w > 0 && onScreen(u.d, 0)) vis += u.w;
          if (vis < 0.5) { targets = [mo.hub]; edgeDir = mo.hub; }
        }
      }
      // the target sits under the shell's UI (the gauges, 我的持仓 …): it waits at the edge like an off-screen one
      let list = deepDir ? [deepDir] : targets || this._candidates(k);
      if (!w.real && !deepDir) {
        // (refine-names, one rule with 2D: a zoomed 抽象 planet has no edge chips — the card points at a piece of its land
        // that is on the free screen, never at one past the screen's edge)
        const vis = list.filter((d) => onScreen(d));
        if (vis.length) list = vis;
      }
      for (const d of list) {
        w.surfPos(d, 0.006 * (w.ws || 1), p);
        const f = p.clone().normalize().dot(cam);
        const cand = { d, f, pos: p.clone() };
        if (!best || f > best.f + 0.02) best = cand;
        if (f > 0.25 && arcPx.length) {
          const [sx, sy] = proj(cand.pos);
          cand.dA = distArc(sx, sy);
          if (cand.dA >= 18 && (!bestFree || f > bestFree.f + 0.02)) bestFree = cand;
          if (!farthest || cand.dA > farthest.dA) farthest = cand;
        }
        if (f > 0.6 && !arcPx.length) break;
      }
      // the leader dot never sits on the 主航道 (or its head): the best-facing free spot, else the farthest
      if (bestFree) best = bestFree;
      else if (farthest && farthest.f > 0.25) best = farthest;
      let ok = best && best.f > 0.25;
      // the cached card size can go stale (measured mid-layout, fonts, a re-wrap, a tour card that gained its line):
      // check it now and then — on the screen's edge too — so two cards never overlap because one of them is taller
      // than the placer thinks
      it._chk = ((it._chk || 0) + 1) % 20;
      if (!it._chk && it.size && it.show) {
        const inner = it.inner || it.el.firstElementChild;
        const rr = inner && inner.getBoundingClientRect();
        if (rr && rr.width && (Math.abs(rr.width - it.size.w) > 3 || Math.abs(rr.height - it.size.h) > 3)) it.size = { w: rr.width, h: rr.height };
      }
      // §26 a zoomed real Earth: a ①②③ off the screen (or over the horizon) waits at the screen's edge, pointing at it
      const edge = w.real && this.edgeBox ? this._edgeSpot(k, ok && !(mo && edgeDir) ? best.pos : null, proj, camera, W, H, edgeDir) : null;
      // the territory's own name stays on its land when the card points elsewhere (a deeper place, money in another
      // sector's unit, or the edge)
      if (w.real && it.twin && (edge || deepDir || (mo && !this._ownsNear(k, mo.hub)))) twinWant.add(it.twin);
      if (!!edge !== !!it._edge) { it._edge = !!edge; it.size = null; } // ('→ 奥斯汀' shows in the edge state only)
      if (edge) {
        const cls = it.cls + ' p3-edge';
        if (it.el.className !== cls) it.el.className = cls;
        it.obj.position.copy(edge.pos);
        const rect = this._callout(it, edge.x, edge.y, cx, cy, fits, 20, [-edge.dx, -edge.dy], cost);
        rect.k = k;
        placed.push({ x0: edge.x - 8, x1: edge.x + 8, y0: edge.y - 8, y1: edge.y + 8, capDot: 9 });
        placed.push(rect);
        rects.push(rect);
        if (it.ea) { const deg = ((Math.atan2(edge.dy, edge.dx) * 180) / Math.PI).toFixed(1); if (it._ead !== deg) { it._ead = deg; it.ea.setAttribute('transform', `rotate(${deg})`); } }
        it.el.style.opacity = op;
        it.show = true;
        continue;
      }
      if (ok) {
        it.obj.position.copy(best.pos);
        const [x, y] = proj(best.pos);
        const rect = this._calloutScored(it, x, y, cx, cy, fits, null, cost, this._settled);
        rect.k = k;
        placed.push({ x0: x - 6, x1: x + 6, y0: y - 6, y1: y + 6, capDot: 8 }); // (capDot: the half-size clouds keep off — planet3d _placeClouds)
        placed.push(rect);
        rects.push(rect);
        if (it.el.className !== it.cls) it.el.className = it.cls;
        it.el.style.opacity = op;
      } else if (it.el.className !== it.cls + ' p3-off') it.el.className = it.cls + ' p3-off';
      it.show = ok;
    }
    // ---- secondary captions (cloud words, intel words): calm by default (§6) — only for the hovered territory,
    // or on a ①②③ territory while the budget allows (at most one on screen, none when ①②③ + 主航道 are 4)
    let budget = this.extraBudget || 0;
    const spotKs = this.spotKs || new Set();
    const mayTalk = (k) => {
      if (k === this.hover) return true;
      if (spotKs.has(k) && budget > 0) { budget--; return true; }
      return false;
    };
    for (const [k, o] of this.cloudLabs) {
      const cobj = cloudObjs && cloudObjs.get('c' + k);
      if (!cobj || !cobj.obj.visible || (cobj.vis != null && cobj.vis < 0.6) || (!cobj.place && w.facingOf(k) < SHOW_FACING - 0.1)) { o.el.classList.add('p3-off'); continue; }
      if (!(k === this.hover || (spotKs.has(k) && budget > 0))) { o.el.classList.add('p3-off'); continue; }
      o.obj.position.copy(cobj.obj.position);
      const [x, y] = proj(cobj.obj.position);
      const sz = this._size(o);
      const cw = Math.max(16, cobj.obj.scale.x * Rpx * 0.5);
      let done = false;
      for (const [ox, oy] of [[0, 5 + sz.h / 2], [cw + sz.w / 2, -sz.h * 0.2], [-(cw + sz.w / 2), -sz.h * 0.2], [0, 12 + sz.h]]) {
        const r = { x0: x + ox - sz.w / 2, x1: x + ox + sz.w / 2, y0: y + oy - sz.h / 2, y1: y + oy + sz.h / 2 };
        if (fits(r)) {
          r.cloud = 'c' + k;
          placed.push(r);
          this._setOff(o, ox, oy);
          o.el.classList.toggle('p3-dk', this._darkUnder(cobj.obj.position));
          o.el.classList.remove('p3-off');
          o.el.style.opacity = String(Math.min(1, reveal));
          done = true;
          mayTalk(k);
          break;
        }
      }
      if (!done) o.el.classList.add('p3-off');
    }
    if (intelObjs) {
      // the ⚡ tag itself is small and quiet; its words only for the hovered / a ①②③ territory
      const order = [...intelObjs.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
      for (const o of order) {
        const a = (o.alpha == null ? 1 : o.alpha) * Math.min(1, reveal);
        if (a < 0.5 || w.facingOf(o.k) < SHOW_FACING - 0.05) { o.el.classList.add('p3-off'); continue; }
        const talk = o.k === this.hover || (spotKs.has(o.k) && budget > 0);
        o.el.classList.toggle('p3-quiet', !talk);
        const key = talk ? 'sz' : 'szQ';
        if (!o[key] || !o[key].w) {
          const was = o.el.classList.contains('p3-off');
          if (was) { o.el.classList.remove('p3-off'); o.el.style.opacity = '0'; }
          const r0 = o.el.getBoundingClientRect();
          o[key] = r0.width ? { w: r0.width, h: r0.height } : null;
          if (was) o.el.classList.add('p3-off');
        }
        const sz = o[key] || (talk ? { w: 120, h: 16 } : { w: 12, h: 14 });
        const [x, y] = proj(o.obj.position);
        let done = false;
        for (const [ox, oy] of [[0, 0], [0, -(sz.h + 4)], [0, sz.h + 4], [sz.w / 2 + 6, 0], [-(sz.w / 2 + 6), 0]]) {
          const r = { x0: x + ox - sz.w / 2, x1: x + ox + sz.w / 2, y0: y + oy - sz.h / 2, y1: y + oy + sz.h / 2 };
          if (fits(r)) {
            placed.push(r);
            const tr = ox || oy ? `${ox}px ${oy}px` : '';
            if (o.tr !== tr) { o.tr = tr; o.el.style.translate = tr; }
            o.el.classList.toggle('p3-dk', this._darkUnder(o.obj.position));
            o.el.classList.remove('p3-off');
            o.el.style.opacity = String(talk ? Math.max(0.88, a) : 0.85 * a);
            if (talk) mayTalk(o.k);
            done = true;
            break;
          }
        }
        if (!done) o.el.classList.add('p3-off');
      }
    }
    // ---- §26 company clusters (stock level): ≥ 3 markers fanned together get one compact callout, money first
    const inClu = new Set();
    this._clusters(w, names.concat(nums), placed, rects, fits, cost, cx, cy, op, inClu, proj);
    // ---- names: never hidden on the visible face — try spots inside the territory, then a smaller style; on the
    // real Earth a name that finds no room on its place moves out (≤ 120 px, toward open water / empty ground) with a
    // hairline leader, and names whose places share one metro stand as a tidy column beside it (money first)
    const pendingNames = [];
    for (const it of names) {
      const s = it.spec;
      if (s.point && inClu.has(it.k) && it.k !== this.hover) { this._hideName(it); continue; }
      pendingNames.push(it);
    }
    for (const it of nums) if (it.twin) { if (twinWant.has(it.twin)) pendingNames.push(it.twin); else if (it.twin.show || !it.twin.el.classList.contains('p3-off')) this._hideName(it.twin); }
    for (const it of this.items) if (it.twin && !it.spec?.num && it.twin.show) this._hideName(it.twin);
    const doneNames = new Set();
    const namedAt = (this._namedAt = []);
    if (w.real) this._metroColumns(w, pendingNames, placed, rects, fits, proj, cam, op, doneNames, smallPlanet);
    for (const it of pendingNames) {
      if (doneNames.has(it)) continue;
      const s = it.spec, k = it.k;
      const cands = [];
      const isTo = k === this.chanTk && tipS, isFrom = k === this.chanFk && tailS;
      // the 主航道's ends: the destination's name sits beyond the arrowhead, the source's behind the tail
      if (isTo) cands.push({ pos: chanGeo.tip.clone(), f: chanGeo.tip.clone().normalize().dot(cam), dir: tipDir, sp: tipS });
      if (isFrom) cands.push({ pos: chanGeo.start.clone(), f: chanGeo.start.clone().normalize().dot(cam), dir: tailDir, sp: tailS });
      // refine (#10/#17): zoomed in (county / district level), the name stands on the unit it owns that holds the most
      // of its money on screen, and says which ('科技 · 海淀区') — not at the default view's label spot off at the edge
      let unitC = null;
      if (w.real && !s.point && s.money && (this.zoom || 1) >= 3.5) {
        let bu = null;
        for (const u of s.money.units) {
          if (!(u.w > 0) || (bu && u.w <= bu.w)) continue;
          if (!this._ownsNear(k, u.d) || !onScreen(u.d)) continue;
          bu = u;
        }
        if (bu) {
          w.surfPos(bu.d, 0.006 * (w.ws || 1), p);
          unitC = { pos: p.clone(), f: p.clone().normalize().dot(cam), unit: bu };
          cands.push(unitC);
        }
      }
      const sfx = unitC && unitC.unit.label && (this.zoom || 1) >= 3.5 ? '· ' + String(unitC.unit.label).replace(/（[^）]*）$/, '') : '';
      if (it.sfxT !== sfx) { it.sfxT = sfx; const se = it.el.querySelector('.p3-sfx'); if (se) se.textContent = sfx; it.size = null; it.sizeT = null; }
      // (refine-names, one rule with 2D: a money unit on screen is THE place of the name — no room there → it moves out
      // from that unit with a leader, keeping '· 海淀区'; never a plain name on some other, poorer piece far away)
      if (!unitC) for (const d of this._candidates(k)) {
        w.surfPos(d, 0.006 * (w.ws || 1), p);
        cands.push({ pos: p.clone(), f: p.clone().normalize().dot(cam) });
      }
      // §26: a company's name by zoom (labels never hide the markers: they sit beside them)
      const minorHidden = (smallPlanet && !s.major) || (s.hideName && k !== this.hover);
      let chosen = null, fallback = null;
      if (!minorHidden) {
        for (const tiny of [false, true]) {
          const sz = this._sizeFor(it, tiny);
          for (const c of cands) {
            if (c.f < SHOW_FACING) continue;
            const [x, y] = c.sp || proj(c.pos);
            let offs;
            if (c.dir) {
              const ext = Math.abs(c.dir[0]) * sz.w / 2 + Math.abs(c.dir[1]) * sz.h / 2;
              const d0 = (chanGeo.headPx || 12) + 28 + ext;
              offs = [];
              for (const a of [0, 0.6, -0.6, 1.2, -1.2]) {
                const ux = c.dir[0] * Math.cos(a) - c.dir[1] * Math.sin(a), uy = c.dir[0] * Math.sin(a) + c.dir[1] * Math.cos(a);
                offs.push([ux * d0, uy * d0]);
              }
            } else if (s.point) {
              // beside the marker (fanned-out position), right first like an atlas
              const po = w.pointOffOf ? w.pointOffOf(k) : [0, 0], pr = (w.pointSize && w.pointKs ? w.pointSize[w.pointKs.indexOf(k)] || 5 : 5) + 4;
              offs = [[po[0] + pr + sz.w / 2, po[1]], [po[0] - pr - sz.w / 2, po[1]], [po[0], po[1] - pr - sz.h / 2], [po[0], po[1] + pr + sz.h / 2],
                [po[0] + pr + sz.w / 2, po[1] - sz.h * 0.7], [po[0] - pr - sz.w / 2, po[1] + sz.h * 0.7]];
            } else offs = [[0, 0], [0, -(sz.h + 2)], [0, sz.h + 2]];
            // (refine #16: the 主航道 end's name — beyond the head / behind the tail — takes the free spot that stays on
            // land, its own first, rather than the first one that fits out at sea)
            let endBest = null;
            for (const [ox, oy] of offs) {
              const r = { x0: x + ox - sz.w / 2 - 3, x1: x + ox + sz.w / 2 + 3, y0: y + oy - sz.h / 2 - 2, y1: y + oy + sz.h / 2 + 2, k, nm: true };
              if (!inDisc(r, c.dir ? 1.1 : 0.975)) continue;
              if (c.dir && w.real) {
                if (!fits(r)) continue;
                const sc = this._groundPen(r, 1.6, 0.3, 3, 2, 0.6, k) + 0.15 * endBest0(ox, oy, offs);
                if (!endBest || sc < endBest.sc) endBest = { c, ox, oy, r, tiny, sc, moved: true };
                continue;
              }
              if (fits(r)) { chosen = { c, ox, oy, r, tiny }; break; }
              if (tiny && !c.dir && !fallback && !w.real) {
                // only grazing other names (never a card, caption, the arc or the shell UI)?
                let bad = false, ov = 0;
                const area = (r.x1 - r.x0) * (r.y1 - r.y0);
                for (const q of placed) {
                  if (!hit(r, q)) continue;
                  if (!q.nm) { bad = true; break; }
                  ov += (Math.min(r.x1, q.x1) - Math.max(r.x0, q.x0)) * (Math.min(r.y1, q.y1) - Math.max(r.y0, q.y0));
                }
                if (!bad) for (const q of (this.obstacles || []).concat(this.blockers || [])) if (hit(r, q)) { bad = true; break; }
                if (!bad && ov < area * 0.07 && c.f >= 0.55) fallback = { c, ox, oy, r, tiny };
              }
            }
            if (!chosen && endBest) chosen = endBest;
            if (chosen) break;
          }
          if (chosen) break;
        }
        // the real Earth: no room on its place → out to the nearest empty ground, with a leader (never hidden)
        if (!chosen && w.real && !s.point) chosen = this._displace(it, cands.find((c) => !c.dir), fits, proj, inDisc);
        if (!chosen && fallback) chosen = fallback;
      }
      if (chosen && it.sfxT && chosen.c !== unitC) { it.sfxT = ''; const se = it.el.querySelector('.p3-sfx'); if (se) se.textContent = ''; it.size = null; it.sizeT = null; }
      if (chosen && chosen.c === unitC) namedAt.push({ k, d: unitC.unit.d });
      if (chosen) {
        const { c, ox, oy, r, tiny } = chosen;
        it.obj.position.copy(c.pos);
        this._setOff(it, ox, oy);
        this._nameLeader(it, chosen.moved ? ox : 0, chosen.moved ? oy : 0, this._sizeFor(it, tiny));
        placed.push(r);
        rects.push(r);
        // knock-out text where the ground under the name is dark — in the tone it is actually drawn in
        const dk = !chosen.moved && this._darkUnder(c.pos);
        const cls = (tiny ? it.base + ' p3-tiny' : it.cls) + (dk ? ' p3-dk' : '');
        if (it.el.className !== cls) it.el.className = cls;
        it.el.style.opacity = op;
        it.show = true;
      } else this._hideName(it);
    }
    // ---- §26 zoomed in (> 3×): every piece of a region big enough on screen gets a quiet name ('金融 · 纽约')
    this._partNames(w, placed, fits, proj, cam, op, smallPlanet);
    // ---- §26 city names: the faintest layer — only where nothing else is, inside the free screen area
    let shown = 0;
    const E = this.edgeBox;
    for (let i = 0; i < this.cityLabs.length; i++) {
      const o = this.cityLabs[i], c = this.cities[i];
      if (!c || !E || shown >= this.cityBudget) { if (!o.el.classList.contains('p3-off')) o.el.classList.add('p3-off'); continue; }
      const html = `<div class="p3-in"><span class="p3-cdot"></span><span>${esc(c.name)}</span></div>`;
      if (o.html !== html) { o.el.innerHTML = html; o.html = html; o.size = null; cacheParts(o); }
      w.surfPos(c.d, 0.002 * (w.ws || 1), p);
      if (p.clone().normalize().dot(cam) < 0.35) { o.el.classList.add('p3-off'); continue; }
      const [x, y] = proj(p);
      const sz = this._size(o);
      let ok = false;
      for (const [ox, oy] of [[sz.w / 2 - 1.5, 0], [-(sz.w / 2 - 1.5), 0]]) {
        const r = { x0: x + ox - sz.w / 2 - 2, x1: x + ox + sz.w / 2 + 2, y0: y - sz.h / 2 - 2, y1: y + sz.h / 2 + 2 };
        if (r.x0 < E.x0 || r.x1 > E.x1 || r.y0 < E.y0 || r.y1 > E.y1 || !fits(r)) continue;
        o.obj.position.copy(p);
        this._setOff(o, ox, oy);
        if (ox < 0 && o.inner) o.inner.style.flexDirection = 'row-reverse'; else if (o.inner) o.inner.style.flexDirection = '';
        placed.push(r);
        o.el.classList.toggle('p3-dk', this._darkUnder(p));
        o.el.classList.remove('p3-off');
        o.el.style.opacity = op;
        ok = true;
        shown++;
        break;
      }
      if (!ok) o.el.classList.add('p3-off');
    }
    // ---- §26 the hovered sea area's producing regions (oil → Permian …): tiny names by their dashed rings
    const hl = this.hintList && this.hover >= 0 ? this.hintList.get(this.hover) : null;
    if (!this.hintLabs) this.hintLabs = [];
    for (let i = 0; i < 4; i++) {
      let o = this.hintLabs[i];
      const h = hl && hl[i];
      if (!o) {
        if (!h) continue;
        const el = document.createElement('div');
        el.className = 'p3-city p3-off';
        o = { el, obj: new CSS2DObject(el), html: '', size: null, inner: null };
        this.group.add(o.obj);
        this.hintLabs[i] = o;
      }
      if (!h || !E) { o.el.classList.add('p3-off'); continue; }
      const html = `<div class="p3-in"><span>${esc(h.name)}</span></div>`;
      if (o.html !== html) { o.el.innerHTML = html; o.html = html; o.size = null; cacheParts(o); }
      w.surfPos(h.d, 0.002 * (w.ws || 1), p);
      if (p.clone().normalize().dot(cam) < 0.3) { o.el.classList.add('p3-off'); continue; }
      const [x, y] = proj(p);
      const sz = this._size(o);
      const r = { x0: x - sz.w / 2, x1: x + sz.w / 2, y0: y + 11, y1: y + 11 + sz.h };
      if (r.x0 < E.x0 || r.x1 > E.x1 || r.y1 > E.y1) { o.el.classList.add('p3-off'); continue; }
      o.obj.position.copy(p);
      this._setOff(o, 0, 11 + sz.h / 2);
      o.el.classList.remove('p3-off');
      o.el.style.opacity = '1';
    }
    this.placed = placed;
    return (this.rects = rects);
  }

  dispose() {
    this.group.traverse((o) => { if (o.isCSS2DObject && o.element) o.element.remove(); });
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

/** How far down an offset list a spot is (0 = the preferred, straight-on one). */
function endBest0(ox, oy, offs) { const i = offs.findIndex((o) => o[0] === ox && o[1] === oy); return i < 0 ? offs.length : i; }

/** Country names for a cluster's place word (ISO2 → 中文). */
const CC_ZH = { US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西', GB: '英国', IE: '爱尔兰', FR: '法国', DE: '德国', NL: '荷兰', BE: '比利时',
  CH: '瑞士', IT: '意大利', ES: '西班牙', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', AT: '奥地利', LU: '卢森堡', IL: '以色列',
  CN: '中国', HK: '香港', TW: '台湾', JP: '日本', KR: '韩国', SG: '新加坡', IN: '印度', AU: '澳大利亚', NZ: '新西兰', ZA: '南非' };

function cacheParts(o) {
  o.inner = o.el.querySelector('.p3-in, .p3-cin, .p3-cloudlab') || o.el.firstElementChild;
  o.line = o.el.querySelector('.p3-lead line');
  o.dot = o.el.querySelector('.p3-nlead circle');
  o.ea = o.el.querySelector('.p3-ea');
  o.off = null;
  o.lx = o.ly = null;
}

export { SEASON_ZH };
