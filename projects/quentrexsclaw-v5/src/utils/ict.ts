/**
 * utils/ict.ts
 * Core ICT/SMC analysis engine — pure functions, no side effects.
 * All inputs are OHLCV arrays, all outputs are typed structs.
 */

import type {
  Candle, SwingPoint, StructurePoint, OrderBlock, FairValueGap,
  PDArray, SwingType, Timeframe
} from '../types';

// ─── SWING DETECTION (equivalent to ta.pivothigh / ta.pivotlow) ───────────────

/**
 * Find pivot high/low points using a left/right lookback window.
 * Higher leftLen = more significant swings (fewer but stronger).
 */
export function detectSwings(
  candles: Candle[],
  leftLen = 5,
  rightLen = 5
): SwingPoint[] {
  const swings: SwingPoint[] = [];

  for (let i = leftLen; i < candles.length - rightLen; i++) {
    const c = candles[i];

    // Pivot High: highest high in [i-left..i+right]
    let isHigh = true;
    for (let j = i - leftLen; j <= i + rightLen; j++) {
      if (j !== i && candles[j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) swings.push({ index: i, time: c.time, price: c.high, type: 'HIGH' });

    // Pivot Low: lowest low in [i-left..i+right]
    let isLow = true;
    for (let j = i - leftLen; j <= i + rightLen; j++) {
      if (j !== i && candles[j].low <= c.low) { isLow = false; break; }
    }
    if (isLow) swings.push({ index: i, time: c.time, price: c.low, type: 'LOW' });
  }

  return swings.sort((a, b) => a.index - b.index);
}

// ─── MARKET STRUCTURE (BOS / CHoCH / MSS) ────────────────────────────────────

/**
 * Detects Break of Structure, Change of Character, Market Structure Shift.
 *
 * BOS:  Price breaks a swing in the SAME direction as current trend (continuation)
 * CHoCH: Price breaks a swing in the OPPOSITE direction (first warning of reversal)
 * MSS:  CHoCH confirmed by close beyond the level (stronger reversal signal)
 */
export function detectMarketStructure(
  candles: Candle[],
  swings: SwingPoint[]
): StructurePoint[] {
  const points: StructurePoint[] = [];
  if (swings.length < 4) return points;

  // Determine trend from first few swings
  let trend: 'UP' | 'DOWN' = swings[0].type === 'LOW' ? 'UP' : 'DOWN';
  let lastHigh = swings.find(s => s.type === 'HIGH');
  let lastLow  = swings.find(s => s.type === 'LOW');

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];

    // Check BOS / CHoCH vs last swing HIGH
    if (lastHigh) {
      if (candle.high > lastHigh.price) {
        const isBOS = trend === 'UP';
        points.push({
          time: candle.time,
          price: lastHigh.price,
          type: isBOS ? 'BOS_BULL' : 'CHoCH_BULL',
          confirmed: candle.close > lastHigh.price,
          candle,
        });
        if (!isBOS) trend = 'UP'; // CHoCH flips trend
        lastHigh = swings.filter(s => s.type === 'HIGH' && s.index <= i)
          .sort((a, b) => b.index - a.index)[0];
      }
    }

    // Check BOS / CHoCH vs last swing LOW
    if (lastLow) {
      if (candle.low < lastLow.price) {
        const isBOS = trend === 'DOWN';
        points.push({
          time: candle.time,
          price: lastLow.price,
          type: isBOS ? 'BOS_BEAR' : 'CHoCH_BEAR',
          confirmed: candle.close < lastLow.price,
          candle,
        });
        if (!isBOS) trend = 'DOWN';
        lastLow = swings.filter(s => s.type === 'LOW' && s.index <= i)
          .sort((a, b) => b.index - a.index)[0];
      }
    }
  }

  return points;
}

// ─── ORDER BLOCK DETECTION ────────────────────────────────────────────────────

/**
 * Bullish OB: Last bearish candle before a bullish BOS / impulse move up.
 * Bearish OB: Last bullish candle before a bearish BOS / impulse move down.
 *
 * Strength increases with:
 * - High volume on OB candle
 * - Strong move away from OB (gap, impulse)
 * - OB on higher timeframe
 */
