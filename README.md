[![gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/xxstealz/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/xxstealz/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

# GTA VI Trophy Rarity Forecast — "TrophyRarity"

Forecasts, for every GTA VI trophy on PlayStation 5, five quantiles of the
percent of Exophase-tracked players who will have earned it a week after
launch (2026-11-26T00:00:00Z), scored by pinball loss on the logit scale.
Entry for the [make.fun bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
($250, top 20).

## The program

`main.ts` (Node 22, standard library only, no network, deterministic) reads
each `<id>.in` case from `/input` (or `MAKEFUN_INPUT_DIR`) and writes
`<id>.out` to `/output`: `{"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]}`.

## The model

Per trophy, on the logit scale against `x = ln(1 + hours since 2026-11-19T00:00Z)`:

- **Two fits, one median.** (A) OLS of `logit(rate)` on `x` over the last
  24h of *distinct* reads — Exophase's page is frozen between refreshes, so
  consecutive identical reads are collapsed first. (B) A decomposition:
  OLS of `log(earners)` on `x` plus a once-per-case OLS of `log(players)`
  on `x`, giving an implied rate `100 * earners_T / players_T`. This
  separates progression (earners grow as players play) from dilution
  (players grow as new buyers sync): when Exophase refreshes and players
  jump, rates fall even though nobody lost a trophy — the first refresh
  took players 638 → 3,868 and moved almost every rate ~1.8 logit down.
  Median = 0.5·A + 0.5·B in logit space.
- **Shrinkage.** Slopes shrink toward their group mean (tier × kind:
  story / collect / activity / other, from name + description),
  empirical-Bayes with k = 3. Story trophies climb steeply, grinds crawl,
  platinum slowest.
- **Saturation caps.** The median's move from the last read is capped at
  3.5 logit, and the median rate itself is capped by tier (platinum 1%,
  gold 10%, silver 25%, bronze 70%): a week-one rate saturates, and a
  linear log-time extrapolation of a saturating curve overshoots by logit
  units. A trophy already at ≥99% is treated as saturated (≈99.99%).
- **Spread.** `sqrt(residual_var + (slope_se·Δx)² + (0.4·√days)² +
  refresh_var)`, where `refresh_var` is estimated from the observed
  refresh jumps in the history (robust MAD estimator, floored at 0.25,
  capped at 4.0) and 2.25 when the history is flat and no refresh has been
  seen yet. The house spread (0.5 logit per √day) is far too narrow for a
  refresh-driven world — it scored ~1.51 on the practice with ~0 coverage.
- **Safety.** Any failure on a case falls back to a tier prior instead of
  crashing, because an invalid case takes no prize.

## Local validation

- `node validate.mjs` — practice cases p00/p01: output valid (55 rows,
  5 quantiles 0–100 non-decreasing, ≤65,536 B), deterministic (two runs
  byte-identical), ~170 ms per run (limit 8 s). **PASS.**
- `node backtest.mjs` — (1) cut-backtest on the flat practice histories;
  (2) practice vs the refresh estimate (answer ≈ rate × 638/3868):
  **model 0.9601 vs persistence 1.6877** (house practice loss ~1.51),
  coverage 0.98; (3) synthetic launch-week backtest, 15 seeded cases
  across 5 scenarios (base / fast / slow / dilution-jump /
  refresh-heavy), main.ts run end-to-end: **model 0.3607 vs persistence
  0.3674 vs house curve baseline 0.3995** — the model beats both house
  baselines on average, winning 14/15 cases against the curve baseline.
  It loses only on the dilution-jump stress cases, where an unforecastable
  3× player jump after the checkpoint reverses the trend (persistence
  wins those by not moving at all).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```
