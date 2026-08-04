// ═══════════════════════════════════════════════════════
//  src/index.js — Main bot loop (standalone)
// ═══════════════════════════════════════════════════════

import "dotenv/config";

import { connectForMode }                from "./auth/deriv-auth.js";
import { connectWebSocket, sendMessage } from "./utils/ws-client.js";
import { getMultiTf }                    from "./data/candles.js";
import { SYMBOLS }                       from "./config/symbols.js";
import {
  getVolatilityScalar,
  marketIsTradeable,
  getH4Trend,
  getTradeReason,
  sessionName,
  isMarketOpen,
  collectSignals,
} from "./strategy/signals.js";
import { placeTradeWithRetry, startForcedCloseTimer } from "./trading/trader.js";
import {
  initPortfolio,
  syncActiveSymbols,
  getActiveSymbols,
  getOpenCount,
  lockSymbol,
} from "./trading/portfolio.js";
import { RiskManager, StopLossTakeProfit } from "./risk/risk-manager.js";
import { startHealthServer }               from "./utils/health-server.js";
import {
  notifyStartup,
  notifyTradeOpened,
  notifyRiskBlock,
  notifyReconnecting,
  notifyMaxTrades,
  notifyDailySummary,
  notifyCycleScan,
} from "./utils/telegram.js";


// ═══════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════
// SYMBOLS imported from src/config/symbols.js (single source of truth, shared with backtest/)

const POLL_SECS        = 15;
const MAX_IDLE_SECS    = 30;
const TRADING_MODE     = "demo";
const DAILY_SUMMARY_HR = 23;

// Telegram notifications below are informational, not trade-critical
// (trade open/close alerts are NOT throttled — those always send).
// Sending a full cycle-scan message every POLL_SECS (15s), forever,
// floods Telegram and triggers 429 flood-control. Only send these
// at most once per interval.
const CYCLE_SCAN_NOTIFY_SECS  = 300; // 5 min
const MAX_TRADES_NOTIFY_SECS  = 300;
const RISK_BLOCK_NOTIFY_SECS  = 300;


// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════

async function getBalance(ws) {
  const resp = await sendMessage(ws, { balance: 1 }, "balance");
  return parseFloat(resp.balance.balance);
}

function sleep(secs) {
  return new Promise(resolve => setTimeout(resolve, secs * 1000));
}


