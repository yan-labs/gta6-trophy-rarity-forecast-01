// GTA VI trophy-rarity forecaster (Node 22, stdlib only).
//
// For each case in the input directory, forecasts every trophy's earn
// rate on Exophase at the case's target, as five quantiles (5/25/50/75/
// 95%). Scoring is mean pinball loss on the logit scale, so the median
// must sit where the rate will be and the spread must be honest.
//
// How the median is built. Earn rates move in logit space roughly
// linearly against log time since launch: the launch-night cohort rushes
// the early trophies, then progress slows and the tracked-player base
// keeps growing, which can even drag a slow trophy's share down (the
// house saw exactly that at the first refresh: 638 -> 3,868 players
// tracked, every rate but the one at 100% lower). So for each trophy I
// fit, by least squares, logit(rate) against ln(1 + hours since
// 2026-11-19T00:00:00Z), over the distinct rates the case's history
// shows (consecutive identical reads collapse to their first appearance,
// so the frozen launch-night page does not flatten the slope), and read
// the line at the target. Where the last 24 hours hold at least three
// distinct points I average that line with a second line fitted on the
// last 24 hours alone, so the current regime counts as much as the
// launch spike. A trophy with no movement keeps its last rate.
//
// How the spread is built. Three parts, combined in quadrature on the
// logit scale: the house baseline's random walk, 0.5 * sqrt(horizon in
// days); the fit's residual scatter, widened by the usual prediction
// factor for how far the target sits past the fitted points; and a
// 0.10 floor for everything the model does not know. The spread is
// floored at 0.30 logit for horizons of a day or more, 0.15 below that,
// so a perfect-looking fit never claims false certainty over a week of
// play. Quantiles are the median shifted by the normal z-scores, then
// clamped to [0.01, 99.99] and rounded to 4 decimals.
//
// Deterministic: no randomness, no network, no clock reads beyond the
// case file itself. Run it with:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LAUNCH = Date.parse('2026-11-19T00:00:00Z');
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const LOGIT_MIN = Math.log(0.01 / 99.99);
const LOGIT_MAX = Math.log(99.99 / 0.01);

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function logit(ratePct) {
  const p = clamp(ratePct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function sigmoid(y) {
  return 100 / (1 + Math.exp(-y));
}

// Least squares for y ~ a + b*x. Returns null when the points do not
// identify a line (fewer than 2 points, or all x equal).
function fitLine(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of points) {
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b, n, xMean: sx / n, xSd: Math.sqrt(Math.max(0, sxx / n - (sx / n) ** 2)) };
}

function residualSd(points, line) {
  if (!line || points.length < 3) return 0;
  let ss = 0;
  for (const [x, y] of points) ss += (y - (line.a + line.b * x)) ** 2;
  return Math.sqrt(ss / (points.length - 2));
}

// Distinct (time, logit-rate) points for one trophy, oldest first.
// Consecutive reads with the same rate collapse to their first time.
function series(history, idx) {
  const pts = [];
  let lastRate = null;
  for (const read of history) {
    const rate = read.rates[idx];
    if (rate === null || rate === undefined) continue;
    if (lastRate !== null && rate === lastRate) continue;
    lastRate = rate;
    const hours = (Date.parse(read.at) - LAUNCH) / 3600000;
    pts.push([Math.log1p(Math.max(0, hours)), logit(rate)]);
  }
  return pts;
}

function forecastTrophy(history, idx, lastRate, horizonDays, targetHours) {
  const xTarget = Math.log1p(Math.max(0, targetHours));
  const all = series(history, idx);
  const lastLogit = logit(lastRate);
  let medianLogit = lastLogit;
  let spread = 0.5 * Math.sqrt(horizonDays);

  const lineAll = fitLine(all);
  if (lineAll) {
    let pred = lineAll.a + lineAll.b * xTarget;
    let res = residualSd(all, lineAll);
    // Second line on the last 24 hours alone, when it has enough shape.
    const cutoff = Math.log1p(Math.max(0, (Date.parse(history[history.length - 1].at) - LAUNCH) / 3600000 - 24));
    const last24 = all.filter(([x]) => x >= cutoff);
    const line24 = fitLine(last24);
    if (line24 && last24.length >= 3) {
      pred = 0.5 * (pred + (line24.a + line24.b * xTarget));
      res = Math.max(res, residualSd(last24, line24));
    }
    medianLogit = clamp(pred, LOGIT_MIN, LOGIT_MAX);
    // Prediction factor: how far past the fitted points the target sits.
    const leverage = lineAll.xSd > 1e-9
      ? Math.sqrt(1 + ((xTarget - lineAll.xMean) / lineAll.xSd) ** 2 / lineAll.n)
      : 1;
    const extra = res * Math.min(4, leverage);
    spread = Math.sqrt(spread * spread + extra * extra + 0.1 * 0.1);
  }

  const floor = horizonDays >= 1 ? 0.3 : 0.15;
  spread = Math.max(spread, floor);

  const qs = Z.map((z) => {
    const q = sigmoid(clamp(medianLogit + z * spread, LOGIT_MIN, LOGIT_MAX));
    return Math.round(clamp(q, 0.01, 99.99) * 10000) / 10000;
  });
  // Rounding can tie neighbours the wrong way round; keep them ordered.
  for (let i = 1; i < qs.length; i++) {
    if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
  }
  return qs;
}

function forecastCase(kase) {
  const horizonDays = kase.horizon_minutes / 1440;
  const targetHours = (Date.parse(kase.target) - LAUNCH) / 3600000;
  const history = kase.history ?? [];
  const last = history.length ? history[history.length - 1] : null;
  const rows = kase.trophies.map((trophy, idx) => {
    const lastRate = last ? last.rates[idx] : null;
    let q;
    if (lastRate === null || lastRate === undefined) {
      // No read ever listed this trophy: a flat, very uncertain prior.
      q = Z.map((z) => Math.round(clamp(sigmoid(logit(0.5) + z * 1.0), 0.01, 99.99) * 10000) / 10000);
    } else {
      q = forecastTrophy(history, idx, lastRate, horizonDays, targetHours);
    }
    return { id: trophy.id, q };
  });
  rows.sort((a, b) => a.id - b.id);
  return { trophies: rows };
}

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });

const cases = readdirSync(inDir).filter((f) => f.endsWith('.in')).sort();
if (!cases.length) throw new Error(`no case files in ${inDir}`);
for (const file of cases) {
  const kase = JSON.parse(readFileSync(join(inDir, file), 'utf8'));
  const out = forecastCase(kase);
  const text = JSON.stringify(out);
  if (Buffer.byteLength(text, 'utf8') > 65536) {
    throw new Error(`${file}: forecast is over the 65,536-byte limit`);
  }
  const dest = join(outDir, file.replace(/\.in$/, '.out'));
  writeFileSync(dest, text);
  console.error(`wrote ${dest} (${out.trophies.length} trophies, ${text.length} bytes)`);
}
