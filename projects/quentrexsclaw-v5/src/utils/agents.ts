/**
 * utils/agents.ts
 * 5-Agent Rule-Based Council — zero API cost, zero backend needed.
 * Each agent scores 0-100 based on pure ICT logic.
 * Consensus = weighted sum → A+(90+), A(80-89), B/C blocked.
 */

import type {
  Candle, AgentSignal, AgentCouncil, SetupGrade, TradeDirection,
  LiquidityLevel, OrderBlock, FairValueGap, PDArray, Killzone,
  StructurePoint
} from '../types';
import { pdScore, countNearbyOBs, nearestFVG } from './ict';
import { scoreLiquidityMagnet } from './liquidity';

// ─── AGENT WEIGHTS ────────────────────────────────────────────────────────────

const WEIGHTS = {
  STRUCTURE:  0.25,
  LIQUIDITY:  0.25,
  ARRAY:      0.20,
  RISK:       0.15,
  EXECUTION:  0.15,
};

// ─── AGENT 1: STRUCTURE ANALYST ───────────────────────────────────────────────

/**
 * Scores based on:
 * - Recent BOS/CHoCH direction alignment
 * - MSS confirmation
 * - HTF vs LTF structure agreement
 * - Number of confirmed structure points
 */
export function runStructureAgent(
  candles: Candle[],
  structurePoints: StructurePoint[],
  direction: 'LONG' | 'SHORT'
): AgentSignal {
  const details: string[] = [];
  let score = 0;
  const recent = structurePoints.slice(-8);

  // Count aligned structure points
  const aligned = recent.filter(sp => {
    if (direction === 'LONG')  return sp.type.includes('BULL');
    if (direction === 'SHORT') return sp.type.includes('BEAR');
    return false;
  });
  const alignedScore = Math.min(40, aligned.length * 12);
  score += alignedScore;
  details.push(`${aligned.length} aligned structure points (+${alignedScore})`);

  // Most recent structure agrees?
  const lastSP = recent[recent.length - 1];
  if (lastSP) {
    const lastAligned = direction === 'LONG'
      ? lastSP.type.includes('BULL')
      : lastSP.type.includes('BEAR');
    if (lastAligned) { score += 20; details.push('Latest structure aligned (+20)'); }
    else { score -= 10; details.push('Latest structure OPPOSED (-10)'); }
  }

  // CHoCH present? (higher quality)
  const hasChoCH = recent.some(sp => sp.type.includes('CHoCH'));
  if (hasChoCH) { score += 15; details.push('CHoCH confirmed (+15)'); }

  // Confirmed (closed beyond level)?
  const confirmed = recent.filter(sp => sp.confirmed && (
    direction === 'LONG' ? sp.type.includes('BULL') : sp.type.includes('BEAR')
  ));
  if (confirmed.length > 0) { score += 15; details.push(`${confirmed.length} confirmed BOS (+15)`); }

  // Price momentum (last 5 candles)
  const last5 = candles.slice(-5);
  const bullish5 = last5.filter(c => c.close > c.open).length;
  if (direction === 'LONG' && bullish5 >= 3) { score += 10; details.push('Bullish momentum (+10)'); }
  if (direction === 'SHORT' && bullish5 <= 2) { score += 10; details.push('Bearish momentum (+10)'); }

  score = Math.max(0, Math.min(100, score));

  return {
    agent: 'STRUCTURE',
    score,
    label: 'Structure Analyst',
    details,
    bullish: direction === 'LONG',
    weight: WEIGHTS.STRUCTURE,
    reasoning: `Market structure ${score >= 70 ? 'STRONGLY' : score >= 50 ? 'MODERATELY' : 'WEAKLY'} supports ${direction}`,
  };
}

// ─── AGENT 2: LIQUIDITY DETECTOR ──────────────────────────────────────────────

/**
 * Scores based on:
 * - Recent sweep quality (HTF sweep > LTF sweep)
 * - Direction of sweep relative to setup (sweep LOW = long setup)
 * - Liquidity magnets above/below
 * - Sweep + displacement confirmation
 */