// ═══════════════════════════════════════════════════════
//  MAIN BOT LOOP
// ═══════════════════════════════════════════════════════
async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Launching bot...");
  console.log("  Strategy  : SMC Bible Strategy (H4 -> M15 -> M1)");
  console.log("  Stages    : H4 Bias/POI -> M15 Sweep -> M1 CHoCH+iBOS+OB/FVG Entry");
  console.log("  Timeframes: D1 / H1 / M15");
  console.log("═══════════════════════════════════════════════\n");

  initPortfolio(SYMBOLS);

  const rm   = new RiskManager();
  const sltp = new StopLossTakeProfit();

  let lastSummaryDate       = "";
  let lastCycleScanNotifyMs = 0;
  let lastMaxTradesNotifyMs = 0;
  let lastRiskBlockNotifyMs = 0;

  // ── OUTER LOOP ───────────────────────────────────────
  while (true) {

    let lastApiCall = Date.now();

    try {

      // STEP 1: Connect
      console.log("🔌 Connecting to Deriv...");
      const wsUrl = await connectForMode(TRADING_MODE);
      const ws    = await connectWebSocket(wsUrl);
      lastApiCall = Date.now();

      // STEP 2: Sync portfolio
      const openCount = await syncActiveSymbols(ws);
      lastApiCall     = Date.now();
      rm.openTrades   = openCount;
      console.log(`Open trades: ${openCount}/${rm.maxOpen} | Slots: ${Math.max(0, rm.maxOpen - openCount)}`);

      // STEP 3: Balance
      let balance = await getBalance(ws);
      lastApiCall = Date.now();
      if (rm.startingBalance === null) rm.setStartingBalance(balance);
      console.log(`💰 Balance: $${balance.toFixed(2)}\n`);

      await notifyStartup(balance, TRADING_MODE);

      // ── INNER LOOP ────────────────────────────────────
      while (true) {

        await sleep(POLL_SECS);

        if ((Date.now() - lastApiCall) / 1000 > MAX_IDLE_SECS) {
          console.log("⏱️  Connection idle — reconnecting proactively...");
          ws.close();
          break;
        }

        balance     = await getBalance(ws);
        lastApiCall = Date.now();

        const currentOpen = await syncActiveSymbols(ws);
        lastApiCall       = Date.now();
        rm.openTrades     = currentOpen;

        console.log(
          `\n📡 Session: ${sessionName()} | Balance: $${balance.toFixed(2)} | ` +
          `Open: ${currentOpen}/${rm.maxOpen}`
        );

        // Daily summary
        const todayStr = new Date().toISOString().slice(0, 10);
        const utcHour  = new Date().getUTCHours();
        if (utcHour === DAILY_SUMMARY_HR && lastSummaryDate !== todayStr) {
          lastSummaryDate = todayStr;
          await notifyDailySummary({
            balance,
            dailyPnl:          rm.dailyPnl,
            openTrades:        currentOpen,
            consecutiveLosses: rm.consecutiveLosses,
          });
        }

        // Max open trades check
        if (currentOpen >= rm.maxOpen) {
          console.log(`🔒 Max open trades (${currentOpen}/${rm.maxOpen}) — waiting`);
          if (Date.now() - lastMaxTradesNotifyMs >= MAX_TRADES_NOTIFY_SECS * 1000) {
            lastMaxTradesNotifyMs = Date.now();
            await notifyMaxTrades(currentOpen, rm.maxOpen);
          }
          continue;
        }

        // Risk check
        if (!rm.canTrade(balance)) {
          const status = rm.status();
          const reason =
            status.consecutiveLosses >= rm.maxConsecutiveLosses
              ? `${status.consecutiveLosses} consecutive losses`
              : `Daily loss limit hit ($${Math.abs(status.dailyPnl).toFixed(2)})`;
          console.log("🚫 Risk block — skipping cycle");
          if (Date.now() - lastRiskBlockNotifyMs >= RISK_BLOCK_NOTIFY_SECS * 1000) {
            lastRiskBlockNotifyMs = Date.now();
            await notifyRiskBlock(reason);
          }
          continue;
        }

        const slotsLeft = rm.maxOpen - currentOpen;
        console.log(`✅ ${slotsLeft} slot(s) available — scanning...`);

        const cycleResults          = [];
        let   tradesPlacedThisCycle = 0;

        // ── SYMBOL LOOP ───────────────────────────────
        for (const symbol of SYMBOLS) {

          if (tradesPlacedThisCycle >= slotsLeft) {
            console.log(`Slot limit reached — stopping scan`);
            break;
          }

          if (getOpenCount() >= rm.maxOpen) {
            console.log(`🔒 Max trades reached mid-scan — stopping`);
            break;
          }

          const activeSymbols = getActiveSymbols();

          if (activeSymbols.has(symbol)) {
            console.log(`${symbol} | LOCKED (trade open) — skipping`);
            cycleResults.push({ symbol, status: "LOCKED" });
            continue;
          }

          if (!isMarketOpen(symbol)) {
            console.log(`${symbol} | MARKET CLOSED — skipping`);
            cycleResults.push({ symbol, status: "CLOSED" });
            continue;
          }

          // Fetch the 3 timeframes used by the SMC strategy
          const tf = await getMultiTf(ws, symbol);
          const { h4: dfH4, m15: dfM15, m1: dfM1 } = tf;
          lastApiCall = Date.now();

          if (!dfM1 || dfM1.length < 2) continue;

          // Global volatility filter — now measured on M1, the execution timeframe
          if (!marketIsTradeable(dfM1)) {
            console.log(`${symbol} | FILTERED (poor market conditions)`);
            cycleResults.push({ symbol, status: "FILTERED" });
            continue;
          }

          // Run SMC strategy
          const result = collectSignals({ h4: dfH4, m15: dfM15, m1: dfM1, symbol });
          const { signal, breakdown, reason, bias } = result;

          if (signal === 0) {
            console.log(`${symbol} | HOLD | H4 Bias: ${(bias || "none").toUpperCase()} | ${reason}`);
            cycleResults.push({
              symbol,
              status: "HOLD",
              bias:   bias || "none",
              reason,
            });
            continue;
          }

          // Signal fired
          const label     = signal === 1 ? "BUY"    : "SELL";
          const direction = signal === 1 ? "MULTUP" : "MULTDOWN";

          // Re-fetch balance right before sizing THIS trade. `balance`
          // above was captured once at the top of the cycle, but this
          // symbol loop can place more than one trade per cycle — if an
          // earlier symbol already opened a trade, the stale balance
          // would still be used here, sizing this trade off funds that
          // are no longer actually free. That's what caused errors like
          // "Enter an amount equal to or lower than X" from Deriv.
          balance          = await getBalance(ws);
          lastApiCall      = Date.now();
          const baseStake  = rm.calculateStake(balance);
          const volScalar  = getVolatilityScalar(dfM1);
          const stake      = parseFloat(Math.max(baseStake * volScalar, rm.minStake).toFixed(2));
          const limitOrder = sltp.getMultiplierLimitOrder(stake);
          const multiplier = 100;

          console.log(
            `\n${symbol} | ${label} | H4 Bias: ${bias.toUpperCase()} | Stake: $${stake.toFixed(2)}`
          );
          console.log(getTradeReason({ h4: dfH4, m15: dfM15, m1: dfM1, symbol }));

          cycleResults.push({ symbol, status: label, bias });

          // Place trade
          const tradeResult = await placeTradeWithRetry(ws, symbol, direction, stake, limitOrder);

          if (tradeResult) {
            lastApiCall = Date.now();
            lockSymbol(symbol);
            rm.tradeOpened();
            tradesPlacedThisCycle++;

            startForcedCloseTimer({
              contractId: typeof tradeResult === "object" ? tradeResult.contractId : String(tradeResult),
              symbol,
              direction,
              stake,
              token:        process.env.DERIV_PAT_TOKEN,
              appId:        process.env.DERIV_APP_ID,
              mode:         TRADING_MODE,
              label:        "Bot",
              durationMins: parseFloat(process.env.CONTRACT_DURATION_MINS || "120"),
            });

            await notifyTradeOpened({
              symbol,
              direction,
              stake,
              multiplier,
              limitOrder,
              contractId: typeof tradeResult === "object" ? tradeResult.contractId : "N/A",
            });

            console.log(
              `✅ Trade recorded. Open: ${rm.openTrades}/${rm.maxOpen} | ` +
              `Locked: ${[...getActiveSymbols()].sort().join(", ")}`
            );
          }

        } // end symbol loop

        const hadSignalThisCycle = cycleResults.some(r => r.status === "BUY" || r.status === "SELL");
        const dueForScanNotify   = Date.now() - lastCycleScanNotifyMs >= CYCLE_SCAN_NOTIFY_SECS * 1000;

        if (cycleResults.length > 0 && (hadSignalThisCycle || dueForScanNotify)) {
          lastCycleScanNotifyMs = Date.now();
          await notifyCycleScan({
            balance,
            openTrades:  currentOpen,
            maxTrades:   rm.maxOpen,
            session:     sessionName(),
            results:     cycleResults,
          });
        }

      } // end inner loop

    } catch (e) {
      console.error("\n❌ Connection lost:", e.message);
      console.log("🔄 Reconnecting in 10 seconds...\n");
      await notifyReconnecting(e.message);
      await sleep(10);
    }

  } // end outer loop
}


// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════
startHealthServer();
main();