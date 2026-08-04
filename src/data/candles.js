// ═══════════════════════════════════════════════════════
//  src/data/candles.js
//
//  Timeframe stack (SMC Bible Strategy):
//    h4  = 14400s → H4 directional bias, premium/discount, major POI
//    m15 = 900s   → intraday structure, POI refinement, liquidity sweep
//    m1  = 60s    → execution: CHoCH, internal BOS, OB/FVG entry
//
//  D1/H1/30M are no longer used by the current strategy
//  (replaced the Daily Bias strategy on 2026-08-04).
// ═══════════════════════════════════════════════════════

import { sendMessage } from "../utils/ws-client.js";

const EMPTY = [];

export async function getCandles(ws, symbol, granularity = 3600, count = 200) {
  try {
    const resp = await sendMessage(ws, {
      ticks_history: symbol,
      style:         "candles",
      granularity,
      count,
      end:           "latest",
    }, "candles");

    const rawCandles = resp?.candles ?? [];
    if (!rawCandles.length) {
      console.warn(`Warning: No candles for ${symbol} (g=${granularity})`);
      return EMPTY;
    }

    const required = ["epoch", "open", "high", "low", "close"];
    if (!required.every(k => k in rawCandles[0])) {
      console.error(`Invalid candle format for ${symbol}`);
      return EMPTY;
    }

    const seen = new Set();
    return rawCandles
      .map(c => ({
        time:  new Date(c.epoch * 1000),
        open:  parseFloat(c.open),
        high:  parseFloat(c.high),
        low:   parseFloat(c.low),
        close: parseFloat(c.close),
        epoch: c.epoch,
      }))
      .sort((a, b) => a.epoch - b.epoch)
      .filter(c => {
        if (seen.has(c.epoch)) return false;
        seen.add(c.epoch);
        return true;
      });
  } catch (e) {
    console.error(`API error getting candles for ${symbol} (g=${granularity}):`, e.message);
    return EMPTY;
  }
}

/**
 * Fetch the 3 timeframes used by the SMC strategy:
 *
 *   h4  = 14400s (H4  — bias, premium/discount, major POI)
 *   m15 = 900s   (M15 — intraday structure, POI refinement, sweep)
 *   m1  = 60s    (M1  — execution: CHoCH, internal BOS, OB/FVG entry)
 *
 * H4 needs fewer bars than M1 — 100 H4 candles is ~16 days of
 * structure, plenty for swing/POI detection. M1 needs a deep-ish
 * window (200 bars = ~3.3 hours) to have enough closed candles for
 * the sweep -> CHoCH -> internal BOS sequence to complete inside
 * its own timing windows.
 */
export async function getMultiTf(ws, symbol) {
  const [h4, m15, m1] = await Promise.all([
    getCandles(ws, symbol, 14400, 100),
    getCandles(ws, symbol, 900,   200),
    getCandles(ws, symbol, 60,    200),
  ]);
  return { h4, m15, m1 };
}
