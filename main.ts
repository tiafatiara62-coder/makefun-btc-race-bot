// Dip-buy + strict trend-follow bot for btc-race-24h-20261111-0801.
// Long only, one position, full size. Every decision is a pure function of the
// closes seen so far (and hello.seed, unused): no clock, no environment, no
// Math.random, so two runs on the same data produce identical orders.
//
// Why this shape: the dev window (24h of 1-minute cbBTC bars, BTC -1.07% with
// a slow grind down and two sharp V-shaped rebounds) punishes every
// trend-following and momentum variant we tried (EMA-cross 8/21: -$89.29,
// EMA-cross 12/48: -$63.05, Donchian: -$29 to -$54, RSI mean-reversion:
// -$14 to -$78) and rewards exactly one thing: buying a sharp multi-hour
// drop and selling the rebound. A full-size round trip costs ~26 bps in fees,
// slippage and impact, so a trade must catch a move well above that; 1-minute
// noise (std ~6 bps) is far below it. The dip-buy below (enter after a
// >=0.90% fall over 90 minutes, exit at +1.00% or -1.00% of cost) is the only
// family that clears the dev gate, at +$20.80 on the dev window, and it does
// so across a plateau of nearby parameters (70 of 175 grid points positive,
// the win-90 cluster all positive), not a single knife-edge set. The
// trend-buy is a strict second mode for the live race window: it only fires
// on a genuine strong uptrend (new 12-hour high AND +1.00% over 6 hours AND
// EMA-24 above EMA-96 by >=20 bps), so it never fired once on the choppy dev
// window, and rides such a trend with a 1.50% trailing stop.
//
// Backtest (own exact replay simulator, fill at next open, 4 bps fee, 2 bps
// slippage, constant-product impact vs the bar's open depth, end flattening):
// dev window net PnL +$20.80, 4 fills (2 round trips), fees $1.62,
// max drawdown 1.0%. Split-half: first 12h +$12.20 (3 fills), second 12h
// $0.00 (0 fills — no >=0.90% 90-minute drop occurred there). See BUILD_LOG.md.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

// --- parameters (bps = 1/100 of 1%) ---
const DIP_WIN = 90; // trailing window (bars) for the drop that triggers a dip-buy
const DIP_BPS = 90; // enter when the close is >=0.90% below the close DIP_WIN bars ago
const DIP_TP_BPS = 100; // dip exit: +1.00% over cost (fees included)
const DIP_SL_BPS = 100; // dip exit: -1.00% under cost
const TREND_HI_WIN = 720; // trend entry needs a new high over the last 12 hours
const TREND_RET6H_BPS = 100; // ... and +1.00% over the last 6 hours
const TREND_EMA_GAP_BPS = 20; // ... and EMA-24 above EMA-96 by >=0.20%
const TREND_TRAIL_BPS = 150; // trend exit: 1.50% trailing stop from the peak value
const EMA_FAST = 24;
const EMA_SLOW = 96;
const MAX_SLIPPAGE_BPS = 200; // fill may be at most 2.00% from the latest close

type Mode = 'dip' | 'trend' | null;

interface Ema {
  warm: number[];
  val: number | null;
  k: number;
}

function emaInit(span: number): Ema {
  return { warm: [], val: null, k: 2 / (span + 1) };
}

function emaStep(e: Ema, span: number, close: number): number | null {
  if (e.val === null) {
    e.warm.push(close);
    if (e.warm.length === span) {
      let sum = 0;
      for (const c of e.warm) sum += c;
      e.val = sum / span;
    }
  } else {
    e.val += e.k * (close - e.val);
  }
  return e.val;
}

const closes: number[] = [];
const emaFast = emaInit(EMA_FAST);
const emaSlow = emaInit(EMA_SLOW);
let mode: Mode = null;
let peak: bigint | null = null; // peak position value while in trend mode

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const sym = state.hello.symbols[0]?.symbol ?? 'CBBTC';
    const bar = batch.bars.find((b) => b.symbol === sym);
    if (bar === undefined) return []; // CBBTC absent this minute: no decision
    const close = Number(bar.c);
    closes.push(close);
    const eFast = emaStep(emaFast, EMA_FAST, close);
    const eSlow = emaStep(emaSlow, EMA_SLOW, close);

    const pos = state.positions.get(sym);
    if (pos !== undefined && pos.qty > 0n) {
      const val = state.value(sym, pos.qty);
      if (mode === 'trend') {
        if (peak === null || val > peak) peak = val;
        // Trailing stop from the peak, or the fast EMA crossing back under slow.
        const trailed = peak !== null && val * 10000n <= peak * BigInt(10000 - TREND_TRAIL_BPS);
        const crossedDown = eFast !== null && eSlow !== null && eFast < eSlow;
        if (trailed || crossedDown) {
          mode = null;
          peak = null;
          return [{ side: 'sell', symbol: sym, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        return [];
      }
      // Dip mode (and any unexpected held state): fixed take-profit / stop-loss on cost.
      // val >= cost * (1 + 1.00%) and val <= cost * (1 - 1.00%), in exact integer bps.
      const tookProfit = val * 10000n >= pos.cost * BigInt(10000 + DIP_TP_BPS);
      const stoppedOut = val * 10000n <= pos.cost * BigInt(10000 - DIP_SL_BPS);
      if (tookProfit || stoppedOut) {
        mode = null;
        peak = null;
        return [{ side: 'sell', symbol: sym, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: look for an entry. Dip-buy first.
    const n = closes.length;
    if (n > DIP_WIN) {
      const ago = closes[n - 1 - DIP_WIN];
      // close <= ago * (1 - 0.90%): close * 10000 <= ago * 9910
      if (close * 10000 <= ago * (10000 - DIP_BPS)) {
        const amount = state.cash < state.weightRoom(sym) ? state.cash : state.weightRoom(sym);
        if (amount >= 1000000n) {
          mode = 'dip';
          peak = null;
          return [{ side: 'buy', symbol: sym, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        return [];
      }
    }

    // Strict trend-buy: new 12h high + strong 6h rise + fast EMA clearly above slow.
    if (n > TREND_HI_WIN && eFast !== null && eSlow !== null) {
      let hi = 0;
      for (let i = n - 1 - TREND_HI_WIN; i < n - 1; i++) {
        if (closes[i] > hi) hi = closes[i];
      }
      const sixHAgo = closes[n - 360];
      const rising6h = sixHAgo !== undefined && close * 10000 >= sixHAgo * (10000 + TREND_RET6H_BPS);
      const emaGap = eFast * 10000 >= eSlow * (10000 + TREND_EMA_GAP_BPS);
      if (close > hi && rising6h && emaGap) {
        const amount = state.cash < state.weightRoom(sym) ? state.cash : state.weightRoom(sym);
        if (amount >= 1000000n) {
          mode = 'trend';
          peak = null;
          return [{ side: 'buy', symbol: sym, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }

    return [];
  },
});