export function runLiquidityAgent(
  levels: LiquidityLevel[],
  currentPrice: number,
  direction: 'LONG' | 'SHORT'
): AgentSignal {
  const details: string[] = [];
  let score = 0;

  // Recent sweeps in the right direction
  const recentSweeps = levels
    .filter(l => l.status === 'SWEPT')
    .slice(-10);

  const alignedSweeps = recentSweeps.filter(l =>
    direction === 'LONG' ? l.type === 'LOW' : l.type === 'HIGH'
  );

  if (alignedSweeps.length > 0) {
    const qualityScore = Math.min(40, alignedSweeps.reduce((s, l) => s + l.strength, 0) / alignedSweeps.length * 0.4);
    score += qualityScore;
    details.push(`${alignedSweeps.length} aligned sweeps (+${qualityScore.toFixed(0)})`);
  } else {
    details.push('No aligned sweeps detected');
  }

  // HTF sweeps carry more weight
  const htfSweeps = alignedSweeps.filter(l =>
    ['4h', '1d', '1w'].includes(l.timeframe)
  );
  if (htfSweeps.length > 0) { score += 25; details.push(`HTF sweep on ${htfSweeps[0].timeframe} (+25)`); }

  // Nearest active levels as magnets
  const magnets = scoreLiquidityMagnet(levels, currentPrice);
  const topMagnet = magnets[0];
  if (topMagnet && topMagnet.magnetScore > 60) {
    const isAligned = direction === 'LONG'
      ? topMagnet.level.type === 'HIGH'   // target above = long
      : topMagnet.level.type === 'LOW';   // target below = short
    if (isAligned) {
      score += 20;
      details.push(`Strong liquidity magnet @ ${topMagnet.level.price.toFixed(3)} (+20)`);
    }
  }

  // No sweep yet = reduced score (waiting for confirmation)
  if (alignedSweeps.length === 0) { score -= 20; }

  score = Math.max(0, Math.min(100, score));

  return {
    agent: 'LIQUIDITY',
    score,
    label: 'Liquidity Detector',
    details,
    bullish: direction === 'LONG',
    weight: WEIGHTS.LIQUIDITY,
    reasoning: `Liquidity ${score >= 70 ? 'STRONGLY' : score >= 50 ? 'MODERATELY' : 'NOT'} supports ${direction}`,
  };
}

// ─── AGENT 3: ARRAY SPECIALIST ────────────────────────────────────────────────

/**
 * Scores based on:
 * - Nearest unmitigated OB quality and proximity
 * - FVG freshness and size
 * - BPR presence
 * - PD array positioning (discount/premium)
 */
export function runArrayAgent(
  orderBlocks: OrderBlock[],
  fvgs: FairValueGap[],
  pdArray: PDArray | null,
  currentPrice: number,
  direction: 'LONG' | 'SHORT'
): AgentSignal {
  const details: string[] = [];
  let score = 0;

  // Nearby OB check
  const nearbyOBs = countNearbyOBs(orderBlocks, currentPrice, 1.5);
  const relevantOBs = direction === 'LONG' ? nearbyOBs.bullish : nearbyOBs.bearish;
  if (relevantOBs > 0) {
    score += Math.min(30, relevantOBs * 15);
    details.push(`${relevantOBs} ${direction === 'LONG' ? 'Bullish' : 'Bearish'} OB nearby (+${Math.min(30, relevantOBs * 15)})`);
  }

  // FVG check
  const fvg = nearestFVG(fvgs, currentPrice, 2.0);
  if (fvg && !fvg.filled) {
    const aligned = direction === 'LONG' ? fvg.type === 'BULLISH' : fvg.type === 'BEARISH';
    if (aligned) {
      score += 25;
      details.push(`Unfilled ${fvg.type} FVG @ ${fvg.midpoint.toFixed(3)} (+25)`);
    }
    // Partially filled FVG (price approaching)
    if (fvg.fillPercent > 30 && fvg.fillPercent < 60) {
      score += 10;
      details.push(`FVG 50% filled — optimal entry zone (+10)`);
    }
  }

  // PD array positioning
  if (pdArray) {
    const pds = pdScore(pdArray, currentPrice);
    if (direction === 'LONG' && pds > 70) {
      score += 25;
      details.push(`Price in Discount zone (${pds.toFixed(0)}% deep) (+25)`);
    } else if (direction === 'SHORT' && pds < 30) {
      score += 25;
      details.push(`Price in Premium zone (+25)`);
    } else if ((direction === 'LONG' && pds > 50) || (direction === 'SHORT' && pds < 50)) {
      score += 10;
      details.push(`Price approaching optimal PD zone (+10)`);
    }
  }

  // OB quality bonus
  const bestOB = orderBlocks
    .filter(ob => !ob.mitigated && ob.type === (direction === 'LONG' ? 'BULLISH' : 'BEARISH'))
    .sort((a, b) => b.strength - a.strength)[0];
  if (bestOB && bestOB.strength > 70) {
    score += 10;
    details.push(`High-strength OB (${bestOB.strength}/100) (+10)`);
  }

  score = Math.max(0, Math.min(100, score));

  return {
    agent: 'ARRAY',
    score,
    label: 'Array Specialist',
    details,
    bullish: direction === 'LONG',
    weight: WEIGHTS.ARRAY,
    reasoning: `PD Arrays ${score >= 70 ? 'HIGHLY CONFLUENT' : score >= 50 ? 'MODERATE' : 'WEAK'} for ${direction}`,
  };
}

