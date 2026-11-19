// diag.mjs — diagnose median error on one synthetic case (slow-growth seed 11).
// Regenerates the case with the same generator as backtest.mjs, runs main.ts,
// and prints per-trophy: truth, model median, curve-baseline median, last
// rate (all logit), plus model spread. Usage: node diag.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT = dirname(fileURLToPath(import.meta.url));
const KIT = '/home/hatch/workspace/makefun/gta6-trophy-rarity-forecast-01-kit/gta6-trophy-rarity-forecast-01-kit';
const TMP = '/tmp/rarity-diag';
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const clampPct = (x) => Math.min(99.99, Math.max(0.01, x));
const logit = (pct) => { const p = clampPct(pct) / 100; return Math.log(p / (1 - p)); };
const sigmoidPct = (l) => 100 / (1 + Math.exp(-l));
const round4 = (x) => Math.round(x * 10000) / 10000;
const rng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const p01 = JSON.parse(readFileSync(join(KIT, 'input', 'p01.in'), 'utf8'));
const TROPHIES = p01.trophies;
const R0 = p01.history[p01.history.length - 1].rates;
const EPOCH = Date.parse('2026-11-19T00:00:00Z');
const iso = (h) => new Date(EPOCH + h * 3600000).toISOString().replace('.000Z', 'Z');
const kindOf = (t) => {
  const d = (t.description || '').toLowerCase();
  if (/^complete (chapter \d|the final mission)/.test(d) || /complete gone fishing/.test(d) ||
      /complete (breakfast run|the cartel heist|child's play|headliners|vcia takedown|operation savage glory)/.test(d)) return 'story';
  if (/(collect|discover|purchase|spend|earn \$|complete \d+ (challenge|collectible|card)|meditate at every|explore all|register \d+ vehicles|attain 100%)/.test(d)) return 'collect';
  if (/(win|beat|medal|race|rob|hunt|take down|bowl|smash|enjoy a cocktail|follow-through|lose a \d+ star)/.test(d)) return 'activity';
  return 'other';
};

// --- regenerate slow-growth seed 11 exactly as backtest.mjs does ---
const sc = { name: 'slow-growth', aP: 0.7, refreshH: 4, jumpAt: null };
const seed = 11;
const rnd = rng(seed * 1000 + sc.name.length * 77);
const params = TROPHIES.map((t, i) => {
  const kind = kindOf(t);
  const tierCeil = { platinum: 0.008, gold: 0.06, silver: 0.12, bronze: 0.5 }[t.tier] ?? 0.3;
  const kindMult = { story: 1.0, collect: 0.35, activity: 0.6, other: 0.5 }[kind];
  const ceil = Math.min(0.99, Math.max(tierCeil * kindMult, R0[i] / 100));
  const speedBase = { story: 2.0, collect: 1.0, activity: 1.3, other: 1.1 }[kind];
  const speed = t.tier === 'platinum' ? 0.6 : speedBase * (0.8 + 0.4 * rnd());
  return { r0: Math.max(0.1, R0[i]), ceil, speed };
});
const playersAt = (h) => 638 * Math.pow(1 + h / 24, sc.aP);
const earnersAt = (i, h) => {
  const { r0, speed } = params[i];
  return ((r0 / 100) * 638) * Math.pow(1 + h / 6, speed);
};
const snapshotAt = (h) => {
  const sh = Math.floor(h / sc.refreshH) * sc.refreshH;
  const P = playersAt(sh);
  const rates = TROPHIES.map((_, i) => {
    const e = Math.min(P, earnersAt(i, sh));
    const r = Math.min(params[i].ceil * 100, (100 * e) / P);
    return Math.round(r * 100) / 100;
  });
  return { P: Math.round(P), rates };
};
const history = [];
for (let h = 0; h < 48; h += 0.5) {
  const s = snapshotAt(h);
  history.push({ slot: iso(h), at: iso(h + 0.001), players_tracked: s.P,
    trophies_earned: s.rates.reduce((a, r) => a + Math.round((r / 100) * s.P), 0), rates: s.rates });
}
const targetH = 156;
const ans = snapshotAt(targetH);
const caseObj = {
  schema: 'makefun/gta6-trophies-case/v1', id: 'diag-slow-11', at: iso(48),
  horizon_minutes: (targetH - 48) * 60, target: iso(targetH), levels: LEVELS,
  game: p01.game, trophies: TROPHIES, history, notes: 'diag',
};

// --- run main.ts ---
const inDir = join(TMP, 'in');
const outDir = join(TMP, 'out');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(inDir, { recursive: true });
writeFileSync(join(inDir, 'diag-slow-11.in'), JSON.stringify(caseObj));
const r = spawnSync('node', ['main.ts'], { cwd: BOT, env: { ...process.env, MAKEFUN_INPUT_DIR: inDir, MAKEFUN_OUTPUT_DIR: outDir }, encoding: 'utf8' });
if (r.status !== 0) { console.log('main.ts failed', r.stderr); process.exit(1); }
const rows = JSON.parse(readFileSync(join(outDir, 'diag-slow-11.out'), 'utf8')).trophies;

// --- curve baseline median (same code as backtest) ---
const days = caseObj.horizon_minutes / 1440;
const rw = 0.5 * Math.sqrt(days);
const last = history[history.length - 1];
const lastMs = Date.parse(last.at);
const win = history.filter((x) => Date.parse(x.at) >= lastMs - 24 * 3600000);
const curveMed = TROPHIES.map((t, i) => {
  const xs = []; const ys = [];
  for (const x of win) {
    if (x.rates[i] === null) continue;
    xs.push(Math.log1p(Math.max(0, (Date.parse(x.at) - EPOCH) / 3600000)));
    ys.push(logit(x.rates[i]));
  }
  if (xs.length < 3) return logit(last.rates[i]);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0; let sxy = 0;
  for (let j = 0; j < n; j++) { sxx += (xs[j] - mx) ** 2; sxy += (xs[j] - mx) * (ys[j] - my); }
  const slope = sxx < 1e-12 ? 0 : sxy / sxx;
  const inter = my - slope * mx;
  const xT = Math.log1p(Math.max(0, (Date.parse(caseObj.target) - EPOCH) / 3600000));
  return inter + slope * xT;
});

console.log('id kind/tier | truth logit | model med | curve med | last | model spread | err_model err_curve');
let em = 0, ec = 0;
TROPHIES.forEach((t, i) => {
  const tl = logit(ans.rates[i]);
  const mm = logit(rows[i].q[2]);
  const cm = curveMed[i];
  const ll = logit(last.rates[i]);
  const s = (logit(rows[i].q[4]) - logit(rows[i].q[0])) / (2 * 1.645);
  em += Math.abs(mm - tl); ec += Math.abs(cm - tl);
  if (i < 20 || Math.abs(mm - tl) > 1.5) {
    console.log(`${String(t.id).padStart(2)} ${kindOf(t).padEnd(8)} ${t.tier.padEnd(8)} | ${tl.toFixed(2).padStart(7)} | ${mm.toFixed(2).padStart(7)} | ${cm.toFixed(2).padStart(7)} | ${ll.toFixed(2).padStart(6)} | ${s.toFixed(2).padStart(6)} | ${(mm - tl).toFixed(2).padStart(6)} ${(cm - tl).toFixed(2).padStart(6)}`);
  }
});
console.log(`mean |median error| model=${(em / TROPHIES.length).toFixed(3)} curve=${(ec / TROPHIES.length).toFixed(3)}`);
console.log(`players: last=${last.players_tracked} target~${Math.round(playersAt(targetH))}; truth rate range: ${Math.min(...ans.rates)}..${Math.max(...ans.rates)}`);
