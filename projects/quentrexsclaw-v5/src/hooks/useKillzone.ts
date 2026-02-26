/**
 * hooks/useKillzone.ts + utils/backtest.ts
 * Killzone management (MMT timezone) and browser-based backtest engine.
 */

import { useState, useEffect, useRef } from 'react';
import type { Killzone, KillzoneName, Candle, Trade, BacktestConfig, BacktestResult, BacktestMetrics, Timeframe } from '../types';
import { detectSwings, detectMarketStructure, detectOrderBlocks, detectFVGs, calcPDArray } from '../utils/ict';
import { detectLiquiditySweeps, detectSweepFVGSetups } from '../utils/liquidity';
import { runStructureAgent, runLiquidityAgent, runArrayAgent, runRiskAgent, runExecutionAgent, runCouncil } from '../utils/agents';

// ─── KILLZONE DEFINITIONS (MMT = UTC+6:30) ────────────────────────────────────

export const KILLZONE_DEFS: Omit<Killzone, 'active' | 'minutesRemaining'>[] = [
  { name: 'AKZ',  label: 'Asian Killzone',     startH: 6,  startM: 30, endH: 10, endM: 0,  color: '#00ff41' },
  { name: 'LKZ',  label: 'London Killzone',    startH: 13, startM: 0,  endH: 17, endM: 0,  color: '#00cfff' },
  { name: 'NYKZ', label: 'New York Killzone',  startH: 18, startM: 15, endH: 22, endM: 15, color: '#ff9500' },
];

export function getMMTTime(date = new Date()): Date {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utcMs + 6.5 * 3600000); // UTC+6:30
}

export function getActiveKillzone(mmtTime: Date): Killzone | null {
  const h = mmtTime.getHours();
  const m = mmtTime.getMinutes();
  const totalMins = h * 60 + m;

  // Auto-flatten 22:05 MMT
  const FLATTEN_MINS = 22 * 60 + 5;

  for (const kz of KILLZONE_DEFS) {
    const startMins = kz.startH * 60 + kz.startM;
    const endMins   = kz.endH   * 60 + kz.endM;
    if (totalMins >= startMins && totalMins < Math.min(endMins, FLATTEN_MINS)) {
      const minutesRemaining = Math.min(endMins, FLATTEN_MINS) - totalMins;
      return { ...kz, active: true, minutesRemaining };
    }
  }
  return null;
}

// ─── KILLZONE HOOK ────────────────────────────────────────────────────────────

