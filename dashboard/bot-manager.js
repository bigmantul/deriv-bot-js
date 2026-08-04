// ═══════════════════════════════════════════════════════
//  dashboard/bot-manager.js
//
//  SMC Bible Strategy integration:
//    - Fetches 3 timeframes (H4 / M15 / M1)
//    - H4: directional bias, premium/discount, major POI
//    - M15: intraday structure, POI refinement, liquidity sweep
//    - M1: execution — CHoCH, internal BOS, OB/FVG entry
//    - All existing infrastructure (risk, trailing stop,
//      forced close, portfolio locking) unchanged
// ═══════════════════════════════════════════════════════

import { connectForMode }                from "../src/auth/deriv-auth.js";
import { connectWebSocket, sendMessage } from "../src/utils/ws-client.js";
import { getCachedMultiTf, startGlobalScanner, getCacheStats } from "../src/data/candle-cache.js";
import {
  collectSignals,
  getTradeReason,
  getVolatilityScalar,
  marketIsTradeable,
  getH4Trend,
  sessionName,
  isMarketOpen,
  SIG_BUY,
  SIG_SELL,
} from "../src/strategy/signals.js";
import { placeTradeWithRetry, startForcedCloseTimer, cancelForcedCloseTimer, closeTrade, resetMultiplierCache } from "../src/trading/trader.js";
import { RiskManager, StopLossTakeProfit } from "../src/risk/risk-manager.js";
import { Trade, User, BotLog }             from "./db.js";
import {
  emitToUser, emitTradeOpened, emitTradeUpdate,
  emitTradeClosed, emitBalanceUpdate, emitBotStatus,
} from "./realtime.js";

// Kept as a thin wrapper so existing call sites (log()) don't
// need to change — routes activity-log events straight to the
// user's Socket.IO room.
function broadcast(userId, event) {
  if (!event || typeof event !== "object") return;
  const { type, ...rest } = event;
  emitToUser(userId, type || "log", rest);
}

import {
  notifyStartup, notifyTradeOpened, notifyRiskBlock,
  notifyReconnecting, notifyMaxTrades, notifyDailySummary,
  notifyCycleScan, notifyTradeClosed, notifyPnlLockUpdate,
  notifyLiveStatus,
} from "../src/utils/telegram.js";

const SYMBOLS = [
  // Forex
  "frxEURUSD",
  "frxGBPUSD",
  "frxUSDJPY",
  "frxUSDCHF",
  "frxAUDUSD",
  "frxUSDCAD",
  "frxNZDUSD",
  "frxGBPJPY",
  "frxEURGBP",
  "frxEURCHF",
  "frxEURCAD",
  "frxEURAUD",

  // Metals
  "frxXAUUSD",
  "frxXAGUSD",

  // Crypto
  "cryBTCUSD",
  "cryETHUSD",

  // Boom Indices
  "BOOM50",
  "BOOM500",
  "BOOM600",
  "BOOM900",
  "BOOM1000",

  // Crash Indices
  "CRASH50",
  "CRASH500",
  "CRASH600",
  "CRASH900",
  "CRASH1000",

  // Jump Indices
  "JD10",
  "JD25",
  "JD50",
  "JD75",
  "JD100",

  // Step Indices
  "STPRNG",
  "STPRNG2",
  "STPRNG3",
  "STPRNG4",
  "STPRNG5",

  // Volatility Indices
  "R_10",
  "R_25",
  "R_50",
  "R_75",
  "R_100",

  // 1Hz Volatility Indices
  "1HZ10V",
  "1HZ15V",
  "1HZ25V",
  "1HZ50V",
  "1HZ75V",
  "1HZ90V",
  "1HZ100V",
];

const POLL_SECS          = 10; // was 30 - the dominant component of the live-status display delay
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const runningBots = new Map();

function sleep(secs) {
  return new Promise(resolve => setTimeout(resolve, secs * 1000));
}

async function getBalance(ws) {
  const resp = await sendMessage(ws, { balance: 1 }, "balance");
  return parseFloat(resp.balance.balance);
}

// ── BOT LOGGER ────────────────────────────────────────
async function log(userId, message, level = "info") {
  console.log(message);
  try {
    const entry = await BotLog.create({ userId, message, level });
    try {
      broadcast(String(userId), {
        type:      "log",
        level,
        message,
        createdAt: entry.createdAt,
        id:        entry._id,
      });
    } catch {}
  } catch {}
}

