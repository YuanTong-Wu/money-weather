// test_words_sweep.mjs — do the words on one screen ever contradict each other? (DESIGN §8 amendment, §12, §14, §23)
//   node pipeline/test_words_sweep.mjs [dataRoot=web/data] [days=21] [--voice=sharp|mild|both]
// Sweeps words.js over every child series of every map in the three trees (curated, fm, gl) for the last `days` days
// and every curated stock file (caster), and checks, per node-day:
//   gate      the season never reads 春 / 夏 / 平稳 while words.crashAt says the node is falling hard (seasonAt,
//             surpriseParts, describe/take on words.nowAt) — and describe/take on a σ-less snapshot (the hover card's
//             dom.nowAt) never claim 春 / 夏 when the drop is past the gate's floor
//   seasonMoney  the season sentence never says money is coming in while the 5-day flow is out (or the reverse)
//   seasonTemp   the season sentence never says 热 next to a 凉/冷 temperature or 冷 next to 暖/热
//   windMoney    the wind line never says 钱在流进来 next to a 5-day outflow (or the reverse) unless it says so (mixed)
//   takeMoney    老风's one-liner (take) never claims the opposite money direction
//   seasonSame   the season in describe() == the season seasonAt() gives the map glyph (same name)
//   caster       the stock caster never claims the opposite of the stock's own 5-day money
//   real         with flows/aligned.json: a material real move against a material like-for-like estimate is always 反,
//                and 反 is never raised without both (realmoney.js compareAt)
//   realWords    where the real money and the estimate disagree (words.realSay: material real money against it, a blind
//                estimate, or real money that barely moved), describe / take / an ETF's caster never state the
//                estimate's direction unqualified (§23 amendment) — series-borne real money (realFlow[])
// Exit 1 when anything is found; prints the first examples of each kind.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(args[0] || path.join(ROOT, 'web', 'data'));
const DAYS = +(args[1] || 21);
const W0 = await import(pathToFileURL(process.env.SWEEP_WORDS ? path.resolve(process.env.SWEEP_WORDS) : path.join(ROOT, 'web', 'js', 'words.js')).href);
// SWEEP_WORDS=<old words.js> sweeps an older words.js (no crashAt): the gate is then judged with this tree's rule
const W = typeof W0.crashAt === 'function' ? W0 : { ...W0, crashAt: (await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'words.js')).href)).crashAt };
const RM = await import(pathToFileURL(path.join(ROOT, 'web', 'js', 'ui', 'realmoney.js')).href);

// the same money-direction patterns brief.py check() uses (IN_WORDS / OUT_WORDS / PAST)
const IN = /钱[^，。；：没不未倒别]{0,5}?(?:涌进|流进|流入|往里|灌|杀回|杀进|摸进|进来|回来|进货|接货|在进)|吸钱|吸走|进货|接货|(?<!不再)进钱(?!停)/;
const OUT = /钱[^，。；：没不未倒别]{0,5}?(?:溜|撤|跑|逃|往外|流出|离开|走)|失血(?!止)|往外漏|夺门|撤钱/;
const PAST = /前几天|5天前|刚还|之前|刚才|一年里|等|才算|如果|要是|按成交估|历史上/;
const MIXED = /但|却|可|倒|没真|还没|不进|没跟|犹豫|只是|人气/;
const HOT = /又热|正热|烧|烫/;
const COLD = /寒冬|冰窖|结冰/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clauses = (t) => String(t || '').split(/[，。；：]/).filter((c) => c && !PAST.test(c));
const claimsIn = (t) => clauses(t).some((c) => IN.test(c) && !MIXED.test(c));
const claimsOut = (t) => clauses(t).some((c) => OUT.test(c) && !MIXED.test(c));

const VOICE = (Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('='))).voice) || 'sharp';
W0.setVoice?.(VOICE);
const found = {};
const add = (kind, ex) => { (found[kind] ||= []).push(ex); };
let checked = 0;

