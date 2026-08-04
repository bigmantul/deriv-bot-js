// ═══════════════════════════════════════════════════════
//  src/utils/telegram.js
//
//  Notifications fully integrated with the SMC Bible
//  Strategy (4-stage state machine: D1 -> Trend -> 1H -> 15M)
// ═══════════════════════════════════════════════════════

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── RATE-LIMIT GUARD ──────────────────────────────────
// Telegram returns 429 + retry_after (seconds) when flooded.
// Keyed per chat_id so one over-active chat doesn't block
// notifications to a different chat. While blocked, sends are
// skipped locally (not even attempted) so we never compound
// the penalty by hammering the API again mid-block.
const blockedUntil = new Map(); // chatId -> epoch ms

async function sendMessage(text, botToken, chatId) {
  const token = botToken || TELEGRAM_BOT_TOKEN;
  const chat  = chatId   || TELEGRAM_CHAT_ID;

  if (!token || !chat) return;
  if (token === "your_telegram_bot_token_here") return;

  const until = blockedUntil.get(chat) || 0;
  if (Date.now() < until) {
    console.warn(`Telegram rate-limited — skipping send, resumes at ${new Date(until).toISOString()}`);
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
    });

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const retryAfterSecs = body?.parameters?.retry_after ?? 30;
      blockedUntil.set(chat, Date.now() + retryAfterSecs * 1000);
      console.error(`Telegram 429 — pausing sends to this chat for ${retryAfterSecs}s`);
      return;
    }

    if (!res.ok) console.error("Telegram failed:", await res.text());
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

// ── HELPERS ───────────────────────────────────────────

// breakdown items now look like: { step, result, reason }
// e.g. { step: "Stage1 DailyBias", result: "BULLISH", reason: "..." }
function stageIcon(result) {
  if (!result) return "⬜";
  const r = result.toUpperCase();
  if (r.includes("BUY") || r.includes("BULLISH") || r.includes("AGREES") || r.includes("ENTRY MODE")) return "🟢";
  if (r.includes("SELL") || r.includes("BEARISH") || r.includes("MISMATCH")) return "🔴";
  if (r.includes("OUTSIDE SESSION")) return "🌙";
  return "⬜";
}

/**
 * Format the 4-stage breakdown into readable Telegram lines.
 * breakdown = [{ step, result, reason }]
 */
function formatBreakdown(breakdown) {
  if (!breakdown || !breakdown.length) return "";
  return breakdown
    .map(s => `  ${stageIcon(s.result)} <b>${s.step}</b>: ${s.result}\n     <i>${s.reason}</i>`)
    .join("\n");
}

// ── STARTUP ───────────────────────────────────────────
export function notifyStartup(balance, mode, label, botToken, chatId) {
  return sendMessage(
    `🤖 <b>${label || "Bot"} — Started</b>\n` +
    `Mode       : ${(mode || "demo").toUpperCase()}\n` +
    `Balance    : $${balance.toFixed(2)}\n` +
    `Engine     : SMC Bible Strategy (H4 -> M15 -> M1)\n` +
    `Stages     : H4 Bias/POI → M15 Sweep → M1 CHoCH+iBOS+OB/FVG Entry\n` +
    `Timeframes : H4 / M15 / M1\n` +
    `FX Session : London + New York + overlap only\n` +
    `Synthetics : 24/7, no session restriction`,
    botToken, chatId
  );
}

// ── TRADE OPENED ──────────────────────────────────────
export function notifyTradeOpened({
  symbol, direction, stake, multiplier, limitOrder,
  contractId, label, botToken, chatId,
  breakdown, bias,
}) {
  const isBuy  = direction === "MULTUP";
  const icon   = isBuy ? "🟢 BUY" : "🔴 SELL";
  const slText = limitOrder ? `\nSL         : $${limitOrder.stop_loss}` : "";
  const tpText = limitOrder ? `\nTP         : $${limitOrder.take_profit}` : "";

  const breakdownBlock = breakdown && breakdown.length
    ? `\n\n<b>4-Stage Breakdown:</b>\n${formatBreakdown(breakdown)}`
    : "";

  return sendMessage(
    `${icon} <b>${label || "Bot"} — ${symbol}</b>\n` +
    `H4 Bias    : ${(bias || "—").toUpperCase()}\n` +
    `Contract   : ${contractId}\n` +
    `Stake      : $${stake.toFixed(2)} x${multiplier}` +
    slText + tpText +
    breakdownBlock,
    botToken, chatId
  );
}

