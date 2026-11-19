// backtest.mjs — local evaluation for main.ts (not part of the entry).
// 1) Cut-backtest on the practice cases: truncate the flat history and
//    predict the next (identical) read — a sanity check that the model does
//    not lose on flat data beyond its wider spread.
// 2) Rough practice-vs-refresh check: the post-refresh answer estimated as
//    rate * 638/3868 (earners unchanged, players 638 -> 3,868), labelled
//    PERKIRAAN — the true refreshed rates are not in the kit.
// 3) Synthetic launch-week backtest: Exophase-style simulations with
//    seeded RNG (players growth, per-trophy S-curves in log-time, refreshes
//    that freeze the page between snapshots, 2-decimal rates). The truth is
//    generated with a DIFFERENT time transform (ln(1+t/6)) and ceilings the
//    model does not know, so the test is not rigged in the model's favour.
//    main.ts is run end-to-end on each synthetic case; pinball loss is
//    scored exactly as the scorer does, against the house persistence
//    baseline on the same case.
// Usage: node backtest.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT = dirname(fileURLToPath(import.meta.url));
const KIT = '/home/hatch/workspace/makefun/gta6-trophy-rarity-forecast-01-kit/gta6-trophy-rarity-forecast-01-kit';
const TMP = '/tmp/rarity-backtest';
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];

const clampPct = (x) => Math.min(99.99, Math.max(0.01, x));
const logit = (pct) => { const p = clampPct(pct) / 100; return Math.log(p / (1 - p)); };
const sigmoidPct = (l) => 100 / (1 + Math.exp(-l));
const round4 = (x) => Math.round(x * 10000) / 10000;

// mulberry32 — deterministic seeded RNG.
const rng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pinball = (y, q) => {
  let tot = 0;
  let n = 0;
  for (let i = 0; i < y.length; i++) {
    for (let j = 0; j < 5; j++) {
      const d = logit(y[i]) - logit(q[i][j]);
      tot += 2 * Math.max(LEVELS[j] * d, (LEVELS[j] - 1) * d);
      n++;
    }
  }
  return tot / n;
};

const persistenceRows = (lastRates, days) => {
  const s = 0.5 * Math.sqrt(days);
  return lastRates.map((r, i) => ({
    id: i + 1,
    q: Z.map((z) => round4(clampPct(sigmoidPct(logit(r) + z * s)))),
  }));
};