// ── SYNC TRADE STATUSES ───────────────────────────────
async function syncTradeStatuses(ws, userId, label, botToken, chatId, rm) {
  try {
    const openTrades = await Trade.find({ userId, status: "open" });
    if (!openTrades.length) return;

    const resp      = await sendMessage(ws, { portfolio: 1 }, "portfolio");
    const contracts = resp?.portfolio?.contracts ?? [];

    const activeContracts = new Map();
    for (const c of contracts) {
      const status = String(c.status ?? "").toLowerCase();
      if (!["sold", "closed", "expired"].includes(status)) {
        activeContracts.set(String(c.contract_id), c);
      }
    }

    for (const trade of openTrades) {
      const contractIdStr = String(trade.contractId);

      if (activeContracts.has(contractIdStr)) {
        const liveContract = activeContracts.get(contractIdStr);
        const livePnl      = parseFloat(liveContract.profit ?? liveContract.bid_price ?? 0);
        await Trade.findByIdAndUpdate(trade._id, { pnl: livePnl });
        emitTradeUpdate(userId, { id: String(trade._id), pnl: livePnl, status: "open" });
        continue;
      }

      // Contract is gone from the active portfolio — it closed somewhere
      // we didn't directly trigger: native SL, native TP, or the forced-
      // close timer already closed it (and that path's own onClosed
      // callback may already have notified — this is the catch-all for
      // any case that wasn't directly caught elsewhere).
      let finalPnl    = 0;
      let finalStatus = "closed";

      try {
        const detail = await sendMessage(ws, {
          proposal_open_contract: 1,
          contract_id: parseInt(trade.contractId),
        }, "proposal_open_contract");

        const contract = detail?.proposal_open_contract;
        if (contract) {
          finalPnl    = parseFloat(contract.profit ?? 0);
          finalStatus = finalPnl > 0 ? "won" : "lost";
        }
      } catch {
        finalStatus = "closed";
      }

      await Trade.findByIdAndUpdate(trade._id, {
        status:   finalStatus,
        pnl:      finalPnl,
        closedAt: new Date(),
      });

      cancelForcedCloseTimer(String(trade.contractId));
      if (rm) rm.tradeClosed(finalPnl);

      emitTradeClosed(userId, {
        id:       String(trade._id),
        symbol:   trade.symbol,
        direction: trade.direction,
        stake:    trade.stake,
        multiplier: trade.multiplier,
        status:   finalStatus,
        pnl:      finalPnl,
        openedAt: trade.openedAt,
        closedAt: new Date(),
      });

      // Balance/equity moved when this trade settled — let the
      // dashboard refresh its balance display immediately rather
      // than waiting for the next poll cycle.
      try {
        const freshBalance = await getBalance(ws);
        emitBalanceUpdate(userId, freshBalance);
      } catch {}

      const soldFor = finalPnl + trade.stake; // derived — matches the soldFor-stake=pnl convention used everywhere else
      const reason  = finalPnl >= 0
        ? "Closed by native Take Profit (or already closed before the bot's own exit checks ran)"
        : "Closed by native Stop Loss (or already closed before the bot's own exit checks ran)";

      await log(userId,
        `[${label}] ${trade.symbol} | [sync] Closed externally → ${finalStatus} | Sold $${soldFor.toFixed(2)} | PnL: $${finalPnl.toFixed(2)}`,
        "trade"
      );
      await notifyTradeClosed({
        symbol: trade.symbol, direction: trade.direction, soldFor, pnl: finalPnl,
        stake: trade.stake, reason, label, botToken, chatId,
      });
    }
  } catch (e) {
    await log(userId, `[${label}] [sync] Error: ${e.message}`, "error");
  }
}

// ── PORTFOLIO TRACKER ─────────────────────────────────
// Builds the callback run when a forced-close timer actually fires.
// Shared by both the initial trade-open call to startForcedCloseTimer()
// and the live-reschedule path in monitorOpenTrades() below, so both
// places update the DB/portfolio/notifications identically instead of
// duplicating this logic.
function buildForcedCloseHandler({ userId, symbol, direction, stake, label, botToken, chatId, portfolio, rm, ws, contractId }) {
  return async ({ soldFor, finalPnl, reason }) => {
    // status:"open" filter makes this safe even if another path (sync,
    // or one of the other monitored exits) already closed/updated this
    // same trade first — matches zero documents in that case, no
    // double-processing.
    const updated = await Trade.findOneAndUpdate(
      { contractId: String(contractId), status: "open" },
      { status: finalPnl >= 0 ? "won" : "lost", pnl: finalPnl, closedAt: new Date() }
    );
    if (!updated) return; // already closed via another path
    portfolio.unlockSymbol(symbol);
    rm.tradeClosed(finalPnl);
    await log(userId, `[${label}] ${symbol} | ⏰ EXIT: ${reason} — closed`, "trade");
    await log(userId, `[${label}] ${symbol} | Closed $${soldFor.toFixed(2)} | PnL: $${finalPnl.toFixed(2)}`, "trade");
    await notifyTradeClosed({ symbol, direction, soldFor, pnl: finalPnl, stake, reason, label, botToken, chatId });
    emitTradeClosed(userId, { id: String(updated._id), symbol, direction, stake, status: finalPnl >= 0 ? "won" : "lost", pnl: finalPnl, closedAt: new Date() });
    try { emitBalanceUpdate(userId, await getBalance(ws)); } catch {}
  };
}

