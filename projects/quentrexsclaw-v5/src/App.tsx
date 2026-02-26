/**
 * QuentrexClaw v5.1 — Main App
 * Zero-cost ICT/SMC trading system. Browser-only. No backend.
 * Real-time Binance Futures WebSocket + rule-based 5-agent council.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { Trade, Signal, SetupGrade, AgentName, Timeframe, BacktestResult } from './types';
import { useMarketData } from './hooks/useMarketData';
import { useKillzone } from './hooks/useKillzone';
import {
  detectSwings, detectMarketStructure, detectOrderBlocks,
  detectFVGs, calcPDArray,
} from './utils/ict';
import { detectLiquiditySweeps, detectSweepFVGSetups } from './utils/liquidity';
import {
  runStructureAgent, runLiquidityAgent, runArrayAgent,
  runRiskAgent, runExecutionAgent, runCouncil,
  gradeColor, scoreColor,
} from './utils/agents';
import { runBacktest } from './hooks/useKillzone';

// ─── PAIRS ───────────────────────────────────────────────────────────────────

const PAIRS = [
  { symbol: 'SOLUSDT',  label: 'SOL',  color: '#9945ff' },
  { symbol: 'BTCUSDT',  label: 'BTC',  color: '#f7931a' },
  { symbol: 'ETHUSDT',  label: 'ETH',  color: '#627eea' },
  { symbol: 'DOGEUSDT', label: 'DOGE', color: '#c3a634' },
  { symbol: 'XRPUSDT',  label: 'XRP',  color: '#00aae4' },
  { symbol: 'BNBUSDT',  label: 'BNB',  color: '#f3ba2f' },
  { symbol: 'HYPEUSDT', label: 'HYPE', color: '#00ff41' },
  { symbol: 'SUIUSDT',  label: 'SUI',  color: '#4da2ff' },
  { symbol: 'AVAXUSDT', label: 'AVAX', color: '#e84142' },
  { symbol: 'LINKUSDT', label: 'LINK', color: '#2a5ada' },
  { symbol: 'ADAUSDT',  label: 'ADA',  color: '#0099ff' },
  { symbol: 'LTCUSDT',  label: 'LTC',  color: '#a8a8a8' },
  { symbol: 'WIFUSDT',  label: 'WIF',  color: '#ff8c42' },
  { symbol: 'PEPEUSDT', label: 'PEPE', color: '#4caf50' },
  { symbol: 'DOTUSDT',  label: 'DOT',  color: '#e6007a' },
];

const TIMEFRAMES: Timeframe[] = ['1m','5m','15m','1h','4h'];
const TABS = ['DASHBOARD','SIGNAL','AGENTS','BACKTEST','JOURNAL','TERMINAL'] as const;
type TabName = typeof TABS[number];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const fp = (v: number | undefined | null, d = 3): string => {
  if (v == null || isNaN(v)) return '—';
  if (v >= 10000) return v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (v >= 100)   return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};

const fv = (v: number | undefined) => !v ? '—' : v >= 1000 ? `$${(v/1000).toFixed(1)}B` : `$${v.toFixed(0)}M`;

// ─── MINI SPARKLINE ───────────────────────────────────────────────────────────

function Sparkline({ data, color, h = 40 }: { data: number[]; color: string; h?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c || data.length < 2) return;
    const ctx = c.getContext('2d')!;
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    const min = Math.min(...data), max = Math.max(...data);
    const r = max - min || 1;
    const pts = data.map((v, i) => [(i / (data.length - 1)) * W, H - ((v - min) / r) * H * 0.8 - H * 0.1] as [number, number]);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, color + '28'); g.addColorStop(1, color + '00');
    ctx.beginPath();
    pts.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath();
    pts.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    const [lx, ly] = pts[pts.length - 1];
    ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 6; ctx.fill();
  }, [data, color]);
  return <canvas ref={ref} width={200} height={h} style={{ width: '100%', height: h }} />;
}

// ─── AGENT METER ──────────────────────────────────────────────────────────────

const AGENT_COLORS: Record<AgentName, string> = {
  STRUCTURE: '#00ff41', LIQUIDITY: '#00cfff', ARRAY: '#9945ff',
  RISK: '#ff9500', EXECUTION: '#ff0055',
};
const AGENT_ICONS: Record<AgentName, string> = {
  STRUCTURE: '⬡', LIQUIDITY: '◈', ARRAY: '◉', RISK: '⬢', EXECUTION: '▶',
};

function AgentMeter({ agent, score, details, reasoning }: {
  agent: AgentName; score: number; details: string[]; reasoning: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const c = AGENT_COLORS[agent];
  const w = `${score}%`;
  return (
    <div style={{ marginBottom: 8, cursor: 'pointer' }} onClick={() => setExpanded(e => !e)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: c, fontFamily: 'Share Tech Mono, monospace', letterSpacing: 1 }}>
          {AGENT_ICONS[agent]} {agent}
        </span>
        <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 700, color: scoreColor(score) }}>
          {score}
        </span>
      </div>
      <div style={{ height: 4, background: '#111', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: w, background: c, borderRadius: 2, transition: 'width 0.8s ease', boxShadow: `0 0 6px ${c}` }} />
      </div>
      {expanded && (
        <div style={{ marginTop: 6, padding: '6px 8px', background: 'rgba(0,0,0,0.5)', borderRadius: 3, borderLeft: `2px solid ${c}22` }}>
          <div style={{ fontSize: 9, color: '#556', fontFamily: 'Share Tech Mono, monospace', marginBottom: 3 }}>{reasoning}</div>
          {details.map((d, i) => (
            <div key={i} style={{ fontSize: 9, color: '#4a7a4a', fontFamily: 'Share Tech Mono, monospace', marginBottom: 1 }}>· {d}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── GRADE BADGE ─────────────────────────────────────────────────────────────

function GradeBadge({ grade }: { grade: SetupGrade }) {
  const c = gradeColor(grade);
  return (
    <span style={{
      fontFamily: 'Orbitron, monospace', fontWeight: 900, fontSize: 20,
      padding: '4px 14px', borderRadius: 3,
      background: grade === 'A+' ? 'rgba(0,255,65,0.1)' : grade === 'A' ? 'rgba(0,207,255,0.1)' : 'rgba(50,50,50,0.5)',
      color: c, border: `1px solid ${c}44`,
      textShadow: grade === 'A+' ? `0 0 12px ${c}` : 'none',
    }}>
      {grade}
    </span>
  );
}

// ─── MAIN APP ──────────────────────────────────────────────────────────────────

export default function App() {
  // ── State ──
  const [pair, setPair]           = useState('SOLUSDT');
  const [tf, setTf]               = useState<Timeframe>('15m');
  const [tab, setTab]             = useState<TabName>('DASHBOARD');
  const [execMode, setExecMode]   = useState<'SIMULATE' | 'REAL'>('SIMULATE');
  const [balance]                 = useState(1000);
  const [trades, setTrades]       = useState<Trade[]>([]);
  const [logs, setLogs]           = useState<string[]>(['[SYSTEM] QuentrexClaw v5.1 initialized.', '[ICT] Rule-based 5-agent council ready.']);
  const [confirmText, setConfirmText] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [priceDir, setPriceDir]   = useState<'up' | 'down' | null>(null);
  const [btResult, setBtResult]   = useState<BacktestResult | null>(null);
  const [btRunning, setBtRunning] = useState(false);
  const prevPriceRef = useRef<number | null>(null);

  const pairInfo = PAIRS.find(p => p.symbol === pair)!;
  const { killzone, mmtStr, mmtDate, nextKZ } = useKillzone();
  const { candles, ticker, orderBook, connected, loading, error, refresh } = useMarketData(pair, tf);

  // ── ICT Analysis (memoized — only recompute when candles change) ──
  const analysis = useMemo(() => {
    if (candles.length < 50) return null;
    const swings    = detectSwings(candles, 5, 5);
    const structure = detectMarketStructure(candles, swings);
    const obs       = detectOrderBlocks(candles, structure, tf);
    const fvgs      = detectFVGs(candles, tf);
    const pdArray   = calcPDArray(swings, candles[candles.length - 1]?.close ?? 0);
    const levels    = detectLiquiditySweeps(candles, tf, 5, 5);
    const setups    = detectSweepFVGSetups(candles, levels, 0.03);
    return { swings, structure, obs, fvgs, pdArray, levels, setups };
  }, [candles.length > 0 ? candles[candles.length - 1].time : 0, tf]);

  // ── Agent Council ──
  const council = useMemo(() => {
    if (!analysis || !ticker?.price) return null;
    const setup = analysis.setups[0];
    const dir = setup?.direction ?? ((ticker.change24h ?? 0) >= 0 ? 'LONG' : 'SHORT');
    const price = ticker.price;
    const atr = price * 0.007;
    const entry = setup?.fvgEntry ?? price;
    const sl    = setup?.stopLoss ?? (dir === 'LONG' ? price - atr * 1.3 : price + atr * 1.3);
    const tp1   = dir === 'LONG' ? entry + atr * 2.5 : entry - atr * 2.5;
    const tp2   = dir === 'LONG' ? entry + atr * 5.0 : entry - atr * 5.0;

    const agents = [
      runStructureAgent(candles, analysis.structure, dir),
      runLiquidityAgent(analysis.levels, price, dir),
      runArrayAgent(analysis.obs, analysis.fvgs, analysis.pdArray, price, dir),
      runRiskAgent(killzone, balance, trades.filter(t => {
        const today = new Date(); const td = new Date(t.executedAt);
        return td.toDateString() === today.toDateString();
      }).length, entry, sl, tp1, false),
      runExecutionAgent(candles, entry, sl, tp1, tp2, dir, setup?.fvgEntry ?? null, null),
    ];
    return { council: runCouncil(agents), entry, sl, tp1, tp2, dir: dir as 'LONG' | 'SHORT', rr: Math.abs(tp1 - entry) / Math.abs(entry - sl) };
  }, [analysis, ticker?.price, killzone?.name, trades.length]);

  // ── Log helper ──
  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    setLogs(l => [`[${ts}] ${msg}`, ...l.slice(0, 99)]);
  }, []);

  // ── Price flash ──
  useEffect(() => {
    const p = ticker?.price;
    if (!p) return;
    if (prevPriceRef.current !== null && p !== prevPriceRef.current) {
      setPriceDir(p > prevPriceRef.current ? 'up' : 'down');
      setTimeout(() => setPriceDir(null), 350);
    }
    prevPriceRef.current = p;
  }, [ticker?.price]);

  // ── Log connections ──
  useEffect(() => {
    if (connected) addLog(`[WS] ✅ Binance Futures connected — ${pair} ${tf}`);
  }, [connected, pair, tf]);

  // ── Execute Trade ──
  function executeTrade() {
    if (!council || !ticker?.price) return;
    if (execMode === 'REAL' && confirmText !== 'CONFIRM + EXECUTE REAL') {
      setShowConfirm(true); return;
    }
    setShowConfirm(false); setConfirmText('');
    if (balance < 30) { addLog('[RISK] ❌ Balance < $30 — PAUSED'); return; }
    const { entry, sl, tp1, tp2, dir, rr } = council;
    const risk = balance * 0.005;
    const t: Trade = {
      id: `trade_${Date.now()}`,
      timestamp: Date.now(),
      pair, timeframe: tf,
      direction: dir,
      setupType: 'LIQUIDITY_SWEEP_FVG',
      grade: council.council.grade,
      entry, stopLoss: sl, tp1, tp2,
      rr: parseFloat(rr.toFixed(2)),
      riskPercent: 0.5,
      killzone: killzone?.name ?? 'IDLE',
      council: council.council,
      notes: `${execMode} trade | ${pair} ${tf}`,
      status: 'ACTIVE',
      executedAt: Date.now(),
      executedPrice: ticker.price,
      positionSize: risk / Math.abs(entry - sl),
      mode: execMode,
    };
    setTrades(tr => [t, ...tr]);
    addLog(`[${execMode}] ${dir} ${pair} @ ${fp(entry)} | Grade:${council.council.grade} | RR:${rr.toFixed(1)}:1`);
  }

  // ── Backtest ──
  async function doBacktest() {
    if (candles.length < 200) { addLog('[BT] Need more candles'); return; }
    setBtRunning(true);
    addLog('[BT] Running 3-month walk-forward backtest...');
    try {
      const result = await runBacktest(candles, {
        pair, timeframe: tf, startDate: candles[0].time, endDate: candles[candles.length - 1].time,
        initialBalance: balance, riskPerTrade: 0.5,
      });
      setBtResult(result);
      addLog(`[BT] ✅ ${result.metrics.totalTrades} trades | WR ${result.metrics.winRate.toFixed(1)}% | PF ${result.metrics.profitFactor.toFixed(2)}`);
    } catch (e) {
      addLog(`[BT] ❌ Error: ${e}`);
    } finally {
      setBtRunning(false);
    }
  }

  // ─────────────────────────── RENDER ────────────────────────────────────────

  const C = {
    bg: '#0a0a0f', surface: 'rgba(0,255,65,0.02)', border: 'rgba(0,255,65,0.1)',
    green: '#00ff41', blue: '#00cfff', red: '#ff0055', orange: '#ff9500',
    dim: '#2a5a2a', text: '#8ab88a',
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: 'Share Tech Mono, monospace' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:wght@400;700&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px;height:3px;background:#050508}
        ::-webkit-scrollbar-thumb{background:#00ff4122}
        .g{text-shadow:0 0 8px currentColor}
        .card{background:${C.surface};border:1px solid ${C.border};border-radius:4px;padding:12px}
        .btn{cursor:pointer;background:transparent;border:1px solid transparent;border-radius:3px;font-family:'Share Tech Mono',monospace;transition:all 0.12s;color:${C.dim}}
        .btn:hover{color:${C.green};border-color:${C.green}33}
        .blink{animation:blink 1s step-end infinite}@keyframes blink{50%{opacity:0}}
        .pulse{animation:pulse 2s ease infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        .slide{animation:slide 0.2s ease}@keyframes slide{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        .fup{animation:fup 0.35s ease}@keyframes fup{0%{color:#00ff41;text-shadow:0 0 16px #00ff41}100%{}}
        .fdn{animation:fdn 0.35s ease}@keyframes fdn{0%{color:#ff0055;text-shadow:0 0 16px #ff0055}100%{}}
        .scan{position:fixed;inset:0;pointer-events:none;z-index:9999;background:repeating-linear-gradient(transparent,transparent 3px,rgba(0,0,0,0.018) 3px,rgba(0,0,0,0.018) 4px)}
        table{width:100%;border-collapse:collapse}
        th,td{padding:5px 8px;font-size:10px;border-bottom:1px solid ${C.border}44;text-align:left;font-family:'JetBrains Mono',monospace}
        th{color:#1a4a1a;font-weight:400;letter-spacing:1px}
        input{background:rgba(0,255,65,0.05);border:1px solid ${C.border};border-radius:3px;color:${C.green};font-family:'Share Tech Mono',monospace;padding:6px 10px;font-size:11px;outline:none;width:100%}
        input:focus{border-color:${C.green}44}
      `}</style>
      <div className="scan" />

      {/* ── TOPBAR ── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 200, background: 'rgba(10,10,15,0.97)', borderBottom: `1px solid ${C.border}`, padding: '7px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, backdropFilter: 'blur(16px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontFamily: 'Orbitron, monospace', fontWeight: 900, fontSize: 17, color: C.green }} className="g">
            QUENTREX<span style={{ color: C.red }}>CLAW</span>
          </span>
          <span style={{ fontSize: 9, color: C.dim, letterSpacing: 2 }}>v5.1 · ICT/SMC · ZERO-COST</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          {/* WS status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? C.green : C.red, boxShadow: connected ? `0 0 6px ${C.green}` : 'none' }} className={connected ? '' : 'pulse'} />
            <span style={{ fontSize: 9, color: connected ? C.green : C.red }}>{connected ? 'BINANCE-F LIVE' : loading ? 'LOADING' : 'RECONNECTING'}</span>
          </div>

          {/* Killzone */}
          {killzone
            ? <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div className="blink" style={{ width: 6, height: 6, borderRadius: '50%', background: killzone.color, boxShadow: `0 0 6px ${killzone.color}` }} />
                <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, color: killzone.color }} className="g">{killzone.name}</span>
                <span style={{ fontSize: 9, color: C.dim }}>{killzone.minutesRemaining}m left</span>
              </div>
            : <span style={{ fontSize: 9, color: '#333' }} className="pulse">NO KZ · next {nextKZ.name} in {Math.round(nextKZ.minsUntil / 60)}h</span>
          }

          {/* Clock */}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 13, fontWeight: 700, color: C.green }}>{mmtStr}</div>
            <div style={{ fontSize: 8, color: C.dim }}>MMT UTC+6:30 · {mmtDate}</div>
          </div>
        </div>
      </div>

      {/* ── PAIR STRIP ── */}
      <div style={{ overflowX: 'auto', display: 'flex', gap: 5, padding: '6px 16px', background: 'rgba(0,0,0,0.6)', borderBottom: `1px solid ${C.border}11`, scrollbarWidth: 'none' }}>
        {PAIRS.map(p => {
          const active = pair === p.symbol;
          return (
            <button key={p.symbol} className="btn" onClick={() => setPair(p.symbol)} style={{
              flexShrink: 0, padding: '3px 8px', minWidth: 64,
              background: active ? p.color + '12' : 'transparent',
              border: active ? `1px solid ${p.color}55` : `1px solid ${C.border}22`,
              color: active ? p.color : C.dim,
            }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1 }}>{p.label}</div>
            </button>
          );
        })}
      </div>

      {/* ── NAV + TF ── */}
      <div style={{ display: 'flex', gap: 2, padding: '5px 16px', background: 'rgba(0,0,0,0.4)', borderBottom: `1px solid ${C.border}11`, alignItems: 'center', flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t} className="btn" onClick={() => setTab(t)} style={{
            padding: '4px 12px', fontFamily: 'Orbitron, monospace', fontSize: 9, letterSpacing: 1,
            background: tab === t ? 'rgba(0,255,65,0.08)' : 'transparent',
            color: tab === t ? C.green : C.dim,
            border: tab === t ? `1px solid ${C.green}33` : '1px solid transparent',
          }}>{t}</button>
        ))}
        <div style={{ flex: 1 }} />
        {/* TF selector */}
        {TIMEFRAMES.map(t => (
          <button key={t} className="btn" onClick={() => setTf(t)} style={{
            padding: '3px 8px', fontSize: 9, fontFamily: 'Orbitron, monospace',
            color: tf === t ? C.blue : C.dim,
            border: tf === t ? `1px solid ${C.blue}44` : `1px solid ${C.border}22`,
            background: tf === t ? 'rgba(0,207,255,0.08)' : 'transparent',
          }}>{t}</button>
        ))}
        <div style={{ width: 1, height: 14, background: C.border, margin: '0 6px' }} />
        <span style={{ fontSize: 9, color: C.dim }}>BAL:</span>
        <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, color: C.green, marginLeft: 4 }}>${balance.toFixed(0)}</span>
      </div>

      {/* ── ERROR BANNER ── */}
      {error && <div style={{ padding: '4px 16px', background: 'rgba(255,0,85,0.1)', borderBottom: `1px solid ${C.red}33`, fontSize: 10, color: C.red }}>⚠ {error}</div>}

      <div style={{ padding: '10px 16px' }}>

        {/* ═══════════════ DASHBOARD ═══════════════ */}
        {tab === 'DASHBOARD' && (
          <div className="slide" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>

              {/* Hero price */}
              <div className="card" style={{ flex: '2 1 250px', border: `1px solid ${pairInfo.color}44`, background: `${pairInfo.color}09` }}>
                <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 6 }}>◈ {pair} · {tf} · BINANCE FUTURES</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div className={priceDir === 'up' ? 'fup' : priceDir === 'down' ? 'fdn' : ''} style={{ fontFamily: 'Orbitron, monospace', fontSize: 28, fontWeight: 900, color: pairInfo.color, letterSpacing: -0.5, textShadow: `0 0 16px ${pairInfo.color}44` }}>
                      {loading ? <span className="pulse" style={{ color: '#222' }}>———</span> : fp(ticker?.price)}
                    </div>
                    <div style={{ fontSize: 9, color: C.dim, marginTop: 3 }}>USDT PERP</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 700, color: (ticker?.change24h ?? 0) >= 0 ? C.green : C.red }}>
                      {ticker?.change24h != null ? `${ticker.change24h >= 0 ? '▲' : '▼'}${Math.abs(ticker.change24h).toFixed(2)}%` : '—'}
                    </div>
                    <div style={{ fontSize: 9, color: '#5a8', marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>H {fp(ticker?.high24h)}</div>
                    <div style={{ fontSize: 9, color: '#5a8', fontFamily: 'JetBrains Mono, monospace' }}>L {fp(ticker?.low24h)}</div>
                  </div>
                </div>
                <div style={{ marginTop: 8 }}>
                  <Sparkline data={candles.slice(-60).map(c => c.close)} color={pairInfo.color} h={48} />
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
                  {[
                    ['VOL 24H', fv(ticker?.vol24h), C.blue],
                    ['FUND',    ticker?.fundingRate != null ? `${ticker.fundingRate >= 0 ? '+' : ''}${ticker.fundingRate.toFixed(4)}%` : '—', (ticker?.fundingRate ?? 0) > 0 ? C.orange : C.blue],
                    ['MARK',    fp(ticker?.markPrice), '#f7931a'],
                  ].map(([l, v, c]) => (
                    <div key={l as string}>
                      <div style={{ fontSize: 8, color: C.dim }}>{l}</div>
                      <div style={{ fontSize: 11, color: c as string, fontFamily: 'JetBrains Mono, monospace' }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ICT Summary */}
              <div className="card" style={{ flex: '1 1 180px' }}>
                <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 8 }}>◈ ICT ANALYSIS</div>
                {analysis ? (
                  <>
                    {[
                      ['Structure Pts', analysis.structure.length, C.green],
                      ['Active OBs',    analysis.obs.filter(o => !o.mitigated).length, '#9945ff'],
                      ['Open FVGs',     analysis.fvgs.filter(f => !f.filled).length, C.blue],
                      ['Liq Levels',    analysis.levels.filter(l => l.status === 'ACTIVE').length, C.orange],
                      ['A+/A Setups',   analysis.setups.filter(s => s.quality >= 70).length, C.green],
                    ].map(([l, v, c]) => (
                      <div key={l as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${C.border}33` }}>
                        <span style={{ fontSize: 10, color: C.dim }}>{l}</span>
                        <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, color: c as string, fontWeight: 700 }}>{v}</span>
                      </div>
                    ))}
                    {analysis.pdArray && (
                      <div style={{ marginTop: 8, padding: '5px 7px', background: 'rgba(0,0,0,0.4)', borderRadius: 3 }}>
                        <div style={{ fontSize: 8, color: C.dim, marginBottom: 3 }}>PD ARRAY</div>
                        <div style={{ fontSize: 10, color: analysis.pdArray.type === 'BULLISH' ? C.green : C.red }}>
                          {analysis.pdArray.type} BIAS
                        </div>
                        <div style={{ fontSize: 9, color: '#4a7', fontFamily: 'JetBrains Mono, monospace' }}>
                          EQ: {fp(analysis.pdArray.equilibrium)} | {analysis.pdArray.type === 'BULLISH' ? '↑' : '↓'}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="pulse" style={{ color: '#1a4a1a', fontSize: 11 }}>Analyzing {candles.length} candles...</div>
                )}
              </div>

              {/* Council score */}
              <div className="card" style={{ flex: '1 1 160px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 12 }}>◈ COUNCIL</div>
                {council ? (
                  <>
                    <GradeBadge grade={council.council.grade} />
                    <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 24, fontWeight: 900, color: scoreColor(council.council.consensusScore), marginTop: 8, marginBottom: 4 }}>
                      {council.council.consensusScore}
                    </div>
                    <div style={{ fontSize: 9, color: C.dim }}>consensus score</div>
                    <div style={{ marginTop: 8, padding: '3px 10px', borderRadius: 2, background: council.dir === 'LONG' ? 'rgba(0,255,65,0.1)' : 'rgba(255,0,85,0.1)', color: council.dir === 'LONG' ? C.green : C.red, fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 700 }}>
                      {council.dir ?? '—'}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 9, color: killzone ? killzone.color : '#444' }}>
                      {killzone ? `⏰ ${killzone.name} ACTIVE` : '⚠ NO KILLZONE'}
                    </div>
                  </>
                ) : (
                  <div className="pulse" style={{ color: '#1a4a1a', fontSize: 11 }}>Loading...</div>
                )}
              </div>
            </div>

            {/* Orderbook */}
            {orderBook && (
              <div className="card" style={{ maxWidth: 320 }}>
                <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 8 }}>◈ ORDERBOOK DEPTH</div>
                {orderBook.asks.slice().reverse().map((l, i) => {
                  const max = Math.max(...orderBook.asks.map(x => x.qty));
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 1, position: 'relative' }}>
                      <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${l.qty / max * 100}%`, background: 'rgba(255,0,85,0.08)' }} />
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: C.red, width: 80 }}>{fp(l.price)}</span>
                      <span style={{ fontSize: 10, color: C.dim, flex: 1, textAlign: 'right', zIndex: 1 }}>{l.qty.toFixed(2)}</span>
                    </div>
                  );
                })}
                <div style={{ textAlign: 'center', padding: '3px 0', fontFamily: 'Orbitron, monospace', fontSize: 12, color: pairInfo.color, background: 'rgba(0,0,0,0.4)', margin: '3px 0', borderRadius: 2 }}>
                  {fp(ticker?.price)} USDT
                </div>
                {orderBook.bids.map((l, i) => {
                  const max = Math.max(...orderBook.bids.map(x => x.qty));
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 1, position: 'relative' }}>
                      <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${l.qty / max * 100}%`, background: 'rgba(0,255,65,0.07)' }} />
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: C.green, width: 80 }}>{fp(l.price)}</span>
                      <span style={{ fontSize: 10, color: C.dim, flex: 1, textAlign: 'right', zIndex: 1 }}>{l.qty.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════ SIGNAL ═══════════════ */}
        {tab === 'SIGNAL' && (
          <div className="slide" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {!ticker?.price
              ? <div className="pulse" style={{ textAlign: 'center', padding: '50px', color: '#1a4a1a' }}>Connecting to Binance Futures...</div>
              : !council
              ? <div className="pulse" style={{ textAlign: 'center', padding: '40px', color: '#1a4a1a' }}>Running ICT analysis on {candles.length} candles...</div>
              : (
                <>
                  <div className="card" style={{ border: `1px solid ${gradeColor(council.council.grade)}44`, boxShadow: council.council.grade === 'A+' ? `0 0 20px ${C.green}0a` : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 13, fontWeight: 700, color: C.green }}>6-LINE SETUP · {pair} {tf}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, color: pairInfo.color }}>{fp(ticker.price)}</span>
                        <GradeBadge grade={council.council.grade} />
                      </div>
                    </div>

                    {[
                      ['① PAIR',       pair,                                         '#00cfff'],
                      ['② DIRECTION',  council.dir,                                  council.dir === 'LONG' ? C.green : C.red],
                      ['③ ENTRY',      `${fp(council.entry)} USDT ← LIVE`,           '#fff'],
                      ['④ STOP LOSS',  `${fp(council.sl)} USDT (${(Math.abs(council.sl - council.entry) / council.entry * 100).toFixed(2)}%)`, C.red],
                      ['⑤ TP1 / TP2',  `${fp(council.tp1)} / ${fp(council.tp2)}`,    C.green],
                      ['⑥ RR · RISK',  `${council.rr.toFixed(1)}:1 · 0.5% balance`, C.orange],
                    ].map(([l, v, c]) => (
                      <div key={l as string} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: `1px solid ${C.border}33` }}>
                        <span style={{ fontSize: 10, color: C.dim, width: 120, flexShrink: 0 }}>{l}</span>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: c as string, fontWeight: 700 }}>{v}</span>
                      </div>
                    ))}

                    {/* Agent gates */}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                      {council.council.agents.map(a => (
                        <div key={a.agent} style={{
                          padding: '3px 8px', borderRadius: 2, fontSize: 9,
                          background: a.score >= 65 ? 'rgba(0,255,65,0.07)' : 'rgba(255,0,85,0.06)',
                          color: a.score >= 65 ? C.green : C.red,
                          border: `1px solid ${a.score >= 65 ? C.green : C.red}22`,
                        }}>{AGENT_ICONS[a.agent]} {a.agent} {a.score}</div>
                      ))}
                    </div>
                  </div>

                  {/* Execute */}
                  <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                    {(['SIMULATE', 'REAL'] as const).map(m => (
                      <button key={m} className="btn" onClick={() => setExecMode(m)} style={{
                        padding: '7px 16px', fontFamily: 'Orbitron, monospace', fontSize: 10,
                        background: execMode === m ? (m === 'REAL' ? 'rgba(255,0,85,0.12)' : 'rgba(0,207,255,0.08)') : 'transparent',
                        color: execMode === m ? (m === 'REAL' ? C.red : C.blue) : C.dim,
                        border: execMode === m ? `1px solid ${m === 'REAL' ? C.red : C.blue}44` : `1px solid ${C.border}`,
                      }}>{m}</button>
                    ))}

                    {(council.council.grade === 'A+' || council.council.grade === 'A')
                      ? <button className="btn" onClick={executeTrade} style={{
                          padding: '9px 24px', fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 700,
                          background: execMode === 'REAL' ? 'rgba(255,0,85,0.15)' : 'rgba(0,255,65,0.1)',
                          color: execMode === 'REAL' ? C.red : C.green,
                          border: `1px solid ${execMode === 'REAL' ? C.red : C.green}`,
                          boxShadow: `0 0 12px ${execMode === 'REAL' ? C.red : C.green}18`,
                        }}>⚡ {execMode === 'REAL' ? 'EXECUTE REAL' : 'SIMULATE TRADE'}</button>
                      : <div style={{ padding: '9px 16px', border: `1px solid #222`, borderRadius: 3, color: '#333', fontSize: 11 }}>⛔ {council.council.grade} — A/A+ only</div>
                    }
                  </div>

                  {showConfirm && (
                    <div style={{ padding: 12, border: `1px solid ${C.red}`, borderRadius: 3, background: 'rgba(255,0,85,0.07)' }}>
                      <div style={{ fontSize: 11, color: C.red, marginBottom: 8 }}>⚠ TYPE EXACT PHRASE TO CONFIRM REAL TRADE:</div>
                      <input
                        value={confirmText}
                        onChange={e => setConfirmText(e.target.value)}
                        placeholder="CONFIRM + EXECUTE REAL"
                        onKeyDown={e => e.key === 'Enter' && executeTrade()}
                      />
                      <div style={{ display: 'flex', gap: 7, marginTop: 7 }}>
                        <button className="btn" onClick={executeTrade} style={{ padding: '6px 16px', background: 'rgba(255,0,85,0.2)', color: C.red, border: `1px solid ${C.red}`, fontFamily: 'Orbitron, monospace', fontSize: 10 }}>CONFIRM</button>
                        <button className="btn" onClick={() => { setShowConfirm(false); setConfirmText(''); }} style={{ padding: '6px 10px', color: C.dim, border: `1px solid #222` }}>CANCEL</button>
                      </div>
                    </div>
                  )}
                </>
              )}
          </div>
        )}

        {/* ═══════════════ AGENTS ═══════════════ */}
        {tab === 'AGENTS' && (
          <div className="slide" style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
            <div className="card" style={{ flex: '1 1 260px' }}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 12 }}>◈ 5-AGENT COUNCIL BREAKDOWN</div>
              {council ? (
                <>
                  {council.council.agents.map(a => (
                    <AgentMeter key={a.agent} agent={a.agent} score={a.score} details={a.details} reasoning={a.reasoning} />
                  ))}
                  <div style={{ marginTop: 14, padding: '8px 10px', background: 'rgba(0,0,0,0.4)', borderRadius: 3, borderLeft: `2px solid ${gradeColor(council.council.grade)}44` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 9, color: C.dim }}>CONSENSUS SCORE</span>
                      <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 14, fontWeight: 700, color: scoreColor(council.council.consensusScore) }}>{council.council.consensusScore}/100</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 9, color: C.dim }}>GRADE</span>
                      <GradeBadge grade={council.council.grade} />
                    </div>
                  </div>
                </>
              ) : (
                <div className="pulse" style={{ color: '#1a4a1a', fontSize: 11 }}>Running agents...</div>
              )}
            </div>

            <div className="card" style={{ flex: '1 1 220px' }}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 10 }}>◈ AGENT ARCHITECTURE</div>
              {[
                ['STRUCTURE', 'BOS/CHoCH alignment, MSS confirmation, trend direction', '25%'],
                ['LIQUIDITY', 'Sweep quality, HTF confluence, magnet strength', '25%'],
                ['ARRAY',     'OB/FVG proximity, PD positioning, breaker blocks', '20%'],
                ['RISK',      'Killzone gate, balance check, RR validation, news', '15%'],
                ['EXECUTION', 'FVG/OB entry precision, SL placement, TP targets', '15%'],
              ].map(([name, desc, weight]) => (
                <div key={name} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${C.border}22` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 10, color: AGENT_COLORS[name as AgentName] }}>{AGENT_ICONS[name as AgentName]} {name}</span>
                    <span style={{ fontSize: 9, color: C.orange }}>{weight}</span>
                  </div>
                  <div style={{ fontSize: 9, color: '#2a5a2a', lineHeight: 1.5 }}>{desc}</div>
                </div>
              ))}
              <div style={{ marginTop: 8, fontSize: 9, color: C.dim }}>
                A+ = 90+  ·  A = 80-89  ·  B/C = blocked
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════ BACKTEST ═══════════════ */}
        {tab === 'BACKTEST' && (
          <div className="slide" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, color: C.green }}>BROWSER BACKTEST ENGINE</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" onClick={doBacktest} disabled={btRunning || candles.length < 200} style={{
                    padding: '7px 18px', fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700,
                    background: btRunning ? 'transparent' : 'rgba(0,255,65,0.1)',
                    color: btRunning ? C.dim : C.green,
                    border: `1px solid ${btRunning ? C.dim : C.green}44`,
                  }}>{btRunning ? '⟳ RUNNING...' : '▶ RUN BACKTEST'}</button>
                </div>
              </div>
              <div style={{ fontSize: 10, color: C.dim }}>
                {pair} · {tf} · {candles.length} candles loaded · ICT walk-forward simulation
              </div>
            </div>

            {btResult && (
              <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                <div className="card" style={{ flex: '1 1 200px' }}>
                  <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 10 }}>◈ PERFORMANCE METRICS</div>
                  {[
                    ['Total Trades', btResult.metrics.totalTrades, '#fff'],
                    ['Win Rate',     `${btResult.metrics.winRate.toFixed(1)}%`,         btResult.metrics.winRate >= 55 ? C.green : C.red],
                    ['Profit Factor',`${btResult.metrics.profitFactor.toFixed(2)}`,     btResult.metrics.profitFactor >= 1.5 ? C.green : C.red],
                    ['Sharpe Ratio', btResult.metrics.sharpeRatio.toFixed(2),           btResult.metrics.sharpeRatio >= 1 ? C.green : C.orange],
                    ['Max Drawdown', `${btResult.metrics.maxDrawdownPct.toFixed(1)}%`,  btResult.metrics.maxDrawdownPct <= 10 ? C.green : C.red],
                    ['Total P&L',    `${btResult.metrics.totalPnlPct >= 0 ? '+' : ''}${btResult.metrics.totalPnlPct.toFixed(1)}%`, btResult.metrics.totalPnl >= 0 ? C.green : C.red],
                    ['Avg RR',       `${btResult.metrics.avgRR.toFixed(2)}:1`,          btResult.metrics.avgRR >= 2 ? C.green : C.orange],
                    ['Best Trade',   `+$${btResult.metrics.bestTrade.toFixed(2)}`,      C.green],
                    ['Worst Trade',  `$${btResult.metrics.worstTrade.toFixed(2)}`,      C.red],
                  ].map(([l, v, c]) => (
                    <div key={l as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${C.border}22` }}>
                      <span style={{ fontSize: 10, color: C.dim }}>{l}</span>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: c as string, fontWeight: 700 }}>{v}</span>
                    </div>
                  ))}
                </div>

                <div className="card" style={{ flex: '1 1 200px' }}>
                  <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 10 }}>◈ KILLZONE EFFICIENCY</div>
                  {(['NYKZ', 'LKZ', 'AKZ'] as const).map(kzName => {
                    const kzData = btResult.metrics.byKillzone[kzName];
                    const wr = kzData.trades > 0 ? (kzData.wins / kzData.trades * 100) : 0;
                    const kzInfo = { NYKZ: { color: C.orange, label: 'New York' }, LKZ: { color: C.blue, label: 'London' }, AKZ: { color: C.green, label: 'Asian' } }[kzName];
                    return (
                      <div key={kzName} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${C.border}22` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ fontSize: 10, color: kzInfo.color }}>{kzName}</span>
                          <span style={{ fontSize: 10, color: wr >= 55 ? C.green : C.red, fontFamily: 'JetBrains Mono, monospace' }}>{wr.toFixed(0)}% WR</span>
                        </div>
                        <div style={{ height: 4, background: '#111', borderRadius: 2, overflow: 'hidden', marginBottom: 3 }}>
                          <div style={{ height: '100%', width: `${wr}%`, background: kzInfo.color, borderRadius: 2, transition: 'width 1s' }} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: C.dim }}>
                          <span>{kzData.trades} trades</span>
                          <span style={{ color: kzData.pnl >= 0 ? C.green : C.red }}>P&L: ${kzData.pnl.toFixed(2)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="card" style={{ flex: '2 1 300px', maxHeight: 320, overflowY: 'auto' }}>
                  <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 8 }}>◈ TRADE LOG ({btResult.trades.length})</div>
                  <table>
                    <thead><tr>{['TIME','DIR','ENTRY','EXIT','PNL%','GRADE','KZ'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                    <tbody>
                      {btResult.trades.map(t => (
                        <tr key={t.id}>
                          <td style={{ color: C.dim }}>{new Date(t.timestamp).toLocaleDateString()}</td>
                          <td style={{ color: t.direction === 'LONG' ? C.green : C.red, fontWeight: 700 }}>{t.direction}</td>
                          <td>{fp(t.entry)}</td>
                          <td>{fp(t.closePrice)}</td>
                          <td style={{ color: (t.pnlPercent ?? 0) >= 0 ? C.green : C.red }}>
                            {(t.pnlPercent ?? 0) >= 0 ? '+' : ''}{(t.pnlPercent ?? 0).toFixed(2)}%
                          </td>
                          <td><span style={{ color: gradeColor(t.grade) }}>{t.grade}</span></td>
                          <td style={{ color: C.orange, fontSize: 9 }}>{t.killzone}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════ JOURNAL ═══════════════ */}
        {tab === 'JOURNAL' && (
          <div className="slide">
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, color: C.green }}>TRADE JOURNAL</span>
                <span style={{ fontSize: 10, color: C.dim }}>{trades.length} trades · bal ${balance.toFixed(0)}</span>
              </div>
              {trades.length === 0
                ? <div style={{ textAlign: 'center', padding: '30px', color: '#1a4a1a', fontSize: 11 }}>No trades yet. Go to SIGNAL → Execute.</div>
                : (
                  <div style={{ overflowX: 'auto' }}>
                    <table>
                      <thead><tr>{['TIME','PAIR','TF','DIR','ENTRY','SL','TP1','TP2','RR','GRADE','KZ','MODE'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                      <tbody>
                        {trades.map(t => (
                          <tr key={t.id}>
                            <td style={{ color: C.dim }}>{new Date(t.executedAt).toLocaleTimeString('en-US', { hour12: false })}</td>
                            <td style={{ color: C.blue }}>{t.pair}</td>
                            <td style={{ color: C.dim }}>{t.timeframe}</td>
                            <td style={{ color: t.direction === 'LONG' ? C.green : C.red, fontWeight: 700 }}>{t.direction}</td>
                            <td>{fp(t.entry)}</td>
                            <td style={{ color: C.red }}>{fp(t.stopLoss)}</td>
                            <td style={{ color: C.green }}>{fp(t.tp1)}</td>
                            <td style={{ color: C.green }}>{fp(t.tp2)}</td>
                            <td style={{ color: C.orange }}>{t.rr}:1</td>
                            <td><span style={{ color: gradeColor(t.grade) }}>{t.grade}</span></td>
                            <td style={{ fontSize: 9, color: C.orange }}>{t.killzone}</td>
                            <td><span style={{ color: t.mode === 'REAL' ? C.red : C.blue }}>{t.mode}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
          </div>
        )}

        {/* ═══════════════ TERMINAL ═══════════════ */}
        {tab === 'TERMINAL' && (
          <div className="slide" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                <span style={{ fontSize: 9, color: C.dim, letterSpacing: 2 }}>◈ SYSTEM LOG</span>
                <button className="btn" onClick={() => setLogs([])} style={{ padding: '2px 8px', fontSize: 9, border: `1px solid ${C.border}` }}>CLEAR</button>
              </div>
              <div style={{ height: 300, overflowY: 'auto', padding: 8, background: 'rgba(0,0,0,0.6)', borderRadius: 3, fontFamily: 'JetBrains Mono, monospace', fontSize: 10 }}>
                {logs.map((l, i) => (
                  <div key={i} style={{ marginBottom: 3, color: l.includes('[WS]') ? C.blue : l.includes('REAL') ? C.red : l.includes('A+') ? C.green : '#2a5a2a' }}>{l}</div>
                ))}
              </div>
            </div>

            {/* AI Model guide */}
            <div className="card">
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 10 }}>◈ AI MODEL USAGE GUIDE (ZERO BUDGET)</div>
              <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                {[
                  { name: 'Claude ($20/mo)', color: '#ff9500', uses: ['Architecture decisions', 'Complex ICT logic', 'Debug hard bugs', 'System design reviews'], limit: 'Use sparingly — high value only' },
                  { name: 'GLM-5 (Free)', color: '#00cfff', uses: ['Boilerplate generation', 'CSS/styling', 'Simple utilities', 'Repetitive code patterns'], limit: 'Unlimited use' },
                  { name: 'Kimi K2.5 (Free)', color: '#9945ff', uses: ['Long file analysis', 'Refactoring large files', 'Documentation writing', 'Type definitions'], limit: 'Unlimited use — 128K context' },
                ].map(m => (
                  <div key={m.name} style={{ flex: '1 1 160px', padding: '8px 10px', background: 'rgba(0,0,0,0.4)', borderRadius: 3, borderLeft: `2px solid ${m.color}55` }}>
                    <div style={{ fontSize: 11, color: m.color, marginBottom: 6 }}>{m.name}</div>
                    {m.uses.map(u => <div key={u} style={{ fontSize: 9, color: '#3a6a3a', marginBottom: 2 }}>· {u}</div>)}
                    <div style={{ fontSize: 8, color: '#1a4a1a', marginTop: 6 }}>{m.limit}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Build roadmap */}
            <div className="card">
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: 2, marginBottom: 10 }}>◈ BUILD ROADMAP (NOW vs MAY GPU)</div>
              <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 180px' }}>
                  <div style={{ fontSize: 10, color: C.green, marginBottom: 6 }}>✅ BUILD NOW (Browser)</div>
                  {['Real-time WS data feed', 'ICT swing detection', 'OB/FVG/liquidity engine', '5-agent rule-based council', 'Signal generation A+/A', 'Browser backtest', 'MMT killzone manager', 'Trade journal (localStorage)'].map(i => (
                    <div key={i} style={{ fontSize: 9, color: '#3a6a3a', marginBottom: 2 }}>✓ {i}</div>
                  ))}
                </div>
                <div style={{ flex: '1 1 180px' }}>
                  <div style={{ fontSize: 10, color: C.orange, marginBottom: 6 }}>⏳ AFTER MAY (GPU)</div>
                  {['Local LLM agent (Mistral 7B)', 'Real-time ML classification', 'Pattern recognition CNN', 'Sentiment from order flow', 'Auto-execute via CCXT', 'Multi-pair scanner', 'Portfolio risk manager', 'RLHF from your trades'].map(i => (
                    <div key={i} style={{ fontSize: 9, color: '#4a5a3a', marginBottom: 2 }}>○ {i}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '7px 16px', borderTop: `1px solid ${C.border}11`, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4, color: '#1a3a1a', fontSize: 8, fontFamily: 'JetBrains Mono, monospace' }}>
        <span>QuentrexClaw v5.1 © 2026 Peps Trading · Zero-cost ICT/SMC · Browser-only</span>
        <div style={{ display: 'flex', gap: 10 }}>
          <span>Binance Futures WS + REST</span><span>15 Pairs</span><span>5-Agent Council</span>
          <span style={{ color: connected ? C.green : '#333' }}>● {connected ? 'LIVE' : '...'}</span>
        </div>
      </div>
    </div>
  );
}
