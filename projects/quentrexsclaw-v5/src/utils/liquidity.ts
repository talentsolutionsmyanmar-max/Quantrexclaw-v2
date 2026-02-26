/**
 * utils/liquidity.ts
 * Multi-timeframe liquidity sweep engine.
 * Equivalent to the Pine Script swing sweep logic.
 */

import type { Candle, LiquidityLevel, SwingPoint, Timeframe } from '../types';
import { detectSwings } from './ict';

// ─── SWEEP DETECTION ──────────────────────────────────────────────────────────

/**
 * Core sweep detection: finds all swing highs/lows and marks them as swept
 * once price exceeds the level (even intrabar on wicks).
 *
 * A sweep is confirmed when:
 * 1. Price wicks beyond the level (partial sweep — weak confirmation)
 * 2. Price closes beyond the level (full sweep — strong confirmation)
 */
export function detectLiquiditySweeps(
  candles: Candle[],
  timeframe: Timeframe,
  leftLen = 10,
  rightLen = 10
): LiquidityLevel[] {
  const swings = detectSwings(candles, leftLen, rightLen);
  const levels: LiquidityLevel[] = [];

  for (const swing of swings) {
    const id = `liq_${timeframe}_${swing.type}_${swing.time}`;

    // Count how many times price approached this level before sweep
    // (more tests = more liquidity = stronger magnet)
    let testCount = 0;
    const swingIdx = swing.index;

    for (let i = swingIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      const approach = swing.type === 'HIGH'
        ? c.high / swing.price        // how close to the high
        : swing.price / c.low;        // how close to the low
      if (approach > 0.997 && approach < 1.003) testCount++;
    }

    const level: LiquidityLevel = {
      id,
      price: swing.price,
      time: swing.time,
      type: swing.type,
      status: 'ACTIVE',
      strength: Math.min(100, 30 + testCount * 15),
      timeframe,
    };

    // Check if swept in subsequent candles
    for (let i = swingIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      if (swing.type === 'HIGH' && c.high > swing.price) {
        level.status = 'SWEPT';
        level.sweepTime = c.time;
        level.sweepCandle = c;
        break;
      }
      if (swing.type === 'LOW' && c.low < swing.price) {
        level.status = 'SWEPT';
        level.sweepTime = c.time;
        level.sweepCandle = c;
        break;
      }
    }

    levels.push(level);
  }

  return levels;
}

// ─── MULTI-TIMEFRAME SWEEP AGGREGATOR ─────────────────────────────────────────

export const MTF_CONFIGS: Record<Timeframe, { parent: Timeframe; leftLen: number; rightLen: number }> = {
  '1m':  { parent: '15m',  leftLen: 5,  rightLen: 5  },
  '3m':  { parent: '15m',  leftLen: 5,  rightLen: 5  },
  '5m':  { parent: '1h',   leftLen: 8,  rightLen: 8  },
  '15m': { parent: '4h',   leftLen: 10, rightLen: 10 },
  '30m': { parent: '4h',   leftLen: 10, rightLen: 10 },
  '1h':  { parent: '1d',   leftLen: 12, rightLen: 12 },
  '4h':  { parent: '1w',   leftLen: 15, rightLen: 15 },
  '1d':  { parent: '1w',   leftLen: 20, rightLen: 20 },
  '1w':  { parent: '1w',   leftLen: 20, rightLen: 20 },
};

/**
 * Identifies HIGH-PROBABILITY sweeps = same swing swept on BOTH timeframes.
 * e.g., a 15m swing that is ALSO a 4h swing = very high liquidity concentration.
 */
export function findConfluenceSweeps(
  htfLevels: LiquidityLevel[],
  ltfLevels: LiquidityLevel[],
  priceTolerancePct = 0.15
): Array<{ htf: LiquidityLevel; ltf: LiquidityLevel; confluenceScore: number }> {
  const results: Array<{ htf: LiquidityLevel; ltf: LiquidityLevel; confluenceScore: number }> = [];

  for (const htf of htfLevels) {
    for (const ltf of ltfLevels) {
      if (htf.type !== ltf.type) continue;
      const priceDiff = Math.abs(htf.price - ltf.price) / htf.price * 100;
      if (priceDiff <= priceTolerancePct) {
        const confluenceScore = Math.round(
          (htf.strength * 0.6 + ltf.strength * 0.4) *
          (1 - priceDiff / priceTolerancePct) * // closer = higher score
          (htf.status === 'ACTIVE' ? 1.2 : 0.8) // active > swept
        );
        results.push({ htf, ltf, confluenceScore: Math.min(100, confluenceScore) });
      }
    }
  }

  return results.sort((a, b) => b.confluenceScore - a.confluenceScore);
}

// ─── SWEEP + FVG SETUP DETECTOR ───────────────────────────────────────────────