async function monitorOpenTrades(ws, userId, label, portfolio, dfH4Cache, riskSettings, botToken, chatId, rm, user) {
  try {
    const openTrades = await Trade.find({ userId, status: "open" });
    if (!openTrades.length) return [];

    // pnlLockPct = % of TAKE PROFIT that must be reached to activate the
    // PnL lock (field name in the DB is still trailingStopPct for backward
    // compatibility with existing user documents — only the dashboard
    // label and all log/Telegram text now say "PnL Lock"). Defaults to
    // 0.5 (50%) if the user has never set this.
    const pnlLockPct = (riskSettings?.trailingStopPct === undefined || riskSettings?.trailingStopPct === null)
      ? 0.5
      : riskSettings.trailingStopPct;

    // noProfitCutoffMins: 0 = OFF (this mechanism never closes a trade).
    const noProfitCutoffMins = (riskSettings?.noProfitCutoffMins === undefined || riskSettings?.noProfitCutoffMins === null)
      ? 20
      : riskSettings.noProfitCutoffMins;

    // cutoffCooldownHours: 0 = no cooldown applied after the cutoff fires.
    const cutoffCooldownHours = (riskSettings?.cutoffCooldownHours === undefined || riskSettings?.cutoffCooldownHours === null)
      ? 2
      : riskSettings.cutoffCooldownHours;

    const liveStatuses = [];

    for (const trade of openTrades) {
      try {
        const detail   = await sendMessage(ws, {
          proposal_open_contract: 1,
          contract_id: parseInt(trade.contractId),
        }, "proposal_open_contract");

        const contract = detail?.proposal_open_contract;
        if (!contract || contract.status !== "open") continue;

        const currentPnl = parseFloat(contract.profit ?? 0);
        const stake      = trade.stake;
        const direction  = trade.direction;
        const dirLabel   = direction === "MULTUP" ? "BUY" : "SELL";
        const tradeBias  = direction === "MULTUP" ? "bullish" : "bearish";

        await Trade.findByIdAndUpdate(trade._id, { pnl: currentPnl });
        emitTradeUpdate(userId, { id: String(trade._id), pnl: currentPnl, status: "open" });

        // ══════════════════════════════════════════════════════
        // LIVE STATUS — every exit mechanism, computed ONCE per
        // cycle here, then reused by the actual exit checks below
        // (no recalculating). Logged AND sent to Telegram every
        // single cycle so all six mechanisms are visible in real
        // time, not just when one of them actually fires.
        // ══════════════════════════════════════════════════════

        // 1+2: distance to native SL/TP (Deriv-side hard backstops)
        const stopLossVal   = trade.stopLoss   || 0;
        const takeProfitVal = trade.takeProfit || 0;
        const distToSL = currentPnl + stopLossVal;     // more loss needed to hit SL
        const distToTP = takeProfitVal - currentPnl;    // more profit needed to hit TP

        // 3: daily bias agreement
        const h4Candles   = dfH4Cache.get(trade.symbol);
        const currentBias = (h4Candles && h4Candles.length >= 3) ? getH4Trend(h4Candles) : "neutral";
        const biasFlipped = currentBias !== "neutral" && currentBias !== tradeBias;
        const biasStatus  = currentBias === "neutral" ? "NEUTRAL" : (biasFlipped ? "REVERSED" : "AGREES");

        // 4: no-profit cutoff (configurable, default 20min, 0 = OFF)
        const openedAtMs  = new Date(trade.openedAt).getTime();
        const minutesOpen = (Date.now() - openedAtMs) / 60000;
        const cutoffDue    = noProfitCutoffMins > 0 && minutesOpen >= noProfitCutoffMins && currentPnl <= 0;
        const cutoffText   = noProfitCutoffMins <= 0
          ? "OFF"
          : (currentPnl > 0
            ? "n/a (in profit)"
            : (cutoffDue ? "TRIGGERED" : `${(noProfitCutoffMins - minutesOpen).toFixed(1)}min remaining`));

        // 5: PnL Lock (stepped ratchet)
        const takeProfit = takeProfitVal;
        let pnlLockText = "not active (below first step)";
        let peak = trade.trailingPeakPnl || 0;
        let floor = trade.pnlLockFloor || 0;
        let stepsBanked = 0;
        let stepSize = 0;
        let lockFloorHit = false;
        if (pnlLockPct > 0 && takeProfit > 0) {
          stepSize = takeProfit * pnlLockPct;
          peak = Math.max(peak, currentPnl);
          stepsBanked = Math.floor(peak / stepSize);
          if (stepsBanked >= 1) {
            const candidateFloor = parseFloat(((stepsBanked - 1) * stepSize).toFixed(4));
            floor = Math.max(candidateFloor, floor);
            pnlLockText = `Step ${stepsBanked} (of $${stepSize.toFixed(2)} each) | closes if PnL <= $${floor.toFixed(4)}`;
            lockFloorHit = currentPnl <= floor;
          }
        }

        // 6: forced-close duration timer
        // Live setting changes (from the dashboard) previously only
        // ever applied to trades opened AFTER the change — an
        // already-open trade's real setTimeout (in trader.js) and its
        // stored `forcedCloseDurationMins` snapshot both stayed frozen
        // at whatever was configured at open time. Detect a mismatch
        // here, every cycle, and actually reschedule the timer so a
        // setting change reaches trades that are already running.
        const liveDurationMins = (riskSettings?.contractDurationMins === undefined || riskSettings?.contractDurationMins === null)
          ? 120
          : riskSettings.contractDurationMins;

        if (liveDurationMins !== (trade.forcedCloseDurationMins ?? 120)) {
          await Trade.findByIdAndUpdate(trade._id, { forcedCloseDurationMins: liveDurationMins });
          trade.forcedCloseDurationMins = liveDurationMins;

          if (!liveDurationMins || liveDurationMins <= 0) {
            cancelForcedCloseTimer(trade.contractId); // 0 = OFF
            portfolio.lockSymbol(trade.symbol, trade.contractId, 0); // clears the LOCKED countdown too
          } else {
            // Keep the total window measured from the ORIGINAL open
            // time, not from now — e.g. if 90 of a new 240min window
            // have already elapsed, only 150min should remain. If the
            // new duration is already in the past relative to open
            // time, fire almost immediately (startForcedCloseTimer
            // requires a positive duration) rather than waiting.
            const remainingMins = (openedAtMs + liveDurationMins * 60000 - Date.now()) / 60000;
            startForcedCloseTimer({
              contractId: trade.contractId, symbol: trade.symbol, direction, stake,
              token: user.derivPAT, appId: user.derivAppId, mode: user.derivMode, label,
              durationMins: Math.max(remainingMins, 0.05), // ~3s floor
              onClosed: buildForcedCloseHandler({ userId, symbol: trade.symbol, direction, stake, label, botToken, chatId, portfolio, rm, ws, contractId: trade.contractId }),
            });
            // Same remaining-time-from-original-open-time math, so the
            // "🔒 LOCKED ⏱️ Xh Ym" display always matches what the real
            // forced-close timer above will actually do.
            portfolio.lockSymbol(trade.symbol, trade.contractId, Math.max(remainingMins, 0.05));
          }
        }

        const durationMins = trade.forcedCloseDurationMins ?? 120;
        let forcedCloseText;
        if (!durationMins || durationMins <= 0) {
          forcedCloseText = "OFF";
        } else {
          const remainMin = (openedAtMs + durationMins * 60000 - Date.now()) / 60000;
          forcedCloseText = remainMin <= 0 ? "TRIGGERED" : `${remainMin.toFixed(1)}min remaining (of ${durationMins}min)`;
        }

        const statusLines = [
          `[${label}] ${trade.symbol} (${dirLabel}) | LIVE STATUS`,
          `PnL: $${currentPnl.toFixed(4)} | SL: $${stopLossVal.toFixed(2)} (${distToSL.toFixed(4)} away) | TP: $${takeProfitVal.toFixed(2)} (${distToTP.toFixed(4)} away)`,
          `H4 Bias: ${currentBias.toUpperCase()} (${biasStatus})`,
          `No-Profit Cutoff: ${cutoffText}`,
          `PnL Lock: ${pnlLockText}`,
          `Forced Close Timer: ${forcedCloseText}`,
        ];
        await log(userId, statusLines.join(" | "), "info");
        await notifyLiveStatus({ lines: statusLines, label, botToken, chatId });

        liveStatuses.push({
          symbol: trade.symbol, direction: dirLabel, pnl: currentPnl,
          biasStatus, cutoffText, pnlLockText, forcedCloseText,
        });

        // ── EXIT 1: DAILY BIAS REVERSAL ──────────────────
        if (biasFlipped) {
          const reason = `Daily bias reversed to ${currentBias.toUpperCase()}`;
          await log(userId, `[${label}] ${trade.symbol} | 🔄 EXIT: ${reason} — closing ${direction}`, "trade");
          const soldFor = await closeTrade(ws, trade.contractId);
          if (soldFor !== null) {
            const finalPnl = soldFor - stake;
            await Trade.findByIdAndUpdate(trade._id, {
              status:   finalPnl >= 0 ? "won" : "lost",
              pnl:      finalPnl,
              closedAt: new Date(),
            });
            portfolio.unlockSymbol(trade.symbol);
            if (rm) rm.tradeClosed(finalPnl);
            await log(userId, `[${label}] ${trade.symbol} | Closed $${soldFor.toFixed(2)} | PnL: $${finalPnl.toFixed(2)}`, "trade");
            await notifyTradeClosed({ symbol: trade.symbol, direction, soldFor, pnl: finalPnl, stake, reason, label, botToken, chatId });
            emitTradeClosed(userId, { id: String(trade._id), symbol: trade.symbol, direction, stake, status: finalPnl >= 0 ? "won" : "lost", pnl: finalPnl, closedAt: new Date() });
            try { emitBalanceUpdate(userId, await getBalance(ws)); } catch {}
          }
          continue;
        }

        // ── EXIT 1B: NO-PROFIT CUTOFF (configurable, default 20min) ──
        // If a trade has been open for >= noProfitCutoffMins and is NOT
        // in profit, close it immediately. If cutoffCooldownHours > 0,
        // also lock the symbol for that many hours — separate from the
        // normal unlock-on-close, a deliberate "stay away" period even
        // though no trade remains open on this symbol. Both settings
        // are user-configurable on the dashboard; either can be set to
        // 0 to disable (cutoff itself, or just the cooldown lock).
        if (cutoffDue) {
          const reason = `Not profitable after ${minutesOpen.toFixed(0)}min`;
          const cooldownMs   = cutoffCooldownHours * 60 * 60 * 1000;
          const cooldownText = cutoffCooldownHours > 0 ? ` + ${cutoffCooldownHours}hr cooldown lock` : "";
          await log(userId,
            `[${label}] ${trade.symbol} | ⏱️ EXIT: ${reason} ($${currentPnl.toFixed(2)}) — closing${cooldownText}`,
            "trade"
          );
          const soldFor = await closeTrade(ws, trade.contractId);
          if (soldFor !== null) {
            const finalPnl = soldFor - stake;
            await Trade.findByIdAndUpdate(trade._id, {
              status:   finalPnl >= 0 ? "won" : "lost",
              pnl:      finalPnl,
              closedAt: new Date(),
            });
            portfolio.unlockSymbol(trade.symbol);
            if (rm) rm.tradeClosed(finalPnl);
            if (cutoffCooldownHours > 0) portfolio.lockSymbolForCooldown(trade.symbol, cooldownMs);
            await log(userId, `[${label}] ${trade.symbol} | Closed $${soldFor.toFixed(2)} | PnL: $${finalPnl.toFixed(2)}${cutoffCooldownHours > 0 ? ` | 🧊 locked ${cutoffCooldownHours}hrs` : ""}`, "trade");
            await notifyTradeClosed({ symbol: trade.symbol, direction, soldFor, pnl: finalPnl, stake, reason: `${reason}${cutoffCooldownHours > 0 ? ` — ${cutoffCooldownHours}hr cooldown lock applied` : ""}`, label, botToken, chatId });
            emitTradeClosed(userId, { id: String(trade._id), symbol: trade.symbol, direction, stake, status: finalPnl >= 0 ? "won" : "lost", pnl: finalPnl, closedAt: new Date() });
            try { emitBalanceUpdate(userId, await getBalance(ws)); } catch {}
          }
          continue;
        }

        // ── EXIT 2: PNL LOCK (stepped ratchet, client-side) ──
        // Does NOT use Deriv's contract_update — per Deriv support's
        // own chat transcript, trailing isn't natively supported, and
        // Deriv's own docs define stop_loss as a LOSS-amount threshold,
        // not a price/equity level. Closes via `sell` (same closeTrade
        // EXIT 1/1B use) the moment profit falls to/below the locked
        // floor computed above. Original stop_loss/take_profit set at
        // trade-open are untouched — still the hard backstop.
        if (stepsBanked >= 1) {
          const floorJustRaised = floor > (trade.pnlLockFloor || 0);
          if (floorJustRaised) {
            const wasActive = trade.trailingActive;
            await Trade.findByIdAndUpdate(trade._id, {
              trailingActive:  true,
              trailingPeakPnl: peak,
              pnlLockFloor:    floor,
            });
            await log(userId,
              `[${label}] ${trade.symbol} | 📈 PnL Lock ${wasActive ? "stepped up" : "ACTIVATED (breakeven)"} | New close-floor: $${floor.toFixed(4)} ` +
              `(step ${stepsBanked} of $${stepSize.toFixed(2)} each)`,
              "trade"
            );
            await notifyPnlLockUpdate({
              symbol: trade.symbol, direction, currentPnl, peak, floor, lockPct: pnlLockPct,
              label, botToken, chatId,
            });
          } else if (peak > (trade.trailingPeakPnl || 0)) {
            await Trade.findByIdAndUpdate(trade._id, { trailingPeakPnl: peak });
          }

          if (lockFloorHit) {
            const reason = `PnL Lock floor hit ($${currentPnl.toFixed(4)} <= $${floor.toFixed(4)})`;
            await log(userId, `[${label}] ${trade.symbol} | 🔒 EXIT: ${reason} — closing`, "trade");
            const soldFor = await closeTrade(ws, trade.contractId);
            if (soldFor !== null) {
              const finalPnl = soldFor - stake;
              await Trade.findByIdAndUpdate(trade._id, {
                status:   finalPnl >= 0 ? "won" : "lost",
                pnl:      finalPnl,
                closedAt: new Date(),
              });
              portfolio.unlockSymbol(trade.symbol);
              if (rm) rm.tradeClosed(finalPnl);
              await log(userId, `[${label}] ${trade.symbol} | Closed $${soldFor.toFixed(2)} | PnL: $${finalPnl.toFixed(2)} (locked floor was $${floor.toFixed(4)})`, "trade");
              await notifyTradeClosed({ symbol: trade.symbol, direction, soldFor, pnl: finalPnl, stake, reason, label, botToken, chatId });
              emitTradeClosed(userId, { id: String(trade._id), symbol: trade.symbol, direction, stake, status: finalPnl >= 0 ? "won" : "lost", pnl: finalPnl, closedAt: new Date() });
              try { emitBalanceUpdate(userId, await getBalance(ws)); } catch {}
            }
            continue;
          }
        }

      } catch (tradeErr) {
        if (!tradeErr.message.includes("closed") && !tradeErr.message.includes("expired")) {
          console.error(`[${label}] Monitor error for ${trade.contractId}:`, tradeErr.message);
        }
      }
    }
    return liveStatuses;
  } catch (e) {
    console.error(`[${label}] Trade monitor error:`, e.message);
    return [];
  }
}

