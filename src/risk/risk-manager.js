// ═══════════════════════════════════════════════════════
//  src/risk/risk-manager.js
// ═══════════════════════════════════════════════════════

export class RiskManager {

  static MIN_STAKE     = 1.00;
  static MAX_STAKE_CAP = 1000;

  constructor({
    riskPct              = 10.0,
    maxDailyLossPct      = 0,
    maxOpenTrades        = 3,
    maxConsecutiveLosses = 30,
  } = {}) {
    this.riskPct              = riskPct;
    this.maxDailyLossPct      = maxDailyLossPct;
    this.maxOpen              = maxOpenTrades;
    this.maxConsecutiveLosses = maxConsecutiveLosses;
    this.minStake             = RiskManager.MIN_STAKE;
    this.openTrades           = 0;
    this.dailyPnl             = 0.0;
    this.consecutiveLosses    = 0;
    this.startingBalance      = null;
    this._lastResetDate       = this._todayStr();
  }

  _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  setStartingBalance(balance) {
    this.startingBalance = balance;
    this._resetDailyState();
  }

  _resetDailyState() {
    this.dailyPnl          = 0.0;
    this.consecutiveLosses = 0;
    this._lastResetDate    = this._todayStr();
  }

  _checkDailyReset() {
    if (this._todayStr() > this._lastResetDate) {
      console.log("📅 New day — resetting daily PnL and loss streak.");
      this._resetDailyState();
    }
  }

  calculateStake(currentBalance) {
    this._checkDailyReset();
    const rawStake = currentBalance * (this.riskPct / 100);
    const stake    = Math.min(
      Math.max(rawStake, RiskManager.MIN_STAKE),
      RiskManager.MAX_STAKE_CAP
    );
    return parseFloat(stake.toFixed(2));
  }

  /**
   * Structural, SMC-Bible-style sizing (doc §33):
   *   stake = (accountEquity * riskFraction) / |entry - stopLoss|
   *
   * Adapted for Deriv multiplier contracts, where P&L for a stake S
   * with leverage `multiplier` moves as:
   *   pnl ≈ S * multiplier * (priceChange / entry)
   *
   * So sizing for a fixed dollar loss at the structural stop:
   *   riskDollars = balance * (riskPct / 100)
   *   stake       = riskDollars / (multiplier * |entry-stopLoss|/entry)
   *
   * This means a TIGHT structural stop (small % of price) sizes a
   * LARGER stake for the same dollar risk, and a WIDE stop sizes a
   * smaller stake — risk-per-trade stays constant regardless of how
   * far away the SMC engine placed the invalidation level.
   *
   * Falls back to the flat calculateStake() if entry/stopLoss are
   * missing or degenerate (e.g. stopLoss === entry).
   */
  calculateStakeForSetup(currentBalance, { entry, stopLoss, multiplier }) {
    this._checkDailyReset();
    if (!entry || stopLoss == null || !multiplier) return this.calculateStake(currentBalance);
    const distPct = Math.abs(entry - stopLoss) / entry;
    if (!isFinite(distPct) || distPct <= 0) return this.calculateStake(currentBalance);

    const riskDollars = currentBalance * (this.riskPct / 100);
    const rawStake     = riskDollars / (multiplier * distPct);
    const stake = Math.min(
      Math.max(rawStake, RiskManager.MIN_STAKE),
      RiskManager.MAX_STAKE_CAP
    );
    return parseFloat(stake.toFixed(2));
  }

  canTrade(currentBalance) {
    this._checkDailyReset();
    if (this.openTrades >= this.maxOpen) {
      console.log(`Risk block: max open trades (${this.maxOpen}) reached`);
      return false;
    }
    if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
      console.log(`Risk block: ${this.consecutiveLosses} consecutive losses — cooling down`);
      return false;
    }
    if (this.startingBalance) {
      const dailyLossRatio = -this.dailyPnl / this.startingBalance;
      if (dailyLossRatio >= this.maxDailyLossPct) {
        console.log(`Risk block: daily loss ${(dailyLossRatio * 100).toFixed(1)}%`);
        return false;
      }
    }
    return true;
  }

  tradeOpened() { this.openTrades += 1; }

  tradeClosed(pnl) {
    this.openTrades = Math.max(0, this.openTrades - 1);
    this.dailyPnl  += pnl;
    if (pnl < 0) this.consecutiveLosses += 1;
    else         this.consecutiveLosses  = 0;
  }

  status() {
    return {
      openTrades:        this.openTrades,
      maxOpenTrades:     this.maxOpen,
      dailyPnl:          parseFloat(this.dailyPnl.toFixed(2)),
      consecutiveLosses: this.consecutiveLosses,
      startingBalance:   this.startingBalance,
      riskPct:           this.riskPct,
      minStake:          this.minStake,
    };
  }
}


// ── STOP LOSS / TAKE PROFIT ───────────────────────────
// Now accepts custom SL/TP percentages per user
export class StopLossTakeProfit {

  constructor({ slPct = 0.80, tpPct = 2.00 } = {}) {
    this.slPct = slPct;
    this.tpPct = tpPct;
  }

  // Flat fallback — fixed % of stake, ignores structure entirely.
  getMultiplierLimitOrder(stake) {
    return {
      stop_loss:   parseFloat((stake * this.slPct).toFixed(2)),
      take_profit: parseFloat((stake * this.tpPct).toFixed(2)),
    };
  }

  /**
   * Converts the SMC engine's structural entry/stopLoss/takeProfit
   * PRICES into the dollar SL/TP thresholds Deriv multiplier
   * contracts expect, using the same pnl ≈ stake*multiplier*(Δ/entry)
   * relationship as calculateStakeForSetup(). Because stake is sized
   * off the same stopLoss distance, the resulting dollar stop_loss
   * should land at (or very near) riskDollars — this just makes that
   * explicit for both SL and TP, so the reward side reflects the
   * real RR the SMC engine already validated (≥3, or ≥4 for FVG).
   *
   * Returns null if entry/stopLoss/takeProfit aren't all present,
   * so the caller can fall back to getMultiplierLimitOrder().
   */
  getStructuralLimitOrder(stake, multiplier, entry, stopLoss, takeProfit) {
    if (!entry || stopLoss == null || takeProfit == null || !multiplier) return null;
    const slDistPct = Math.abs(entry - stopLoss)   / entry;
    const tpDistPct = Math.abs(takeProfit - entry) / entry;
    if (!isFinite(slDistPct) || !isFinite(tpDistPct) || slDistPct <= 0 || tpDistPct <= 0) return null;
    return {
      stop_loss:   parseFloat((stake * multiplier * slDistPct).toFixed(2)),
      take_profit: parseFloat((stake * multiplier * tpDistPct).toFixed(2)),
    };
  }
}