function sweepSeries(tree, mapFile, cid, s, name) {
  const L = Math.max((s.wind || []).length, (s.idx || []).length);
  for (let i = Math.max(70, L - DAYS); i < L; i++) {
    checked++;
    const tag = `${tree}:${cid}${name ? ' ' + name : ''} @${i - L + 1}`;
    const cr = W.crashAt(s, i);
    const S = W.seasonAt(s, i);
    const n = W.nowAt(s, i);
    const P = W.surpriseParts(s, i);
    if (cr && (S.key === 'spring' || S.key === 'summer' || !S.key)) add('gate', `${tag} seasonAt=${S.key} while ${cr.name} (r1 ${cr.r1}, r5 ${cr.r5})`);
    if (cr && (P.season === 'spring' || P.season === 'summer' || !P.season)) add('gate', `${tag} surpriseParts=${P.season} while ${cr.name}`);
    const f5 = n.flow5;
    const lines = W.describe(n);
    const tk = W.take(n);
    // the hover card's σ-less snapshot (dom.nowAt has no crash key)
    const snap = { ...n }; delete snap.crash;
    const ls2 = W.describe(snap);
    if (cr) {
      const bad = ls2.find((l) => /^(🌱|☀️) [春夏]（/.test(l));
      if (bad) add('gate', `${tag} describe(snapshot) says "${bad}" while ${cr.name}`);
      const tk2 = W.take(snap);
      if (/刚冒芽|盛夏/.test(tk2)) add('gate', `${tag} take(snapshot) "${tk2}" while ${cr.name}`);
    }
    if (S.key && isNum(f5) && Math.abs(f5) >= 0.05 && !S.crash) {
      if (f5 < 0 && claimsIn(S.now)) add('seasonMoney', `${tag} ${S.name} "${S.now}" but 5天 ${f5.toFixed(1)}`);
      if (f5 > 0 && claimsOut(S.now)) add('seasonMoney', `${tag} ${S.name} "${S.now}" but 5天 +${f5.toFixed(1)}`);
    }
    if (S.key && isNum(n.temp)) {
      if (n.temp <= -0.5 && HOT.test(S.now)) add('seasonTemp', `${tag} ${S.name} "${S.now}" but temp ${n.temp}`);
      if (n.temp >= 0.5 && COLD.test(S.now)) add('seasonTemp', `${tag} ${S.name} "${S.now}" but temp ${n.temp}`);
    }
    for (const l of lines) {
      if (!/^(⏫|🔼|🔽|⏬)/.test(l) || !isNum(f5) || Math.abs(f5) < 0.05) continue;
      if (f5 < 0 && /钱在(狂涌|流)进来/.test(l)) add('windMoney', `${tag} "${l}"`);
      if (f5 > 0 && /钱在(悄悄溜走|大逃离)/.test(l)) add('windMoney', `${tag} "${l}"`);
    }
    if (isNum(f5) && Math.abs(f5) >= 0.05 && !n.crash) {
      if (f5 < 0 && claimsIn(tk)) add('takeMoney', `${tag} take "${tk}" but 5天 ${f5.toFixed(1)}`);
      if (f5 > 0 && claimsOut(tk)) add('takeMoney', `${tag} take "${tk}" but 5天 +${f5.toFixed(1)}`);
    }
    const sl = lines.find((l) => /^(🌱|☀️|🍂|❄️) [春夏秋冬]（/.test(l));
    if (sl && S.key && !sl.includes(S.name + '（')) add('seasonSame', `${tag} describe "${sl}" vs map ${S.name}`);
    // §23 amendment: where the real money and the estimate disagree (material real money against it, a blind estimate,
    // or real money that barely moved), describe / take never state the estimate's direction unqualified
    const rs = W.realSay ? W.realSay(n.real, f5) : null;
    if (rs && isNum(f5) && Math.abs(f5) >= 0.05) {
      const claims = f5 > 0 ? claimsIn : claimsOut;
      const said = [tk, ...lines].find((l) => claims(l));
      if (said) add('realWords', `${tag} ${rs.kind}: "${said}" (估 5天 ${f5.toFixed(1)}, 真钱 ${n.real.flow5.toFixed(1)})`);
    }
    // real money (curated): 反 consistent with the rule on the same series
    if (Array.isArray(s.realFlow)) {
      const c = RM.compareAt(s.realFlow, Array.isArray(s.realEst) ? s.realEst : null, i);
      if (c) {
        const should = !c.blind && c.realMat && c.estMat && (c.real5 > 0) !== (c.est5 > 0);
        if (should !== c.clash) add('real', `${tag} clash ${c.clash} but rule says ${should}`);
      }
    }
  }
}