// ── PER-USER PORTFOLIO ────────────────────────────────
function createPortfolio(userId) {
  let activeSymbols = new Set();
  let openCount     = 0;
  const timers      = new Map();
  const cooldowns   = new Map(); // symbol -> expiresAt (ms epoch) — survives sync()

  return {
    getActiveSymbols: () => activeSymbols,
    getOpenCount:     () => openCount,

    lockSymbol(sym, contractId, durationMins) {
      activeSymbols.add(sym);
      openCount = activeSymbols.size;
      if (contractId) {
        // Mirrors whatever the forced-close timer is actually set to
        // (trader.js's startForcedCloseTimer / user's CONTRACT CUTOFF
        // setting) — this used to be a hardcoded 2 hours regardless of
        // that setting, so the "🔒 LOCKED" countdown shown per symbol
        // would drift out of sync with (and often expire well before)
        // the real forced-close time, even though the actual lock/
        // unlock behavior itself was still correct (driven by the real
        // trade closing, not by this countdown). durationMins <= 0
        // means the forced-close timer is OFF — no expiry to display.
        const entry = { contractId: String(contractId) };
        if (durationMins > 0) entry.expiresAt = Date.now() + durationMins * 60 * 1000;
        timers.set(sym, entry);
      }
    },

    unlockSymbol(sym) {
      activeSymbols.delete(sym);
      timers.delete(sym);
      openCount = Math.max(0, openCount - 1);
    },

    // Locks a symbol for a fixed cooldown window WITHOUT requiring an
    // open trade — used by the 20-min-no-profit auto-close rule so the
    // symbol stays off-limits for 2hrs after that specific exit, even
    // though no trade is open anymore. Independent of timers/activeSymbols
    // so portfolio.sync() rebuilding those from Deriv/DB doesn't erase it.
    lockSymbolForCooldown(sym, durationMs = 2 * 60 * 60 * 1000) {
      cooldowns.set(sym, Date.now() + durationMs);
    },

    isOnCooldown(sym) {
      const expiresAt = cooldowns.get(sym);
      if (!expiresAt) return false;
      if (Date.now() >= expiresAt) { cooldowns.delete(sym); return false; }
      return true;
    },

    getCooldownRemaining(sym) {
      const expiresAt = cooldowns.get(sym);
      if (!expiresAt) return "";
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) return "";
      const hrs  = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      return hrs > 0 ? ` | 🧊 cooldown ${hrs}h ${mins}m` : ` | 🧊 cooldown ${mins}m`;
    },

    getCountdown(sym) {
      const t = timers.get(sym);
      if (!t) return "";
      if (!t.expiresAt) return ""; // forced-close is OFF for this trade — no countdown to show
      const remaining = t.expiresAt - Date.now();
      if (remaining <= 0) return " | ⏱️ Expiring soon";
      const hrs  = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      return hrs > 0 ? ` | ⏱️ ${hrs}h ${mins}m` : ` | ⏱️ ${mins}m`;
    },

    async sync(ws) {
      try {
        const resp      = await sendMessage(ws, { portfolio: 1 }, "portfolio");
        const contracts = resp?.portfolio?.contracts ?? [];
        const activeNow = new Set();
        let total = 0;

        for (const c of contracts) {
          const status = String(c.status ?? "").toLowerCase();
          if (["sold","closed","expired"].includes(status)) continue;
          total++;
          for (const field of ["underlying","symbol","shortcode","underlying_symbol"]) {
            const val = String(c[field] ?? "");
            for (const sym of SYMBOLS) {
              if (val.includes(sym)) { activeNow.add(sym); break; }
            }
          }
        }

        // DB check — prevents duplicate trades after reconnect
        const dbOpenTrades = await Trade.find({ userId, status: "open" });
        for (const t of dbOpenTrades) activeNow.add(t.symbol);

        for (const sym of timers.keys()) {
          if (!activeNow.has(sym)) timers.delete(sym);
        }

        activeSymbols = activeNow;
        openCount     = total;
        return total;
      } catch (e) {
        console.error("Portfolio sync error:", e.message);
        return openCount;
      }
    },
  };
}