// ─── AGENT 4: RISK GUARDIAN ───────────────────────────────────────────────────

/**
 * Hard gates + soft scores:
 * - Is killzone ACTIVE? (hard gate — score 0 if inactive)
 * - Is balance above $30? (hard gate)
 * - Are news events in next 30m? (reduce score)
 * - Max 2 trades per session?
 * - Is RR achievable (>2:1)?
 */
export function runRiskAgent(
  killzone: Killzone | null,
  balance: number,
  tradesThisSession: number,
  entryPrice: number,
  stopLoss: number,
  tp1: number,
  newsInWindow: boolean
): AgentSignal {
  const details: string[] = [];
  let score = 0;
  let blocked = false;

  // Hard gate: balance
  if (balance < 30) {
    blocked = true;
    details.push('❌ Balance < $30 — HALTED');
  }

  // Hard gate: max trades
  if (tradesThisSession >= 2) {
    blocked = true;
    details.push('❌ Max 2 trades/session reached');
  }

  if (blocked) {
    return { agent: 'RISK', score: 0, label: 'Risk Guardian', details, bullish: false, weight: WEIGHTS.RISK, reasoning: 'BLOCKED by hard risk gate' };
  }

  // Killzone check (not a hard block but heavily weighted)
  if (killzone && killzone.active) {
    score += 40;
    details.push(`✅ ${killzone.name} ACTIVE — killzone confirmed (+40)`);
    // Bonus for NYKZ (highest volume)
    if (killzone.name === 'NYKZ') { score += 10; details.push('NYKZ bonus (+10)'); }
    // Caution near killzone end
    if ((killzone.minutesRemaining ?? 999) < 15) {
      score -= 15;
      details.push(`⚠ Only ${killzone.minutesRemaining}m left in killzone (-15)`);
    }
  } else {
    score -= 30;
    details.push('⚠ Outside killzone — reduced confidence (-30)');
  }

  // RR check
  const rr = Math.abs(tp1 - entryPrice) / Math.abs(entryPrice - stopLoss);
  if (rr >= 3) { score += 25; details.push(`RR ${rr.toFixed(1)}:1 excellent (+25)`); }
  else if (rr >= 2) { score += 15; details.push(`RR ${rr.toFixed(1)}:1 good (+15)`); }
  else { score -= 20; details.push(`RR ${rr.toFixed(1)}:1 below minimum (-20)`); }

  // News penalty
  if (newsInWindow) { score -= 20; details.push('⚠ High-impact news nearby (-20)'); }

  // Session count bonus for first trade
  if (tradesThisSession === 0) { score += 10; details.push('First trade of session (+10)'); }

  score = Math.max(0, Math.min(100, score));

  return {
    agent: 'RISK',
    score,
    label: 'Risk Guardian',
    details,
    bullish: score > 50,
    weight: WEIGHTS.RISK,
    reasoning: `Risk score ${score}/100 — ${score >= 70 ? 'CLEARED' : score >= 50 ? 'CAUTION' : 'HIGH RISK'}`,
  };
}

// ─── AGENT 5: EXECUTION OPTIMIZER ────────────────────────────────────────────

/**
 * Scores the quality of the specific entry mechanics:
 * - Is entry at FVG 50% or OB edge? (optimal)
 * - Is SL beyond sweep extreme?
 * - Are TPs at next liquidity pool?
 * - Spread/slippage consideration
 */
