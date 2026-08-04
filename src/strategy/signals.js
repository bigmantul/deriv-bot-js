// ═══════════════════════════════════════════════════════
//  src/strategy/signals.js
//
//  SMC BIBLE STRATEGY — H4 → M15 → M1 deterministic engine
//
//  H4:  directional bias, market structure, premium/discount,
//       major liquidity, major POI.
//  M15: intraday market structure, liquidity, POI refinement,
//       confirms price has returned to the H4 POI, M15 sweep.
//  M1:  execution — CHoCH, internal BOS (the "C-I model"),
//       Order Block / FVG entry.
//
//  Every rule maps to a deterministic numeric/structural
//  condition — no discretionary chart interpretation. Only
//  CLOSED candles are ever used to confirm structure, BOS,
//  CHoCH, sweeps, or displacement (no look-ahead bias). The
//  last element of every candle array passed in is treated as
//  the currently-forming candle and is dropped before analysis.
//
//  What's directly from the SMC Bible vs. what's an
//  implementation parameter is documented inline throughout —
//  see SMC_CONFIG below for every numeric threshold that had to
//  be introduced to make the strategy executable.
//
//  This replaces the old Daily Bias (D1 → H1 → M15) strategy
//  entirely, effective 2026-08-04. That strategy's code lives on
//  in signals-voting-candidate.js for reference/backtest
//  comparison but is no longer wired into the live bot.
// ═══════════════════════════════════════════════════════

// ── SIGNAL CONSTANTS ──────────────────────────────────
export const SIG_BUY  =  1;
export const SIG_SELL = -1;
export const SIG_HOLD =  0;

// ── MARKET CLASSIFICATION ─────────────────────────────
const SYNTHETIC_SYMBOLS = new Set([
  "BOOM50","BOOM500","BOOM600","BOOM900","BOOM1000",
  "CRASH50","CRASH500","CRASH600","CRASH900","CRASH1000",
  "JD10","JD25","JD50","JD75","JD100",
  "STPRNG","STPRNG2","STPRNG3","STPRNG4","STPRNG5",
  "R_10","R_25","R_50","R_75","R_100",
  "1HZ10V","1HZ15V","1HZ25V","1HZ50V","1HZ75V","1HZ90V","1HZ100V",
]);
const CRYPTO_SYMBOLS = new Set(["cryBTCUSD","cryETHUSD"]);

export function isMarketOpen(symbol) {
  if (SYNTHETIC_SYMBOLS.has(symbol) || CRYPTO_SYMBOLS.has(symbol)) return true;
  const now  = new Date();
  const day  = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 0 && hour < 21) return false;
  if (day === 5 && hour >= 21) return false;
  return true;
}

const LONDON_START = 7, LONDON_END = 16;
const NY_START     = 12, NY_END    = 21;

export function isInTradingSession(symbol) {
  if (SYNTHETIC_SYMBOLS.has(symbol) || CRYPTO_SYMBOLS.has(symbol)) return true;
  const hour   = new Date().getUTCHours();
  const london = hour >= LONDON_START && hour < LONDON_END;
  const ny     = hour >= NY_START     && hour < NY_END;
  return london || ny;
}

export function sessionName() {
  const hour   = new Date().getUTCHours();
  const london = hour >= LONDON_START && hour < LONDON_END;
  const ny     = hour >= NY_START     && hour < NY_END;
  if (london && ny) return "London+NY overlap";
  if (london)       return "London";
  if (ny)           return "New York";
  return "Asian/off-peak";
}

// ── PER-SYMBOL STATE ───────────────────────────────────
const symbolState = new Map();

function getState(symbol) {
  if (!symbolState.has(symbol)) {
    symbolState.set(symbol, {
      lastSignalEpoch: null, // M1 entry-candle epoch of the last signal fired,
                              // so the same setup doesn't re-fire every scan cycle
    });
  }
  return symbolState.get(symbol);
}

