// gta6-trophy-rarity-forecast-01 — "TrophyRarity" forecaster (Node 22, stdlib only).
//
// What it forecasts: for every trophy of GTA VI on PS5, five quantiles of the
// percent of Exophase-tracked players who will have earned it at the case's
// target, scored by pinball loss on the logit scale.
//
// The model, per trophy, on the logit scale against x = ln(1 + hours since
// 2026-11-19T00:00Z):
//   - Fit A (direct): OLS of logit(rate) on x over the last 36h of DISTINCT
//     reads (Exophase's page is frozen between refreshes, so consecutive
//     identical reads are collapsed first; a flat stretch carries no signal).
//   - Fit B (decomposition): OLS of log(earners) on x and, once per case,
//     OLS of log(players) on x, giving an implied rate
//     100 * earners_T / players_T. This separates progression (earners grow
//     as players play) from dilution (players grow as new buyers sync):
//     when Exophase refreshes and players jump, rates fall even though
//     nobody lost a trophy — the first refresh took players 638 -> 3,868
//     and moved almost every rate ~1.8 logit down. Fit B sees through that.
//   - Median = 0.35 * A + 0.65 * B in logit space (B wins when players move).
//   - Slopes are shrunk toward their group mean (tier x kind: story /
//     collect / activity / other, from name + description), empirical-Bayes
//     with k = 3: story trophies climb steeply, grinds crawl, platinum
//     slowest. Groups with too few members fall back to tier, then global.
//   - The median's move from the last read is capped at 3.5 logit, and the
//     median rate itself is capped by tier (platinum 1%, gold 10%, silver
//     25%, bronze 70%): a week-one rate saturates — a linear log-time
//     extrapolation of a saturating curve overshoots catastrophically
//     (a chapter trophy heading for ~50% must not be forecast at 99%).
//     The cap binds only the median; the upper quantiles may exceed it.
//   - A trophy already at >=99% is treated as saturated (~99.95%).
//   - Spread s per trophy: sqrt(residual_var + (slope_se * dx)^2
//     + (0.5 * sqrt(days))^2 + refresh_var), where refresh_var is estimated
//     from the observed refresh jumps in the history (robust MAD estimator,
//     floored at 0.25, capped at 4.0) and 2.25 when the history is flat and
//     no refresh has been seen yet. The house spread (0.5 logit per
//     square-root day) is far too narrow for a refresh-driven world.
//   - Quantiles: sigmoid(logit(median) + z_tau * s), z = the normal
//     quantiles at 0.05/0.25/0.5/0.75/0.95, rounded to 4 decimals.
//
// Everything is a pure function of the case file: no clock, no randomness,
// files processed in name order, so two runs are byte-identical. Any failure
// on a case falls back to a tier prior instead of crashing, because an
// invalid case takes no prize.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Log-time origin: launch day, 2026-11-19T00:00:00Z. */
const EPOCH_MS = Date.parse('2026-11-19T00:00:00Z');
/** How far back the trend fits look, in hours (drops the stale launch-night regime). */
const WINDOW_HOURS = 24;
/** Empirical-Bayes shrinkage strength for slopes (pseudo-count of group reads). */
const SHRINK_K = 3;
/** Weight of the earners/players decomposition in the median (rest: direct fit). */
const DECOMP_WEIGHT = 0.5;
/** Max logit move of the median away from the last read. */
const MAX_LOGIT_MOVE = 3.5;
/** Week-one saturation ceiling on the median rate, by tier (percent). */
const TIER_CAP: Record<string, number> = { platinum: 1, gold: 10, silver: 25, bronze: 70 };
/** Refresh variance when the history is flat and no refresh was ever seen. */
const REFRESH_VAR_PRIOR = 2.25;
/** Refresh variance floor / cap. */
const REFRESH_VAR_MIN = 0.25;
const REFRESH_VAR_MAX = 4.0;
/** Spread floor / cap, in logit units. */
const SPREAD_MIN = 0.3;
const SPREAD_MAX = 3.5;
/** Tier fallback medians (percent) when a trophy has no usable history. */
const TIER_PRIOR: Record<string, number> = { platinum: 0.5, gold: 1, silver: 1, bronze: 1 };

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}
interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}
interface CaseFile {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: unknown;
  trophies: Trophy[];
  history: Read[];
}
/** One distinct snapshot of the Exophase page. */
interface Snap {
  hours: number;
  x: number;
  players: number;
  rates: Array<number | null>;
}
interface Fit {
  slope: number;
  intercept: number;
  meanX: number;
  meanY: number;
  residVar: number;
  slopeSe: number;
  n: number;
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const sigmoidPct = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const hoursSinceEpoch = (iso: string): number =>
  Math.max(0, (Date.parse(iso) - EPOCH_MS) / 3_600_000);
const xOfHours = (h: number): number => Math.log1p(h);
const medianOf = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Ordinary least squares of ys on xs; null when fewer than 2 points. */
const ols = (xs: number[], ys: number[]): Fit | null => {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  if (sxx < 1e-12) {
    return { slope: 0, intercept: my, meanX: mx, meanY: my, residVar: 0, slopeSe: 0, n };
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    rss += r * r;
  }
  const residVar = rss / Math.max(1, n - 2);
  return {
    slope,
    intercept,
    meanX: mx,
    meanY: my,
    residVar,
    slopeSe: Math.sqrt(residVar / sxx),
    n,
  };
};

/** Collapse consecutive identical page snapshots (frozen between refreshes). */
const dedupe = (history: Read[]): Snap[] => {
  const snaps: Snap[] = [];
  for (const r of history) {
    const hours = hoursSinceEpoch(r.at);
    const players = typeof r.players_tracked === 'number' ? r.players_tracked : 0;
    const rates = Array.isArray(r.rates) ? r.rates : [];
    const prev = snaps[snaps.length - 1];
    if (
      prev !== undefined &&
      prev.players === players &&
      prev.rates.length === rates.length &&
      prev.rates.every((v, i) => v === rates[i])
    ) {
      continue;
    }
    snaps.push({ hours, x: xOfHours(hours), players, rates });
  }
  return snaps;
};

/** Story / collect / activity / other, from the trophy's own description. */
const kindOf = (t: Trophy): string => {
  const d = (t.description || '').toLowerCase();
  if (
    /^complete (chapter \d|the final mission)/.test(d) ||
    /complete gone fishing/.test(d) ||
    /complete (breakfast run|the cartel heist|child's play|headliners|vcia takedown|operation savage glory)/.test(d)
  ) {
    return 'story';
  }
  if (
    /(collect|discover|purchase|spend|earn \$|complete \d+ (challenge|collectible|card)|meditate at every|explore all|register \d+ vehicles|attain 100%)/.test(
      d,
    )
  ) {
    return 'collect';
  }
  if (
    /(win|beat|medal|race|rob|hunt|take down|bowl|smash|enjoy a cocktail|follow-through|lose a \d+ star)/.test(
      d,
    )
  ) {
    return 'activity';
  }
  return 'other';
};

/** Mean of a list, or the fallback when the list is too short to trust. */
const groupMean = (vals: number[], fallback: number): number => {
  if (vals.length >= 2) {
    let s = 0;
    for (const v of vals) s += v;
    return s / vals.length;
  }
  return fallback;
};

/** Forecast one case file into its output rows. Never throws. */
const forecastCase = (c: CaseFile): Array<{ id: number; q: number[] }> => {
  const trophies = c.trophies;
  const nT = trophies.length;
  const days = Math.max(0, c.horizon_minutes / 1440);
  const xT = xOfHours(hoursSinceEpoch(c.target));
  // Random-walk term, 0.4 logit per square-root day: the house uses 0.5
  // for a no-trend forecast, but the trend fits below already remove the
  // systematic movement, so the residual walk is narrower.
  const rwVar = 0.16 * days;
  const lastRaw = c.history[c.history.length - 1];

  // Distinct snapshots, then the fitting window (last 36h, or all when short).
  const snaps = dedupe(c.history);
  const lastSnap = snaps[snaps.length - 1];
  const lastHours = lastSnap !== undefined ? lastSnap.hours : 0;
  const window = snaps.filter((s) => s.hours >= lastHours - WINDOW_HOURS);
  const fitSnaps = window.length >= 3 ? window : snaps;

  // Refresh noise: robust spread of the per-trophy logit jumps between
  // consecutive distinct snapshots. Flat history -> the prior (a refresh
  // the case has never seen can move rates ~1.5 logit).
  let refreshVar = REFRESH_VAR_PRIOR;
  if (snaps.length >= 2) {
    const jumps: number[] = [];
    for (let j = 1; j < snaps.length; j++) {
      const a = snaps[j - 1];
      const b = snaps[j];
      for (let i = 0; i < nT; i++) {
        const ra = a.rates[i];
        const rb = b.rates[i];
        if (ra === null || rb === null) continue;
        jumps.push(Math.abs(logit(rb) - logit(ra)));
      }
    }
    if (jumps.length >= 5) {
      const mad = medianOf(jumps);
      const sd = mad / 0.6745;
      refreshVar = Math.min(REFRESH_VAR_MAX, Math.max(REFRESH_VAR_MIN, sd * sd));
    }
  }

  // Global players fit (one series for the whole case).
  const pXs: number[] = [];
  const pYs: number[] = [];
  for (const s of fitSnaps) {
    if (s.players > 0) {
      pXs.push(s.x);
      pYs.push(Math.log(s.players));
    }
  }
  const fitP = ols(pXs, pYs);

  // Pass 1: raw per-trophy fits, for the group priors.
  interface RawFit {
    fitA: Fit | null;
    fitE: Fit | null;
    lastRate: number | null;
    n: number;
  }
  const raw: RawFit[] = trophies.map((_, i) => {
    const xs: number[] = [];
    const ysA: number[] = [];
    const ysE: number[] = [];
    let lastRate: number | null = null;
    for (const s of fitSnaps) {
      const r = s.rates[i];
      if (r === null || r === undefined || s.players <= 0) continue;
      xs.push(s.x);
      ysA.push(logit(r));
      ysE.push(Math.log((clampPct(r) / 100) * s.players));
      lastRate = r;
    }
    if (lastRaw !== undefined && lastRaw.rates !== undefined && lastRaw.rates[i] !== null) {
      lastRate = lastRaw.rates[i] as number;
    }
    return { fitA: ols(xs, ysA), fitE: ols(xs, ysE), lastRate, n: xs.length };
  });

  // Group slope priors (tier x kind), with tier then global fallbacks.
  const slopeAByGroup = new Map<string, number[]>();
  const slopeEByGroup = new Map<string, number[]>();
  const slopeAByTier = new Map<string, number[]>();
  const slopeEByTier = new Map<string, number[]>();
  const allSlopeA: number[] = [];
  const allSlopeE: number[] = [];
  trophies.forEach((t, i) => {
    const g = `${t.tier}|${kindOf(t)}`;
    const r = raw[i];
    if (r.fitA !== null) {
      (slopeAByGroup.get(g) ?? slopeAByGroup.set(g, []).get(g) as number[]).push(r.fitA.slope);
      (slopeAByTier.get(t.tier) ?? slopeAByTier.set(t.tier, []).get(t.tier) as number[]).push(
        r.fitA.slope,
      );
      allSlopeA.push(r.fitA.slope);
    }
    if (r.fitE !== null) {
      (slopeEByGroup.get(g) ?? slopeEByGroup.set(g, []).get(g) as number[]).push(r.fitE.slope);
      (slopeEByTier.get(t.tier) ?? slopeEByTier.set(t.tier, []).get(t.tier) as number[]).push(
        r.fitE.slope,
      );
      allSlopeE.push(r.fitE.slope);
    }
  });
  const globalA = allSlopeA.length > 0 ? allSlopeA.reduce((a, b) => a + b, 0) / allSlopeA.length : 0;
  const globalE = allSlopeE.length > 0 ? allSlopeE.reduce((a, b) => a + b, 0) / allSlopeE.length : 0;
  const priorSlope = (
    byGroup: Map<string, number[]>,
    byTier: Map<string, number[]>,
    global: number,
    tier: string,
    group: string,
  ): number => {
    const g = byGroup.get(group);
    if (g !== undefined && g.length >= 2) return groupMean(g, global);
    const t = byTier.get(tier);
    if (t !== undefined && t.length >= 2) return groupMean(t, global);
    return global;
  };

  // Pass 2: final forecast per trophy.
  return trophies.map((t, i) => {
    const r = raw[i];
    const lastRate = r.lastRate;
    const fallbackMedian = TIER_PRIOR[t.tier] ?? 1;
    // No usable history at all: tier prior, wide spread.
    if (lastRate === null || lastRate === undefined) {
      const l = logit(fallbackMedian);
      return {
        id: t.id,
        q: Z.map((z) => round4(clampPct(sigmoidPct(l + z * 1.5)))),
      };
    }
    // Already at ~100%: essentially everyone has it (it held 100% through
    // a 6x player jump on launch night); keep the median at the top with a
    // modest downside tail for dilution by brand-new players.
    if (lastRate >= 99) {
      const l = logit(99.99);
      return {
        id: t.id,
        q: Z.map((z) => round4(clampPct(sigmoidPct(l + z * 0.8)))),
      };
    }
    const lastLogit = logit(lastRate);
    // Too little history to fit: persistence, wide spread.
    if (r.fitA === null || r.fitE === null || r.n < 3) {
      const s = Math.min(
        SPREAD_MAX,
        Math.max(SPREAD_MIN, Math.sqrt(REFRESH_VAR_PRIOR + rwVar + 0.25)),
      );
      return {
        id: t.id,
        q: Z.map((z) => round4(clampPct(sigmoidPct(lastLogit + z * s)))),
      };
    }
    const fitA = r.fitA;
    const fitE = r.fitE;
    const group = `${t.tier}|${kindOf(t)}`;
    const priorA = priorSlope(slopeAByGroup, slopeAByTier, globalA, t.tier, group);
    const priorE = priorSlope(slopeEByGroup, slopeEByTier, globalE, t.tier, group);
    // Shrink each slope toward its group mean, then read the line at xT.
    const w = r.n / (r.n + SHRINK_K);
    const slopeA = w * fitA.slope + (1 - w) * priorA;
    const intA = fitA.meanY - slopeA * fitA.meanX;
    const predA = intA + slopeA * xT;
    const slopeE = w * fitE.slope + (1 - w) * priorE;
    const intE = fitE.meanY - slopeE * fitE.meanX;
    const earnersT = Math.exp(intE + slopeE * xT);
    let predB: number;
    if (fitP !== null) {
      const playersT = Math.exp(fitP.intercept + fitP.slope * xT);
      predB = logit(clampPct((100 * earnersT) / Math.max(1, playersT)));
    } else {
      predB = logit(clampPct((100 * earnersT) / Math.max(1, lastSnap.players)));
    }
    // Combine, then cap the move from the last read and the absolute rate:
    // week-one rates saturate, and a linear log-time extrapolation of a
    // saturating curve overshoots by logit units, not by percent. The cap
    // never pulls the median below the last read.
    let med = (1 - DECOMP_WEIGHT) * predA + DECOMP_WEIGHT * predB;
    med = Math.min(lastLogit + MAX_LOGIT_MOVE, Math.max(lastLogit - MAX_LOGIT_MOVE, med));
    med = Math.min(med, logit(Math.max(TIER_CAP[t.tier] ?? 70, lastRate)));
    // Spread: fit residual + slope uncertainty over the extrapolation +
    // the house random walk + refresh noise.
    const dx = xT - fitA.meanX;
    const s2 =
      Math.max(0.04, fitA.residVar) +
      (fitA.slopeSe * dx) * (fitA.slopeSe * dx) +
      rwVar +
      refreshVar;
    const s = Math.min(SPREAD_MAX, Math.max(SPREAD_MIN, Math.sqrt(s2)));
    const qs = Z.map((z) => round4(clampPct(sigmoidPct(med + z * s))));
    // Enforce non-decreasing after rounding.
    for (let j = 1; j < qs.length; j++) {
      if (qs[j] < qs[j - 1]) qs[j] = qs[j - 1];
    }
    return { id: t.id, q: qs };
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
    if (!Array.isArray(c.trophies) || c.trophies.length === 0) continue;
    const trophies = forecastCase(c);
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
  } catch {
    // A case we cannot read at all is skipped; the per-trophy fallback
    // inside forecastCase handles every data problem we can recover from.
    continue;
  }
}