export function runExecutionAgent(
  candles: Candle[],
  entryPrice: number,
  stopLoss: number,
  tp1: number,
  tp2: number,
  direction: 'LONG' | 'SHORT',
  fvgMidpoint: number | null,
  obEdge: number | null
): AgentSignal {
  const details: string[] = [];
  let score = 0;

  // Entry precision
  if (fvgMidpoint !== null) {
    const distFromFVG = Math.abs(entryPrice - fvgMidpoint) / entryPrice * 100;
    if (distFromFVG < 0.1) { score += 30; details.push(`Entry AT FVG 50% (+30)`); }
    else if (distFromFVG < 0.3) { score += 20; details.push(`Entry near FVG 50% (+20)`); }
    else { score += 10; details.push(`Entry within FVG (+10)`); }
  } else if (obEdge !== null) {
    const distFromOB = Math.abs(entryPrice - obEdge) / entryPrice * 100;
    if (distFromOB < 0.2) { score += 25; details.push(`Entry at OB edge (+25)`); }
    else { score += 10; details.push(`Entry near OB (+10)`); }
  }

  // SL placement
  const slPct = Math.abs(entryPrice - stopLoss) / entryPrice * 100;
  if (slPct >= 0.5 && slPct <= 1.5) {
    score += 20;
    details.push(`SL placement ideal (${slPct.toFixed(2)}%) (+20)`);
  } else if (slPct < 0.3) {
    score -= 15;
    details.push(`SL too tight (${slPct.toFixed(2)}%) — risk of stop hunt (-15)`);
  } else if (slPct > 2.5) {
    score -= 10;
    details.push(`SL wide (${slPct.toFixed(2)}%) — reduces RR (-10)`);
  }

  // RR quality
  const rr1 = Math.abs(tp1 - entryPrice) / Math.abs(entryPrice - stopLoss);
  const rr2 = Math.abs(tp2 - entryPrice) / Math.abs(entryPrice - stopLoss);
  if (rr1 >= 2) { score += 20; details.push(`TP1 RR ${rr1.toFixed(1)}:1 (+20)`); }
  if (rr2 >= 3) { score += 15; details.push(`TP2 RR ${rr2.toFixed(1)}:1 (+15)`); }

  // Candle momentum confirmation (last 3 candles)
  const last3 = candles.slice(-3);
  const momentum = last3.filter(c =>
    direction === 'LONG' ? c.close > c.open : c.close < c.open
  ).length;
  if (momentum >= 2) { score += 15; details.push(`Momentum confirmed (${momentum}/3 candles) (+15)`); }

  score = Math.max(0, Math.min(100, score));

  return {
    agent: 'EXECUTION',
    score,
    label: 'Execution Optimizer',
    details,
    bullish: direction === 'LONG',
    weight: WEIGHTS.EXECUTION,
    reasoning: `Entry mechanics ${score >= 70 ? 'OPTIMAL' : score >= 50 ? 'ACCEPTABLE' : 'SUBOPTIMAL'}`,
  };
}

// ─── COUNCIL CONSENSUS ────────────────────────────────────────────────────────

export function runCouncil(agents: AgentSignal[]): AgentCouncil {
  // Weighted average
  const totalWeight = agents.reduce((s, a) => s + a.weight, 0);
  const consensusScore = agents.reduce((s, a) => s + a.score * a.weight, 0) / totalWeight;

  // Grade
  const grade: SetupGrade =
    consensusScore >= 90 ? 'A+' :
    consensusScore >= 80 ? 'A'  :
    consensusScore >= 65 ? 'B'  : 'C';

  // Direction by majority
  const bullishVotes = agents.filter(a => a.bullish).reduce((s, a) => s + a.weight, 0);
  const direction: TradeDirection | null =
    bullishVotes > 0.6 ? 'LONG' :
    bullishVotes < 0.4 ? 'SHORT' : null;

  return {
    agents,
    consensusScore: Math.round(consensusScore),
    grade,
    direction,
    timestamp: Date.now(),
  };
}

// ─── GRADE COLOR ─────────────────────────────────────────────────────────────

export function gradeColor(grade: SetupGrade): string {
  return grade === 'A+' ? '#00ff41' : grade === 'A' ? '#00cfff' : '#666';
}

export function scoreColor(score: number): string {
  if (score >= 80) return '#00ff41';
  if (score >= 65) return '#00cfff';
  if (score >= 50) return '#f7931a';
  return '#ff0055';
}
