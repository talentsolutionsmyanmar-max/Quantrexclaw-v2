/**
 * hooks/useMarketData.ts
 * Real-time market data from Binance Futures (primary) → Bybit (fallback).
 * WebSocket for live prices + REST for history, OI, funding.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Candle, Ticker, OrderBook, Timeframe } from '../types';

const BINANCE_REST  = 'https://fapi.binance.com';
const BINANCE_WS    = 'wss://fstream.binance.com/ws';
const BYBIT_REST    = 'https://api.bybit.com';

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
// Binance: 1200 req/min = 20/sec. We stay under 600/min to be safe.

class RateLimiter {
  private queue: Array<() => void> = [];
  private running = 0;
  private readonly maxPerSecond: number;

  constructor(maxPerSecond = 10) {
    this.maxPerSecond = maxPerSecond;
    setInterval(() => this.flush(), 1000 / maxPerSecond);
  }

  async throttle<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try { resolve(await fn()); } catch (e) { reject(e); }
      });
    });
  }

  private flush() {
    const task = this.queue.shift();
    if (task) task();
  }
}

const limiter = new RateLimiter(8);

// ─── BINANCE REST HELPERS ─────────────────────────────────────────────────────

async function binanceFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${BINANCE_REST}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await limiter.throttle(() => fetch(url.toString()));
  if (!res.ok) throw new Error(`Binance ${path}: ${res.status}`);
  return res.json();
}

/** Fetch OHLCV candles from Binance Futures */
export async function fetchCandles(
  symbol: string,
  interval: Timeframe,
  limit = 500
): Promise<Candle[]> {
  const raw: [number, string, string, string, string, string, ...unknown[]][] =
    await binanceFetch('/fapi/v1/klines', {
      symbol: symbol.toUpperCase(),
      interval,
      limit: limit.toString(),
    });

  return raw.map(k => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

/** Fetch top-of-book depth */
export async function fetchOrderBook(symbol: string, limit = 20): Promise<OrderBook> {
  const raw: { bids: [string, string][]; asks: [string, string][]; T: number } =
    await binanceFetch('/fapi/v1/depth', {
      symbol: symbol.toUpperCase(),
      limit: limit.toString(),
    });

  return {
    bids: raw.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    asks: raw.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    timestamp: raw.T,
  };
}

/** Fetch ticker + OI + funding in parallel */
export async function fetchFullTicker(symbol: string): Promise<Partial<Ticker>> {
  const sym = symbol.toUpperCase();
  const [ticker, oi, funding] = await Promise.allSettled([
    binanceFetch<{ lastPrice: string; priceChangePercent: string; highPrice: string; lowPrice: string; volume: string; quoteVolume: string }>('/fapi/v1/ticker/24hr', { symbol: sym }),
    binanceFetch<{ openInterest: string }>('/fapi/v1/openInterest', { symbol: sym }),
    binanceFetch<{ lastFundingRate: string; nextFundingTime: string; markPrice: string }>('/fapi/v1/premiumIndex', { symbol: sym }),
  ]);

  return {
    symbol: sym,
    price:          ticker.status === 'fulfilled' ? parseFloat(ticker.value.lastPrice) : undefined,
    change24h:      ticker.status === 'fulfilled' ? parseFloat(ticker.value.priceChangePercent) : undefined,
    vol24h:         ticker.status === 'fulfilled' ? parseFloat(ticker.value.quoteVolume) / 1e6 : undefined,
    high24h:        ticker.status === 'fulfilled' ? parseFloat(ticker.value.highPrice) : undefined,
    low24h:         ticker.status === 'fulfilled' ? parseFloat(ticker.value.lowPrice) : undefined,
    openInterest:   oi.status === 'fulfilled' ? parseFloat(oi.value.openInterest) : undefined,
    fundingRate:    funding.status === 'fulfilled' ? parseFloat(funding.value.lastFundingRate) * 100 : undefined,
    markPrice:      funding.status === 'fulfilled' ? parseFloat(funding.value.markPrice) : undefined,
    nextFundingTime:funding.status === 'fulfilled' ? parseInt(funding.value.nextFundingTime) : undefined,
  } as Partial<Ticker>;
}

// ─── BYBIT FALLBACK ───────────────────────────────────────────────────────────

async function bybitFetchCandles(
  symbol: string,
  interval: string,
  limit = 200
): Promise<Candle[]> {
  const map: Record<string, string> = { '1m':'1','5m':'5','15m':'15','1h':'60','4h':'240','1d':'D' };
  const url = `${BYBIT_REST}/v5/market/kline?category=linear&symbol=${symbol}&interval=${map[interval]??'15'}&limit=${limit}`;
  const res = await fetch(url);
  const json: { result: { list: [string, string, string, string, string, string][] } } = await res.json();

  return (json.result?.list ?? []).reverse().map(k => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── WEBSOCKET HOOK ───────────────────────────────────────────────────────────

export interface UseMarketDataReturn {
  candles: Candle[];
  ticker: Partial<Ticker> | null;
  orderBook: OrderBook | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMarketData(
  symbol: string,
  timeframe: Timeframe
): UseMarketDataReturn {
  const [candles, setCandles]     = useState<Candle[]>([]);
  const [ticker, setTicker]       = useState<Partial<Ticker> | null>(null);
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);

  const wsRef      = useRef<WebSocket | null>(null);
  const reconnRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef  = useRef(true);
  const symRef     = useRef(symbol);
  const tfRef      = useRef(timeframe);

  // ── REST initial load ──
  const loadRest = useCallback(async () => {
    setLoading(true); setError(null);
    const sym = symRef.current;
    const tf  = tfRef.current;

    try {
      const [c, t] = await Promise.all([
        fetchCandles(sym, tf, 500),
        fetchFullTicker(sym),
      ]);
      setCandles(c);
      setTicker(t);

      // Orderbook in background (non-blocking)
      fetchOrderBook(sym, 10)
        .then(setOrderBook)
        .catch(() => {}); // silent fail ok

    } catch (e) {
      // Binance failed — try Bybit
      try {
        const c = await bybitFetchCandles(sym, tf, 300);
        setCandles(c);
        setError('Using Bybit fallback');
      } catch {
        setError('Both Binance and Bybit failed. Check CORS or network.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // ── WebSocket live candle feed ──
  const connectWS = useCallback(() => {
    if (!activeRef.current) return;
    const sym = symRef.current.toLowerCase();
    const tf  = tfRef.current;

    // Combined stream: kline + ticker + depth
    const streams = [
      `${sym}@kline_${tf}`,
      `${sym}@ticker`,
      `${sym}@depth5@100ms`,
    ].join('/');

    const ws = new WebSocket(`${BINANCE_WS}/${streams}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data as string);
        // Combined stream wraps in { stream, data }
        const stream  = (msg.stream as string) ?? '';
        const payload = msg.data ?? msg;

        if (stream.includes('@kline')) {
          const k = payload.k;
          const candle: Candle = {
            time:   k.t as number,
            open:   parseFloat(k.o),
            high:   parseFloat(k.h),
            low:    parseFloat(k.l),
            close:  parseFloat(k.c),
            volume: parseFloat(k.v),
          };
          setCandles(prev => {
            const last = prev[prev.length - 1];
            if (last && last.time === candle.time) {
              // Update current candle in place
              return [...prev.slice(0, -1), candle];
            }
            // k.x = candle is closed — append new
            if (k.x) return [...prev.slice(-499), candle];
            return [...prev.slice(0, -1), candle];
          });
        }

        if (stream.includes('@ticker')) {
          setTicker(prev => ({
            ...prev,
            price:    parseFloat(payload.c),
            change24h:parseFloat(payload.P),
            vol24h:   parseFloat(payload.q) / 1e6,
            high24h:  parseFloat(payload.h),
            low24h:   parseFloat(payload.l),
          }));
        }

        if (stream.includes('@depth5')) {
          setOrderBook({
            bids: ((payload.b ?? []) as [string, string][]).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
            asks: ((payload.a ?? []) as [string, string][]).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
            timestamp: Date.now(),
          });
        }
      } catch {}
    };

    ws.onerror = () => setError('WebSocket error — reconnecting');
    ws.onclose = () => {
      setConnected(false);
      if (activeRef.current) {
        reconnRef.current = setTimeout(connectWS, 3000);
      }
    };
  }, []);

  // ── Periodic REST refresh for OI + funding (every 60s) ──
  useEffect(() => {
    const t = setInterval(() => {
      if (activeRef.current) {
        fetchFullTicker(symRef.current).then(t => setTicker(prev => ({ ...prev, ...t }))).catch(() => {});
      }
    }, 60000);
    return () => clearInterval(t);
  }, []);

  // ── Mount / unmount ──
  useEffect(() => {
    activeRef.current = true;
    symRef.current   = symbol;
    tfRef.current    = timeframe;
    setCandles([]); setTicker(null);

    loadRest().then(connectWS);

    return () => {
      activeRef.current = false;
      if (reconnRef.current) clearTimeout(reconnRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [symbol, timeframe, loadRest, connectWS]);

  return {
    candles, ticker, orderBook, connected, loading, error,
    refresh: loadRest,
  };
}

// ─── MULTI-TIMEFRAME CANDLES HOOK ─────────────────────────────────────────────

export function useMultiTimeframeCandles(
  symbol: string,
  timeframes: Timeframe[]
): Record<Timeframe, Candle[]> {
  const [data, setData] = useState<Record<Timeframe, Candle[]>>({} as Record<Timeframe, Candle[]>);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const results = await Promise.allSettled(
        timeframes.map(tf => fetchCandles(symbol, tf, 200))
      );

      if (cancelled) return;

      const next = {} as Record<Timeframe, Candle[]>;
      timeframes.forEach((tf, i) => {
        if (results[i].status === 'fulfilled') {
          next[tf] = (results[i] as PromiseFulfilledResult<Candle[]>).value;
        }
      });
      setData(next);
    };

    load();
    const t = setInterval(load, 5 * 60 * 1000); // refresh every 5min
    return () => { cancelled = true; clearInterval(t); };
  }, [symbol, timeframes.join(',')]);

  return data;
}