for (const tree of ['', 'fm', 'gl']) {
  const dir = path.join(DATA, tree, 'maps');
  if (!fs.existsSync(dir)) continue;
  const names = {};
  try {
    const walk = (n) => { names[n.id] = n.name; (n.children || []).forEach(walk); };
    walk(JSON.parse(fs.readFileSync(path.join(DATA, tree, 'tree.json'), 'utf8')));
  } catch (e) { /* names are only for the report */ }
  try {
    const b = JSON.parse(fs.readFileSync(path.join(DATA, tree, 'brief.json'), 'utf8'));
    if (b.seasonStats) W.setSeasonStats(b.seasonStats);
  } catch (e) { /* default stats */ }
  for (const f of fs.readdirSync(dir)) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const [cid, s] of Object.entries(m.children || {})) sweepSeries(tree || 'curated', f, cid, s, names[cid]);
  }
}
// curated stock files: the caster
const sdir = path.join(DATA, 'stocks');
if (fs.existsSync(sdir)) {
  for (const f of fs.readdirSync(sdir)) {
    const st = JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8'));
    const L = (st.c || []).length;
    for (let i = Math.max(70, L - DAYS); i < L; i++) {
      checked++;
      const lines = W.caster(st, i);
      let f5 = 0, k = 0;
      for (let j = Math.max(0, i - 4); j <= i; j++) if (isNum(st.flow?.[j])) { f5 += st.flow[j]; k++; }
      if (!k || Math.abs(f5) < 0.05 || W.crashAt(st, i)) continue;
      const first = lines[0] || '';
      // an ETF with real money: when it disagrees with the estimate, the caster never states the estimate's direction
      const rr = W.realOfSeries ? W.realOfSeries(st, i) : null;
      const rsx = rr && W.realSay ? W.realSay(rr, f5) : null;
      if (rsx) {
        const said = lines.find((l) => (f5 > 0 ? claimsIn : claimsOut)(l));
        if (said) add('realWords', `stock ${st.t} @${i - L + 1} ${rsx.kind}: "${said}" (估 ${f5.toFixed(1)}, 真钱 ${rr.flow5.toFixed(1)})`);
      }
      if (f5 < 0 && claimsIn(first)) add('caster', `stock ${st.t} @${i - L + 1} "${first}" but 5天 ${f5.toFixed(1)}`);
      if (f5 > 0 && claimsOut(first)) add('caster', `stock ${st.t} @${i - L + 1} "${first}" but 5天 +${f5.toFixed(1)}`);
    }
  }
}

const voice = flags.voice || 'sharp';
const total = Object.values(found).reduce((a, b) => a + b.length, 0);
console.log(`words sweep (${voice}) — ${checked} node-days checked over the last ${DAYS} days: ${total} contradiction(s)`);
for (const [k, xs] of Object.entries(found)) {
  console.log(`  ${k}: ${xs.length}`);
  for (const x of xs.slice(0, 6)) console.log('     ' + x);
}
process.exit(total ? 1 : 0);