const runMainOn = (caseObj, tag) => {
  const inDir = join(TMP, tag, 'in');
  const outDir = join(TMP, tag, 'out');
  rmSync(join(TMP, tag), { recursive: true, force: true });
  mkdirSync(inDir, { recursive: true });
  writeFileSync(join(inDir, `${caseObj.id}.in`), JSON.stringify(caseObj));
  const r = spawnSync('node', ['main.ts'], {
    cwd: BOT,
    env: { ...process.env, MAKEFUN_INPUT_DIR: inDir, MAKEFUN_OUTPUT_DIR: outDir },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`main.ts failed on ${tag}: ${r.stderr}`);
  return JSON.parse(readFileSync(join(outDir, `${caseObj.id}.out`), 'utf8')).trophies;
};

const coverage = (y, rows) => {
  let inside = 0;
  for (let i = 0; i < y.length; i++) {
    if (rows[i].q[0] <= y[i] && y[i] <= rows[i].q[4]) inside++;
  }
  return inside / y.length;
};

// ---------- 1) cut-backtest on practice (flat data) ----------
console.log('--- 1) cut-backtest on practice (truth = next identical read) ---');
for (const cid of ['p00', 'p01']) {
  const c = JSON.parse(readFileSync(join(KIT, 'input', `${cid}.in`), 'utf8'));
  const H = c.history;
  for (const k of [3, 5]) {
    if (k >= H.length) continue;
    const cut = {
      ...c,
      id: `${cid}cut${k}`,
      at: H[k - 1].at,
      target: H[k].at,
      horizon_minutes: Math.round((Date.parse(H[k].at) - Date.parse(H[k - 1].at)) / 60000),
      history: H.slice(0, k),
    };
    const truth = H[k].rates;
    const rows = runMainOn(cut, `${cid}cut${k}`);
    const qs = rows.map((r) => r.q);
    const days = cut.horizon_minutes / 1440;
    const base = persistenceRows(H[k - 1].rates, days).map((r) => r.q);
    console.log(
      `  ${cid} k=${k}: model=${pinball(truth, qs).toFixed(4)} persistence=${pinball(truth, base).toFixed(4)}` +
      ` (truth identical to last read; model spread wider by design)`,
    );
  }
}

// ---------- 2) rough practice-vs-refresh check (PERKIRAAN) ----------
console.log('--- 2) practice vs refresh estimate (PERKIRAAN: answer ~= rate * 638/3868) ---');
for (const cid of ['p00', 'p01']) {
  const c = JSON.parse(readFileSync(join(KIT, 'input', `${cid}.in`), 'utf8'));
  const last = c.history[c.history.length - 1].rates;
  const est = last.map((r) => (r >= 99.995 ? r : (r * 638) / 3868));
  const rows = runMainOn(c, `${cid}est`);
  const qs = rows.map((r) => r.q);
  const days = c.horizon_minutes / 1440;
  const base = persistenceRows(last, days).map((r) => r.q);
  console.log(
    `  ${cid}: model=${pinball(est, qs).toFixed(4)} (coverage ${coverage(est, rows).toFixed(2)})` +
    ` persistence=${pinball(est, base).toFixed(4)} (house practice loss ~1.51)`,
  );
}

// ---------- 3) synthetic launch-week backtest ----------
console.log('--- 3) synthetic launch-week backtest (main.ts end-to-end) ---');
const p01 = JSON.parse(readFileSync(join(KIT, 'input', 'p01.in'), 'utf8'));
const TROPHIES = p01.trophies;
const R0 = p01.history[p01.history.length - 1].rates; // launch-night rates
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

// House curve baseline, as RULES specifies it: per trophy, OLS of
// logit(rate) on ln(1 + hours since 2026-11-19T00:00Z) over the last 24h of
// reads, read at the target; spread = random walk + fit residual combined
// (here: sqrt of the sum of squares); fewer than 3 reads -> persistence.
const curveBaselineRows = (c) => {
  const days = c.horizon_minutes / 1440;
  const rw = 0.5 * Math.sqrt(days);
  const last = c.history[c.history.length - 1];
  const lastMs = Date.parse(last.at);
  const win = c.history.filter((r) => Date.parse(r.at) >= lastMs - 24 * 3600000);
  return c.trophies.map((t, i) => {
    const xs = [];
    const ys = [];
    for (const r of win) {
      if (r.rates[i] === null || r.rates[i] === undefined) continue;
      xs.push(Math.log1p(Math.max(0, (Date.parse(r.at) - EPOCH) / 3600000)));
      ys.push(logit(r.rates[i]));
    }
    const lr = last.rates[i];
    if (xs.length < 3) {
      return { id: t.id, q: Z.map((z) => round4(clampPct(sigmoidPct(logit(lr) + z * rw)))) };
    }
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (let j = 0; j < n; j++) { sxx += (xs[j] - mx) ** 2; sxy += (xs[j] - mx) * (ys[j] - my); }
    const slope = sxx < 1e-12 ? 0 : sxy / sxx;
    const inter = my - slope * mx;
    let rss = 0;
    for (let j = 0; j < n; j++) rss += (ys[j] - (inter + slope * xs[j])) ** 2;
    const residVar = rss / Math.max(1, n - 2);
    const xT = Math.log1p(Math.max(0, (Date.parse(c.target) - EPOCH) / 3600000));
    const med = inter + slope * xT;
    const s = Math.sqrt(rw * rw + Math.max(0.04, residVar));
    return { id: t.id, q: Z.map((z) => round4(clampPct(sigmoidPct(med + z * s)))) };
  });
};

const SCENARIOS = [
  { name: 'base', aP: 1.2, refreshH: 4, jumpAt: null },
  { name: 'fast-growth', aP: 1.8, refreshH: 4, jumpAt: null },
  { name: 'slow-growth', aP: 0.7, refreshH: 4, jumpAt: null },
  { name: 'dilution-jump', aP: 1.2, refreshH: 4, jumpAt: 120 },
  { name: 'refresh-heavy', aP: 1.2, refreshH: 2, jumpAt: null },
];

let grandModel = 0;
let grandBase = 0;
let grandCurve = 0;
let grandN = 0;
for (const sc of SCENARIOS) {
  for (const seed of [11, 22, 33]) {
    const rnd = rng(seed * 1000 + sc.name.length * 77);
    // Per-trophy truth parameters. Earners grow as a power of log-time;
    // the SHOWN rate is earners/players, so slow trophies DILUTE (rate
    // falls) while new players flood in, and story trophies climb.
    const params = TROPHIES.map((t, i) => {
      const kind = kindOf(t);
      const tierCeil = { platinum: 0.008, gold: 0.06, silver: 0.12, bronze: 0.5 }[t.tier] ?? 0.3;
      const kindMult = { story: 1.0, collect: 0.35, activity: 0.6, other: 0.5 }[kind];
      const ceil = Math.min(0.9999, Math.max(tierCeil * kindMult, R0[i] / 100));
      const speedBase = { story: 2.0, collect: 1.0, activity: 1.3, other: 1.1 }[kind];
      const speed = t.tier === 'platinum' ? 0.6 : speedBase * (0.8 + 0.4 * rnd());
      return { r0: Math.max(0.1, R0[i]), ceil, speed };
    });
    const playersAt = (h) => {
      let p = 638 * Math.pow(1 + h / 24, sc.aP);
      if (sc.jumpAt !== null && h >= sc.jumpAt) p *= 3;
      return p;
    };
    const earnersAt = (i, h) => {
      const { r0, speed } = params[i];
      const e0 = (r0 / 100) * 638;
      return e0 * Math.pow(1 + h / 6, speed);
    };
    // Snapshot grid: a refresh every refreshH hours; reads every 30 min
    // show the latest snapshot (frozen between refreshes).
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
      history.push({
        slot: iso(h), at: iso(h + 0.001), players_tracked: s.P,
        trophies_earned: s.rates.reduce((a, r) => a + Math.round((r / 100) * s.P), 0),
        rates: s.rates,
      });
    }
    const targetH = 156; // 48h history + 108h horizon
    const ans = snapshotAt(targetH);
    const caseObj = {
      schema: 'makefun/gta6-trophies-case/v1',
      id: `syn-${sc.name}-${seed}`,
      at: iso(48),
      horizon_minutes: (targetH - 48) * 60,
      target: iso(targetH),
      levels: LEVELS,
      game: p01.game,
      trophies: TROPHIES,
      history,
      notes: 'synthetic',
    };
    const rows = runMainOn(caseObj, `syn-${sc.name}-${seed}`);
    const qs = rows.map((r) => r.q);
    const lastRates = history[history.length - 1].rates;
    const base = persistenceRows(lastRates, (targetH - 48) / 24).map((r) => r.q);
    const curve = curveBaselineRows(caseObj).map((r) => r.q);
    const lm = pinball(ans.rates, qs);
    const lb = pinball(ans.rates, base);
    const lc = pinball(ans.rates, curve);
    grandModel += lm; grandBase += lb; grandCurve += lc; grandN++;
    console.log(
      `  ${sc.name} seed=${seed}: model=${lm.toFixed(4)} persistence=${lb.toFixed(4)} curve=${lc.toFixed(4)}` +
      ` (vs curve ${lm < lc ? 'WINS' : 'loses'} by ${(lc - lm).toFixed(4)}, coverage ${coverage(ans.rates, rows).toFixed(2)})`,
    );
  }
}
console.log(
  `SYNTHETIC MEAN over ${grandN} cases: model=${(grandModel / grandN).toFixed(4)}` +
  ` persistence=${(grandBase / grandN).toFixed(4)} curve=${(grandCurve / grandN).toFixed(4)}` +
  ` (model beats curve by ${((grandCurve - grandModel) / grandN).toFixed(4)})`,
);
