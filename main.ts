// gta6-trophy-rarity-forecast-01 — earners over players: a counts forecast.
//
// Idea: a trophy's earn rate is a ratio, rate = 100 * earners / players_tracked,
// and the two counts move on their own clocks. So this program never fits the
// rate directly: it reconstructs both counts from every history read and
// projects each one to the target, then divides.
//
//   e_i = round(rate_i * P / 100)          earners of trophy i in a read
//   h   = hours since the 2026-11-19T00:00:00Z release
//
// Two regimes, picked from the history itself:
//
//   FLAT — every read shows the same page (one distinct state). That is the
//   launch-night frozen page: P = 638 until Exophase's first refresh. The
//   RULES state the refresh outright (04:30 UTC 19 Nov, P = 3,868, every rate
//   but the 100% one lower). With earners unchanged across a refresh, the new
//   rate is pure dilution: rate' = 100 * e_i / 3868, printed to 2 decimals.
//   The 100% trophy is the prologue trophy every new player earns, so it
//   stays 100%. All five quantiles equal the diluted rate: the refresh is
//   deterministic given the model, and the dev board proves this scores ~0.
//
//   RICH — the page actually moves. Players and earners each follow a
//   log-time trend, ln(count) = a + b * ln(1 + h), fit by least squares over
//   the last 24 h of reads. Both counts are projected to the target and the
//   median is rate* = 100 * e* / P*. The logit spread per trophy is
//   calibrated by backtest: fit on the first 60% of the history's time span,
//   forecast the later reads, take the SD of the logit errors.
//
// Deterministic: fixed key order, no timestamps, no randomness, no network.
// Node 22, standard library only (node:fs, node:path).
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Release instant: every hour count is measured from here. */
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
/** Exophase's first refresh of the launch-night page (stated in the RULES). */
const REFRESH_MS = Date.parse('2026-11-19T04:30:00Z');
/** Players tracked on the refreshed page. */
const REFRESH_PLAYERS = 3868;
/** The frozen launch-night page never tracked more than this many players. */
const FROZEN_MAX_PLAYERS = 1000;
/** Print quantum of the Exophase page: rates are printed to 2 decimals. */
const PRINT_QUANTUM = 0.01;
/** A trophy nobody has earned yet: half the print quantum, wide spread. */
const ZERO_EARNER_MEDIAN = 0.005;

/** Quantile levels, in the order each output row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Backtest fallback spread (logit units) when a trophy has < 3 points. */
const FALLBACK_SIGMA = 0.8;
/** House-baseline spread scale (logit units per sqrt day), used for the
 *  FLAT/persistence fallback and as the floor of the backtest spread. */
const BASE_SIGMA_PER_SQRT_DAY = 0.5;

interface TrophyDef {
  id: number;
}

interface HistoryRead {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: TrophyDef[];
  history: HistoryRead[];
}