export function detectOrderBlocks(
  candles: Candle[],
  structurePoints: StructurePoint[],
  timeframe: Timeframe
): OrderBlock[] {
  const blocks: OrderBlock[] = [];
  const avgVol = candles.reduce((s, c) => s + c.volume, 0) / candles.length;

  for (const sp of structurePoints) {
    const spIdx = candles.findIndex(c => c.time >= sp.time);
    if (spIdx < 3) continue;

    if (sp.type === 'BOS_BULL' || sp.type === 'CHoCH_BULL') {
      // Find last bearish candle before structure break
      for (let j = spIdx - 1; j >= Math.max(0, spIdx - 20); j--) {
        const c = candles[j];
        if (c.close < c.open) { // bearish candle
          const volStrength = Math.min(100, (c.volume / avgVol) * 50);
          const moveStrength = Math.min(50, ((sp.price - c.high) / c.high) * 1000);
          blocks.push({
            id: `ob_bull_${c.time}`,
            type: 'BULLISH',
            top: c.open,      // OB range = from open to low of bearish candle
            bottom: c.low,
            time: c.time,
            mitigated: false,
            volume: c.volume,
            strength: Math.round(volStrength + moveStrength),
            timeframe,
          });
          break;
        }
      }
    }

    if (sp.type === 'BOS_BEAR' || sp.type === 'CHoCH_BEAR') {
      for (let j = spIdx - 1; j >= Math.max(0, spIdx - 20); j--) {
        const c = candles[j];
        if (c.close > c.open) { // bullish candle
          const volStrength = Math.min(100, (c.volume / avgVol) * 50);
          const moveStrength = Math.min(50, ((c.low - sp.price) / c.low) * 1000);
          blocks.push({
            id: `ob_bear_${c.time}`,
            type: 'BEARISH',
            top: c.high,
            bottom: c.open,   // OB range = from open to high of bullish candle
            time: c.time,
            mitigated: false,
            volume: c.volume,
            strength: Math.round(volStrength + moveStrength),
            timeframe,
          });
          break;
        }
      }
    }
  }

  // Check mitigation: price has traded through the OB
  for (const ob of blocks) {
    const obIdx = candles.findIndex(c => c.time >= ob.time);
    for (let i = obIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      if (ob.type === 'BULLISH' && c.low <= ob.bottom) {
        ob.mitigated = true; ob.mitigationTime = c.time; break;
      }
      if (ob.type === 'BEARISH' && c.high >= ob.top) {
        ob.mitigated = true; ob.mitigationTime = c.time; break;
      }
    }
  }

  return blocks.filter(b => b.strength > 20); // filter weak blocks
}

// ─── FAIR VALUE GAP (FVG) ─────────────────────────────────────────────────────

/**
 * FVG = 3-candle imbalance where candle[i-1].high < candle[i+1].low (bullish)
 * or candle[i-1].low > candle[i+1].high (bearish)
 */
export function detectFVGs(
  candles: Candle[],
  timeframe: Timeframe,
  minSizePercent = 0.05
): FairValueGap[] {
  const fvgs: FairValueGap[] = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish FVG: gap between prev.high and next.low
    if (next.low > prev.high) {
      const gapSize = (next.low - prev.high) / prev.high * 100;
      if (gapSize >= minSizePercent) {
        const top = next.low;
        const bottom = prev.high;
        const mid = (top + bottom) / 2;
        fvgs.push({
          id: `fvg_bull_${curr.time}`,
          type: 'BULLISH',
          top, bottom, midpoint: mid,
          time: curr.time,
          filled: false,
          fillPercent: 0,
          timeframe,
        });
      }
    }

    // Bearish FVG: gap between prev.low and next.high
    if (next.high < prev.low) {
      const gapSize = (prev.low - next.high) / prev.low * 100;
      if (gapSize >= minSizePercent) {
        const top = prev.low;
        const bottom = next.high;
        const mid = (top + bottom) / 2;
        fvgs.push({
          id: `fvg_bear_${curr.time}`,
          type: 'BEARISH',
          top, bottom, midpoint: mid,
          time: curr.time,
          filled: false,
          fillPercent: 0,
          timeframe,
        });
      }
    }
  }

  // Track fill status
  for (const fvg of fvgs) {
    const fvgIdx = candles.findIndex(c => c.time >= fvg.time);
    for (let i = fvgIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      if (fvg.type === 'BULLISH') {
        if (c.low <= fvg.top) {
          const penetration = Math.min(fvg.top - c.low, fvg.top - fvg.bottom);
          fvg.fillPercent = (penetration / (fvg.top - fvg.bottom)) * 100;
          if (c.low <= fvg.bottom) { fvg.filled = true; fvg.fillPercent = 100; break; }
        }
      } else {
        if (c.high >= fvg.bottom) {
          const penetration = Math.min(c.high - fvg.bottom, fvg.top - fvg.bottom);
          fvg.fillPercent = (penetration / (fvg.top - fvg.bottom)) * 100;
          if (c.high >= fvg.top) { fvg.filled = true; fvg.fillPercent = 100; break; }
        }
      }
    }
  }

  return fvgs;
}