export function resetSymbolState(symbol) {
  symbolState.delete(symbol);
}

// ── GENERIC HELPERS (timeframe-agnostic) ──────────────
function calcAtr(df, period = 14) {
  if (!df || df.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < df.length; i++) {
    trs.push(Math.max(
      df[i].high - df[i].low,
      Math.abs(df[i].high - df[i - 1].close),
      Math.abs(df[i].low  - df[i - 1].close),
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

export function getAtrPct(df, period = 14) {
  const atr   = calcAtr(df, period);
  const price = df[df.length - 1]?.close ?? 1;
  return price > 0 ? atr / price : 0;
}

export function marketIsTradeable(df) {
  if (!df || df.length < 20) return false;
  const pct = getAtrPct(df);
  return pct >= 0.00005 && pct <= 0.10;
}

export function getVolatilityScalar(df) {
  const pct = Math.max(getAtrPct(df), 0.0001);
  return parseFloat(Math.max(0.25, Math.min(1.0, 0.003 / pct)).toFixed(4));
}

// Kept for the backtest walk-forward regime bucketer and the
// (not-yet-wired-in) confluence-votes.js — a generic trend-strength
// classifier via Kaufman's Efficiency Ratio. Works on any candle
// window; historically called with the D1 window, now typically
// called with the H4 window instead.
export function classifyD1Regime(window, { lookback = 30, excludeForming = true, trendThreshold = 0.15 } = {}) {
  if (!window || window.length < 3) return { trending: false, agreeRatio: 0 };
  let candles = excludeForming ? window.slice(0, -1) : window;
  if (lookback && candles.length > lookback) candles = candles.slice(-lookback);
  if (candles.length < 3) return { trending: false, agreeRatio: 0 };
  const netMove = Math.abs(candles[candles.length - 1].close - candles[0].close);
  let sumMoves = 0;
  for (let i = 1; i < candles.length; i++) sumMoves += Math.abs(candles[i].close - candles[i - 1].close);
  const agreeRatio = sumMoves > 0 ? netMove / sumMoves : 0;
  return { trending: agreeRatio >= trendThreshold, agreeRatio: +agreeRatio.toFixed(4) };
}

function closed(df) {
  return (df && df.length > 1) ? df.slice(0, -1) : (df || []);
}

// ═══════════════════════════════════════════════════════
//  SMC CONFIGURATION — every implementation parameter the
//  Bible does NOT numerically define. See doc §36/§56.
// ═══════════════════════════════════════════════════════
export const SMC_CONFIG = {
  structure: {
    h4SwingLength:  3,
    m15SwingLength: 3,
    m1SwingLength:  2,
  },
  liquidity: {
    equalLevelTolerance: 0.001, // 0.1%
    sweepMinATR: 0.05,
    sweepMaxATR: 1.00,
  },
  displacement: {
    minBodyRatio: 0.60,
    minRangeATR:  1.00,
  },
  poi: {
    minScore: 10, // out of 14 — see scorePOI()
  },
  timing: {
    maxPoiWaitM15:     48, // M15 candles the price has to return to the H4 POI
    maxSweepToChochM1: 15,
    maxChochToIbosM1:  15,
    maxIbosToEntryM1:  20,
  },
  risk: {
    minRR:    3.0,
    fvgMinRR: 4.0, // directly from the Bible — author's own stated minimum for FVG entries
    slBufferATR: 0.10,
  },
  management: {
    proTrendBEAfterBOS:     2, // directly from the Bible
    counterTrendBEAfterBOS: 1, // directly from the Bible
  },
};

// ═══════════════════════════════════════════════════════
//  1. SWING DETECTION (doc §5)
// ═══════════════════════════════════════════════════════
function getSwingHighs(candles, k) {
  const highs = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true;
    for (let j = i - k; j < i; j++) {
      if (!(candles[i].high > candles[j].high)) { isHigh = false; break; }
    }
    if (isHigh) {
      for (let j = i + 1; j <= i + k; j++) {
        if (!(candles[i].high >= candles[j].high)) { isHigh = false; break; }
      }
    }
    if (isHigh) highs.push({ idx: i, price: candles[i].high, epoch: candles[i].epoch, type: "H" });
  }
  return highs;
}

function getSwingLows(candles, k) {
  const lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isLow = true;
    for (let j = i - k; j < i; j++) {
      if (!(candles[i].low < candles[j].low)) { isLow = false; break; }
    }
    if (isLow) {
      for (let j = i + 1; j <= i + k; j++) {
        if (!(candles[i].low <= candles[j].low)) { isLow = false; break; }
      }
    }
    if (isLow) lows.push({ idx: i, price: candles[i].low, epoch: candles[i].epoch, type: "L" });
  }
  return lows;
}

// ═══════════════════════════════════════════════════════
//  2. MARKET STRUCTURE — HH/HL/LL/LH, protected levels,
//     BOS structure levels (doc §6-9)
// ═══════════════════════════════════════════════════════
function buildStructure(candles, k) {
  const highs = getSwingHighs(candles, k);
  const lows  = getSwingLows(candles, k);
  const points = [...highs, ...lows].sort((a, b) => a.idx - b.idx);

  // Collapse consecutive same-type points to the more extreme one
  // (a real alternating HH/HL/LL/LH sequence never has two highs
  // in a row without a low between them at this resolution).
  const alt = [];
  for (const p of points) {
    const last = alt[alt.length - 1];
    if (!last || last.type !== p.type) {
      alt.push(p);
    } else if (p.type === "H" && p.price > last.price) {
      alt[alt.length - 1] = p;
    } else if (p.type === "L" && p.price < last.price) {
      alt[alt.length - 1] = p;
    }
  }

  let trend = "NEUTRAL";
  let protectedHigh = null, protectedLow = null;
  let structureHigh = null, structureLow = null;

  for (let i = 1; i < alt.length; i++) {
    const prev = alt[i - 1], cur = alt[i];
    if (cur.type === "H") {
      const priorHighs = alt.slice(0, i).filter(p => p.type === "H");
      const priorHigh  = priorHighs[priorHighs.length - 1];
      if (priorHigh && cur.price > priorHigh.price) {
        structureHigh = cur;
        trend = "BULLISH";
        if (prev.type === "L") protectedLow = prev;
      }
    } else {
      const priorLows = alt.slice(0, i).filter(p => p.type === "L");
      const priorLow  = priorLows[priorLows.length - 1];
      if (priorLow && cur.price < priorLow.price) {
        structureLow = cur;
        trend = "BEARISH";
        if (prev.type === "H") protectedHigh = prev;
      }
    }
  }

  return { trend, protectedHigh, protectedLow, structureHigh, structureLow, swings: alt };
}

function nearestBSLBefore(structure, idx) {
  const highs = structure.swings.filter(s => s.type === "H" && s.idx < idx);
  return highs.length ? highs[highs.length - 1] : null;
}
function nearestSSLBefore(structure, idx) {
  const lows = structure.swings.filter(s => s.type === "L" && s.idx < idx);
  return lows.length ? lows[lows.length - 1] : null;
}

// ═══════════════════════════════════════════════════════
//  3. LIQUIDITY SWEEP (doc §16-18)
// ═══════════════════════════════════════════════════════
function detectSweep(candle, liquidityPrice, atr, side, config) {
  if (liquidityPrice == null || !atr) return null;
  if (side === "SSL") {
    if (candle.low < liquidityPrice && candle.close > liquidityPrice) {
      const depth = (liquidityPrice - candle.low) / atr;
      if (depth >= config.liquidity.sweepMinATR && depth <= config.liquidity.sweepMaxATR) {
        return { type: "BULLISH_SSL_SWEEP", liquidityPrice, sweepLow: candle.low, depth, epoch: candle.epoch };
      }
    }
  } else {
    if (candle.high > liquidityPrice && candle.close < liquidityPrice) {
      const depth = (candle.high - liquidityPrice) / atr;
      if (depth >= config.liquidity.sweepMinATR && depth <= config.liquidity.sweepMaxATR) {
        return { type: "BEARISH_BSL_SWEEP", liquidityPrice, sweepHigh: candle.high, depth, epoch: candle.epoch };
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════
//  4. DISPLACEMENT / MOMENTUM (doc §18/§25)
// ═══════════════════════════════════════════════════════
function detectDisplacement(candle, atr, config) {
  const range = candle.high - candle.low;
  const body  = Math.abs(candle.close - candle.open);
  if (range === 0 || !atr) return null;
  const bodyRatio = body / range;
  const rangeATR  = range / atr;
  if (bodyRatio < config.displacement.minBodyRatio || rangeATR < config.displacement.minRangeATR) return null;
  if (candle.close > candle.open) return "BULLISH";
  if (candle.close < candle.open) return "BEARISH";
  return null;
}

// ═══════════════════════════════════════════════════════
//  5. ORDER BLOCK (doc §26-29)
// ═══════════════════════════════════════════════════════
function findOrderBlock(candles, direction) {
  for (let i = candles.length - 2, steps = 0; i >= 0 && steps < 6; i--, steps++) {
    const c = candles[i];
    if (direction === "BULLISH" && c.close < c.open) {
      return { high: c.high, low: c.low, epoch: c.epoch, type: "BULLISH_OB" };
    }
    if (direction === "BEARISH" && c.close > c.open) {
      return { high: c.high, low: c.low, epoch: c.epoch, type: "BEARISH_OB" };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════
//  6. FAIR VALUE GAP (doc §30-31)
// ═══════════════════════════════════════════════════════
function findFVG(candles) {
  if (candles.length < 3) return null;
  const [a, , c] = candles.slice(-3);
  if (c.low > a.high) return { type: "BULLISH_FVG", low: a.high, high: c.low, mid: (a.high + c.low) / 2 };
  if (c.high < a.low) return { type: "BEARISH_FVG", low: c.high, high: a.low, mid: (c.high + a.low) / 2 };
  return null;
}

// ═══════════════════════════════════════════════════════
//  7. PREMIUM / DISCOUNT (doc §20)
// ═══════════════════════════════════════════════════════
function premiumDiscount(structure, price) {
  const leg = structure.trend === "BULLISH"
    ? { high: structure.structureHigh?.price, low: structure.protectedLow?.price }
    : { high: structure.protectedHigh?.price, low: structure.structureLow?.price };
  if (leg.high == null || leg.low == null) return null;
  const equilibrium = (leg.high + leg.low) / 2;
  const zone = price < equilibrium ? "DISCOUNT" : (price > equilibrium ? "PREMIUM" : "EQUILIBRIUM");
  return { equilibrium, zone, leg };
}

// ═══════════════════════════════════════════════════════
//  8. POI SCORE (doc §23-24)
// ═══════════════════════════════════════════════════════
function scorePOI({ bos, momentum, liquidity, imbalance, sweep, inducement }) {
  return (bos ? 3 : 0) + (momentum ? 3 : 0) + (liquidity ? 3 : 0)
       + (imbalance ? 2 : 0) + (sweep ? 2 : 0) + (inducement ? 1 : 0);
}

// ═══════════════════════════════════════════════════════
//  9. FULL SETUP ANALYSIS — H4 -> M15 -> M1 (doc §37-38)
// ═══════════════════════════════════════════════════════
function analyzeSmcSetup(h4, m15, m1, config, debug) {
  const reject = (msg) => { debug.push(`SMC_REJECT: ${msg}`); return null; };

  const h4c = closed(h4);
  if (h4c.length < config.structure.h4SwingLength * 2 + 15) return reject("Insufficient H4 data");

  const h4Structure = buildStructure(h4c, config.structure.h4SwingLength);
  if (h4Structure.trend === "NEUTRAL") return reject("H4 trend neutral");

  const m15c = closed(m15);
  const m1c  = closed(m1);
  if (m15c.length < 30) return reject("Insufficient M15 data");
  if (m1c.length  < 30) return reject("Insufficient M1 data");

  const price = m1c[m1c.length - 1].close;
  const pd = premiumDiscount(h4Structure, price);
  if (!pd) return reject("H4 structural leg incomplete — no premium/discount reference yet");

  const direction = h4Structure.trend === "BULLISH" ? "LONG" : "SHORT";
  if (direction === "LONG"  && pd.zone !== "DISCOUNT") return reject(`H4 bullish but price in ${pd.zone.toLowerCase()}, not discount`);
  if (direction === "SHORT" && pd.zone !== "PREMIUM")  return reject(`H4 bearish but price in ${pd.zone.toLowerCase()}, not premium`);

  // ── H4 POI ──
  const atrH4  = calcAtr(h4c);
  const refPoint = direction === "LONG" ? h4Structure.structureHigh : h4Structure.structureLow;
  if (!refPoint) return reject("No confirmed H4 structural break to anchor a POI");

  const obDir = direction === "LONG" ? "BULLISH" : "BEARISH";
  const ob    = findOrderBlock(h4c.slice(0, refPoint.idx + 1), obDir);
  if (!ob) return reject("No H4 order block found at structural break");

  const bosCandle = h4c[refPoint.idx];
  const momentum  = detectDisplacement(bosCandle, atrH4, config) === obDir;
  const fvg       = findFVG(h4c.slice(Math.max(0, refPoint.idx - 2), refPoint.idx + 1));
  const priorLiquidity = obDir === "BULLISH"
    ? nearestBSLBefore(h4Structure, refPoint.idx)
    : nearestSSLBefore(h4Structure, refPoint.idx);

  const poiScore = scorePOI({
    bos: true, momentum, liquidity: !!priorLiquidity, imbalance: !!fvg, sweep: !!priorLiquidity, inducement: false,
  });
  if (!momentum) return reject("POI has BOS but momentum/displacement threshold not met");
  if (poiScore < config.poi.minScore) return reject(`POI score ${poiScore} < required ${config.poi.minScore}`);

  // ── M15: price back in the H4 POI + M15 liquidity sweep ──
  const inZoneWindow = m15c.slice(-config.timing.maxPoiWaitM15);
  const inZone = inZoneWindow.some(c => c.low <= ob.high && c.high >= ob.low);
  if (!inZone) return reject("Price has not returned into the H4 POI zone on M15 within the wait window");

  const m15Structure = buildStructure(m15c, config.structure.m15SwingLength);
  const atrM15 = calcAtr(m15c);
  const m15LiquidityPoint = direction === "LONG"
    ? m15Structure.swings.filter(s => s.type === "L").at(-1)
    : m15Structure.swings.filter(s => s.type === "H").at(-1);
  if (!m15LiquidityPoint) return reject(direction === "LONG" ? "No valid SSL on M15" : "No valid BSL on M15");

  let m15Sweep = null;
  for (const c of inZoneWindow) {
    const s = detectSweep(c, m15LiquidityPoint.price, atrM15, direction === "LONG" ? "SSL" : "BSL", config);
    if (s) m15Sweep = s;
  }
  if (!m15Sweep) return reject(direction === "LONG" ? "SSL sweep did not occur/close back above liquidity" : "BSL sweep did not occur/close back below liquidity");

  // ── M1: CHoCH -> internal BOS (C-I model) -> OB/FVG entry ──
  const m1Structure = buildStructure(m1c, config.structure.m1SwingLength);
  const chochLevel = direction === "LONG" ? m1Structure.protectedHigh : m1Structure.protectedLow;
  if (!chochLevel) return reject("No M1 protected level to test for CHoCH");

  let chochIdx = -1;
  const chochScanStart = Math.max(0, m1c.length - config.timing.maxSweepToChochM1);
  for (let i = chochScanStart; i < m1c.length; i++) {
    const c = m1c[i];
    if (direction === "LONG"  && c.close > chochLevel.price) { chochIdx = i; break; }
    if (direction === "SHORT" && c.close < chochLevel.price) { chochIdx = i; break; }
  }
  if (chochIdx === -1) return reject("CHoCH not confirmed by candle close within timing window");

  let ibosIdx = -1;
  let runningExtreme = direction === "LONG" ? m1c[chochIdx].high : m1c[chochIdx].low;
  const ibosScanEnd = Math.min(m1c.length, chochIdx + 1 + config.timing.maxChochToIbosM1);
  for (let i = chochIdx + 1; i < ibosScanEnd; i++) {
    const c = m1c[i];
    if (direction === "LONG") {
      if (c.close > runningExtreme) { ibosIdx = i; break; }
      runningExtreme = Math.max(runningExtreme, c.high);
    } else {
      if (c.close < runningExtreme) { ibosIdx = i; break; }
      runningExtreme = Math.min(runningExtreme, c.low);
    }
  }
  if (ibosIdx === -1) return reject("Internal BOS not detected within timing window");

  const atrM1   = calcAtr(m1c);
  const entryDir = direction === "LONG" ? "BULLISH" : "BEARISH";
  const entryOb  = findOrderBlock(m1c.slice(0, ibosIdx + 1), entryDir);
  const entryFvg = findFVG(m1c.slice(Math.max(0, ibosIdx - 2), ibosIdx + 1));
  if (!entryOb && !entryFvg) return reject("No M1 order block or FVG created by the internal-BOS displacement");

  let entryType, entry, slAnchor;
  if (entryOb) {
    entryType = "ORDER_BLOCK";
    entry     = (entryOb.high + entryOb.low) / 2;
    slAnchor  = direction === "LONG" ? entryOb.low : entryOb.high;
  } else {
    entryType = "FVG";
    entry     = entryFvg.mid;
    slAnchor  = direction === "LONG" ? ob.low : ob.high; // H4 POI boundary
  }

  const buffer   = atrM1 * config.risk.slBufferATR;
  const stopLoss = direction === "LONG" ? slAnchor - buffer : slAnchor + buffer;

  const oppositeM15 = direction === "LONG"
    ? m15Structure.swings.filter(s => s.type === "H").at(-1)
    : m15Structure.swings.filter(s => s.type === "L").at(-1);
  const oppositeH4 = direction === "LONG"
    ? h4Structure.swings.filter(s => s.type === "H").at(-1)
    : h4Structure.swings.filter(s => s.type === "L").at(-1);
  const takeProfit = oppositeM15?.price ?? oppositeH4?.price ?? null;
  if (takeProfit == null) return reject("No opposing liquidity target found for take-profit");

  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return reject("Invalid stop distance (zero/negative risk)");
  const reward = Math.abs(takeProfit - entry);
  const rr = reward / risk;

  const minRR = entryType === "FVG" ? config.risk.fvgMinRR : config.risk.minRR;
  if (rr < minRR) return reject(`${entryType} RR ${rr.toFixed(2)} < required ${minRR}`);

  return {
    direction, entryType, entry, stopLoss, takeProfit, rr: +rr.toFixed(2), poiScore,
    h4Trend: h4Structure.trend, pdZone: pd.zone,
    m1EntryEpoch: m1c[ibosIdx].epoch,
    confirmations: {
      h4Bias: true, h4PremiumDiscount: true, validPOI: true, bos: true, momentum,
      liquidity: !!priorLiquidity, imbalance: !!fvg, sweep: true, choch: true, internalBos: true,
    },
    metadata: {
      h4POI: { high: ob.high, low: ob.low },
      m15Sweep, chochLevel: chochLevel.price, ibosEpoch: m1c[ibosIdx].epoch,
      takeProfitSource: oppositeM15 ? "M15" : "H4",
    },
  };
}

// ═══════════════════════════════════════════════════════
//  10. PUBLIC ENTRY POINTS
// ═══════════════════════════════════════════════════════

/**
 * @param {object} tf - { h4, m15, m1, symbol }
 */
export function collectSignals(tf) {
  const { h4, m15, m1, symbol } = tf || {};
  const state = getState(symbol || "default");
  const breakdown = [];
  const debug = [];

  if (!h4 || !m15 || !m1) {
    return { signal: SIG_HOLD, breakdown, reason: "Missing timeframe data (h4/m15/m1)", bias: "none" };
  }

  if (!isInTradingSession(symbol)) {
    breakdown.push({ step: "Session", result: "OUTSIDE SESSION", reason: `${symbol} — waiting for London/NY session (FX only)` });
    return { signal: SIG_HOLD, breakdown, reason: "Outside London/NY trading session — SMC held for next session", bias: "none" };
  }

  const setup = analyzeSmcSetup(h4, m15, m1, SMC_CONFIG, debug);
  const lastReject = debug[debug.length - 1] || "No SMC setup";

  breakdown.push({ step: "SMC Setup", result: setup ? setup.direction : "NO_SIGNAL", reason: setup ? "Full sequence confirmed" : lastReject });

  if (!setup) {
    return { signal: SIG_HOLD, breakdown, reason: lastReject, bias: "none", debug };
  }

  if (state.lastSignalEpoch === setup.m1EntryEpoch) {
    return { signal: SIG_HOLD, breakdown, reason: "Setup already signaled on this M1 candle — waiting for a new one", bias: setup.h4Trend.toLowerCase(), debug };
  }
  state.lastSignalEpoch = setup.m1EntryEpoch;

  return {
    signal: setup.direction === "LONG" ? SIG_BUY : SIG_SELL,
    breakdown,
    reason: `SMC ${setup.direction} — ${setup.entryType} entry, POI score ${setup.poiScore}/14, RR ${setup.rr}`,
    bias: setup.h4Trend.toLowerCase(),
    setup,
    debug,
  };
}

export function getTradeReason(tf) {
  const result = collectSignals(tf);
  const direction = result.signal === SIG_BUY ? "BUY" : result.signal === SIG_SELL ? "SELL" : "HOLD/WAIT";
  const lines = [`SMC BIBLE STRATEGY (H4 -> M15 -> M1) — ${direction}`];
  for (const step of result.breakdown) lines.push(`  ${step.step}: ${step.result} — ${step.reason}`);
  if (result.setup) {
    const s = result.setup;
    lines.push(`  Entry: ${s.entryType} @ ${s.entry} | SL ${s.stopLoss} | TP ${s.takeProfit} | RR ${s.rr}`);
  }
  return lines.join("\n");
}

export function getLatestSignalMtf(dfM1, dfM15, dfH4, symbol) {
  return collectSignals({ h4: dfH4, m15: dfM15, m1: dfM1, symbol }).signal;
}

export function getH4Trend(dfH4) {
  const c = closed(dfH4);
  if (!c || c.length < SMC_CONFIG.structure.h4SwingLength * 2 + 5) return "neutral";
  const structure = buildStructure(c, SMC_CONFIG.structure.h4SwingLength);
  if (structure.trend === "BULLISH") return "bullish";
  if (structure.trend === "BEARISH") return "bearish";
  return "neutral";
}

// Back-compat alias — previously took the D1 window, now takes H4.
export function get15mTrend(dfH4) {
  return getH4Trend(dfH4);
}