// ── LIVE STATUS (all exit mechanisms, every monitor cycle) ──
export function notifyLiveStatus({ lines, label, botToken, chatId }) {
  return sendMessage(`📡 ${lines.join("\n")}`, botToken, chatId);
}

// ── TRADE CLOSED (any exit reason) ────────────────────
export function notifyTradeClosed({
  symbol, direction, soldFor, pnl, stake, reason,
  label, botToken, chatId,
}) {
  const isWin = pnl >= 0;
  const icon  = isWin ? "✅ WIN" : "❌ LOSS";
  const dir   = direction === "MULTUP" ? "BUY" : "SELL";

  return sendMessage(
    `${icon} <b>${label || "Bot"} — ${symbol}</b>\n` +
    `Direction  : ${dir}\n` +
    `Reason     : ${reason}\n` +
    `Sold For   : $${soldFor.toFixed(2)}\n` +
    `PnL        : $${pnl.toFixed(2)} (stake $${stake.toFixed(2)})`,
    botToken, chatId
  );
}

// ── PNL LOCK FLOOR RAISED (client-side profit lock) ───
export function notifyPnlLockUpdate({
  symbol, direction, currentPnl, peak, floor, lockPct,
  label, botToken, chatId,
}) {
  const dir = direction === "MULTUP" ? "BUY" : "SELL";
  return sendMessage(
    `🔒 <b>${label || "Bot"} — ${symbol} PnL Lock</b>\n` +
    `Direction  : ${dir}\n` +
    `Current PnL: $${currentPnl.toFixed(2)}\n` +
    `Peak PnL   : $${peak.toFixed(2)}\n` +
    `Locked at  : ${(lockPct * 100).toFixed(0)}% of peak\n` +
    `New Floor  : $${floor.toFixed(2)}\n` +
    `Closes automatically if profit falls to/below this floor.`,
    botToken, chatId
  );
}

// ── RISK BLOCK ────────────────────────────────────────
export function notifyRiskBlock(reason, label, botToken, chatId) {
  return sendMessage(
    `⚠️ <b>${label || "Bot"} — Risk Block</b>\n${reason}`,
    botToken, chatId
  );
}

// ── RECONNECTING ──────────────────────────────────────
export function notifyReconnecting(error, label, botToken, chatId) {
  return sendMessage(
    `🔌 <b>${label || "Bot"} — Reconnecting...</b>\nReason: ${error}`,
    botToken, chatId
  );
}

// ── MAX TRADES ────────────────────────────────────────
export function notifyMaxTrades(current, max, label, botToken, chatId) {
  return sendMessage(
    `🔒 <b>${label || "Bot"} — Max trades reached</b>\nOpen: ${current}/${max} — waiting for a trade to close`,
    botToken, chatId
  );
}

// ── DAILY SUMMARY ─────────────────────────────────────
export function notifyDailySummary({ balance, dailyPnl, openTrades, consecutiveLosses, label, botToken, chatId }) {
  const icon = dailyPnl >= 0 ? "📈" : "📉";
  return sendMessage(
    `${icon} <b>${label || "Bot"} — Daily Summary</b>\n` +
    `Balance    : $${balance.toFixed(2)}\n` +
    `Daily PnL  : ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}\n` +
    `Open trades: ${openTrades}\n` +
    `Loss streak: ${consecutiveLosses}`,
    botToken, chatId
  );
}