// ── RUN ONE USER'S BOT ────────────────────────────────
let _userStartOffset = 0;

async function runUserBot(user, stopSignal) {
  const userId   = user._id.toString();
  const label    = user.name;
  const myOffset = (_userStartOffset++ % 4) * 7000;
  if (myOffset > 0) await new Promise(r => setTimeout(r, myOffset));
  const botToken = TELEGRAM_BOT_TOKEN;
  const chatId   = user.telegramChatId;

  await log(userId, `[${label}] Bot starting — SMC Bible Strategy (H4 -> M15 -> M1)`, "info");

  const rm = new RiskManager({
    riskPct:              user.risk.riskPct,
    maxDailyLossPct:      user.risk.maxDailyLossPct,
    maxOpenTrades:        user.risk.maxOpenTrades,
    maxConsecutiveLosses: user.risk.maxConsecutiveLosses,
  });

  const portfolio     = createPortfolio(user._id);
  let lastSummaryDate = "";
  const dfH4Cache      = new Map();

  while (!stopSignal.stopped) {
    let lastApiCall = Date.now();
    try {
      const wsUrl = await connectForMode(user.derivMode, user.derivPAT, user.derivAppId);
      const ws    = await connectWebSocket(wsUrl);
      lastApiCall = Date.now();

      const openCount = await portfolio.sync(ws);
      lastApiCall     = Date.now();
      rm.openTrades   = openCount;

      let balance = await getBalance(ws);
      lastApiCall = Date.now();
      if (rm.startingBalance === null) rm.setStartingBalance(balance);
      emitBalanceUpdate(user._id, balance, user.derivMode);
      emitBotStatus(user._id, true);

      await log(userId, `[${label}] ✅ Connected | Balance: $${balance.toFixed(2)} | Open: ${openCount}/${rm.maxOpen}`, "info");
      await notifyStartup(balance, user.derivMode, label, botToken, chatId);

      while (!stopSignal.stopped) {
        await sleep(POLL_SECS);

        if (ws.readyState !== 1) {
          await log(userId, `[${label}] ⏱️ WebSocket dropped — reconnecting...`, "warn");
          ws.close(); break;
        }

        const freshUser = await User.findById(userId);
        if (!freshUser || !freshUser.botActive) {
          await log(userId, `[${label}] Bot stopped from dashboard`, "info");
          ws.close();
          stopSignal.stopped = true;
          break;
        }

        lastApiCall = Date.now();
        balance     = await getBalance(ws);
        lastApiCall = Date.now();
        emitBalanceUpdate(user._id, balance, user.derivMode);

        await syncTradeStatuses(ws, user._id, label, botToken, chatId, rm);
        lastApiCall = Date.now();

        const liveStatuses = await monitorOpenTrades(ws, user._id, label, portfolio, dfH4Cache, freshUser.risk, botToken, chatId, rm, freshUser);
        lastApiCall = Date.now();

        const currentOpen = await portfolio.sync(ws);
        lastApiCall = Date.now();
        rm.openTrades     = currentOpen;

        // Apply latest risk settings from DB
        rm.maxOpen              = freshUser.risk.maxOpenTrades;
        rm.maxConsecutiveLosses = freshUser.risk.maxConsecutiveLosses;
        rm.maxDailyLossPct      = freshUser.risk.maxDailyLossPct;
        rm.riskPct              = freshUser.risk.riskPct;

        await log(userId,
          `[${label}] 📡 ${sessionName()} | Balance: $${balance.toFixed(2)} | Open: ${currentOpen}/${rm.maxOpen}`,
          "info"
        );

        // Daily summary
        const todayStr = new Date().toISOString().slice(0, 10);
        if (new Date().getUTCHours() === 23 && lastSummaryDate !== todayStr) {
          lastSummaryDate = todayStr;
          await notifyDailySummary({ balance, dailyPnl: rm.dailyPnl, openTrades: currentOpen, consecutiveLosses: rm.consecutiveLosses, label, botToken, chatId });
        }

        if (currentOpen >= rm.maxOpen) {
          if (liveStatuses.length) {
            const tradeLines = liveStatuses.map(s =>
              `  • ${s.symbol} (${s.direction}) | PnL: $${s.pnl.toFixed(4)} | Bias: ${s.biasStatus} | Cutoff: ${s.cutoffText} | ${s.pnlLockText} | Timer: ${s.forcedCloseText}`
            );
            await log(userId,
              `[${label}] 🔒 Max open trades (${currentOpen}/${rm.maxOpen}) — watching ${liveStatuses.length} open position(s):\n${tradeLines.join("\n")}`,
              "warn"
            );
          } else {
            await log(userId, `[${label}] 🔒 Max open trades (${currentOpen}/${rm.maxOpen}) — waiting`, "warn");
          }
          await notifyMaxTrades(currentOpen, rm.maxOpen, label, botToken, chatId);
          continue;
        }

        if (!rm.canTrade(balance)) {
          const s      = rm.status();
          const reason = s.consecutiveLosses >= rm.maxConsecutiveLosses
            ? `${s.consecutiveLosses} consecutive losses`
            : `Daily loss limit ($${Math.abs(s.dailyPnl).toFixed(2)})`;
          await log(userId, `[${label}] 🚫 Risk block: ${reason}`, "warn");
          await notifyRiskBlock(reason, label, botToken, chatId);
          continue;
        }

        const slotsLeft    = rm.maxOpen - currentOpen;
        await log(userId, `[${label}] ✅ ${slotsLeft} slot(s) available — scanning (SMC)...`, "info");

        const cycleResults = [];
        let   placed       = 0;

        // ── SYMBOL LOOP ───────────────────────────────
        for (const symbol of SYMBOLS) {
          if (stopSignal.stopped) break;
          if (placed >= slotsLeft || portfolio.getOpenCount() >= rm.maxOpen) break;

          const activeSymbols = portfolio.getActiveSymbols();

          if (activeSymbols.has(symbol)) {
            const countdown = portfolio.getCountdown(symbol);
            await log(userId, `[${label}] ${symbol} | 🔒 LOCKED${countdown}`, "info");
            cycleResults.push({ symbol, status: "LOCKED", countdown });
            continue;
          }

          if (portfolio.isOnCooldown(symbol)) {
            const cooldownText = portfolio.getCooldownRemaining(symbol);
            await log(userId, `[${label}] ${symbol} | 🧊 COOLDOWN${cooldownText}`, "info");
            cycleResults.push({ symbol, status: "LOCKED", countdown: cooldownText });
            continue;
          }

          if (!isMarketOpen(symbol)) {
            await log(userId, `[${label}] ${symbol} | 🕐 MARKET CLOSED`, "info");
            cycleResults.push({ symbol, status: "CLOSED" });
            continue;
          }

          // DB duplicate check
          const existingOpenTrade = await Trade.findOne({
            userId: user._id,
            symbol,
            status: "open",
          });
          if (existingOpenTrade) {
            portfolio.lockSymbol(symbol);
            cycleResults.push({ symbol, status: "LOCKED" });
            continue;
          }

          // Read from global cache — 3 timeframes (H4/M15/M1)
          lastApiCall    = Date.now();
          const tf       = await getCachedMultiTf(ws, symbol);
          const { h4: dfH4, m15: dfM15, m1: dfM1 } = tf;

          if (dfH4 && dfH4.length > 0) dfH4Cache.set(symbol, dfH4);

          if (!dfM1 || dfM1.length < 2) continue;

          // Global volatility filter — measured on M1, the execution timeframe
          if (!marketIsTradeable(dfM1)) {
            await log(userId, `[${label}] ${symbol} | ⛔ FILTERED — poor volatility`, "info");
            cycleResults.push({ symbol, status: "FILTERED" });
            continue;
          }

          // ── RUN SMC BIBLE STRATEGY ────────────────────
          const result = collectSignals({ h4: dfH4, m15: dfM15, m1: dfM1, symbol });
          const { signal, breakdown, reason, bias } = result;

          if (signal === 0) {
            await log(userId,
              `[${label}] ${symbol} | HOLD | Bias: ${(bias || "none").toUpperCase()} | ${reason}`,
              "info"
            );
            cycleResults.push({
              symbol,
              status:       "HOLD",
              bias:    bias || "none",
              strength:     0,
              rejectReason: reason,
              breakdown,
            });
            continue;
          }

          // ── SIGNAL FIRED ─────────────────────────────
          const direction = signal === SIG_BUY ? "MULTUP" : "MULTDOWN";
          const label2    = signal === SIG_BUY ? "BUY"    : "SELL";

          // Fixed dollar stake — user sets amount directly (min $1)
          const stake      = parseFloat(Math.max(freshUser.risk.stakeAmount || 1.00, 1.00).toFixed(2));
          // Deriv deducts commission from the stake up front on multiplier
          // contracts, so the maximum loss you can ever actually realize
          // is always slightly LESS than 100% of the stake — a stop_loss
          // set to exactly (or above) the full stake is mathematically
          // unreachable and Deriv rejects it outright. Clamp to a safe
          // ceiling below 100% regardless of what's configured, so a
          // 100%+ setting (accidental or intentional) can never break
          // every single trade for this reason again.
          const safeStopLossPct = Math.min(freshUser.risk.stopLossPct, 0.95);
          const limitOrder = {
            stop_loss:   parseFloat((stake * safeStopLossPct).toFixed(2)),
            take_profit: parseFloat((stake * freshUser.risk.takeProfitPct).toFixed(2)),
          };
          const multiplier = 100;

          // Log full strategy breakdown
          await log(userId,
            `[${label}] ${symbol} | ${label2}! | H4 Bias: ${bias.toUpperCase()} | Stake: $${stake} | SL=$${limitOrder.stop_loss} TP=$${limitOrder.take_profit}`,
            "trade"
          );
          await log(userId, getTradeReason({ h4: dfH4, m15: dfM15, m1: dfM1, symbol }), "trade");

          cycleResults.push({
            symbol,
            status:    label2,
            bias,
            breakdown,
          });

          const tradeResult = await placeTradeWithRetry(ws, symbol, direction, stake, limitOrder);

          if (tradeResult) {
            lastApiCall = Date.now();

            const contractId = typeof tradeResult === "object" ? tradeResult.contractId : String(tradeResult);
            const buyPrice   = typeof tradeResult === "object" ? tradeResult.buyPrice : 0;

            // Default to 120 mins (2hrs) if the user has never set this
            // (covers existing user documents created before this field
            // existed in the schema). Explicit 0 from the dashboard toggle
            // still correctly means OFF.
            const durationMins = (freshUser.risk.contractDurationMins === undefined || freshUser.risk.contractDurationMins === null)
              ? 120
              : freshUser.risk.contractDurationMins;

            portfolio.lockSymbol(symbol, contractId, durationMins);
            rm.tradeOpened();
            placed++;

            startForcedCloseTimer({
              contractId,
              symbol,
              direction,
              stake,
              token:        user.derivPAT,
              appId:        user.derivAppId,
              mode:         user.derivMode,
              label,
              durationMins, // 0 = OFF (explicit user choice), no min/max otherwise
              onClosed: buildForcedCloseHandler({ userId: user._id, symbol, direction, stake, label, botToken, chatId, portfolio, rm, ws, contractId }),
            });

            try {
              const newTrade = await Trade.create({
                userId:     user._id,
                symbol,
                direction,
                stake,
                multiplier,
                contractId,
                buyPrice,
                stopLoss:   limitOrder.stop_loss,
                takeProfit: limitOrder.take_profit,
                forcedCloseDurationMins: durationMins,
                status:     "open",
                pnl:        0,
              });
              emitTradeOpened(user._id, {
                id:         String(newTrade._id),
                symbol, direction, stake, multiplier,
                contractId, status: "open", pnl: 0,
                openedAt:   newTrade.openedAt,
              });
            } catch (dbErr) {
              if (!dbErr.message.includes("duplicate key")) {
                await log(userId, `[${label}] DB save error: ${dbErr.message}`, "error");
              }
            }

            await notifyTradeOpened({
              symbol, direction, stake, multiplier,
              limitOrder,
              contractId, label, botToken, chatId,
              breakdown,
              bias,
            });

            await log(userId,
              `[${label}] ✅ Trade saved | ${symbol} | ${label2} | $${stake} | ID: ${contractId}`,
              "trade"
            );
          }

        } // end symbol loop

        if (cycleResults.length > 0) {
          await notifyCycleScan({ balance, openTrades: currentOpen, maxTrades: rm.maxOpen, session: sessionName(), results: cycleResults, label, botToken, chatId });
        }

      } // inner loop

    } catch (e) {
      if (stopSignal.stopped) break;
      await log(userId, `[${label}] ❌ Error: ${e.message}`, "error");
      await notifyReconnecting(e.message, label, botToken, chatId);
      await sleep(10);
    }
  } // outer loop

  await log(userId, `[${label}] Bot fully stopped.`, "info");
  runningBots.delete(userId);
}