export function useKillzone() {
  const [mmtTime, setMmtTime] = useState(getMMTTime());
  const [killzone, setKillzone] = useState<Killzone | null>(getActiveKillzone(getMMTTime()));

  useEffect(() => {
    const t = setInterval(() => {
      const mmt = getMMTTime();
      setMmtTime(mmt);
      setKillzone(getActiveKillzone(mmt));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const mmtStr  = mmtTime.toLocaleTimeString('en-US', { hour12: false });
  const mmtDate = mmtTime.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  // Next killzone info
  const nextKZ = (() => {
    const totalMins = mmtTime.getHours() * 60 + mmtTime.getMinutes();
    for (const kz of KILLZONE_DEFS) {
      const start = kz.startH * 60 + kz.startM;
      if (start > totalMins) {
        const minsUntil = start - totalMins;
        return { ...kz, minsUntil };
      }
    }
    // Next is tomorrow's AKZ
    return { ...KILLZONE_DEFS[0], minsUntil: (24 * 60 - totalMins) + KILLZONE_DEFS[0].startH * 60 + KILLZONE_DEFS[0].startM };
  })();

  return { killzone, mmtTime, mmtStr, mmtDate, nextKZ };
}

// ─── BROWSER BACKTEST ENGINE ──────────────────────────────────────────────────

export async function runBacktest(
  candles: Candle[],
  config: BacktestConfig
): Promise<BacktestResult> {
  const trades: Trade[] = [];
  let balance = config.initialBalance;
  const timeframe = config.timeframe as Timeframe;

  // Minimum 100 candles needed for analysis
  if (candles.length < 100) throw new Error('Not enough candles for backtest');

  // Walk-forward: analyze from index 50 onward (warmup period)
  for (let i = 50; i < candles.length - 5; i++) {
    const slice = candles.slice(0, i + 1);
    const lastCandle = slice[slice.length - 1];

    // Check killzone (use candle time)
    const candleTime = new Date(lastCandle.time);
    const mmt = getMMTTime(candleTime);
    const kz = getActiveKillzone(mmt);
    if (!kz) continue; // Only trade in killzones

    // Don't over-analyze — check every 15 candles
    if (i % 15 !== 0) continue;

    // ICT analysis on the slice
    const swings = detectSwings(slice, 5, 5);
    const structure = detectMarketStructure(slice, swings);
    const obs = detectOrderBlocks(slice, structure, timeframe);
    const fvgs = detectFVGs(slice, timeframe);
    const pdArray = calcPDArray(swings, lastCandle.close);
    const levels = detectLiquiditySweeps(slice, timeframe, 5, 5);
    const setups = detectSweepFVGSetups(slice, levels, 0.03);

    if (setups.length === 0) continue;
    const setup = setups[0]; // Best setup

    const direction = setup.direction;
    const entry  = setup.fvgEntry;
    const sl     = setup.stopLoss;
    const atr    = lastCandle.close * 0.008;
    const tp1    = direction === 'LONG' ? entry + atr * 2.5 : entry - atr * 2.5;
    const tp2    = direction === 'LONG' ? entry + atr * 5.0 : entry - atr * 5.0;
    const rr     = Math.abs(tp1 - entry) / Math.abs(entry - sl);

    if (rr < 2) continue; // Enforce RR filter

    // Run agents
    const agents = [
      runStructureAgent(slice, structure, direction),
      runLiquidityAgent(levels, lastCandle.close, direction),
      runArrayAgent(obs, fvgs, pdArray, lastCandle.close, direction),
      runRiskAgent(kz, balance, 0, entry, sl, tp1, false),
      runExecutionAgent(slice, entry, sl, tp1, tp2, direction, setup.fvgEntry, null),
    ];
    const council = runCouncil(agents);

    if (council.grade !== 'A+' && council.grade !== 'A') continue;

    // Simulate trade outcome on future candles
    const riskAmt = balance * config.riskPerTrade / 100;
    const posSize = riskAmt / Math.abs(entry - sl);
    let outcome: 'TP1_HIT' | 'TP2_HIT' | 'SL_HIT' = 'SL_HIT';
    let exitPrice = sl;

    for (let j = i + 1; j < Math.min(i + 50, candles.length); j++) {
      const fc = candles[j];
      if (direction === 'LONG') {
        if (fc.high >= tp2) { outcome = 'TP2_HIT'; exitPrice = tp2; break; }
        if (fc.high >= tp1) { outcome = 'TP1_HIT'; exitPrice = tp1; break; }
        if (fc.low  <= sl)  { outcome = 'SL_HIT';  exitPrice = sl;  break; }
      } else {
        if (fc.low  <= tp2) { outcome = 'TP2_HIT'; exitPrice = tp2; break; }
        if (fc.low  <= tp1) { outcome = 'TP1_HIT'; exitPrice = tp1; break; }
        if (fc.high >= sl)  { outcome = 'SL_HIT';  exitPrice = sl;  break; }
      }
    }

    const pnl = direction === 'LONG'
      ? (exitPrice - entry) * posSize
      : (entry - exitPrice) * posSize;
    const pnlPct = pnl / balance * 100;

    balance += pnl;

    trades.push({
      id: `bt_${lastCandle.time}`,
      timestamp: lastCandle.time,
      pair: config.pair,
      timeframe,
      direction,
      setupType: 'LIQUIDITY_SWEEP_FVG',
      grade: council.grade,
      entry, stopLoss: sl, tp1, tp2,
      rr: parseFloat(rr.toFixed(2)),
      riskPercent: config.riskPerTrade,
      killzone: kz.name,
      council,
      notes: `Backtest: ${outcome}`,
      status: outcome,
      executedAt: lastCandle.time,
      executedPrice: entry,
      positionSize: posSize,
      pnl, pnlPercent: pnlPct,
      closedAt: lastCandle.time,
      closePrice: exitPrice,
      mode: 'SIMULATE',
    } as Trade);

    // Skip forward to avoid overlapping trades
    i += 20;
  }

  return {
    config,
    trades,
    metrics: calcMetrics(trades, config),
  };
}

function calcMetrics(trades: Trade[], config: BacktestConfig): BacktestMetrics {
  const wins = trades.filter(t => (t.pnl ?? 0) > 0);
  const losses = trades.filter(t => (t.pnl ?? 0) <= 0);

  const grossWin  = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));

  const pnlArr = trades.map(t => t.pnl ?? 0);
  const totalPnl = pnlArr.reduce((s, p) => s + p, 0);
  const avgPnl = totalPnl / (trades.length || 1);
  const stdDev = Math.sqrt(pnlArr.map(p => (p - avgPnl) ** 2).reduce((s, v) => s + v, 0) / (trades.length || 1));

  // Max drawdown
  let peak = config.initialBalance, dd = 0, maxDD = 0;
  let bal = config.initialBalance;
  for (const t of trades) {
    bal += t.pnl ?? 0;
    if (bal > peak) peak = bal;
    dd = peak - bal;
    if (dd > maxDD) maxDD = dd;
  }

  const byKillzone: BacktestMetrics['byKillzone'] = {
    AKZ:  { trades: 0, wins: 0, pnl: 0 },
    LKZ:  { trades: 0, wins: 0, pnl: 0 },
    NYKZ: { trades: 0, wins: 0, pnl: 0 },
    IDLE: { trades: 0, wins: 0, pnl: 0 },
  };
  for (const t of trades) {
    const kz = byKillzone[t.killzone];
    kz.trades++;
    if ((t.pnl ?? 0) > 0) kz.wins++;
    kz.pnl += t.pnl ?? 0;
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    sharpeRatio: stdDev > 0 ? avgPnl / stdDev * Math.sqrt(252) : 0,
    maxDrawdown: maxDD,
    maxDrawdownPct: config.initialBalance > 0 ? maxDD / config.initialBalance * 100 : 0,
    totalPnl,
    totalPnlPct: config.initialBalance > 0 ? totalPnl / config.initialBalance * 100 : 0,
    avgRR: trades.length ? trades.reduce((s, t) => s + t.rr, 0) / trades.length : 0,
    bestTrade:  Math.max(...pnlArr, 0),
    worstTrade: Math.min(...pnlArr, 0),
    byKillzone,
  };
}