/** One reconstructed read: hours since release, players, earners per trophy. */
interface CountRead {
  h: number;
  atMs: number;
  players: number;
  earners: Array<number | null>;
  /** Index of this read in the case's history (reads may be dropped). */
  src: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const logit = (pct: number): number => {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number => 100 / (1 + Math.exp(-l));
const round2 = (x: number): number => Math.round(x * 100) / 100;
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const hoursSinceRelease = (ms: number): number => Math.max(0, (ms - RELEASE_MS) / 3_600_000);

/**
 * Inverse standard normal CDF (Acklam's rational approximation, ~1e-9
 * accurate). Lets the program honour whatever levels a case asks for
 * instead of hard-coding the five z values.
 */
const normInv = (p: number): number => {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
};

/** Least squares for y = a + b*x. Returns null when the fit is unusable. */
const leastSquares = (xs: number[], ys: number[]): { a: number; b: number } | null => {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  if (sxx <= 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
};

/** Reads of the last 24 h before the newest read; all reads if too few. */
const recentWindow = (reads: CountRead[]): CountRead[] => {
  if (reads.length === 0) return reads;
  const newest = reads[reads.length - 1].atMs;
  const windowed = reads.filter((r) => newest - r.atMs <= 24 * 3_600_000);
  return windowed.length >= 3 ? windowed : reads;
};

/**
 * Fit ln(count) = a + b*ln(1+h) on the given reads and project to hTarget.
 * `countOf` pulls the count out of a read (players, or one trophy's earners,
 * with the +0.5 continuity shift applied by the caller where needed).
 * Returns null when the fit cannot be made.
 */
const fitLogCount = (
  reads: CountRead[],
  countOf: (r: CountRead) => number | null,
  bMax: number,
): { project: (hTarget: number) => number } | null => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of reads) {
    const c = countOf(r);
    if (c === null || !(c > 0) || !Number.isFinite(c)) continue;
    xs.push(Math.log1p(r.h));
    ys.push(Math.log(c));
  }
  const fit = leastSquares(xs, ys);
  if (fit === null) return null;
  const b = clamp(fit.b, 0, bMax);
  // Re-anchor the line through the centroid after clamping the slope.
  let mx = 0;
  let my = 0;
  for (let i = 0; i < xs.length; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= xs.length;
  my /= ys.length;
  const a = my - b * mx;
  return { project: (hTarget: number) => Math.exp(a + b * Math.log1p(hTarget)) };
};

/**
 * The counts model (§3b): project players and per-trophy earners to hTarget
 * from a set of reads. Returns the projected players and earners, plus the
 * last observed values for fallback.
 */
const projectCounts = (
  reads: CountRead[],
  trophyCount: number,
  hTarget: number,
): { playersStar: number; earnersStar: Array<number | null>; playersLast: number; earnersLast: Array<number | null> } => {
  const last = reads[reads.length - 1];
  const playersLast = last.players;
  const earnersLast = last.earners.slice();
  const windowed = recentWindow(reads);
  let playersStar = playersLast;
  try {
    const pFit = fitLogCount(windowed, (r) => r.players, 1.5);
    if (pFit !== null) {
      playersStar = clamp(pFit.project(hTarget), playersLast, 5 * playersLast);
    }
  } catch {
    playersStar = playersLast;
  }
  const earnersStar: Array<number | null> = [];
  for (let i = 0; i < trophyCount; i++) {
    let eStar: number | null = earnersLast[i];
    try {
      const eFit = fitLogCount(windowed, (r) => {
        const e = r.earners[i];
        return e === null ? null : e + 0.5;
      }, 3);
      if (eFit !== null) {
        eStar = Math.max(0, eFit.project(hTarget) - 0.5);
      }
    } catch {
      eStar = earnersLast[i];
    }
    earnersStar.push(eStar);
  }
  return { playersStar, earnersStar, playersLast, earnersLast };
};

/** Sample standard deviation; null when fewer than 2 points. */
const sampleSd = (xs: number[]): number | null => {
  if (xs.length < 2) return null;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
};

/**
 * Backtest (§3b): split the history at 60% of its time span, fit the counts
 * model on the earlier part only, forecast the rates at each later read's
 * time, and take the per-trophy SD of the logit errors. Returns one sigma
 * per trophy.
 */
const backtestSigmas = (reads: CountRead[], trophyCount: number, horizonDays: number): number[] => {
  const sigmas: number[] = [];
  for (let i = 0; i < trophyCount; i++) sigmas.push(FALLBACK_SIGMA);
  if (reads.length < 4) return sigmas;
  const t0 = reads[0].atMs;
  const t1 = reads[reads.length - 1].atMs;
  if (t1 <= t0) return sigmas;
  const split = t0 + 0.6 * (t1 - t0);
  const early = reads.filter((r) => r.atMs <= split);
  const late = reads.filter((r) => r.atMs > split);
  if (early.length < 2 || late.length === 0) return sigmas;
  const errors: Array<number[]> = [];
  for (let i = 0; i < trophyCount; i++) errors.push([]);
  for (const read of late) {
    let proj: ReturnType<typeof projectCounts>;
    try {
      proj = projectCounts(early, trophyCount, read.h);
    } catch {
      continue;
    }
    for (let i = 0; i < trophyCount; i++) {
      const actual = read.earners[i] === null ? null : (100 * (read.earners[i] as number)) / read.players;
      const eStar = proj.earnersStar[i];
      if (actual === null || eStar === null) continue;
      const forecast = clamp((100 * eStar) / proj.playersStar, 0.01, 99.99);
      errors[i].push(logit(actual) - logit(forecast));
    }
  }
  const growth = Math.sqrt(1 + horizonDays / 2);
  for (let i = 0; i < trophyCount; i++) {
    if (errors[i].length < 3) {
      sigmas[i] = FALLBACK_SIGMA;
      continue;
    }
    const sd = sampleSd(errors[i]);
    if (sd === null || !Number.isFinite(sd)) {
      sigmas[i] = FALLBACK_SIGMA;
      continue;
    }
    sigmas[i] = clamp(1.25 * sd * growth, 0.35, 2.0);
  }
  return sigmas;
};

/** Five quantiles around a median percent on the logit scale. */
const quantilesAround = (medianPct: number, sigma: number, z: number[]): number[] => {
  const centre = Math.log(clamp(medianPct, 0.01, 99.99) / (100 - clamp(medianPct, 0.01, 99.99)));
  const qs = z.map((zi) => round4(clamp(invLogitPct(centre + zi * sigma), 0.01, 100)));
  // Enforce non-decreasing (holds by construction; rounding can only tie).
  for (let i = 1; i < qs.length; i++) {
    if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
  }
  return qs;
};

/** Forecast one case. Never throws for a usable case: falls back per trophy. */
const forecastCase = (c: Case): { trophies: Array<{ id: number; q: number[] }> } => {
  const trophyCount = c.trophies.length;
  const z = c.levels.map((t) => normInv(clamp(t, 0.0001, 0.9999)));
  const horizonDays = c.horizon_minutes / 1440;
  const targetMs = Date.parse(c.target);
  const hTarget = hoursSinceRelease(targetMs);

  // Reconstruct counts, oldest first; drop reads with missing/invalid P.
  const reads: CountRead[] = [];
  for (let ri = 0; ri < c.history.length; ri++) {
    const read = c.history[ri];
    const p = read.players_tracked;
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) continue;
    const atMs = Date.parse(read.at);
    if (!Number.isFinite(atMs)) continue;
    const earners: Array<number | null> = [];
    for (let i = 0; i < trophyCount; i++) {
      const rate = read.rates[i];
      if (rate === null || rate === undefined || typeof rate !== 'number' || !Number.isFinite(rate)) {
        earners.push(null);
        continue;
      }
      if (rate >= 100) earners.push(p);
      else if (rate <= 0) earners.push(0);
      else earners.push(Math.round((rate * p) / 100));
    }
    reads.push({ h: hoursSinceRelease(atMs), atMs, players: p, earners, src: ri });
  }
  if (reads.length === 0) throw new Error(`${c.id} has no usable history`);
  const last = reads[reads.length - 1];
  const lastRates: Array<number | null> = last.earners.map((e, i) => {
    const rate = c.history[last.src].rates[i];
    return typeof rate === 'number' && Number.isFinite(rate) ? rate : e === null ? null : (100 * e) / last.players;
  });

  // How many distinct page states does the (usable) history show?
  const states = new Set<string>();
  for (const r of reads) {
    states.add(`${r.players}|${r.earners.map((x) => String(x)).join(',')}`);
  }
  const isFlat = states.size <= 1;

  // FLAT regime: the known launch-night refresh (SPEC §3a).
  const flatApplies =
    isFlat &&
    last.atMs < REFRESH_MS &&
    targetMs >= REFRESH_MS &&
    last.players <= FROZEN_MAX_PLAYERS;
  if (flatApplies) {
    const trophies = c.trophies.map((t, i) => {
      const e = last.earners[i];
      let rate: number;
      if ((lastRates[i] ?? 0) >= 100) rate = 100;
      else if (e === null || e === 0) rate = 0;
      else rate = round2((100 * e) / REFRESH_PLAYERS);
      const q = [rate, rate, rate, rate, rate].map((x) => round4(clamp(x, 0, 100)));
      return { id: t.id, q };
    });
    return { trophies };
  }

  // RICH regime (or FLAT history that does not straddle the refresh):
  // counts model with backtest-calibrated spreads; persistence per trophy
  // wherever a fit fails.
  let sigmas: number[];
  let proj: ReturnType<typeof projectCounts> | null = null;
  if (!isFlat) {
    sigmas = backtestSigmas(reads, trophyCount, horizonDays);
    try {
      proj = projectCounts(reads, trophyCount, hTarget);
    } catch {
      proj = null;
    }
  } else {
    // Flat history, no refresh to dilute into: persistence + house spread.
    const sigma = Math.max(0.25, BASE_SIGMA_PER_SQRT_DAY * Math.sqrt(horizonDays));
    sigmas = new Array<number>(trophyCount).fill(sigma);
  }
  const wideZeroSigma = Math.max(1.5, BASE_SIGMA_PER_SQRT_DAY * Math.sqrt(horizonDays));

  const trophies = c.trophies.map((t, i) => {
    const lastRate = lastRates[i];
    const eLast = last.earners[i];
    // The prologue trophy: every tracked player earns it.
    if ((lastRate ?? 0) >= 100) return { id: t.id, q: [100, 100, 100, 100, 100] };
    // Nobody has earned it yet: it may earn its first trophies by target.
    const allZero = reads.every((r) => r.earners[i] === 0);
    if (allZero) {
      const centre = Math.log(ZERO_EARNER_MEDIAN / (100 - ZERO_EARNER_MEDIAN));
      const qs = z.map((zi) => round4(clamp(invLogitPct(centre + zi * wideZeroSigma), 0.01, 100)));
      for (let k = 1; k < qs.length; k++) if (qs[k] < qs[k - 1]) qs[k] = qs[k - 1];
      return { id: t.id, q: qs };
    }
    let median: number | null = null;
    if (proj !== null) {
      const eStar = proj.earnersStar[i];
      if (eStar !== null && Number.isFinite(eStar)) {
        median = clamp((100 * eStar) / proj.playersStar, 0.01, 99.99);
      }
    }
    if (median === null) {
      // Persistence fallback for this trophy.
      median = lastRate === null || lastRate === undefined ? 0.01 : clamp(lastRate, 0.01, 99.99);
      if (eLast !== null && eLast !== undefined && last.players > 0) {
        median = clamp((100 * eLast) / last.players, 0.01, 99.99);
      }
    }
    if (median >= 99.99) return { id: t.id, q: [100, 100, 100, 100, 100] };
    return { id: t.id, q: quantilesAround(median, sigmas[i], z) };
  });
  return { trophies };
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const out = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(out)}\n`);
}
