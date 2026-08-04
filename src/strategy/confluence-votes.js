// ═══════════════════════════════════════════════════════
//  src/strategy/confluence-votes.js — ADD-ON, NOT WIRED IN YET
//
//  Adds a confluence/voting layer ON TOP of the SMC Bible engine
//  (signals.js) — does not replace or modify it. collectSignals()
//  still decides WHEN and WHICH DIRECTION to trade exactly as
//  before (H4 bias -> M15 sweep -> M1 CHoCH/iBOS/OB entry). This
//  module answers a separate question: once that engine wants to
//  fire, do enough independent signals agree that it's a good
//  moment to actually take it?
//
//  Three votes, each measuring something genuinely different (not
//  three re-readings of "which way is price going", which the SMC
//  engine already answers):
//
//    1. TREND STRENGTH  - not direction, CONVICTION. Kaufman
//       Efficiency Ratio over the H4 window: is this a clean,
//       purposeful trend, or one that technically qualifies as
//       HH/HL or LL/LH but is really just noise/chop that happened
//       to tip one way?
//    2. MOMENTUM EXHAUSTION - is the move already stretched? RSI
//       confirms direction is fine, but doesn't tell you whether
//       you're buying right as the move runs out of steam. This
//       vote fails if RSI is already deep in overbought/oversold
//       territory IN THE TRADE'S OWN DIRECTION (i.e. buying at
//       RSI 78, or selling at RSI 22).
//    3. VOLATILITY SUITABILITY - reuses the existing
//       marketIsTradeable() check (ATR% in a sane range), but as a
//       counted vote instead of a silent skip, so you can see it
//       in the breakdown.
//
//  requireVotes (default 2 of 3) is deliberately not "all 3" --
//  demanding unanimous agreement across independent dimensions is
//  usually where a voting system quietly turns back into an
//  overly-strict AND-gate, the exact problem this was meant to
//  avoid. 2-of-3 means one weak dimension doesn't kill an
//  otherwise-good setup, but the entry still needs real agreement,
//  not just the base bias direction.
// ═══════════════════════════════════════════════════════
import { classifyD1Regime, getAtrPct, marketIsTradeable } from "./signals.js";

function calcRsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += -diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * @param {object} tf - { h4, m15, m1 } — same shape collectSignals() uses
 * @param {"bullish"|"bearish"} direction - the H4 bias direction the SMC engine already agreed on
 * @param {object} params
 * @param {number} params.trendThreshold  - agreeRatio cutoff for the trend-strength vote (default 0.15, same calibration as classifyD1Regime's own default)
 * @param {number} params.rsiOverboughtLevel - RSI level above which a BUY is considered exhausted (default 70)
 * @param {number} params.rsiOversoldLevel   - RSI level below which a SELL is considered exhausted (default 30)
 * @param {number} params.requireVotes - how many of the 3 votes must pass (default 2)
 */
export function getConfluenceVotes(tf, direction, params = {}) {
  const {
    trendThreshold = 0.15,
    rsiOverboughtLevel = 70,
    rsiOversoldLevel = 30,
    requireVotes = 2,
  } = params;

  const votes = [];

  // ── VOTE 1: trend strength (conviction, not direction) ──
  const h4Closed = tf.h4 ? tf.h4.slice(0, -1) : [];
  const { trending, agreeRatio } = classifyD1Regime(h4Closed, {
    lookback: h4Closed.length,
    excludeForming: false, // already dropped the forming candle above
    trendThreshold,
  });
  votes.push({
    name: "trend_strength",
    pass: trending,
    detail: `H4 efficiency ratio ${agreeRatio} (need >= ${trendThreshold} to count as a real trend, not just noise that tipped one way)`,
  });

  // ── VOTE 2: momentum not already exhausted ──
  const m1Closes = tf.m1 ? tf.m1.slice(0, -1).map(c => c.close) : [];
  const rsi = calcRsi(m1Closes, 14);
  const exhausted = direction === "bullish" ? rsi >= rsiOverboughtLevel : rsi <= rsiOversoldLevel;
  votes.push({
    name: "momentum_not_exhausted",
    pass: !exhausted,
    detail: `M1 RSI ${rsi.toFixed(1)} — ${exhausted ? "already stretched in this direction" : "room left to run"}`,
  });

  // ── VOTE 3: volatility suitability ──
  const tradeable = marketIsTradeable(tf.m1);
  const atrPct = getAtrPct(tf.m1);
  votes.push({
    name: "volatility_suitable",
    pass: tradeable,
    detail: `ATR% ${(atrPct * 100).toFixed(3)}% — ${tradeable ? "within normal tradeable range" : "too dead or too explosive right now"}`,
  });

  const passCount = votes.filter(v => v.pass).length;
  return {
    passCount,
    requireVotes,
    approved: passCount >= requireVotes,
    votes,
  };
}