// ── BOT MANAGER PUBLIC API ────────────────────────────
export const botManager = {
  async startUser(user) {
    const userId = user._id.toString();
    if (runningBots.has(userId)) {
      console.log(`[${user.name}] Already running`); return;
    }
    // multiplierCache (trader.js) is a plain module-level Map shared
    // across the whole server process — the process itself never
    // restarts just because a user's bot loop stops and starts again,
    // so without this the cache would otherwise persist stale/learned
    // multiplier values indefinitely across any Stop → Start or
    // Restart action taken from the dashboard.
    resetMultiplierCache();
    const stats = getCacheStats();
    if (stats.total === 0) {
      startGlobalScanner(SYMBOLS, user.derivPAT, user.derivAppId, user.derivMode || "demo")
        .catch(e => console.error("[scanner] Failed to start:", e.message));
    }
    const stopSignal = { stopped: false };
    runningBots.set(userId, stopSignal);
    runUserBot(user, stopSignal);
    console.log(`[${user.name}] Bot started`);
  },

  async stopUser(userId) {
    const signal = runningBots.get(userId);
    if (signal) {
      signal.stopped = true;
      runningBots.delete(userId);
    }
    emitBotStatus(userId, false);
  },

  async restartUser(userId) {
    await this.stopUser(userId);
    await sleep(2);
    const user = await User.findById(userId);
    if (user && user.botActive) await this.startUser(user);
  },

  isRunning(userId) { return runningBots.has(userId); },
  runningCount()    { return runningBots.size; },
};


export async function resumeActiveBots() {
  const activeUsers = await User.find({ botActive: true });
  console.log(`Resuming ${activeUsers.length} active bot(s)...`);

  if (activeUsers.length > 0) {
    const u = activeUsers[0];
    startGlobalScanner(SYMBOLS, u.derivPAT, u.derivAppId, u.derivMode || "demo")
      .catch(e => console.error("[scanner] Failed to start:", e.message));
  } else {
    const token = process.env.DERIV_PAT_TOKEN;
    const appId = process.env.DERIV_APP_ID;
    if (token && appId) {
      startGlobalScanner(SYMBOLS, token, appId, "demo")
        .catch(e => console.error("[scanner] Failed to start:", e.message));
    }
  }

  for (const user of activeUsers) {
    await botManager.startUser(user);
  }
}