/**
 * THE CORE ICT SETUP: Liquidity Sweep followed by displacement into FVG.
 *
 * 1. Price sweeps a swing high/low (grabs liquidity)
 * 2. Displacement candle (large body, closes strong)
 * 3. FVG forms in the displacement
 * 4. Entry: FVG 50% (midpoint)
 * 5. SL: Beyond sweep extreme
 * 6. TP: Opposing liquidity
 */
export interface SweepFVGSetup {
  sweep: LiquidityLevel;
  displacementCandle: Candle;
  fvgEntry: number;     // 50% of FVG
  fvgTop: number;
  fvgBottom: number;
  stopLoss: number;
  direction: 'LONG' | 'SHORT';
  quality: number;      // 0-100
}

export function detectSweepFVGSetups(
  candles: Candle[],
  levels: LiquidityLevel[],
  fvgMinSizePct = 0.05
): SweepFVGSetup[] {
  const setups: SweepFVGSetup[] = [];
  const sweptLevels = levels.filter(l => l.status === 'SWEPT' && l.sweepCandle);

  for (const level of sweptLevels) {
    const sweepCandleIdx = candles.findIndex(c => c.time === level.sweepTime);
    if (sweepCandleIdx < 1 || sweepCandleIdx >= candles.length - 2) continue;

    // Look for displacement in 1-5 candles after sweep
    for (let i = sweepCandleIdx + 1; i < Math.min(sweepCandleIdx + 6, candles.length - 1); i++) {
      const prev = candles[i - 1];
      const curr = candles[i];
      const next = candles[i + 1];

      if (level.type === 'HIGH') {
        // After sweeping a HIGH, we want bearish displacement
        const bearishBody = curr.open - curr.close;
        const isDisplacement = bearishBody > 0 && bearishBody / curr.open > 0.003;

        // Bearish FVG: prev.low > next.high
        if (isDisplacement && next.high < prev.low) {
          const fvgTop    = prev.low;
          const fvgBottom = next.high;
          const fvgSize   = (fvgTop - fvgBottom) / fvgBottom * 100;

          if (fvgSize >= fvgMinSizePct) {
            setups.push({
              sweep: level,
              displacementCandle: curr,
              fvgEntry: (fvgTop + fvgBottom) / 2,
              fvgTop, fvgBottom,
              stopLoss: level.price * 1.002, // just above sweep
              direction: 'SHORT',
              quality: calcSetupQuality(level, bearishBody / curr.open, fvgSize),
            });
          }
        }
      } else {
        // After sweeping a LOW, we want bullish displacement
        const bullishBody = curr.close - curr.open;
        const isDisplacement = bullishBody > 0 && bullishBody / curr.open > 0.003;

        // Bullish FVG: prev.high < next.low
        if (isDisplacement && next.low > prev.high) {
          const fvgTop    = next.low;
          const fvgBottom = prev.high;
          const fvgSize   = (fvgTop - fvgBottom) / fvgBottom * 100;

          if (fvgSize >= fvgMinSizePct) {
            setups.push({
              sweep: level,
              displacementCandle: curr,
              fvgEntry: (fvgTop + fvgBottom) / 2,
              fvgTop, fvgBottom,
              stopLoss: level.price * 0.998, // just below sweep
              direction: 'LONG',
              quality: calcSetupQuality(level, bullishBody / curr.open, fvgSize),
            });
          }
        }
      }
    }
  }

  return setups.sort((a, b) => b.quality - a.quality);
}

function calcSetupQuality(
  level: LiquidityLevel,
  displacementSize: number,
  fvgSize: number
): number {
  let score = level.strength * 0.4;
  score += Math.min(30, displacementSize * 3000); // bigger displacement = better
  score += Math.min(20, fvgSize * 40);            // bigger FVG = more room
  score += level.status === 'SWEPT' ? 10 : 0;
  return Math.min(100, Math.round(score));
}

// ─── LIQUIDITY MAGNET SCORING ──────────────────────────────────────────────────

/**
 * Scores how "magnetic" the nearest liquidity level is.
 * Higher score = price more likely to sweep that level soon.
 * Based on: distance, strength (test count), age, timeframe weight.
 */
export function scoreLiquidityMagnet(
  levels: LiquidityLevel[],
  currentPrice: number
): { level: LiquidityLevel; magnetScore: number }[] {
  const TF_WEIGHT: Record<Timeframe, number> = {
    '1w': 1.0, '1d': 0.85, '4h': 0.7, '1h': 0.6,
    '30m': 0.5, '15m': 0.45, '5m': 0.35, '3m': 0.3, '1m': 0.25,
  };

  return levels
    .filter(l => l.status === 'ACTIVE')
    .map(l => {
      const distPct = Math.abs(l.price - currentPrice) / currentPrice * 100;
      const distScore  = Math.max(0, 50 - distPct * 10); // closer = higher
      const tfScore    = (TF_WEIGHT[l.timeframe] ?? 0.3) * 30;
      const strScore   = l.strength * 0.2;
      const magnetScore = Math.min(100, distScore + tfScore + strScore);
      return { level: l, magnetScore };
    })
    .sort((a, b) => b.magnetScore - a.magnetScore);
}