// ── CYCLE SCAN ────────────────────────────────────────
//
// r.status: "LOCKED" | "CLOSED" | "FILTERED" | "HOLD" | "BUY" | "SELL"
// r.bias: "bullish" | "bearish" | "none" (present on HOLD/BUY/SELL)
// r.breakdown: [{ step, result, reason }] (present on HOLD/BUY/SELL)
// r.rejectReason: short reason string (present on HOLD)
//
// Telegram's hard limit is 4096 chars per message. Leave headroom
// for HTML tags/emoji byte-length quirks.
const TELEGRAM_MAX_CHARS = 3500;

/**
 * Splits an array of text lines into chunks that each stay
 * under TELEGRAM_MAX_CHARS when joined with newlines, then
 * sends each chunk as a separate message in order.
 */
async function sendChunked(headerLines, bodyLines, botToken, chatId) {
  const header = headerLines.join("\n");

  if (!bodyLines.length) {
    return sendMessage(header, botToken, chatId);
  }

  const chunks = [];
  let current = [];
  let currentLen = header.length + 1;

  for (const line of bodyLines) {
    const lineLen = line.length + 1;
    if (currentLen + lineLen > TELEGRAM_MAX_CHARS && current.length > 0) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    const partLabel = chunks.length > 1 ? `\n<i>(part ${i + 1}/${chunks.length})</i>` : "";
    const text = i === 0
      ? `${header}\n${chunks[i].join("\n")}${partLabel}`
      : `${chunks[i].join("\n")}${partLabel}`;
    await sendMessage(text, botToken, chatId);
  }
}

export function notifyCycleScan({ balance, openTrades, maxTrades, session, results, label, botToken, chatId }) {
  const headerLines = [
    `📊 <b>${label || "Bot"} — Scan Cycle</b>`,
    `Session : ${session}`,
    `Balance : $${balance.toFixed(2)}`,
    `Open    : ${openTrades}/${maxTrades}`,
    ``,
  ];

  const bodyLines = [];

  for (const r of results) {
    const sym = r.symbol;

    // ── LOCKED ─────────────────────────────────────────
    if (r.status === "LOCKED") {
      const cd = r.countdown ? r.countdown : "";
      bodyLines.push(`🔒 ${sym} | LOCKED${cd}`);

    // ── MARKET CLOSED ──────────────────────────────────
    } else if (r.status === "CLOSED") {
      bodyLines.push(`🕐 ${sym} | MARKET CLOSED`);

    // ── FILTERED ───────────────────────────────────────
    } else if (r.status === "FILTERED") {
      bodyLines.push(`⛔ ${sym} | FILTERED — poor volatility`);

    // ── HOLD ───────────────────────────────────────────
    } else if (r.status === "HOLD") {
      const bias = (r.bias || "none").toUpperCase();
      const biasIcon = bias === "BULLISH" ? "🟢" : bias === "BEARISH" ? "🔴" : "⬜";

      // Find which stage is currently blocking, for a quick one-line summary
      const lastStage = r.breakdown && r.breakdown.length
        ? r.breakdown[r.breakdown.length - 1]
        : null;
      const stageLabel = lastStage ? lastStage.step.replace(/^Stage\d /, "") : "—";
      // Keep the reason short — long Rule A/B explanations get truncated
      // here so one symbol's line can't blow up the whole message.
      let shortReason = r.rejectReason || (lastStage ? lastStage.reason : "no data");
      if (shortReason.length > 90) shortReason = shortReason.slice(0, 87) + "...";

      bodyLines.push(`⏸ ${sym} | HOLD | Bias: ${biasIcon} ${bias} | ${stageLabel}: ${shortReason}`);

    // ── BUY / SELL ─────────────────────────────────────
    } else if (r.status === "BUY" || r.status === "SELL") {
      const icon = r.status === "BUY" ? "🟢" : "🔴";
      const bias = (r.bias || "—").toUpperCase();

      bodyLines.push(`${icon} ${sym} | ${r.status} | H4 Bias: ${bias}`);
    }
  }

  return sendChunked(headerLines, bodyLines, botToken, chatId);
}