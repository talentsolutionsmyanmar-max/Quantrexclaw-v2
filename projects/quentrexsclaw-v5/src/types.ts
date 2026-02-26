// ─── OHLCV & MARKET DATA ──────────────────────────────────────────────────────

export interface Candle {
  time: number;       // Unix timestamp (ms)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';

export interface OrderBookLevel {
  price: number;
  qty: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface FundingRate {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
}

export interface Ticker {
  symbol: string;
  price: number;
  change24h: number;
  vol24h: number;
  high24h: number;
  low24h: number;
  markPrice: number;
  openInterest: number;
  fundingRate: number;
  nextFundingTime: number;
}

// ─── ICT / SMC STRUCTURES ─────────────────────────────────────────────────────

export type SwingType = 'HIGH' | 'LOW';
export type StructureType = 'BOS_BULL' | 'BOS_BEAR' | 'CHoCH_BULL' | 'CHoCH_BEAR' | 'MSS_BULL' | 'MSS_BEAR';
export type SweepStatus = 'ACTIVE' | 'SWEPT';

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: SwingType;
}

export interface StructurePoint {
  time: number;
  price: number;
  type: StructureType;
  confirmed: boolean;
  candle: Candle;
}

export interface LiquidityLevel {
  id: string;
  price: number;
  time: number;
  type: SwingType;
  status: SweepStatus;
  sweepTime?: number;
  sweepCandle?: Candle;
  strength: number;          // 0-100 based on how many times tested
  timeframe: Timeframe;
}

export interface OrderBlock {
  id: string;
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  time: number;
  mitigated: boolean;
  mitigationTime?: number;
  volume: number;
  strength: number;          // 0-100
  timeframe: Timeframe;
}

export interface FairValueGap {
  id: string;
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  time: number;
  midpoint: number;
  filled: boolean;
  fillPercent: number;       // 0-100
  timeframe: Timeframe;
}

export interface PDArray {
  premium: number;           // 61.8% fib
  equilibrium: number;       // 50%
  discount: number;          // 38.2% fib
  high: number;
  low: number;
  type: 'BULLISH' | 'BEARISH';
  strength: number;
}

// ─── KILLZONE ─────────────────────────────────────────────────────────────────

export type KillzoneName = 'AKZ' | 'LKZ' | 'NYKZ' | 'IDLE';

export interface Killzone {
  name: KillzoneName;
  label: string;
  startH: number;   // UTC+6:30 hour
  startM: number;
  endH: number;
  endM: number;
  color: string;
  active: boolean;
  minutesRemaining?: number;
}

// ─── AI AGENTS ────────────────────────────────────────────────────────────────

export type AgentName = 'STRUCTURE' | 'LIQUIDITY' | 'ARRAY' | 'RISK' | 'EXECUTION';

export interface AgentSignal {
  agent: AgentName;
  score: number;       // 0-100
  label: string;
  details: string[];
  bullish: boolean;
  weight: number;      // 0-1
  reasoning: string;
}

export type SetupGrade = 'A+' | 'A' | 'B' | 'C' | 'NONE';
export type SetupType = 'LIQUIDITY_SWEEP_FVG' | 'BREAKER_BLOCK' | 'TREND_CONTINUATION' | 'BPR' | 'OB_RETEST';
export type TradeDirection = 'LONG' | 'SHORT';

export interface AgentCouncil {
  agents: AgentSignal[];
  consensusScore: number;
  grade: SetupGrade;
  direction: TradeDirection | null;
  timestamp: number;
}

// ─── SIGNALS & TRADES ─────────────────────────────────────────────────────────

export interface Signal {
  id: string;
  timestamp: number;
  pair: string;
  timeframe: Timeframe;
  direction: TradeDirection;
  setupType: SetupType;
  grade: SetupGrade;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3?: number;
  rr: number;
  riskPercent: number;
  killzone: KillzoneName;
  council: AgentCouncil;
  notes: string;
  status: 'PENDING' | 'ACTIVE' | 'TP1_HIT' | 'TP2_HIT' | 'SL_HIT' | 'CANCELLED';
}

export interface Trade extends Signal {
  executedAt: number;
  executedPrice: number;
  positionSize: number;
  pnl?: number;
  pnlPercent?: number;
  closedAt?: number;
  closePrice?: number;
  mode: 'SIMULATE' | 'REAL';
  exchange?: string;
}

// ─── BACKTEST ─────────────────────────────────────────────────────────────────

export interface BacktestConfig {
  pair: string;
  timeframe: Timeframe;
  startDate: number;
  endDate: number;
  initialBalance: number;
  riskPerTrade: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: Trade[];
  metrics: BacktestMetrics;
}

export interface BacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  totalPnl: number;
  totalPnlPct: number;
  avgRR: number;
  bestTrade: number;
  worstTrade: number;
  byKillzone: Record<KillzoneName, { trades: number; wins: number; pnl: number }>;
}

// ─── UI STATE ─────────────────────────────────────────────────────────────────

export type ActiveTab = 'dashboard' | 'signal' | 'backtest' | 'journal' | 'terminal';

export interface AppState {
  activePair: string;
  activeTimeframe: Timeframe;
  activeTab: ActiveTab;
  execMode: 'SIMULATE' | 'REAL';
  balance: number;
  isConnected: boolean;
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────

export interface WSKlineMessage {
  e: string;
  E: number;
  s: string;
  k: {
    t: number; T: number; s: string; i: string;
    o: string; h: string; l: string; c: string; v: string;
    n: number; x: boolean; q: string;
  };
}

export interface WSTicker {
  e: string; E: number; s: string;
  p: string; P: string; c: string;
  h: string; l: string; q: string; n: number;
}