// ─── PD ARRAY / PREMIUM-DISCOUNT ─────────────────────────────────────────────

/**
 * Premium/Discount zones based on Fibonacci levels of the last swing range.
 * Price in Premium = sell bias. Price in Discount = buy bias.
 */
export function calcPDArray(swings: SwingPoint[], currentPrice: number): PDArray | null {
  const highs = swings.filter(s => s.type === 'HIGH').slice(-3);
  const lows  = swings.filter(s => s.type === 'LOW').slice(-3);
  if (!highs.length || !lows.length) return null;

  const high = Math.max(...highs.map(s => s.price));
  const low  = Math.min(...lows.map(s => s.price));
  const range = high - low;

  return {
    high, low,
    premium: low + range * 0.618,
    equilibrium: low + range * 0.5,
    discount: low + range * 0.382,
    type: currentPrice > (low + range * 0.5) ? 'BEARISH' : 'BULLISH',
    strength: Math.min(100, (range / currentPrice) * 10000),
  };
}

// ─── BREAKER BLOCK ────────────────────────────────────────────────────────────

/**
 * A Breaker Block is an OB that has been MITIGATED (swept) and then
 * price returned to it — now it acts as the opposite bias.
 * Bullish OB that got swept → becomes Bearish Breaker (and vice versa)
 */
export function detectBreakerBlocks(
  orderBlocks: OrderBlock[],
  candles: Candle[]
): OrderBlock[] {
  return orderBlocks
    .filter(ob => ob.mitigated)
    .map(ob => ({
      ...ob,
      id: `brk_${ob.id}`,
      type: ob.type === 'BULLISH' ? 'BEARISH' as const : 'BULLISH' as const,
      strength: ob.strength + 20, // breakers are stronger than OBs
    }));
}

// ─── BALANCED PRICE RANGE (BPR) ───────────────────────────────────────────────

/**
 * BPR = overlap between a bullish FVG and bearish FVG on different timeframes.
 * High confluence zone — price tends to react strongly.
 */
export function detectBPR(
  bullFVGs: FairValueGap[],
  bearFVGs: FairValueGap[]
): Array<{ top: number; bottom: number; time: number; strength: number }> {
  const bprs: Array<{ top: number; bottom: number; time: number; strength: number }> = [];

  for (const bull of bullFVGs.filter(f => !f.filled)) {
    for (const bear of bearFVGs.filter(f => !f.filled)) {
      const overlapTop    = Math.min(bull.top, bear.top);
      const overlapBottom = Math.max(bull.bottom, bear.bottom);
      if (overlapTop > overlapBottom) {
        const overlapSize = (overlapTop - overlapBottom) / overlapBottom * 100;
        bprs.push({
          top: overlapTop,
          bottom: overlapBottom,
          time: Math.max(bull.time, bear.time),
          strength: Math.min(100, overlapSize * 20),
        });
      }
    }
  }

  return bprs.sort((a, b) => b.strength - a.strength);
}

// ─── SCORING HELPERS ──────────────────────────────────────────────────────────

/** Rate where price is relative to a PD array: 0=premium, 50=eq, 100=discount */
export function pdScore(pd: PDArray, price: number): number {
  if (price >= pd.premium) return 0;    // overpriced, sell bias
  if (price <= pd.discount) return 100; // cheap, buy bias
  // linear interpolation between discount and premium
  return ((pd.premium - price) / (pd.premium - pd.discount)) * 100;
}

/** How many unmitigated OBs are stacked near current price (within pct%) */
export function countNearbyOBs(
  obs: OrderBlock[],
  price: number,
  pctRange = 1.0
): { bullish: number; bearish: number } {
  const range = price * pctRange / 100;
  return {
    bullish: obs.filter(ob => !ob.mitigated && ob.type === 'BULLISH' && Math.abs(ob.top - price) < range).length,
    bearish: obs.filter(ob => !ob.mitigated && ob.type === 'BEARISH' && Math.abs(ob.bottom - price) < range).length,
  };
}

/** Returns the most recent unmitigated FVG near price */
export function nearestFVG(
  fvgs: FairValueGap[],
  price: number,
  pctRange = 2.0
): FairValueGap | null {
  const range = price * pctRange / 100;
  const nearby = fvgs
    .filter(f => !f.filled && Math.abs(f.midpoint - price) < range)
    .sort((a, b) => b.time - a.time);
  return nearby[0] ?? null;
}
