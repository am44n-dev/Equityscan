#!/usr/bin/env node
"use strict";
/**
 * EquityScan — single-file app.
 *
 * Runs the full backend (real NSE data via stock-nse-india, cached and
 * budget-limited) AND serves the frontend, from one file.
 *
 *   npm install express cors stock-nse-india
 *   node equityscan.js
 *   open http://localhost:3000
 *
 * Everything below is organized the same way the multi-file version was
 * (config / cache / budget / provider / normalize / services / routes) —
 * just inlined into one process so there's a single file to run. See
 * README.md in this bundle for the full write-up of the caching and
 * daily-budget strategy.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { NseIndia } = require("stock-nse-india");

/* ============================================================
   CONFIG
   ============================================================ */
function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  port: num("PORT", 3000),
  frontendOrigin: process.env.FRONTEND_ORIGIN || "*",
  dailyCallBudget: num("DAILY_CALL_BUDGET", 50),
  quoteCacheTtl: num("QUOTE_CACHE_TTL", 5 * 60 * 1000),
  marketStatusCacheTtl: num("MARKET_STATUS_CACHE_TTL", 60 * 1000),
  requestTimeout: num("REQUEST_TIMEOUT", 10000),
  maxConcurrency: num("MAX_CONCURRENCY", 4),
  maxRetries: num("MAX_RETRIES", 2),
  refreshIntervalMs: num("REFRESH_INTERVAL_MS", 15 * 60 * 1000),
  universe: [
    "TCS", "RELIANCE", "HDFCBANK", "INFY", "ICICIBANK", "BHARTIARTL", "SBIN",
    "ITC", "LT", "KOTAKBANK", "HINDUNILVR", "AXISBANK", "BAJFINANCE", "MARUTI",
    "ASIANPAINT", "WIPRO", "TITAN", "SUNPHARMA", "NTPC", "ADANIENT",
    "ULTRACEMCO", "POWERGRID", "NESTLEIND", "TATAMOTORS", "JSWSTEEL",
  ],
};

/* ============================================================
   ERRORS
   ============================================================ */
class ApiError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus || 500;
  }
  toJSON() {
    return { success: false, error: { code: this.code, message: this.message } };
  }
}
const Errors = {
  invalidSymbol: (sym) => new ApiError("INVALID_SYMBOL", `"${sym}" is not a valid NSE symbol.`, 400),
  invalidParameters: (msg) => new ApiError("INVALID_PARAMETERS", msg, 400),
  notFound: (msg) => new ApiError("NOT_FOUND", msg || "Resource not found.", 404),
  rateLimited: (msg) => new ApiError("RATE_LIMITED", msg || "Upstream rate limit reached. Try again shortly.", 429),
  budgetExhausted: () => new ApiError("RATE_LIMITED", "Daily upstream call budget is exhausted; serving cached data only until reset.", 429),
  providerForbidden: () => new ApiError("PROVIDER_FORBIDDEN", "NSE rejected the upstream request.", 502),
  providerUnavailable: (msg) => new ApiError("PROVIDER_UNAVAILABLE", msg || "Market data service is temporarily unavailable.", 503),
  timeout: () => new ApiError("TIMEOUT", "Upstream request timed out.", 504),
  invalidProviderResponse: () => new ApiError("INVALID_PROVIDER_RESPONSE", "Upstream returned an unexpected response shape.", 502),
  internal: (msg) => new ApiError("INTERNAL_ERROR", msg || "Internal server error.", 500),
};

/* ============================================================
   VALIDATION
   ============================================================ */
const SYMBOL_RE = /^[A-Z0-9&\-]{1,20}$/;
function cleanSymbol(raw) {
  if (typeof raw !== "string") throw Errors.invalidSymbol(String(raw));
  const sym = raw.trim().toUpperCase();
  if (!SYMBOL_RE.test(sym)) throw Errors.invalidSymbol(raw);
  return sym;
}
function cleanNumber(raw, { name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw Errors.invalidParameters(`"${name}" must be a finite number.`);
  if (n < min || n > max) throw Errors.invalidParameters(`"${name}" must be between ${min} and ${max}.`);
  return n;
}

/* ============================================================
   CACHE (TTL + in-flight dedup)
   ============================================================ */
class CacheService {
  constructor() { this.store = new Map(); this.inFlight = new Map(); }
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return undefined; }
    return entry.value;
  }
  getStale(key) { const entry = this.store.get(key); return entry ? entry.value : undefined; }
  set(key, value, ttlMs) { this.store.set(key, { value, expiresAt: Date.now() + ttlMs }); return value; }
  async dedupe(key, fn) {
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const p = Promise.resolve().then(fn).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }
}
const cache = new CacheService();

/* ============================================================
   DAILY CALL BUDGET (persisted, resets at 00:00 IST)
   ============================================================ */
const STATE_FILE = path.join(__dirname, ".budget-state.json");
function istDateKey(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}
class BudgetService {
  constructor() { this.limit = config.dailyCallBudget; this.load(); }
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (parsed.date === istDateKey()) { this.date = parsed.date; this.used = parsed.used; return; }
    } catch (e) { /* no state file yet, or corrupt — start fresh */ }
    this.date = istDateKey(); this.used = 0; this.persist();
  }
  persist() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ date: this.date, used: this.used })); }
    catch (e) { console.error("[EquityScan] failed to persist budget state:", e.message); }
  }
  rolloverIfNeeded() {
    const today = istDateKey();
    if (today !== this.date) { this.date = today; this.used = 0; this.persist(); }
  }
  remaining() { this.rolloverIfNeeded(); return Math.max(0, this.limit - this.used); }
  canSpend(n = 1) { return this.remaining() >= n; }
  spend(n = 1) { this.rolloverIfNeeded(); this.used += n; this.persist(); return this.remaining(); }
  status() { this.rolloverIfNeeded(); return { date: this.date, limit: this.limit, used: this.used, remaining: this.remaining() }; }
}
const budget = new BudgetService();

/* ============================================================
   PROVIDER ADAPTER — the only place that talks to NSE
   ============================================================ */
const nse = new NseIndia();

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Errors.timeout()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function classifyHttpError(err) {
  const status = err?.response?.status || err?.status;
  if (status === 403) return Errors.providerForbidden();
  if (status === 429) return Errors.rateLimited("NSE rate-limited this request.");
  if (status === 404) return Errors.notFound("Symbol not found on NSE.");
  if (status >= 500) return Errors.providerUnavailable(`NSE returned ${status}.`);
  return Errors.providerUnavailable(err?.message);
}
async function withRetry(fn, { maxRetries, label }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(fn(), config.requestTimeout);
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      if (status === 403) throw classifyHttpError(err);
      if (err && err.code === "TIMEOUT" && attempt === maxRetries) throw err;
      if (attempt < maxRetries) {
        const backoff = 250 * Math.pow(2, attempt);
        console.warn(`[EquityScan] ${label} attempt ${attempt + 1} failed (${status || err.code || err.message}); retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
    }
  }
  if (lastErr && lastErr.code) throw lastErr;
  throw classifyHttpError(lastErr);
}
async function providerGetEquity(symbol) {
  return withRetry(() => nse.getEquityDetails(symbol), { maxRetries: config.maxRetries, label: `getEquityDetails(${symbol})` });
}
async function providerGetMarketStatus() {
  return withRetry(() => nse.getMarketStatus(), { maxRetries: config.maxRetries, label: "getMarketStatus" });
}
async function providerGetAllSymbols() {
  try { return await withRetry(() => nse.getAllStockSymbols(), { maxRetries: 1, label: "getAllStockSymbols" }); }
  catch (e) { return null; }
}

/* ============================================================
   NORMALIZATION — map raw NSE shape to EquityScan's stable contract.
   Only fields the provider actually returns are mapped; market cap is
   not reliably available from NSE's free equity endpoint, so it's
   always null rather than guessed. See README "Data Integrity".
   ============================================================ */
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function normalizeEquity(symbol, raw) {
  if (!raw || typeof raw !== "object") return null;
  const info = raw.info || {};
  const priceInfo = raw.priceInfo || {};
  const weekHighLow = priceInfo.weekHighLow || {};
  const securityInfo = raw.securityInfo || {};

  const currentPrice = n(priceInfo.lastPrice);
  const week52High = n(weekHighLow.max);
  const marketCap = null; // never fabricated — see comment above
  const volume = n(priceInfo.totalTradedVolume ?? securityInfo.totalTradedVolume);

  const required = [currentPrice, week52High, marketCap];
  const missing = required.filter((v) => v === null || v === undefined).length;
  const dataStatus = missing === 0 ? "COMPLETE" : missing === required.length ? "UNAVAILABLE" : "PARTIAL";

  return {
    symbol,
    companyName: info.companyName || null,
    exchange: "NSE",
    sector: info.industry || null,
    currentPrice,
    previousClose: n(priceInfo.previousClose),
    change: n(priceInfo.change),
    percentChange: n(priceInfo.pChange),
    open: n(priceInfo.open),
    dayHigh: priceInfo.intraDayHighLow ? n(priceInfo.intraDayHighLow.max) : null,
    dayLow: priceInfo.intraDayHighLow ? n(priceInfo.intraDayHighLow.min) : null,
    week52High,
    week52Low: n(weekHighLow.min),
    marketCap,
    volume,
    lastUpdated: priceInfo.lastUpdateTime || null,
    dataStatus,
  };
}

/* ============================================================
   CONCURRENCY-LIMITED BATCH RUNNER
   ============================================================ */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runOne() {
    while (cursor < items.length) {
      const idx = cursor++;
      try { results[idx] = { ok: true, value: await worker(items[idx], idx) }; }
      catch (err) { results[idx] = { ok: false, error: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}

/* ============================================================
   STOCK SERVICE — cache-first, budget-aware, deduplicated
   ============================================================ */
const keyFor = (symbol) => `equity:${symbol}`;
async function getNormalizedEquity(symbol) {
  const key = keyFor(symbol);
  const fresh = cache.get(key);
  if (fresh) return { data: fresh, source: "cache" };

  return cache.dedupe(key, async () => {
    const freshAfterWait = cache.get(key);
    if (freshAfterWait) return { data: freshAfterWait, source: "cache" };

    if (!budget.canSpend(1)) {
      const stale = cache.getStale(key);
      if (stale) return { data: stale, source: "stale-cache-budget-exhausted" };
      throw Errors.budgetExhausted();
    }
    const raw = await providerGetEquity(symbol);
    budget.spend(1);
    const normalized = normalizeEquity(symbol, raw);
    if (!normalized) throw Errors.invalidProviderResponse();
    cache.set(key, normalized, config.quoteCacheTtl);
    return { data: normalized, source: "provider" };
  });
}
async function getRawEquity(symbol) {
  const key = `raw:${symbol}`;
  const fresh = cache.get(key);
  if (fresh) return { data: fresh, source: "cache" };

  return cache.dedupe(key, async () => {
    const freshAfterWait = cache.get(key);
    if (freshAfterWait) return { data: freshAfterWait, source: "cache" };

    if (!budget.canSpend(1)) {
      const stale = cache.getStale(key);
      if (stale) return { data: stale, source: "stale-cache-budget-exhausted" };
      throw Errors.budgetExhausted();
    }
    const raw = await providerGetEquity(symbol);
    budget.spend(1);
    cache.set(key, raw, config.quoteCacheTtl);
    return { data: raw, source: "provider" };
  });
}

/* ============================================================
   MARKET SERVICE
   ============================================================ */
const MARKET_KEY = "market:status";
async function getMarketStatus() {
  const fresh = cache.get(MARKET_KEY);
  if (fresh) return { data: fresh, source: "cache" };

  return cache.dedupe(MARKET_KEY, async () => {
    const freshAfterWait = cache.get(MARKET_KEY);
    if (freshAfterWait) return { data: freshAfterWait, source: "cache" };

    if (!budget.canSpend(1)) {
      const stale = cache.getStale(MARKET_KEY);
      if (stale) return { data: stale, source: "stale-cache-budget-exhausted" };
      return { data: { market: "NSE", status: "UNKNOWN", tradeDate: null, lastUpdated: null }, source: "unavailable" };
    }
    try {
      const raw = await providerGetMarketStatus();
      budget.spend(1);
      const marketBlock = Array.isArray(raw?.marketState) ? (raw.marketState.find((m) => m.market === "Capital Market") || raw.marketState[0]) : null;
      const normalized = {
        market: "NSE",
        status: marketBlock?.marketStatus ? (marketBlock.marketStatus.toUpperCase().includes("OPEN") ? "OPEN" : "CLOSED") : "UNKNOWN",
        tradeDate: marketBlock?.tradeDate || null,
        lastUpdated: new Date().toISOString(),
      };
      cache.set(MARKET_KEY, normalized, config.marketStatusCacheTtl);
      return { data: normalized, source: "provider" };
    } catch (err) {
      const stale = cache.getStale(MARKET_KEY);
      if (stale) return { data: stale, source: "stale-cache-provider-error" };
      throw err && err.code ? err : Errors.providerUnavailable();
    }
  });
}

/* ============================================================
   SCREENER SERVICE + background pre-warmer
   ============================================================ */
function evaluate(equity, marketCapMin, highPercentMin) {
  const { currentPrice, week52High, marketCap } = equity;
  const missing = currentPrice === null || week52High === null || marketCap === null;
  if (missing) {
    return {
      symbol: equity.symbol, companyName: equity.companyName, currentPrice,
      change: equity.change, percentChange: equity.percentChange, week52High,
      highPercent: null, marketCap, status: "DATA_UNAVAILABLE",
    };
  }
  const highPercent = (currentPrice / week52High) * 100;
  const passes = marketCap >= marketCapMin && highPercent >= highPercentMin;
  return {
    symbol: equity.symbol, companyName: equity.companyName, currentPrice,
    change: equity.change, percentChange: equity.percentChange, week52High,
    highPercent: Number(highPercent.toFixed(2)), marketCap, status: passes ? "PASS" : "FAIL",
  };
}
async function runScreener({ marketCapMin, highPercentMin, symbols }) {
  const universe = symbols && symbols.length ? symbols : config.universe;
  const outcomes = await mapWithConcurrency(universe, config.maxConcurrency, async (symbol) => {
    const { data } = await getNormalizedEquity(symbol);
    return data;
  });
  const results = [];
  let passed = 0, failed = 0, dataUnavailable = 0;
  outcomes.forEach((outcome, i) => {
    if (!outcome.ok) {
      results.push({ symbol: universe[i], companyName: null, currentPrice: null, change: null, percentChange: null, week52High: null, highPercent: null, marketCap: null, status: "DATA_UNAVAILABLE" });
      dataUnavailable++; return;
    }
    const evaluated = evaluate(outcome.value, marketCapMin, highPercentMin);
    if (evaluated.status === "PASS") passed++; else if (evaluated.status === "FAIL") failed++; else dataUnavailable++;
    results.push(evaluated);
  });
  return { criteria: { marketCapMin, highPercentMin }, summary: { scanned: universe.length, passed, failed, dataUnavailable }, results };
}
let refreshCursor = 0;
function startBackgroundRefresh() {
  const BATCH_SIZE = Math.max(1, Math.min(config.maxConcurrency, 3));
  setInterval(async () => {
    const batch = [];
    for (let i = 0; i < BATCH_SIZE; i++) { batch.push(config.universe[refreshCursor % config.universe.length]); refreshCursor++; }
    for (const symbol of batch) {
      try { await getNormalizedEquity(symbol); } catch (e) { /* budget exhausted or upstream error — skip silently */ }
    }
  }, config.refreshIntervalMs).unref();
}

/* ============================================================
   EXPRESS APP
   ============================================================ */
const app = express();
app.use(cors({ origin: config.frontendOrigin }));
app.use(express.json());
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => console.log(`[EquityScan] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`));
  next();
});

function errorMiddleware(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof ApiError) { console.error(`[EquityScan] ${err.code}: ${err.message}`); return res.status(err.httpStatus).json(err.toJSON()); }
  console.error("[EquityScan] unhandled error:", err);
  return res.status(500).json(Errors.internal().toJSON());
}

// --- API routes ---
app.get("/api/health", (req, res) => {
  res.json({ success: true, service: "EquityScan Backend", status: "healthy", provider: "stock-nse-india", timestamp: new Date().toISOString() });
});

app.get("/api/stock/:symbol", async (req, res, next) => {
  try { const symbol = cleanSymbol(req.params.symbol); const { data } = await getNormalizedEquity(symbol); res.json({ success: true, data }); }
  catch (err) { next(err); }
});

app.get("/api/equity/:symbol", async (req, res, next) => {
  try { const symbol = cleanSymbol(req.params.symbol); const { data } = await getRawEquity(symbol); res.json(data); }
  catch (err) { next(err); }
});

app.get("/api/screener", async (req, res, next) => {
  try {
    const marketCapMin = cleanNumber(req.query.marketCapMin, { name: "marketCapMin", fallback: 100, min: 0, max: 100_000_000 });
    const highPercentMin = cleanNumber(req.query.highPercentMin, { name: "highPercentMin", fallback: 80, min: 0, max: 100 });
    const result = await runScreener({ marketCapMin, highPercentMin });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

app.get("/api/market/status", async (req, res, next) => {
  try { const { data } = await getMarketStatus(); res.json({ success: true, ...data }); }
  catch (err) { next(err); }
});

app.get("/api/symbols", async (req, res, next) => {
  try {
    const all = await providerGetAllSymbols();
    const symbols = Array.isArray(all) && all.length ? all : config.universe;
    res.json({ success: true, count: symbols.length, symbols });
  } catch (err) { next(err); }
});

app.get("/api/provider/status", (req, res) => {
  res.json({
    provider: "stock-nse-india",
    status: "available",
    cacheEnabled: true,
    dailyBudget: budget.status()
  });
});

app.get("/debug-nse", async (req, res) => {
  try {
    const result = await nse.getEquityDetails("TCS");

    res.json({
      ok: true,
      status: 200,
      result
    });
  } catch (err) {
    console.error("NSE DEBUG ERROR:", err);

    res.status(500).json({
      ok: false,
      message: err?.message || "Unknown error",
      status: err?.response?.status ?? err?.status ?? null,
      response: err?.response?.data ?? null,
      code: err?.code ?? null
    });
  }
});

// --- Frontend (embedded, base64-decoded at startup) ---
const FRONTEND_B64_CHUNKS = [
  "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAsIHZpZXdwb3J0LWZpdD1jb3Zl",
  "ciI+Cjx0aXRsZT5FcXVpdHlTY2FuIOKAlCBTdG9jayBJbnRlbGxpZ2VuY2U8L3RpdGxlPgo8bGluayByZWw9InByZWNvbm5lY3QiIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20iPgo8bGluayByZWw9InByZWNvbm5lY3QiIGhyZWY9Imh0dHBzOi8v",
  "Zm9udHMuZ3N0YXRpYy5jb20iIGNyb3Nzb3JpZ2luPgo8bGluayBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tL2NzczI/ZmFtaWx5PU1hbnJvcGU6d2dodEA0MDA7NTAwOzYwMDs3MDA7ODAwJmZhbWlseT1KZXRCcmFpbnMrTW9ubzp3Z2h0QDQwMDs1",
  "MDA7NjAwOzcwMCZkaXNwbGF5PXN3YXAiIHJlbD0ic3R5bGVzaGVldCI+CjxzdHlsZT4KLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFRPS0VOUwogICA9PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KOnJvb3R7CiAgLS1iZy12b2lkOiMwNTA2MEI7CiAgLS1iZy1iYXNlOiMwODBBMTM7CiAgLS1iZy1zdXJmYWNlOiMwRDExMjA7CiAgLS1iZy1lbGV2YXRlZDojMTMxODI5OwogIC0tYmctZWxl",
  "dmF0ZWQtMjojMTcxRDMyOwogIC0tYm9yZGVyLWhhaXI6cmdiYSgxNTgsMTcxLDIxNCwwLjEwKTsKICAtLWJvcmRlci1zb2Z0OnJnYmEoMTU4LDE3MSwyMTQsMC4xNik7CiAgLS1ib3JkZXItc3Ryb25nOnJnYmEoMTU4LDE3MSwyMTQsMC4yNik7CgogIC0taW5kaWdv",
  "LTkwMDojMEIwRTFFOwogIC0taW5kaWdvLTcwMDojMUEyMTQwOwogIC0tYmx1ZTojNEM3REZGOwogIC0tYmx1ZS1zb2Z0OiM3REEwRkY7CiAgLS12aW9sZXQ6IzhCNkJGMDsKICAtLXZpb2xldC1zb2Z0OiNBOThDRkY7CiAgLS1jeWFuOiMzMUQ1RUU7CgogIC0tcG9z",
  "OiMzM0Q2QTY7CiAgLS1wb3Mtc29mdDojOEZGMEQ0OwogIC0tcG9zLWJnOnJnYmEoNTEsMjE0LDE2NiwwLjEwKTsKICAtLW5lZzojRkI2QjZCOwogIC0tbmVnLXNvZnQ6I0ZGOUI5QjsKICAtLW5lZy1iZzpyZ2JhKDI1MSwxMDcsMTA3LDAuMTApOwoKICAtLXRleHQt",
  "aGk6I0YzRjVGQzsKICAtLXRleHQtbWlkOiNBRUI2RDQ7CiAgLS10ZXh0LWxvOiM2QjczOTg7CiAgLS10ZXh0LWZhaW50OiM0NTRDNkU7CgogIC0tcmFkaXVzLXM6OHB4OwogIC0tcmFkaXVzLW06MTJweDsKICAtLXJhZGl1cy1sOjE4cHg7CiAgLS1yYWRpdXMteGw6",
  "MjZweDsKCiAgLS1mb250LXVpOidNYW5yb3BlJywtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwnU2Vnb2UgVUknLHNhbnMtc2VyaWY7CiAgLS1mb250LW51bTonSmV0QnJhaW5zIE1vbm8nLCdTRiBNb25vJyxDb25zb2xhcyxtb25vc3BhY2U7CgogIC0t",
  "ZWFzZS1vdXQ6Y3ViaWMtYmV6aWVyKC4xNiwxLC4zLDEpOwogIC0tZWFzZS1zcHJpbmc6Y3ViaWMtYmV6aWVyKC4zNCwxLjU2LC42NCwxKTsKCiAgY29sb3Itc2NoZW1lOiBkYXJrOwp9CgpAbWVkaWEgKHByZWZlcnMtY29sb3Itc2NoZW1lOiBsaWdodCl7CiAgOnJv",
  "b3Q6bm90KFtkYXRhLXRoZW1lPSJkYXJrIl0pewogICAgLS1iZy12b2lkOiNGM0Y0Rjk7IC0tYmctYmFzZTojRURFRkY2OyAtLWJnLXN1cmZhY2U6I0ZGRkZGRjsgLS1iZy1lbGV2YXRlZDojRkZGRkZGOyAtLWJnLWVsZXZhdGVkLTI6I0Y2RjdGQzsKICAgIC0tYm9y",
  "ZGVyLWhhaXI6cmdiYSgzMCwzNSw3MCwwLjA4KTsgLS1ib3JkZXItc29mdDpyZ2JhKDMwLDM1LDcwLDAuMTMpOyAtLWJvcmRlci1zdHJvbmc6cmdiYSgzMCwzNSw3MCwwLjIyKTsKICAgIC0tdGV4dC1oaTojMTIxNDJBOyAtLXRleHQtbWlkOiM0QzUxNzA7IC0tdGV4",
  "dC1sbzojODY4Q0FEOyAtLXRleHQtZmFpbnQ6I0I3QkJENDsKICAgIGNvbG9yLXNjaGVtZTogbGlnaHQ7CiAgfQp9Cjpyb290W2RhdGEtdGhlbWU9ImRhcmsiXXsKICAtLWJnLXZvaWQ6IzA1MDYwQjsgLS1iZy1iYXNlOiMwODBBMTM7IC0tYmctc3VyZmFjZTojMEQx",
  "MTIwOyAtLWJnLWVsZXZhdGVkOiMxMzE4Mjk7IC0tYmctZWxldmF0ZWQtMjojMTcxRDMyOwogIC0tdGV4dC1oaTojRjNGNUZDOyAtLXRleHQtbWlkOiNBRUI2RDQ7IC0tdGV4dC1sbzojNkI3Mzk4OyAtLXRleHQtZmFpbnQ6IzQ1NEM2RTsKICBjb2xvci1zY2hlbWU6",
  "IGRhcms7Cn0KCiosKjo6YmVmb3JlLCo6OmFmdGVye2JveC1zaXppbmc6Ym9yZGVyLWJveDt9Cmh0bWwsYm9keXtoZWlnaHQ6MTAwJTt9CmJvZHl7CiAgbWFyZ2luOjA7CiAgYmFja2dyb3VuZDp2YXIoLS1iZy12b2lkKTsKICBjb2xvcjp2YXIoLS10ZXh0LWhpKTsK",
  "ICBmb250LWZhbWlseTp2YXIoLS1mb250LXVpKTsKICAtd2Via2l0LWZvbnQtc21vb3RoaW5nOmFudGlhbGlhc2VkOwogIG92ZXJmbG93LXg6aGlkZGVuOwogIG1pbi1oZWlnaHQ6MTAwdmg7Cn0KOjpzZWxlY3Rpb257YmFja2dyb3VuZDpyZ2JhKDc2LDEyNSwyNTUs",
  "MC4zNSk7Y29sb3I6I2ZmZjt9CmF7Y29sb3I6aW5oZXJpdDt0ZXh0LWRlY29yYXRpb246bm9uZTt9CmJ1dHRvbntmb250LWZhbWlseTppbmhlcml0O30KOjotd2Via2l0LXNjcm9sbGJhcnt3aWR0aDoxMHB4O2hlaWdodDoxMHB4O30KOjotd2Via2l0LXNjcm9sbGJh",
  "ci10cmFja3tiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O30KOjotd2Via2l0LXNjcm9sbGJhci10aHVtYntiYWNrZ3JvdW5kOnZhcigtLWJvcmRlci1zdHJvbmcpO2JvcmRlci1yYWRpdXM6OHB4O30KCi50YWJ1bGFye2ZvbnQtdmFyaWFudC1udW1lcmljOnRhYnVsYXIt",
  "bnVtcztmb250LWZlYXR1cmUtc2V0dGluZ3M6InRudW0iIDE7fQoubW9ub3tmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7fQoKQG1lZGlhIChwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpewogICosKjo6YmVmb3JlLCo6OmFmdGVye2FuaW1hdGlvbi1k",
  "dXJhdGlvbjowLjAwMW1zICFpbXBvcnRhbnQ7YW5pbWF0aW9uLWl0ZXJhdGlvbi1jb3VudDoxICFpbXBvcnRhbnQ7dHJhbnNpdGlvbi1kdXJhdGlvbjowLjAwMW1zICFpbXBvcnRhbnQ7fQp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT0KICAgQU1CSUVOVCBCQUNLR1JPVU5ECiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwouYW1iaWVudHsKICBwb3NpdGlvbjpmaXhlZDtpbnNldDowO3ot",
  "aW5kZXg6MDtwb2ludGVyLWV2ZW50czpub25lO292ZXJmbG93OmhpZGRlbjsKfQouYW1iaWVudDo6YmVmb3JlewogIGNvbnRlbnQ6IiI7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6LTIwJTsKICBiYWNrZ3JvdW5kOgogICAgcmFkaWFsLWdyYWRpZW50KDQ4JSAzOCUg",
  "YXQgMTglIDglLCByZ2JhKDc2LDEyNSwyNTUsMC4xNiksIHRyYW5zcGFyZW50IDYwJSksCiAgICByYWRpYWwtZ3JhZGllbnQoNDAlIDM0JSBhdCA4NiUgMTglLCByZ2JhKDEzOSwxMDcsMjQwLDAuMTQpLCB0cmFuc3BhcmVudCA2MCUpLAogICAgcmFkaWFsLWdyYWRp",
  "ZW50KDUwJSA0MCUgYXQgNTAlIDEwMCUsIHJnYmEoNDksMjEzLDIzOCwwLjA2KSwgdHJhbnNwYXJlbnQgNjAlKTsKICBhbmltYXRpb246ZHJpZnRHbG93IDI2cyBlYXNlLWluLW91dCBpbmZpbml0ZSBhbHRlcm5hdGU7Cn0KQGtleWZyYW1lcyBkcmlmdEdsb3d7CiAg",
  "MCV7dHJhbnNmb3JtOnRyYW5zbGF0ZTNkKDAsMCwwKSBzY2FsZSgxKTt9CiAgMTAwJXt0cmFuc2Zvcm06dHJhbnNsYXRlM2QoLTIlLDIlLDApIHNjYWxlKDEuMDYpO30KfQouYW1iaWVudC1ncmlkewogIHBvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7b3BhY2l0eTow",
  "LjM1OwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQodmFyKC0tYm9yZGVyLWhhaXIpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgdmFyKC0tYm9yZGVyLWhhaXIpIDFweCwgdHJhbnNwYXJlbnQg",
  "MXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6NjRweCA2NHB4OwogIG1hc2staW1hZ2U6cmFkaWFsLWdyYWRpZW50KDcwJSA2MCUgYXQgNTAlIDIwJSwgYmxhY2ssIHRyYW5zcGFyZW50IDg1JSk7Cn0KLmFtYmllbnQtbGluZXN7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6",
  "MDtvcGFjaXR5OjAuNTt9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgSEVBREVSCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PSAqLwpoZWFkZXIudG9wYmFyewogIHBvc2l0aW9uOnN0aWNreTt0b3A6MDt6LWluZGV4OjUwOwogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjI4cHg7CiAgcGFkZGluZzowIDI4cHg7aGVpZ2h0OjY0cHg7CiAgYmFja2dyb3VuZDpyZ2Jh",
  "KDgsMTAsMTksMC41NSk7CiAgYmFja2Ryb3AtZmlsdGVyOmJsdXIoMThweCkgc2F0dXJhdGUoMTQwJSk7CiAgLXdlYmtpdC1iYWNrZHJvcC1maWx0ZXI6Ymx1cigxOHB4KSBzYXR1cmF0ZSgxNDAlKTsKICBib3JkZXItYm90dG9tOjFweCBzb2xpZCB0cmFuc3BhcmVu",
  "dDsKICB0cmFuc2l0aW9uOmJhY2tncm91bmQgLjM1cyB2YXIoLS1lYXNlLW91dCksIGJvcmRlci1jb2xvciAuMzVzIHZhcigtLWVhc2Utb3V0KSwgYm94LXNoYWRvdyAuMzVzIHZhcigtLWVhc2Utb3V0KTsKfQpoZWFkZXIudG9wYmFyLnNjcm9sbGVkewogIGJhY2tn",
  "cm91bmQ6cmdiYSg4LDEwLDE5LDAuODYpOwogIGJvcmRlci1ib3R0b20tY29sb3I6dmFyKC0tYm9yZGVyLWhhaXIpOwogIGJveC1zaGFkb3c6MCAxMnB4IDMwcHggLTE4cHggcmdiYSgwLDAsMCwwLjYpOwp9Ci5icmFuZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6",
  "Y2VudGVyO2dhcDoxMXB4O2ZvbnQtd2VpZ2h0OjgwMDtsZXR0ZXItc3BhY2luZzotMC4wMWVtO2ZvbnQtc2l6ZToxOHB4O2ZsZXgtc2hyaW5rOjA7fQouYnJhbmQtbWFya3sKICB3aWR0aDozMnB4O2hlaWdodDozMnB4O2JvcmRlci1yYWRpdXM6OXB4O3Bvc2l0aW9u",
  "OnJlbGF0aXZlO2ZsZXgtc2hyaW5rOjA7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTUwZGVnLHZhcigtLWluZGlnby03MDApLHZhcigtLWJnLWVsZXZhdGVkLTIpKTsKICBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1zb2Z0KTsKICBib3gtc2hh",
  "ZG93OjAgNnB4IDE4cHggLThweCByZ2JhKDc2LDEyNSwyNTUsMC41NSk7CiAgZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyOwp9Ci5icmFuZC1tYXJrIHN2Z3t3aWR0aDoxOXB4O2hlaWdodDoxOXB4O2Rpc3BsYXk6",
  "YmxvY2s7fQouYnJhbmQtd29yZG1hcmt7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtsaW5lLWhlaWdodDoxLjE1O30KLmJyYW5kLXdvcmRtYXJrIC5lcXtjb2xvcjp2YXIoLS10ZXh0LWhpKTt9Ci5icmFuZC13b3JkbWFyayAuc2NhbnsKICBiYWNr",
  "Z3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMjBkZWcsdmFyKC0tYmx1ZS1zb2Z0KSx2YXIoLS12aW9sZXQtc29mdCkpOwogIC13ZWJraXQtYmFja2dyb3VuZC1jbGlwOnRleHQ7YmFja2dyb3VuZC1jbGlwOnRleHQ7Y29sb3I6dHJhbnNwYXJlbnQ7Cn0KLmJyYW5kIHNt",
  "YWxse2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6OS41cHg7bGV0dGVyLXNwYWNpbmc6MC4xZW07ZGlzcGxheTpibG9jazttYXJnaW4tdG9wOjFweDt9CgpuYXYubWFpbm5hdntkaXNwbGF5OmZsZXg7Z2FwOjRweDtmbGV4OjE7",
  "fQpuYXYubWFpbm5hdiBidXR0b257CiAgYmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO2NvbG9yOnZhcigtLXRleHQtbWlkKTtmb250LXNpemU6MTRweDtmb250LXdlaWdodDo2MDA7CiAgcGFkZGluZzo4cHggMTRweDtib3JkZXItcmFkaXVzOjlweDtjdXJzb3I6",
  "cG9pbnRlcjtwb3NpdGlvbjpyZWxhdGl2ZTsKICB0cmFuc2l0aW9uOmNvbG9yIC4ycyB2YXIoLS1lYXNlLW91dCksIGJhY2tncm91bmQgLjJzIHZhcigtLWVhc2Utb3V0KTsKfQpuYXYubWFpbm5hdiBidXR0b246aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dC1oaSk7YmFj",
  "a2dyb3VuZDp2YXIoLS1ib3JkZXItaGFpcik7fQpuYXYubWFpbm5hdiBidXR0b24uYWN0aXZle2NvbG9yOnZhcigtLXRleHQtaGkpO30KbmF2Lm1haW5uYXYgYnV0dG9uLmFjdGl2ZTo6YWZ0ZXJ7CiAgY29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtsZWZ0OjE0",
  "cHg7cmlnaHQ6MTRweDtib3R0b206MnB4O2hlaWdodDoycHg7Ym9yZGVyLXJhZGl1czoycHg7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsdmFyKC0tYmx1ZSksdmFyKC0tdmlvbGV0KSk7Cn0KCi5oZWFkZXItcmlnaHR7ZGlzcGxheTpmbGV4O2Fs",
  "aWduLWl0ZW1zOmNlbnRlcjtnYXA6MTJweDtmbGV4LXNocmluazowO30KLm1hcmtldC1waWxsewogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjdweDtwYWRkaW5nOjZweCAxMnB4O2JvcmRlci1yYWRpdXM6OTlweDsKICBiYWNrZ3JvdW5kOnZh",
  "cigtLWJnLWVsZXZhdGVkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7Zm9udC13ZWlnaHQ6NjAwOwp9Ci5kb3QtbGl2ZXt3aWR0aDo2cHg7aGVpZ2h0OjZweDtib3JkZXItcmFk",
  "aXVzOjUwJTtiYWNrZ3JvdW5kOnZhcigtLXBvcyk7Ym94LXNoYWRvdzowIDAgMCAzcHggdmFyKC0tcG9zLWJnKTthbmltYXRpb246cHVsc2VEb3QgMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7fQpAa2V5ZnJhbWVzIHB1bHNlRG90ezAlLDEwMCV7b3BhY2l0eToxO301",
  "MCV7b3BhY2l0eTouNDU7fX0KCi5pY29uLWJ0bnsKICB3aWR0aDozNnB4O2hlaWdodDozNnB4O2JvcmRlci1yYWRpdXM6MTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtiYWNrZ3JvdW5kOnZhcigtLWJnLWVsZXZhdGVkKTsKICBkaXNwbGF5",
  "OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6dmFyKC0tdGV4dC1taWQpO2N1cnNvcjpwb2ludGVyOwogIHRyYW5zaXRpb246YWxsIC4xOHMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5pY29uLWJ0bjpob3Zlcntjb2xvcjp2",
  "YXIoLS10ZXh0LWhpKTtib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyLXNvZnQpO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpO30KLmljb24tYnRuIHN2Z3t3aWR0aDoxNnB4O2hlaWdodDoxNnB4O30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBMQVlPVVQKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCm1haW57cG9zaXRpb246cmVsYXRpdmU7ei1pbmRleDoxO21heC13aWR0aDox",
  "MzIwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjM2cHggMjhweCAxMjBweDt9Ci52aWV3e2FuaW1hdGlvbjp2aWV3SW4gLjQycyB2YXIoLS1lYXNlLW91dCk7fQpAa2V5ZnJhbWVzIHZpZXdJbntmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSg4cHgp",
  "O310b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMCk7fX0KLnNlY3Rpb24taGVhZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6YmFzZWxpbmU7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luOjAgMCAxNnB4O30KLnNlY3Rpb24taGVh",
  "ZCBoMntmb250LXNpemU6MTVweDtmb250LXdlaWdodDo3MDA7Y29sb3I6dmFyKC0tdGV4dC1oaSk7bWFyZ2luOjA7bGV0dGVyLXNwYWNpbmc6LTAuMDFlbTt9Ci5zZWN0aW9uLWhlYWQgLnN1Yntjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTIuNXB4O30K",
  "Ci8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBHTEFTUyBDQVJEIEJBU0UKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICov",
  "Ci5nbGFzc3sKICBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxODBkZWcsIHZhcigtLWJnLWVsZXZhdGVkKSwgdmFyKC0tYmctc3VyZmFjZSkpOwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpOwogIGJvcmRlci1yYWRpdXM6dmFyKC0tcmFk",
  "aXVzLWwpOwogIHBvc2l0aW9uOnJlbGF0aXZlOwp9Ci5nbGFzczo6YmVmb3JlewogIGNvbnRlbnQ6IiI7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6MDtib3JkZXItcmFkaXVzOmluaGVyaXQ7cGFkZGluZzoxcHg7cG9pbnRlci1ldmVudHM6bm9uZTsKICBiYWNrZ3Jv",
  "dW5kOmxpbmVhci1ncmFkaWVudCgxNjBkZWcsIHJnYmEoMjU1LDI1NSwyNTUsMC4wNiksIHRyYW5zcGFyZW50IDQwJSk7CiAgLXdlYmtpdC1tYXNrOmxpbmVhci1ncmFkaWVudCgjMDAwIDAgMCkgY29udGVudC1ib3gsIGxpbmVhci1ncmFkaWVudCgjMDAwIDAgMCk7",
  "CiAgLXdlYmtpdC1tYXNrLWNvbXBvc2l0ZTp4b3I7bWFzay1jb21wb3NpdGU6ZXhjbHVkZTsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEhFUk8gLyBJTkRJQ0VTCiAgID09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwouaGVyby1yb3d7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpO2dhcDoxNHB4O21hcmdpbi1ib3R0b206MzRweDt9Ci5pbmRl",
  "eC1jYXJkewogIHBhZGRpbmc6MjBweCAyMnB4O292ZXJmbG93OmhpZGRlbjt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMjVzIHZhcigtLWVhc2Utb3V0KSwgYm9yZGVyLWNvbG9yIC4yNXMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5pbmRleC1jYXJkOmhvdmVye3RyYW5zZm9y",
  "bTp0cmFuc2xhdGVZKC0ycHgpO2JvcmRlci1jb2xvcjp2YXIoLS1ib3JkZXItc29mdCk7fQouaW5kZXgtY2FyZCAucm93MXtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9t",
  "OjE0cHg7fQouaW5kZXgtbmFtZXtmb250LXNpemU6MTIuNXB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7bGV0dGVyLXNwYWNpbmc6MC4wMWVtO30KLmluZGV4LWZ1bGx7Zm9udC1zaXplOjEwLjVweDtjb2xvcjp2YXIoLS10ZXh0LWZhaW50",
  "KTttYXJnaW4tdG9wOjJweDt9Ci5pbmRleC1iYWRnZXtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7cGFkZGluZzozcHggOHB4O2JvcmRlci1yYWRpdXM6N3B4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDt9Ci5pbmRleC1iYWRn",
  "ZS5wb3N7Y29sb3I6dmFyKC0tcG9zKTtiYWNrZ3JvdW5kOnZhcigtLXBvcy1iZyk7fQouaW5kZXgtYmFkZ2UubmVne2NvbG9yOnZhcigtLW5lZyk7YmFja2dyb3VuZDp2YXIoLS1uZWctYmcpO30KLmluZGV4LXZhbHVle2ZvbnQtc2l6ZToyOHB4O2ZvbnQtd2VpZ2h0",
  "OjcwMDtsZXR0ZXItc3BhY2luZzotMC4wMWVtO30KLmluZGV4LWNoYW5nZXtmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2MDA7bWFyZ2luLXRvcDo0cHg7fQouaW5kZXgtY2hhbmdlLnBvc3tjb2xvcjp2YXIoLS1wb3Mtc29mdCk7fQouaW5kZXgtY2hhbmdlLm5l",
  "Z3tjb2xvcjp2YXIoLS1uZWctc29mdCk7fQouaW5kZXgtc3Bhcmt7bWFyZ2luLXRvcDoxNHB4O2hlaWdodDozNnB4O30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBTRUFSQ0gKICAgPT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi5zZWFyY2gtd3JhcHtwb3NpdGlvbjpyZWxhdGl2ZTttYXJnaW4tYm90dG9tOjM4cHg7fQouc2VhcmNoLWJveHsKICBkaXNwbGF5OmZsZXg7YWxpZ24taXRl",
  "bXM6Y2VudGVyO2dhcDoxMHB4O3BhZGRpbmc6MTRweCAxNnB4O2JvcmRlci1yYWRpdXM6dmFyKC0tcmFkaXVzLW0pOwogIGJhY2tncm91bmQ6cmdiYSgxOSwyNCw0MSwwLjc1KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxMnB4KTsKICBib3JkZXI6MXB4IHNvbGlkIHZh",
  "cigtLWJvcmRlci1zb2Z0KTsKICB0cmFuc2l0aW9uOmJvcmRlci1jb2xvciAuMjJzIHZhcigtLWVhc2Utb3V0KSwgYm94LXNoYWRvdyAuMjJzIHZhcigtLWVhc2Utb3V0KTsKfQouc2VhcmNoLWJveC5mb2N1c2VkewogIGJvcmRlci1jb2xvcjpyZ2JhKDEyNCwxNTAs",
  "MjU1LDAuNTUpOwogIGJveC1zaGFkb3c6MCAwIDAgNHB4IHJnYmEoNzYsMTI1LDI1NSwwLjEwKSwgMCAxOHB4IDQwcHggLTIwcHggcmdiYSg3NiwxMjUsMjU1LDAuMzUpOwp9Ci5zZWFyY2gtYm94IHN2Z3t3aWR0aDoxN3B4O2hlaWdodDoxN3B4O2NvbG9yOnZhcigt",
  "LXRleHQtbG8pO2ZsZXgtc2hyaW5rOjA7fQouc2VhcmNoLWJveCBpbnB1dHsKICBmbGV4OjE7YmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO291dGxpbmU6bm9uZTtjb2xvcjp2YXIoLS10ZXh0LWhpKTtmb250LXNpemU6MTQuNXB4O2ZvbnQtZmFtaWx5OnZhcigt",
  "LWZvbnQtdWkpOwp9Ci5zZWFyY2gtYm94IGlucHV0OjpwbGFjZWhvbGRlcntjb2xvcjp2YXIoLS10ZXh0LWxvKTt9CmtiZC5rc2hvcnRjdXR7CiAgZm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0pO2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO2Jv",
  "cmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpOwogIHBhZGRpbmc6MnB4IDdweDtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOnZhcigtLWJnLWJhc2UpOwp9Ci5zZWFyY2gtZHJvcHsKICBwb3NpdGlvbjphYnNvbHV0ZTtsZWZ0OjA7cmlnaHQ6MDt0",
  "b3A6Y2FsYygxMDAlICsgOHB4KTt6LWluZGV4OjQwOwogIGJvcmRlci1yYWRpdXM6dmFyKC0tcmFkaXVzLW0pO292ZXJmbG93OmhpZGRlbjsKICBiYWNrZ3JvdW5kOnZhcigtLWJnLWVsZXZhdGVkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1zb2Z0KTsK",
  "ICBib3gtc2hhZG93OjAgMjRweCA2MHB4IC0yMnB4IHJnYmEoMCwwLDAsMC42NSk7CiAgbWF4LWhlaWdodDozNDBweDtvdmVyZmxvdy15OmF1dG87Cn0KLnNlYXJjaC1yb3d7CiAgZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6",
  "c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjExcHggMTZweDtjdXJzb3I6cG9pbnRlcjsKICBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7CiAgYW5pbWF0aW9uOnJvd0luIC4yOHMgdmFyKC0tZWFzZS1vdXQpIGJvdGg7CiAgdHJhbnNpdGlv",
  "bjpiYWNrZ3JvdW5kIC4xNXM7Cn0KLnNlYXJjaC1yb3c6aG92ZXJ7YmFja2dyb3VuZDp2YXIoLS1ib3JkZXItaGFpcik7fQouc2VhcmNoLXJvdzpsYXN0LWNoaWxke2JvcmRlci1ib3R0b206bm9uZTt9CkBrZXlmcmFtZXMgcm93SW57ZnJvbXtvcGFjaXR5OjA7dHJh",
  "bnNmb3JtOnRyYW5zbGF0ZVkoLTRweCk7fXRve29wYWNpdHk6MTt0cmFuc2Zvcm06dHJhbnNsYXRlWSgwKTt9fQouc3ItbGVmdHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMXB4O30KLnNyLXRpY2tlcnsKICB3aWR0aDozNnB4O2hlaWdodDoz",
  "NnB4O2JvcmRlci1yYWRpdXM6OXB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjsKICBmb250LXNpemU6MTFweDtmb250LXdlaWdodDo4MDA7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0pOwogIGJhY2tncm91",
  "bmQ6bGluZWFyLWdyYWRpZW50KDE1MGRlZyx2YXIoLS1pbmRpZ28tNzAwKSx2YXIoLS1iZy1lbGV2YXRlZC0yKSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7Y29sb3I6dmFyKC0tYmx1ZS1zb2Z0KTsKfQouc3ItbmFtZXtmb250LXNpemU6MTMu",
  "NXB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS10ZXh0LWhpKTt9Ci5zci1tZXRhe2ZvbnQtc2l6ZToxMS41cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7fQouc3ItcHJpY2V7Zm9udC1zaXplOjEzLjVweDtmb250LXdlaWdodDo3MDA7fQouc2VhcmNoLWVtcHR5",
  "e3BhZGRpbmc6MjZweCAxNnB4O3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxM3B4O30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBTQ1JFRU5F",
  "UiBGSUxURVJTCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwouZmlsdGVycy1iYXJ7CiAgZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxMHB4O3BhZGRpbmc6MTZweDttYXJnaW4t",
  "Ym90dG9tOjIwcHg7Cn0KLmZpbHRlci1jaGlwewogIGRpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjRweDtwYWRkaW5nOjlweCAxNHB4O2JvcmRlci1yYWRpdXM6dmFyKC0tcmFkaXVzLXMpOwogIGJhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7",
  "Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7bWluLXdpZHRoOjE1MHB4Owp9Ci5maWx0ZXItY2hpcCBsYWJlbHtmb250LXNpemU6MTAuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtd2VpZ2h0OjcwMDtsZXR0ZXItc3BhY2luZzowLjAyZW07",
  "fQouZmlsdGVyLWNoaXAgc2VsZWN0LCAuZmlsdGVyLWNoaXAgaW5wdXRbdHlwZT10ZXh0XXsKICBiYWNrZ3JvdW5kOm5vbmU7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tdGV4dC1oaSk7Zm9udC1zaXplOjEzcHg7Zm9udC13ZWlnaHQ6NjAwO291dGxpbmU6bm9uZTtm",
  "b250LWZhbWlseTppbmhlcml0Owp9Ci5yYW5nZS1zbGlkZXJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7YXBwZWFyYW5jZTpub25lO3dpZHRoOjEzMHB4O2hlaWdodDozcHg7Ym9yZGVyLXJhZGl1czozcHg7YmFja2dyb3VuZDp2YXIoLS1ib3JkZXItc29mdCk7b3V0",
  "bGluZTpub25lO2N1cnNvcjpwb2ludGVyO30KLnJhbmdlLXNsaWRlcjo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7d2lkdGg6MTNweDtoZWlnaHQ6MTNweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnZhcigtLWJsdWUt",
  "c29mdCk7Ym94LXNoYWRvdzowIDAgMCAzcHggcmdiYSg3NiwxMjUsMjU1LDAuMjIpO2N1cnNvcjpwb2ludGVyO30KLnJhbmdlLXZhbHtmb250LXNpemU6MTIuNXB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjp2YXIoLS1ibHVlLXNvZnQpO30KLnRvZ2dsZS1ncm91cHtk",
  "aXNwbGF5OmZsZXg7Z2FwOjZweDt9Ci50b2dnbGUtYnRuewogIHBhZGRpbmc6NXB4IDExcHg7Ym9yZGVyLXJhZGl1czo3cHg7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NzAwO2N1cnNvcjpwb2ludGVyOwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVy",
  "LWhhaXIpO2JhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7Y29sb3I6dmFyKC0tdGV4dC1taWQpOwogIHRyYW5zaXRpb246YWxsIC4xNnMgdmFyKC0tZWFzZS1vdXQpOwp9Ci50b2dnbGUtYnRuLmFjdGl2ZXtjb2xvcjojZmZmO2JvcmRlci1jb2xvcjp0cmFuc3BhcmVu",
  "dDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFyKC0tYmx1ZSksdmFyKC0tdmlvbGV0KSk7fQoucmVzZXQtZmlsdGVyc3ttYXJnaW4tbGVmdDphdXRvO2FsaWduLXNlbGY6Y2VudGVyO2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMi41",
  "cHg7Zm9udC13ZWlnaHQ6NzAwO2N1cnNvcjpwb2ludGVyO3BhZGRpbmc6OHB4IDZweDt9Ci5yZXNldC1maWx0ZXJzOmhvdmVye2NvbG9yOnZhcigtLXRleHQtaGkpO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PQogICBUQUJMRQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLnRhYmxlLXdyYXB7b3ZlcmZsb3cteDphdXRvO2JvcmRlci1yYWRpdXM6dmFyKC0tcmFkaXVzLWwpO30KdGFi",
  "bGUuc3RvY2stdGFibGV7d2lkdGg6MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7bWluLXdpZHRoOjc2MHB4O30KLnN0b2NrLXRhYmxlIHRoZWFkIHRoewogIHBvc2l0aW9uOnN0aWNreTt0b3A6NjRweDt6LWluZGV4OjU7CiAgdGV4dC1hbGlnbjpyaWdodDtm",
  "b250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7Y29sb3I6dmFyKC0tdGV4dC1sbyk7bGV0dGVyLXNwYWNpbmc6MC4wMmVtOwogIHBhZGRpbmc6MTJweCAxNnB4O2JhY2tncm91bmQ6cmdiYSgxMywxNywzMiwwLjkyKTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxMHB4",
  "KTsKICBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItc29mdCk7Y3Vyc29yOnBvaW50ZXI7dXNlci1zZWxlY3Q6bm9uZTt3aGl0ZS1zcGFjZTpub3dyYXA7Cn0KLnN0b2NrLXRhYmxlIHRoZWFkIHRoOmZpcnN0LWNoaWxkLCAuc3RvY2stdGFibGUg",
  "dGhlYWQgdGg6bnRoLWNoaWxkKDIpe3RleHQtYWxpZ246bGVmdDt9Ci5zdG9jay10YWJsZSB0aGVhZCB0aDpob3Zlcntjb2xvcjp2YXIoLS10ZXh0LWhpKTt9Ci5zdG9jay10YWJsZSB0aGVhZCB0aCAuc29ydC1pbmR7b3BhY2l0eTowO21hcmdpbi1sZWZ0OjRweDtm",
  "b250LXNpemU6OXB4O3RyYW5zaXRpb246b3BhY2l0eSAuMTVzO30KLnN0b2NrLXRhYmxlIHRoZWFkIHRoLnNvcnRlZCAuc29ydC1pbmR7b3BhY2l0eToxO2NvbG9yOnZhcigtLWJsdWUtc29mdCk7fQouc3RvY2stdGFibGUgdGJvZHkgdHJ7CiAgYm9yZGVyLWJvdHRv",
  "bToxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpO2N1cnNvcjpwb2ludGVyOwogIHRyYW5zaXRpb246YmFja2dyb3VuZCAuMTVzIHZhcigtLWVhc2Utb3V0KTsKICBhbmltYXRpb246cm93RmFkZSAuM3MgdmFyKC0tZWFzZS1vdXQpIGJvdGg7Cn0KLnN0b2NrLXRh",
  "YmxlIHRib2R5IHRyOmhvdmVye2JhY2tncm91bmQ6dmFyKC0tYm9yZGVyLWhhaXIpO30KLnN0b2NrLXRhYmxlIHRke3BhZGRpbmc6MTNweCAxNnB4O3RleHQtYWxpZ246cmlnaHQ7Zm9udC1zaXplOjEzcHg7d2hpdGUtc3BhY2U6bm93cmFwO30KLnN0b2NrLXRhYmxl",
  "IHRkOmZpcnN0LWNoaWxkLCAuc3RvY2stdGFibGUgdGQ6bnRoLWNoaWxkKDIpe3RleHQtYWxpZ246bGVmdDt9CkBrZXlmcmFtZXMgcm93RmFkZXtmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNHB4KTt9dG97b3BhY2l0eToxO3RyYW5zZm9ybTp0",
  "cmFuc2xhdGVYKDApO319Ci5jZWxsLWNvbXBhbnl7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDt9Ci5jZWxsLXRpY2tlci1iYWRnZXsKICB3aWR0aDozMHB4O2hlaWdodDozMHB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZTo5LjVw",
  "eDtmb250LXdlaWdodDo4MDA7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0pOwogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjb2xvcjp2YXIoLS1ibHVlLXNvZnQpOwogIGJhY2tncm91bmQ6bGluZWFyLWdy",
  "YWRpZW50KDE1MGRlZyx2YXIoLS1pbmRpZ28tNzAwKSx2YXIoLS1iZy1lbGV2YXRlZC0yKSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7ZmxleC1zaHJpbms6MDsKfQouY29tcGFueS1uYW1le2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS10",
  "ZXh0LWhpKTtmb250LXNpemU6MTNweDt9Ci5jb21wYW55LXN1Yntmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS10ZXh0LWxvKTt9Ci5jaGFuZ2UtcGlsbHsKICBkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6M3B4O3BhZGRpbmc6M3B4",
  "IDhweDtib3JkZXItcmFkaXVzOjZweDtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEyLjVweDtmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7Cn0KLmNoYW5nZS1waWxsLnBvc3tjb2xvcjp2YXIoLS1wb3MpO2JhY2tncm91bmQ6dmFyKC0tcG9zLWJnKTt9Ci5j",
  "aGFuZ2UtcGlsbC5uZWd7Y29sb3I6dmFyKC0tbmVnKTtiYWNrZ3JvdW5kOnZhcigtLW5lZy1iZyk7fQouc3Rhci1idG57YmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO2N1cnNvcjpwb2ludGVyO2NvbG9yOnZhcigtLXRleHQtZmFpbnQpO3BhZGRpbmc6NHB4O3Ry",
  "YW5zaXRpb246YWxsIC4ycyB2YXIoLS1lYXNlLXNwcmluZyk7fQouc3Rhci1idG46aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dC1taWQpO3RyYW5zZm9ybTpzY2FsZSgxLjE1KTt9Ci5zdGFyLWJ0bi5hY3RpdmV7Y29sb3I6I0ZGQzg1Nzt9Ci5zdGFyLWJ0biBzdmd7d2lk",
  "dGg6MTZweDtoZWlnaHQ6MTZweDt9CgovKiBtb2JpbGUgY2FyZHMgKi8KLnN0b2NrLWNhcmRze2Rpc3BsYXk6bm9uZTtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjEwcHg7fQouc3RvY2stY2FyZHsKICBwYWRkaW5nOjE0cHggMTZweDtkaXNwbGF5OmZsZXg7YWxp",
  "Z24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2dhcDoxMnB4OwogIGFuaW1hdGlvbjpyb3dGYWRlIC4zcyB2YXIoLS1lYXNlLW91dCkgYm90aDsKfQouc3RvY2stY2FyZCAubGVmdHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2Vu",
  "dGVyO2dhcDoxMXB4O21pbi13aWR0aDowO30KLnN0b2NrLWNhcmQgLm5hbWUtYmxvY2t7bWluLXdpZHRoOjA7fQouc3RvY2stY2FyZCAuY29tcGFueS1uYW1le2Rpc3BsYXk6YmxvY2s7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXM7d2hpdGUt",
  "c3BhY2U6bm93cmFwO21heC13aWR0aDoxMzBweDt9Ci5zdG9jay1jYXJkIC5yaWdodHt0ZXh0LWFsaWduOnJpZ2h0O2ZsZXgtc2hyaW5rOjA7fQouc3RvY2stY2FyZCAucHJpY2V7Zm9udC1zaXplOjE0LjVweDtmb250LXdlaWdodDo3MDA7Zm9udC1mYW1pbHk6dmFy",
  "KC0tZm9udC1udW0pO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBTVE9DSyBERVRBSUwKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09ICovCi5kZXRhaWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LXdyYXA6d3JhcDtnYXA6MjBweDttYXJnaW4tYm90dG9tOjI2cHg7fQouZGV0YWlsLXRpdGxl",
  "LXJvd3tkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxNHB4O30KLmRldGFpbC10aWNrZXItYmFkZ2V7CiAgd2lkdGg6NTJweDtoZWlnaHQ6NTJweDtib3JkZXItcmFkaXVzOjE0cHg7Zm9udC1zaXplOjE1cHg7Zm9udC13ZWlnaHQ6ODAwO2ZvbnQt",
  "ZmFtaWx5OnZhcigtLWZvbnQtbnVtKTsKICBkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6dmFyKC0tYmx1ZS1zb2Z0KTsKICBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxNTBkZWcsdmFyKC0taW5k",
  "aWdvLTcwMCksdmFyKC0tYmctZWxldmF0ZWQtMikpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpOwp9Ci5kZXRhaWwtbmFtZXtmb250LXNpemU6MjJweDtmb250LXdlaWdodDo4MDA7bGV0dGVyLXNwYWNpbmc6LTAuMDE1ZW07fQouZGV0YWlsLXN1",
  "Yntmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO21hcmdpbi10b3A6MnB4O30KLmRldGFpbC1wcmljZS1ibG9ja3t0ZXh0LWFsaWduOnJpZ2h0O30KLmRldGFpbC1wcmljZXtmb250LXNpemU6MzJweDtmb250LXdlaWdodDo4MDA7Zm9udC1mYW1p",
  "bHk6dmFyKC0tZm9udC1udW0pO2xldHRlci1zcGFjaW5nOi0wLjAxZW07fQouZGV0YWlsLWNoYW5nZXtmb250LXNpemU6MTRweDtmb250LXdlaWdodDo3MDA7bWFyZ2luLXRvcDo0cHg7fQoKLm1ldHJpY3MtZ3JpZHtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1j",
  "b2x1bW5zOnJlcGVhdCg2LDFmcik7Z2FwOjEwcHg7bWFyZ2luOjI0cHggMCAyOHB4O30KLm1ldHJpYy1jYXJke3BhZGRpbmc6MTRweCAxNnB4O30KLm1ldHJpYy1sYWJlbHtmb250LXNpemU6MTAuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtd2VpZ2h0Ojcw",
  "MDtsZXR0ZXItc3BhY2luZzowLjAyZW07bWFyZ2luLWJvdHRvbTo2cHg7fQoubWV0cmljLXZhbHVle2ZvbnQtc2l6ZToxNS41cHg7Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtZmFtaWx5OnZhcigtLWZvbnQtbnVtKTt9CgouY2hhcnQtY2FyZHtwYWRkaW5nOjIycHg7bWFy",
  "Z2luLWJvdHRvbToyOHB4O30KLmNoYXJ0LWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tYm90dG9tOjZweDtmbGV4LXdyYXA6d3JhcDtnYXA6MTJweDt9Ci5yYW5nZS10YWJze2Rp",
  "c3BsYXk6ZmxleDtnYXA6MnB4O2JhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7cGFkZGluZzozcHg7Ym9yZGVyLXJhZGl1czo5cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7fQoucmFuZ2UtdGFicyBidXR0b257CiAgYm9yZGVyOm5vbmU7YmFj",
  "a2dyb3VuZDpub25lO2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjcwMDtwYWRkaW5nOjZweCAxMnB4O2JvcmRlci1yYWRpdXM6N3B4O2N1cnNvcjpwb2ludGVyOwogIHRyYW5zaXRpb246YWxsIC4xOHMgdmFyKC0tZWFzZS1v",
  "dXQpOwp9Ci5yYW5nZS10YWJzIGJ1dHRvbi5hY3RpdmV7Y29sb3I6I2ZmZjtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFyKC0tYmx1ZSksdmFyKC0tdmlvbGV0KSk7fQouY2hhcnQtY2FudmFzLXdyYXB7cG9zaXRpb246cmVsYXRpdmU7aGVpZ2h0",
  "OjI4MHB4O21hcmdpbi10b3A6MTRweDt9Ci52b2x1bWUtd3JhcHttYXJnaW4tdG9wOjEwcHg7fQoudm9sdW1lLWxhYmVse2ZvbnQtc2l6ZToxMC41cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC13ZWlnaHQ6NzAwO2xldHRlci1zcGFjaW5nOjAuMDJlbTttYXJn",
  "aW4tYm90dG9tOjZweDt9CiN2b2x1bWVDaGFydHt3aWR0aDoxMDAlO2hlaWdodDo2NHB4O2Rpc3BsYXk6YmxvY2s7fQouY2hhcnQtdG9vbHRpcHsKICBwb3NpdGlvbjphYnNvbHV0ZTtwb2ludGVyLWV2ZW50czpub25lO3BhZGRpbmc6OHB4IDExcHg7Ym9yZGVyLXJh",
  "ZGl1czo5cHg7YmFja2dyb3VuZDp2YXIoLS1iZy1lbGV2YXRlZC0yKTsKICBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1zb2Z0KTtmb250LXNpemU6MTEuNXB4O2JveC1zaGFkb3c6MCAxNHB4IDMwcHggLTEycHggcmdiYSgwLDAsMCwwLjYpOwogIG9wYWNp",
  "dHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlKC01MCUsLTExNSUpO3RyYW5zaXRpb246b3BhY2l0eSAuMXM7d2hpdGUtc3BhY2U6bm93cmFwO3otaW5kZXg6NjsKfQouY2hhcnQtdG9vbHRpcCAudHQtcHJpY2V7Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtZmFtaWx5OnZhcigt",
  "LWZvbnQtbnVtKTtjb2xvcjp2YXIoLS10ZXh0LWhpKTt9Ci5jaGFydC10b29sdGlwIC50dC1kYXRle2NvbG9yOnZhcigtLXRleHQtbG8pO21hcmdpbi10b3A6MnB4O30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PQogICBXQVRDSExJU1QKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi53YXRjaGxpc3QtZ3JpZHtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgz",
  "LDFmcik7Z2FwOjE0cHg7fQoud2F0Y2gtY2FyZHtwYWRkaW5nOjE2cHggMThweDtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47dHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjJzIHZhcigtLWVhc2Utb3V0KTt9Ci53YXRjaC1jYXJkOmhvdmVye3RyYW5zZm9y",
  "bTp0cmFuc2xhdGVZKC0ycHgpO30KLndhdGNoLWNhcmQucmVtb3Zpbmd7YW5pbWF0aW9uOmNhcmRPdXQgLjNzIHZhcigtLWVhc2Utb3V0KSBmb3J3YXJkczt9CkBrZXlmcmFtZXMgY2FyZE91dHt0b3tvcGFjaXR5OjA7dHJhbnNmb3JtOnNjYWxlKDAuOSkgdHJhbnNs",
  "YXRlWSg2cHgpO319Ci53YXRjaC1jYXJkLmVudGVyaW5ne2FuaW1hdGlvbjpjYXJkSW4gLjM4cyB2YXIoLS1lYXNlLXNwcmluZykgYm90aDt9CkBrZXlmcmFtZXMgY2FyZElue2Zyb217b3BhY2l0eTowO3RyYW5zZm9ybTpzY2FsZSgwLjkpIHRyYW5zbGF0ZVkoMTBw",
  "eCk7fXRve29wYWNpdHk6MTt0cmFuc2Zvcm06c2NhbGUoMSkgdHJhbnNsYXRlWSgwKTt9fQoud2F0Y2gtdG9we2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpmbGV4LXN0YXJ0O21hcmdpbi1ib3R0b206MTBweDt9",
  "Ci53YXRjaC1lbXB0eXtwYWRkaW5nOjYwcHggMjBweDt0ZXh0LWFsaWduOmNlbnRlcjtncmlkLWNvbHVtbjoxLy0xO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBTS0VMRVRPTlMKICAg",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCkBrZXlmcmFtZXMgc2hpbW1lcnswJXtiYWNrZ3JvdW5kLXBvc2l0aW9uOi0zMDBweCAwO30xMDAle2JhY2tncm91bmQtcG9zaXRpb246MzAwcHggMDt9",
  "fQouc2tlbHsKICBib3JkZXItcmFkaXVzOjhweDsKICBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5MGRlZywgdmFyKC0tYmctZWxldmF0ZWQpIDI1JSwgdmFyKC0tYmctZWxldmF0ZWQtMikgNTAlLCB2YXIoLS1iZy1lbGV2YXRlZCkgNzUlKTsKICBiYWNrZ3Jv",
  "dW5kLXNpemU6MzAwcHggMTAwJTsKICBhbmltYXRpb246c2hpbW1lciAxLjVzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9Ci5za2VsLWxpbmV7aGVpZ2h0OjEycHg7bWFyZ2luLWJvdHRvbTo4cHg7fQouc2tlbC1jYXJke2hlaWdodDoxMTJweDtib3JkZXItcmFkaXVz",
  "OnZhcigtLXJhZGl1cy1sKTt9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgRU1QVFkgLyBFUlJPUiBTVEFURVMKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09ICovCi5zdGF0ZS1ib3h7CiAgZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjt0ZXh0LWFsaWduOmNlbnRlcjsKICBwYWRkaW5nOjY0cHgg",
  "MjRweDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7Z2FwOjEycHg7Cn0KLnN0YXRlLWljb257CiAgd2lkdGg6NTJweDtoZWlnaHQ6NTJweDtib3JkZXItcmFkaXVzOjE0cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVy",
  "OwogIGJhY2tncm91bmQ6dmFyKC0tYmctZWxldmF0ZWQtMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7Y29sb3I6dmFyKC0tdGV4dC1sbyk7bWFyZ2luLWJvdHRvbTo0cHg7Cn0KLnN0YXRlLXRpdGxle2ZvbnQtc2l6ZToxNC41cHg7Zm9udC13",
  "ZWlnaHQ6NzAwO2NvbG9yOnZhcigtLXRleHQtaGkpO30KLnN0YXRlLXN1Yntmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO21heC13aWR0aDozMjBweDt9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT0KICAgQk9UVE9NIE5BViAobW9iaWxlKQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLmJvdHRvbS1uYXZ7CiAgZGlzcGxheTpub25lO3Bvc2l0aW9uOmZpeGVkO2xl",
  "ZnQ6MDtyaWdodDowO2JvdHRvbTowO3otaW5kZXg6NTA7CiAgYmFja2dyb3VuZDpyZ2JhKDEwLDEzLDIzLDAuOSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoMThweCk7CiAgYm9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpOwogIHBhZGRpbmc6OHB4",
  "IDZweCBjYWxjKDhweCArIGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSk7CiAganVzdGlmeS1jb250ZW50OnNwYWNlLWFyb3VuZDsKfQouYm90dG9tLW5hdiBidXR0b257CiAgYmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO2NvbG9yOnZhcigtLXRleHQtbG8p",
  "O2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDozcHg7CiAgZm9udC1zaXplOjEwcHg7Zm9udC13ZWlnaHQ6NzAwO3BhZGRpbmc6NHB4IDEwcHg7Y3Vyc29yOnBvaW50ZXI7Cn0KLmJvdHRvbS1uYXYgYnV0dG9u",
  "IHN2Z3t3aWR0aDoxOXB4O2hlaWdodDoxOXB4O30KLmJvdHRvbS1uYXYgYnV0dG9uLmFjdGl2ZXtjb2xvcjp2YXIoLS1ibHVlLXNvZnQpO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBS",
  "RVNQT05TSVZFCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpAbWVkaWEgKG1heC13aWR0aDogOTgwcHgpewogIC5oZXJvLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZy",
  "KTt9CiAgLm1ldHJpY3MtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTt9CiAgLndhdGNobGlzdC1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO30KfQpAbWVkaWEgKG1heC13aWR0aDogNjQwcHgpewogICNiYWNr",
  "ZW5kQmFkZ2V7ZGlzcGxheTpub25lO30KfQpAbWVkaWEgKG1heC13aWR0aDogNzYwcHgpewogIG5hdi5tYWlubmF2e2Rpc3BsYXk6bm9uZTt9CiAgaGVhZGVyLnRvcGJhcntwYWRkaW5nOjAgMTZweDtoZWlnaHQ6NThweDtnYXA6MTRweDt9CiAgbWFpbntwYWRkaW5n",
  "OjIwcHggMTZweCA5NnB4O30KICAuaGVyby1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLDFmcik7Z2FwOjEwcHg7fQogIC5tZXRyaWNzLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLDFmcik7fQogIC53YXRjaGxpc3QtZ3JpZHtn",
  "cmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyO30KICAudGFibGUtd3JhcHtkaXNwbGF5Om5vbmU7fQogIC5zdG9jay1jYXJkc3tkaXNwbGF5OmZsZXg7fQogIC5ib3R0b20tbmF2e2Rpc3BsYXk6ZmxleDt9CiAgLmRldGFpbC1wcmljZS1ibG9ja3t0ZXh0LWFsaWduOmxl",
  "ZnQ7fQogIC5kZXRhaWwtaGVhZHtmbGV4LWRpcmVjdGlvbjpjb2x1bW47fQogIC5maWx0ZXJzLWJhcntwYWRkaW5nOjEycHg7fQogIC5maWx0ZXItY2hpcHttaW4td2lkdGg6NDQlO2ZsZXg6MTt9Cn0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KCjxkaXYgY2xhc3M9",
  "ImFtYmllbnQiPgogIDxkaXYgY2xhc3M9ImFtYmllbnQtZ3JpZCI+PC9kaXY+CiAgPHN2ZyBjbGFzcz0iYW1iaWVudC1saW5lcyIgaWQ9ImFtYmllbnRMaW5lcyIgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSI+PC9zdmc+CjwvZGl2PgoKPGhlYWRlciBjbGFzcz0i",
  "dG9wYmFyIiBpZD0idG9wYmFyIj4KICA8ZGl2IGNsYXNzPSJicmFuZCI+CiAgICA8ZGl2IGNsYXNzPSJicmFuZC1tYXJrIj4KICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPgogICAgICAgIDxkZWZzPgogICAgICAgICAgPGxpbmVhckdy",
  "YWRpZW50IGlkPSJsb2dvR3JhZCIgeDE9IjIiIHkxPSIyMCIgeDI9IjIyIiB5Mj0iNCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgogICAgICAgICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjNEM3REZGIi8+CiAgICAgICAgICAgIDxz",
  "dG9wIG9mZnNldD0iNTUlIiBzdG9wLWNvbG9yPSIjOEI2QkYwIi8+CiAgICAgICAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzMxRDVFRSIvPgogICAgICAgICAgPC9saW5lYXJHcmFkaWVudD4KICAgICAgICA8L2RlZnM+CiAgICAgICAgPHJl",
  "Y3QgeD0iMi41IiB5PSIxMyIgd2lkdGg9IjQiIGhlaWdodD0iOC41IiByeD0iMS4yIiBmaWxsPSJ1cmwoI2xvZ29HcmFkKSIgb3BhY2l0eT0iMC41NSIvPgogICAgICAgIDxyZWN0IHg9IjEwIiB5PSI4IiB3aWR0aD0iNCIgaGVpZ2h0PSIxMy41IiByeD0iMS4yIiBm",
  "aWxsPSJ1cmwoI2xvZ29HcmFkKSIgb3BhY2l0eT0iMC44Ii8+CiAgICAgICAgPHJlY3QgeD0iMTcuNSIgeT0iMi41IiB3aWR0aD0iNCIgaGVpZ2h0PSIxOSIgcng9IjEuMiIgZmlsbD0idXJsKCNsb2dvR3JhZCkiLz4KICAgICAgPC9zdmc+CiAgICA8L2Rpdj4KICAg",
  "IDxkaXYgY2xhc3M9ImJyYW5kLXdvcmRtYXJrIj48c3Bhbj48c3BhbiBjbGFzcz0iZXEiPkVxdWl0eTwvc3Bhbj48c3BhbiBjbGFzcz0ic2NhbiI+U2Nhbjwvc3Bhbj48L3NwYW4+PHNtYWxsPk1BUktFVCBJTlRFTExJR0VOQ0U8L3NtYWxsPjwvZGl2PgogIDwvZGl2",
  "PgogIDxuYXYgY2xhc3M9Im1haW5uYXYiIGlkPSJtYWluTmF2Ij4KICAgIDxidXR0b24gZGF0YS12aWV3PSJkYXNoYm9hcmQiPkRhc2hib2FyZDwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLXZpZXc9InNjcmVlbmVyIj5TY3JlZW5lcjwvYnV0dG9uPgogICAgPGJ1",
  "dHRvbiBkYXRhLXZpZXc9Im1hcmtldHMiPk1hcmtldHM8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS12aWV3PSJ3YXRjaGxpc3QiPldhdGNobGlzdDwvYnV0dG9uPgogIDwvbmF2PgogIDxkaXYgY2xhc3M9ImhlYWRlci1yaWdodCI+CiAgICA8ZGl2IGNsYXNzPSJt",
  "YXJrZXQtcGlsbCI+PHNwYW4gY2xhc3M9ImRvdC1saXZlIj48L3NwYW4+PHNwYW4gaWQ9Im1hcmtldFN0YXR1c1RleHQiPk1hcmtldCBPcGVuPC9zcGFuPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ibWFya2V0LXBpbGwiIGlkPSJiYWNrZW5kQmFkZ2UiIHRpdGxlPSJD",
  "aGVja2luZyBiYWNrZW5kIGNvbm5lY3Rpb27igKYiPjxzcGFuIGNsYXNzPSJkb3QtbGl2ZSI+PC9zcGFuPjxzcGFuPkNoZWNraW5n4oCmPC9zcGFuPjwvZGl2PgogICAgPGJ1dHRvbiBjbGFzcz0iaWNvbi1idG4iIGlkPSJzZWFyY2hUb2dnbGVCdG4iIHRpdGxlPSJT",
  "ZWFyY2ggKC8pIj4KICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iNyIvPjxw",
  "YXRoIGQ9Ik0yMSAyMWwtNC4zLTQuMyIvPjwvc3ZnPgogICAgPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJpY29uLWJ0biIgdGl0bGU9IlNldHRpbmdzIj4KICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVu",
  "dENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMyIvPjxwYXRoIGQ9Ik0xOS40IDE1YTEuNjUgMS42NSAwIDAwLjMzIDEuODJsLjA2LjA2",
  "YTIgMiAwIDExLTIuODMgMi44M2wtLjA2LS4wNmExLjY1IDEuNjUgMCAwMC0xLjgyLS4zMyAxLjY1IDEuNjUgMCAwMC0xIDEuNTFWMjFhMiAyIDAgMDEtNCAwdi0uMDlBMS42NSAxLjY1IDAgMDA5IDE5LjRhMS42NSAxLjY1IDAgMDAtMS44Mi4zM2wtLjA2LjA2YTIg",
  "MiAwIDExLTIuODMtMi44M2wuMDYtLjA2QTEuNjUgMS42NSAwIDAwNC42IDE1YTEuNjUgMS42NSAwIDAwLTEuNTEtMUgzYTIgMiAwIDAxMC00aC4wOUExLjY1IDEuNjUgMCAwMDQuNiA5YTEuNjUgMS42NSAwIDAwLS4zMy0xLjgybC0uMDYtLjA2YTIgMiAwIDExMi44",
  "My0yLjgzbC4wNi4wNkExLjY1IDEuNjUgMCAwMDkgNC42YTEuNjUgMS42NSAwIDAwMS0xLjUxVjNhMiAyIDAgMDE0IDB2LjA5YTEuNjUgMS42NSAwIDAwMSAxLjUxIDEuNjUgMS42NSAwIDAwMS44Mi0uMzNsLjA2LS4wNmEyIDIgMCAxMTIuODMgMi44M2wtLjA2LjA2",
  "QTEuNjUgMS42NSAwIDAwMTkuNCA5YTEuNjUgMS42NSAwIDAwMS41MSAxSDIxYTIgMiAwIDAxMCA0aC0uMDlhMS42NSAxLjY1IDAgMDAtMS41MSAxeiIvPjwvc3ZnPgogICAgPC9idXR0b24+CiAgPC9kaXY+CjwvaGVhZGVyPgoKPG1haW4gaWQ9Im1haW5Sb290Ij48",
  "L21haW4+Cgo8bmF2IGNsYXNzPSJib3R0b20tbmF2IiBpZD0iYm90dG9tTmF2Ij4KICA8YnV0dG9uIGRhdGEtdmlldz0iZGFzaGJvYXJkIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0",
  "aD0iMiI+PHJlY3QgeD0iMyIgeT0iMyIgd2lkdGg9IjciIGhlaWdodD0iOSIgcng9IjEuNSIvPjxyZWN0IHg9IjE0IiB5PSIzIiB3aWR0aD0iNyIgaGVpZ2h0PSI1IiByeD0iMS41Ii8+PHJlY3QgeD0iMTQiIHk9IjEyIiB3aWR0aD0iNyIgaGVpZ2h0PSI5IiByeD0i",
  "MS41Ii8+PHJlY3QgeD0iMyIgeT0iMTYiIHdpZHRoPSI3IiBoZWlnaHQ9IjUiIHJ4PSIxLjUiLz48L3N2Zz5EYXNoYm9hcmQ8L2J1dHRvbj4KICA8YnV0dG9uIGRhdGEtdmlldz0ic2NyZWVuZXIiPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBz",
  "dHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNNCA2aDE2TTcgMTJoMTBNMTAgMThoNCIvPjwvc3ZnPlNjcmVlbmVyPC9idXR0b24+CiAgPGJ1dHRvbiBkYXRhLXZpZXc9Im1hcmtldHMiPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0",
  "IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMyAxN2w2LTYgNCA0IDgtOCIvPjwvc3ZnPk1hcmtldHM8L2J1dHRvbj4KICA8YnV0dG9uIGRhdGEtdmlldz0id2F0Y2hsaXN0Ij48c3ZnIHZpZXdCb3g9",
  "IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTEyIDE3LjNsLTYuMTYgMy42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIgMi40bDIuOTQgNi40IDcuMDYuNi01LjQ4IDQuNiAxLjY0",
  "IDYuOXoiLz48L3N2Zz5XYXRjaGxpc3Q8L2J1dHRvbj4KPC9uYXY+Cgo8c2NyaXB0PgoidXNlIHN0cmljdCI7CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIElOVEVHUkFUSU9OIExB",
  "WUVSCiAgIFRoaXMgZnJvbnRlbmQgbm93IHRhbGtzIHRvIGEgcmVhbCBFcXVpdHlTY2FuIGJhY2tlbmQgKHNlZSAvYmFja2VuZCkKICAgd2hpY2ggcHJveGllcyBOU0UgdmlhIHN0b2NrLW5zZS1pbmRpYSwgY2FjaGVkIGFuZCBidWRnZXQtbGltaXRlZCB0bwogICB+",
  "NTAgdXBzdHJlYW0gY2FsbHMvZGF5LiBFdmVyeSBBUEkuKiBtZXRob2QgYmVsb3cgdHJpZXMgdGhlIGxpdmUKICAgYmFja2VuZCBmaXJzdCBhbmQgZmFsbHMgYmFjayB0byBkZXRlcm1pbmlzdGljIG1vY2sgZGF0YSBpZiB0aGUKICAgYmFja2VuZCBpcyB1bnJlYWNo",
  "YWJsZSDigJQgd2hpY2ggaXMgZXhwZWN0ZWQgd2hlbiB0aGlzIHBhZ2UgaXMgb3BlbmVkCiAgIGFzIGEgaG9zdGVkIHByZXZpZXcsIHNpbmNlIGEgcHVibGlzaGVkIHBhZ2UgY2Fubm90IHJlYWNoIGEKICAgbG9jYWxob3N0IHNlcnZlci4gUnVuIHRoZSBiYWNrZW5k",
  "IGFuZCBvcGVuIHRoaXMgZmlsZSBsb2NhbGx5IChub3QKICAgdGhlIHB1Ymxpc2hlZCBwcmV2aWV3KSB0byBzZWUgcmVhbCBOU0UgcXVvdGVzIGVuZCB0byBlbmQuCiAgIFRoZSBiYWNrZW5kIGhhcyBubyBoaXN0b3JpY2FsLXByaWNlIGVuZHBvaW50IHlldCwgc28g",
  "Y2hhcnQgc2VyaWVzCiAgIGFuZCBzcGFya2xpbmVzIHN0YXkgc3ludGhldGljIGV2ZW4gaW4gbGl2ZSBtb2RlIOKAlCBldmVyeXRoaW5nIGVsc2UKICAgKHByaWNlLCBjaGFuZ2UgJSwgNTJXIGhpZ2gvbG93LCBjb21wYW55IG5hbWUsIG1hcmtldCBzdGF0dXMpIGlz",
  "CiAgIHJlYWwgd2hlbiB0aGUgYmFja2VuZCBpcyByZWFjaGFibGUuCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3QgQ09ORklHID0gewogIEFQSV9CQVNFOiAod2luZG93Lmxv",
  "Y2F0aW9uLnByb3RvY29sID09PSAiZmlsZToiID8gImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMCIgOiB3aW5kb3cubG9jYXRpb24ub3JpZ2luKSArICIvYXBpIiwKICBMSVZFX1RJTUVPVVRfTVM6IDgwMDAsCn07CmxldCBsaXZlQmFja2VuZEF2YWlsYWJsZSA9IGZhbHNl",
  "Owpjb25zdCBNT0NLX0xBVEVOQ1kgPSA0MjA7CgpmdW5jdGlvbiBmZXRjaFdpdGhUaW1lb3V0KHVybCwgbXMpewogIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7CiAgY29uc3QgaWQgPSBzZXRUaW1lb3V0KCgpPT5jdHJsLmFib3J0KCksIG1zKTsK",
  "ICByZXR1cm4gZmV0Y2godXJsLCB7c2lnbmFsOiBjdHJsLnNpZ25hbH0pLmZpbmFsbHkoKCk9PmNsZWFyVGltZW91dChpZCkpOwp9Cgphc3luYyBmdW5jdGlvbiBjaGVja0xpdmVCYWNrZW5kKCl7CiAgdHJ5ewogICAgY29uc3QgciA9IGF3YWl0IGZldGNoV2l0aFRp",
  "bWVvdXQoQ09ORklHLkFQSV9CQVNFICsgIi9oZWFsdGgiLCBDT05GSUcuTElWRV9USU1FT1VUX01TKTsKICAgIGxpdmVCYWNrZW5kQXZhaWxhYmxlID0gISEociAmJiByLm9rKTsKICB9Y2F0Y2goZSl7CiAgICBsaXZlQmFja2VuZEF2YWlsYWJsZSA9IGZhbHNlOwog",
  "IH0KICB1cGRhdGVCYWNrZW5kQmFkZ2UoKTsKICByZXR1cm4gbGl2ZUJhY2tlbmRBdmFpbGFibGU7Cn0KCmZ1bmN0aW9uIHVwZGF0ZUJhY2tlbmRCYWRnZSgpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJhY2tlbmRCYWRnZSIpOwogIGlm",
  "KCFlbCkgcmV0dXJuOwogIGVsLmNsYXNzTGlzdC50b2dnbGUoImxpdmUiLCBsaXZlQmFja2VuZEF2YWlsYWJsZSk7CiAgZWwucXVlcnlTZWxlY3RvcigiLmRvdC1saXZlIikuc3R5bGUuYmFja2dyb3VuZCA9IGxpdmVCYWNrZW5kQXZhaWxhYmxlID8gInZhcigtLXBv",
  "cykiIDogInZhcigtLXRleHQtZmFpbnQpIjsKICBlbC5xdWVyeVNlbGVjdG9yKCJzcGFuOmxhc3QtY2hpbGQiKS50ZXh0Q29udGVudCA9IGxpdmVCYWNrZW5kQXZhaWxhYmxlID8gIkxpdmUgTlNFIERhdGEiIDogIkRlbW8gRGF0YSI7CiAgZWwudGl0bGUgPSBsaXZl",
  "QmFja2VuZEF2YWlsYWJsZQogICAgPyAiQ29ubmVjdGVkIHRvIHRoZSBFcXVpdHlTY2FuIGJhY2tlbmQg4oCUIHByaWNlcyBhcmUgcmVhbCBOU0UgcXVvdGVzLiIKICAgIDogIkJhY2tlbmQgbm90IHJlYWNoYWJsZSBhdCAiICsgQ09ORklHLkFQSV9CQVNFICsgIiDi",
  "gJQgc2hvd2luZyBkZXRlcm1pbmlzdGljIGRlbW8gZGF0YS4iOwp9CgpmdW5jdGlvbiBtYXBCYWNrZW5kVG9Gcm9udGVuZChkKXsKICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkLnN5bWJvbCk7CiAgY29uc3QgYmFzaXMgPSBkLmN1cnJlbnRQcmljZSB8fCAxMDAw",
  "OwogIGNvbnN0IHNlcmllcyA9IGdlblNlcmllcyhzZWVkLCAyMCwgMC4wMDUsIGJhc2lzKTsKICByZXR1cm4gewogICAgdDogZC5zeW1ib2wsCiAgICBuYW1lOiBkLmNvbXBhbnlOYW1lIHx8IGQuc3ltYm9sLAogICAgZXhjaDogZC5leGNoYW5nZSB8fCAiTlNFIiwK",
  "ICAgIHNlY3RvcjogZC5zZWN0b3IgfHwgIuKAlCIsCiAgICBwcmljZTogZC5jdXJyZW50UHJpY2UsCiAgICBjaGFuZ2U6IGQuY2hhbmdlLAogICAgcGN0OiBkLnBlcmNlbnRDaGFuZ2UsCiAgICBtYXJrZXRDYXA6IGQubWFya2V0Q2FwLAogICAgdm9sdW1lOiBkLnZv",
  "bHVtZSwKICAgIGhpZ2g1MjogZC53ZWVrNTJIaWdoLAogICAgbG93NTI6IGQud2VlazUyTG93LAogICAgb3BlbjogZC5vcGVuLAogICAgZGF5SGlnaDogZC5kYXlIaWdoLAogICAgZGF5TG93OiBkLmRheUxvdywKICAgIHNlcmllcywKICAgIGxpdmU6IHRydWUsCiAg",
  "ICBkYXRhU3RhdHVzOiBkLmRhdGFTdGF0dXMsCiAgfTsKfQoKYXN5bmMgZnVuY3Rpb24gbGl2ZUZldGNoU3RvY2sodGlja2VyKXsKICBjb25zdCByID0gYXdhaXQgZmV0Y2hXaXRoVGltZW91dChgJHtDT05GSUcuQVBJX0JBU0V9L3N0b2NrLyR7ZW5jb2RlVVJJQ29t",
  "cG9uZW50KHRpY2tlcil9YCwgQ09ORklHLkxJVkVfVElNRU9VVF9NUyk7CiAgaWYoIXIub2spIHRocm93IG5ldyBFcnJvcigiYmFja2VuZCBzdGF0dXMgIityLnN0YXR1cyk7CiAgY29uc3QganNvbiA9IGF3YWl0IHIuanNvbigpOwogIGlmKCFqc29uLnN1Y2Nlc3Mg",
  "fHwgIWpzb24uZGF0YSkgdGhyb3cgbmV3IEVycm9yKCJiYWNrZW5kIHBheWxvYWQgZXJyb3IiKTsKICByZXR1cm4gbWFwQmFja2VuZFRvRnJvbnRlbmQoanNvbi5kYXRhKTsKfQoKYXN5bmMgZnVuY3Rpb24gbGl2ZUZldGNoTWFueSh0aWNrZXJzKXsKICBjb25zdCBz",
  "ZXR0bGVkID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKHRpY2tlcnMubWFwKGxpdmVGZXRjaFN0b2NrKSk7CiAgcmV0dXJuIHNldHRsZWQuZmlsdGVyKHM9PnMuc3RhdHVzPT09ImZ1bGZpbGxlZCIpLm1hcChzPT5zLnZhbHVlKTsKfQoKY29uc3QgVU5JVkVSU0Ug",
  "PSBbCiAge3Q6IlRDUyIsIG5hbWU6IlRhdGEgQ29uc3VsdGFuY3kgU2VydmljZXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IklUIFNlcnZpY2VzIiwgYmFzZTozODQyfSwKICB7dDoiUkVMSUFOQ0UiLCBuYW1lOiJSZWxpYW5jZSBJbmR1c3RyaWVzIiwgZXhjaDoiTlNF",
  "Iiwgc2VjdG9yOiJFbmVyZ3kiLCBiYXNlOjI5NTF9LAogIHt0OiJIREZDQkFOSyIsIG5hbWU6IkhERkMgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTY4N30sCiAge3Q6IklORlkiLCBuYW1lOiJJbmZvc3lzIiwgZXhjaDoiTlNFIiwg",
  "c2VjdG9yOiJJVCBTZXJ2aWNlcyIsIGJhc2U6MTg0MX0sCiAge3Q6IklDSUNJQkFOSyIsIG5hbWU6IklDSUNJIEJhbmsiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkJhbmtpbmciLCBiYXNlOjEyNjR9LAogIHt0OiJCSEFSVElBUlRMIiwgbmFtZToiQmhhcnRpIEFpcnRl",
  "bCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiVGVsZWNvbSIsIGJhc2U6MTY5OH0sCiAge3Q6IlNCSU4iLCBuYW1lOiJTdGF0ZSBCYW5rIG9mIEluZGlhIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZTo4MjR9LAogIHt0OiJJVEMiLCBuYW1lOiJJVEMg",
  "TGltaXRlZCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiRk1DRyIsIGJhc2U6NDc4fSwKICB7dDoiTFQiLCBuYW1lOiJMYXJzZW4gJiBUb3Vicm8iLCBleGNoOiJOU0UiLCBzZWN0b3I6IkluZnJhc3RydWN0dXJlIiwgYmFzZTozNjEyfSwKICB7dDoiS09UQUtCQU5LIiwg",
  "bmFtZToiS290YWsgTWFoaW5kcmEgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTc4OX0sCiAge3Q6IkhJTkRVTklMVlIiLCBuYW1lOiJIaW5kdXN0YW4gVW5pbGV2ZXIiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkZNQ0ciLCBiYXNlOjI1",
  "NDd9LAogIHt0OiJBWElTQkFOSyIsIG5hbWU6IkF4aXMgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTE0Mn0sCiAge3Q6IkJBSkZJTkFOQ0UiLCBuYW1lOiJCYWphaiBGaW5hbmNlIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJGaW5hbmNp",
  "YWwgU2VydmljZXMiLCBiYXNlOjcyODR9LAogIHt0OiJNQVJVVEkiLCBuYW1lOiJNYXJ1dGkgU3V6dWtpIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJBdXRvbW9iaWxlIiwgYmFzZToxMjQ4MH0sCiAge3Q6IkFTSUFOUEFJTlQiLCBuYW1lOiJBc2lhbiBQYWludHMiLCBl",
  "eGNoOiJOU0UiLCBzZWN0b3I6IkNvbnN1bWVyIEdvb2RzIiwgYmFzZToyODk0fSwKICB7dDoiV0lQUk8iLCBuYW1lOiJXaXBybyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSVQgU2VydmljZXMiLCBiYXNlOjUxMn0sCiAge3Q6IlRJVEFOIiwgbmFtZToiVGl0YW4gQ29t",
  "cGFueSIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQ29uc3VtZXIgR29vZHMiLCBiYXNlOjM0MjF9LAogIHt0OiJTVU5QSEFSTUEiLCBuYW1lOiJTdW4gUGhhcm1hY2V1dGljYWwiLCBleGNoOiJOU0UiLCBzZWN0b3I6IlBoYXJtYSIsIGJhc2U6MTc4Nn0sCiAge3Q6Ik5U",
  "UEMiLCBuYW1lOiJOVFBDIExpbWl0ZWQiLCBleGNoOiJOU0UiLCBzZWN0b3I6IlBvd2VyIiwgYmFzZTozNjJ9LAogIHt0OiJBREFOSUVOVCIsIG5hbWU6IkFkYW5pIEVudGVycHJpc2VzIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJEaXZlcnNpZmllZCIsIGJhc2U6Mjkx",
  "NH0sCiAge3Q6IlVMVFJBQ0VNQ08iLCBuYW1lOiJVbHRyYVRlY2ggQ2VtZW50IiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJDZW1lbnQiLCBiYXNlOjExMjQwfSwKICB7dDoiUE9XRVJHUklEIiwgbmFtZToiUG93ZXIgR3JpZCBDb3JwIiwgZXhjaDoiTlNFIiwgc2VjdG9y",
  "OiJQb3dlciIsIGJhc2U6MzE4fSwKICB7dDoiTkVTVExFSU5EIiwgbmFtZToiTmVzdGxlIEluZGlhIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJGTUNHIiwgYmFzZToyMjc4fSwKICB7dDoiVEFUQU1PVE9SUyIsIG5hbWU6IlRhdGEgTW90b3JzIiwgZXhjaDoiTlNFIiwg",
  "c2VjdG9yOiJBdXRvbW9iaWxlIiwgYmFzZTo5NDh9LAogIHt0OiJKU1dTVEVFTCIsIG5hbWU6IkpTVyBTdGVlbCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiTWV0YWxzIiwgYmFzZToxMDEyfSwKXTsKCmZ1bmN0aW9uIHNlZWRlZFJhbmQoc2VlZCl7CiAgbGV0IHggPSBN",
  "YXRoLnNpbihzZWVkKSAqIDEwMDAwOwogIHJldHVybiB4IC0gTWF0aC5mbG9vcih4KTsKfQpmdW5jdGlvbiBkYXlPZlllYXIoKXsKICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpOwogIHJldHVybiBNYXRoLmZsb29yKChub3cgLSBuZXcgRGF0ZShub3cuZ2V0RnVsbFll",
  "YXIoKSwwLDApKSAvIDg2NDAwMDAwKTsKfQpmdW5jdGlvbiBnZW5TZXJpZXMoc2VlZCwgcG9pbnRzLCB2b2xhdGlsaXR5LCBiYXNlKXsKICBjb25zdCBhcnIgPSBbXTsKICBsZXQgdiA9IGJhc2U7CiAgZm9yKGxldCBpPTA7aTxwb2ludHM7aSsrKXsKICAgIGNvbnN0",
  "IHIgPSBzZWVkZWRSYW5kKHNlZWQgKiA5Ny43ICsgaSAqIDEzLjMxKSAtIDAuNTsKICAgIHYgPSB2ICogKDEgKyByICogdm9sYXRpbGl0eSk7CiAgICBhcnIucHVzaCh2KTsKICB9CiAgcmV0dXJuIGFycjsKfQpmdW5jdGlvbiB0aWNrZXJTZWVkKHRpY2tlcil7CiAg",
  "bGV0IGggPSAwOwogIGZvcihsZXQgaT0wO2k8dGlja2VyLmxlbmd0aDtpKyspIGggPSAoaCozMSArIHRpY2tlci5jaGFyQ29kZUF0KGkpKSAlIDEwMDAwMDsKICByZXR1cm4gaCArIGRheU9mWWVhcigpOwp9CgpmdW5jdGlvbiB3aXRoTGF0ZW5jeSh2YWx1ZSl7CiAg",
  "cmV0dXJuIG5ldyBQcm9taXNlKHJlcyA9PiBzZXRUaW1lb3V0KCgpID0+IHJlcyh2YWx1ZSksIE1PQ0tfTEFURU5DWSkpOwp9Cgpjb25zdCBBUEkgPSB7CiAgYXN5bmMgZmV0Y2hJbmRpY2VzKCl7CiAgICBjb25zdCBkZWZzID0gWwogICAgICB7Y29kZToiTklGVFkg",
  "NTAiLCBmdWxsOiJOU0UgTmlmdHkgNTAgSW5kZXgiLCBiYXNlOjI0ODEyfSwKICAgICAge2NvZGU6IlNFTlNFWCIsIGZ1bGw6IkJTRSBTZW5zZXgiLCBiYXNlOjgxNjQwfSwKICAgICAge2NvZGU6Ik5JRlRZIEJBTksiLCBmdWxsOiJOU0UgQmFuayBOaWZ0eSBJbmRl",
  "eCIsIGJhc2U6NTIxNDB9LAogICAgXTsKICAgIGNvbnN0IG91dCA9IGRlZnMubWFwKGQ9PnsKICAgICAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQoZC5jb2RlKTsKICAgICAgY29uc3Qgc2VyaWVzID0gZ2VuU2VyaWVzKHNlZWQsIDI0LCAwLjAwNiwgZC5iYXNlKTsK",
  "ICAgICAgY29uc3QgbGFzdCA9IHNlcmllc1tzZXJpZXMubGVuZ3RoLTFdOwogICAgICBjb25zdCBwcmV2ID0gZC5iYXNlOwogICAgICBjb25zdCBjaGcgPSBsYXN0IC0gcHJldjsKICAgICAgY29uc3QgcGN0ID0gKGNoZy9wcmV2KSoxMDA7CiAgICAgIHJldHVybiB7",
  "Li4uZCwgdmFsdWU6bGFzdCwgY2hhbmdlOmNoZywgcGN0LCBzZXJpZXN9OwogICAgfSk7CiAgICByZXR1cm4gd2l0aExhdGVuY3kob3V0KTsKICB9LAoKICBhc3luYyBzZWFyY2hTdG9ja3MocXVlcnkpewogICAgY29uc3QgcSA9IHF1ZXJ5LnRyaW0oKS50b0xvd2Vy",
  "Q2FzZSgpOwogICAgaWYoIXEpIHJldHVybiB3aXRoTGF0ZW5jeShbXSk7CiAgICBjb25zdCBtYXRjaGVzID0gVU5JVkVSU0UuZmlsdGVyKHMgPT4gcy50LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkgfHwgcy5uYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkp",
  "LnNsaWNlKDAsOCk7CiAgICBpZihsaXZlQmFja2VuZEF2YWlsYWJsZSl7CiAgICAgIGNvbnN0IGxpdmUgPSBhd2FpdCBsaXZlRmV0Y2hNYW55KG1hdGNoZXMubWFwKG09Pm0udCkpOwogICAgICBpZihsaXZlLmxlbmd0aCkgcmV0dXJuIGxpdmU7CiAgICB9CiAgICBy",
  "ZXR1cm4gd2l0aExhdGVuY3kobWF0Y2hlcy5tYXAocyA9PiBkZWNvcmF0ZVN0b2NrKHMpKSk7CiAgfSwKCiAgYXN5bmMgZmV0Y2hTY3JlZW5lclJlc3VsdHMoZmlsdGVycyl7CiAgICBsZXQgbGlzdDsKICAgIGlmKGxpdmVCYWNrZW5kQXZhaWxhYmxlKXsKICAgICAg",
  "Y29uc3QgbGl2ZSA9IGF3YWl0IGxpdmVGZXRjaE1hbnkoVU5JVkVSU0UubWFwKHM9PnMudCkpOwogICAgICBsaXN0ID0gbGl2ZS5sZW5ndGggPyBsaXZlIDogVU5JVkVSU0UubWFwKHM9PmRlY29yYXRlU3RvY2socykpOwogICAgfSBlbHNlIHsKICAgICAgbGlzdCA9",
  "IFVOSVZFUlNFLm1hcChkZWNvcmF0ZVN0b2NrKTsKICAgICAgYXdhaXQgd2l0aExhdGVuY3kobnVsbCk7CiAgICB9CiAgICBpZihmaWx0ZXJzLnF1ZXJ5KXsKICAgICAgY29uc3QgcSA9IGZpbHRlcnMucXVlcnkudG9Mb3dlckNhc2UoKTsKICAgICAgbGlzdCA9IGxp",
  "c3QuZmlsdGVyKHM9PnMudC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpfHxzLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSk7CiAgICB9CiAgICBpZihmaWx0ZXJzLnNlY3RvciAmJiBmaWx0ZXJzLnNlY3RvciAhPT0gIkFsbCIpIGxpc3QgPSBsaXN0LmZp",
  "bHRlcihzPT5zLnNlY3Rvcj09PWZpbHRlcnMuc2VjdG9yKTsKICAgIGlmKGZpbHRlcnMubWluUHJpY2UpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnByaWNlPj1maWx0ZXJzLm1pblByaWNlKTsKICAgIGlmKGZpbHRlcnMubWF4UHJpY2UpIGxpc3QgPSBsaXN0LmZp",
  "bHRlcihzPT5zLnByaWNlPD1maWx0ZXJzLm1heFByaWNlKTsKICAgIGlmKGZpbHRlcnMuZGlyZWN0aW9uPT09ImdhaW5lcnMiKSBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q+PTApOwogICAgaWYoZmlsdGVycy5kaXJlY3Rpb249PT0ibG9zZXJzIikgbGlzdCA9",
  "IGxpc3QuZmlsdGVyKHM9PnMucGN0PDApOwogICAgcmV0dXJuIGxpc3Q7CiAgfSwKCiAgYXN5bmMgZmV0Y2hTdG9jayh0aWNrZXIpewogICAgaWYobGl2ZUJhY2tlbmRBdmFpbGFibGUpewogICAgICB0cnl7IHJldHVybiBhd2FpdCBsaXZlRmV0Y2hTdG9jayh0aWNr",
  "ZXIpOyB9CiAgICAgIGNhdGNoKGUpeyAvKiBmYWxsIHRocm91Z2ggdG8gbW9jayAqLyB9CiAgICB9CiAgICBjb25zdCBkZWYgPSBVTklWRVJTRS5maW5kKHM9PnMudD09PXRpY2tlcik7CiAgICBpZighZGVmKSByZXR1cm4gd2l0aExhdGVuY3kobnVsbCk7CiAgICBy",
  "ZXR1cm4gd2l0aExhdGVuY3koZGVjb3JhdGVTdG9jayhkZWYsIHRydWUpKTsKICB9LAoKICBhc3luYyBmZXRjaFN0b2NrSGlzdG9yeSh0aWNrZXIsIHJhbmdlKXsKICAgIGNvbnN0IHNlZWQgPSB0aWNrZXJTZWVkKHRpY2tlcik7CiAgICBjb25zdCBjZmcgPSB7CiAg",
  "ICAgICIxRCI6e3BvaW50czo3OCwgdm9sOjAuMDAxNn0sCiAgICAgICIxVyI6e3BvaW50czozNSwgdm9sOjAuMDAzfSwKICAgICAgIjFNIjp7cG9pbnRzOjIyLCB2b2w6MC4wMDh9LAogICAgICAiM00iOntwb2ludHM6NjUsIHZvbDowLjAwOX0sCiAgICAgICI2TSI6",
  "e3BvaW50czoxMzAsIHZvbDowLjAxMH0sCiAgICAgICIxWSI6e3BvaW50czoyNTAsIHZvbDowLjAxMn0sCiAgICB9W3JhbmdlXSB8fCB7cG9pbnRzOjYwLCB2b2w6MC4wMDh9OwogICAgY29uc3QgZGVmID0gVU5JVkVSU0UuZmluZChzPT5zLnQ9PT10aWNrZXIpOwog",
  "ICAgY29uc3QgYmFzZSA9IGRlZiA/IGRlZi5iYXNlICogMC45NCA6IDEwMDA7CiAgICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCArIHJhbmdlLmxlbmd0aCwgY2ZnLnBvaW50cywgY2ZnLnZvbCwgYmFzZSk7CiAgICByZXR1cm4gd2l0aExhdGVuY3koc2Vy",
  "aWVzKTsKICB9LAp9OwoKZnVuY3Rpb24gZGVjb3JhdGVTdG9jayhkZWYsIGRldGFpbGVkKXsKICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkZWYudCk7CiAgY29uc3Qgc2VyaWVzID0gZ2VuU2VyaWVzKHNlZWQsIDIwLCAwLjAwNSwgZGVmLmJhc2UpOwogIGNvbnN0",
  "IHByaWNlID0gc2VyaWVzW3Nlcmllcy5sZW5ndGgtMV07CiAgY29uc3QgcHJldkNsb3NlID0gZGVmLmJhc2U7CiAgY29uc3QgY2hhbmdlID0gcHJpY2UgLSBwcmV2Q2xvc2U7CiAgY29uc3QgcGN0ID0gKGNoYW5nZS9wcmV2Q2xvc2UpKjEwMDsKICBjb25zdCBtYXJr",
  "ZXRDYXAgPSBwcmljZSAqIChzZWVkZWRSYW5kKHNlZWQqMi4xKSo0MDAwKzgwMCkgKiAxZTY7CiAgY29uc3Qgdm9sdW1lID0gTWF0aC5yb3VuZChzZWVkZWRSYW5kKHNlZWQqMy4zKSo4XzAwMF8wMDAgKyAyMDBfMDAwKTsKICBjb25zdCBoaWdoNTIgPSBwcmljZSAq",
  "ICgxICsgc2VlZGVkUmFuZChzZWVkKjQuNCkqMC4zNSArIDAuMDUpOwogIGNvbnN0IGxvdzUyID0gcHJpY2UgKiAoMSAtIHNlZWRlZFJhbmQoc2VlZCo1LjUpKjAuMzAgLSAwLjA0KTsKICBjb25zdCBvdXQgPSB7CiAgICB0OmRlZi50LCBuYW1lOmRlZi5uYW1lLCBl",
  "eGNoOmRlZi5leGNoLCBzZWN0b3I6ZGVmLnNlY3RvciwKICAgIHByaWNlLCBjaGFuZ2UsIHBjdCwgbWFya2V0Q2FwLCB2b2x1bWUsIGhpZ2g1MiwgbG93NTIsIHNlcmllcywKICB9OwogIGlmKGRldGFpbGVkKXsKICAgIG91dC5vcGVuID0gcHJpY2UgLSBjaGFuZ2Uq",
  "MC42OwogICAgb3V0LmRheUhpZ2ggPSBNYXRoLm1heChwcmljZSwgb3V0Lm9wZW4pICogKDErc2VlZGVkUmFuZChzZWVkKjYuNikqMC4wMTIpOwogICAgb3V0LmRheUxvdyA9IE1hdGgubWluKHByaWNlLCBvdXQub3BlbikgKiAoMS1zZWVkZWRSYW5kKHNlZWQqNy43",
  "KSowLjAxMik7CiAgfQogIHJldHVybiBvdXQ7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgRk9STUFUIEhFTFBFUlMKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpmdW5jdGlvbiBmbXRJTlIodiwgZGVjaW1hbHMpewogIGlmKHY9PT11bmRlZmluZWR8fHY9PT1udWxsfHxpc05hTih2KSkgcmV0dXJuICLigJQiOwogIGNvbnN0IGQgPSBkZWNpbWFscz09PXVuZGVm",
  "aW5lZD8yOmRlY2ltYWxzOwogIHJldHVybiAi4oK5IiArIHYudG9Mb2NhbGVTdHJpbmcoImVuLUlOIiwge21pbmltdW1GcmFjdGlvbkRpZ2l0czpkLCBtYXhpbXVtRnJhY3Rpb25EaWdpdHM6ZH0pOwp9CmZ1bmN0aW9uIGZtdENvbXBhY3Qodil7CiAgaWYodj09PXVu",
  "ZGVmaW5lZHx8dj09PW51bGx8fGlzTmFOKHYpKSByZXR1cm4gIuKAlCI7CiAgaWYodj49MWUxMikgcmV0dXJuICLigrkiKyh2LzFlMTIpLnRvRml4ZWQoMikrIlQiOwogIGlmKHY+PTFlOSkgcmV0dXJuICLigrkiKyh2LzFlOSkudG9GaXhlZCgyKSsiQiI7CiAgaWYo",
  "dj49MWU3KSByZXR1cm4gIuKCuSIrKHYvMWU3KS50b0ZpeGVkKDIpKyJDciI7CiAgaWYodj49MWU1KSByZXR1cm4gIuKCuSIrKHYvMWU1KS50b0ZpeGVkKDIpKyJMIjsKICByZXR1cm4gIuKCuSIrdi50b0ZpeGVkKDApOwp9CmZ1bmN0aW9uIGZtdFZvbCh2KXsKICBp",
  "Zih2Pj0xZTcpIHJldHVybiAodi8xZTcpLnRvRml4ZWQoMikrIkNyIjsKICBpZih2Pj0xZTUpIHJldHVybiAodi8xZTUpLnRvRml4ZWQoMikrIkwiOwogIGlmKHY+PTFlMykgcmV0dXJuICh2LzFlMykudG9GaXhlZCgxKSsiSyI7CiAgcmV0dXJuIFN0cmluZyh2KTsK",
  "fQpmdW5jdGlvbiBwY3RTdHIocCl7IHJldHVybiAocD49MD8iKyI6IiIpICsgcC50b0ZpeGVkKDIpICsgIiUiOyB9CmZ1bmN0aW9uIGNoZ1N0cihjKXsgcmV0dXJuIChjPj0wPyIrIjoiIikgKyBmbXRJTlIoTWF0aC5hYnMoYykpOyB9CmZ1bmN0aW9uIGVzY2FwZUh0",
  "bWwocyl7CiAgcmV0dXJuIFN0cmluZyhzKS5yZXBsYWNlKC9bJjw+IiddL2csIG0gPT4gKHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsJyInOiImcXVvdDsiLCInIjoiJiMzOTsifVttXSkpOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNUQVRFCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3Qgc3RhdGUgPSB7CiAgdmlldzogImRhc2hi",
  "b2FyZCIsCiAgd2F0Y2hsaXN0OiBbXSwKICBkZXRhaWxUaWNrZXI6ICJUQ1MiLAogIGRldGFpbFJhbmdlOiAiMU0iLAogIHNjcmVlbmVyRmlsdGVyczoge3F1ZXJ5OiIiLCBzZWN0b3I6IkFsbCIsIG1pblByaWNlOjAsIG1heFByaWNlOjE1MDAwLCBkaXJlY3Rpb246",
  "ImFsbCJ9LAogIHNjcmVlbmVyU29ydDoge2tleToibWFya2V0Q2FwIiwgZGlyOiJkZXNjIn0sCn07Cgp0cnl7CiAgY29uc3Qgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgiZXF1aXR5c2Nhbl93YXRjaGxpc3QiKTsKICBpZihzYXZlZCkgc3RhdGUud2F0Y2hs",
  "aXN0ID0gSlNPTi5wYXJzZShzYXZlZCk7Cn1jYXRjaChlKXt9CmZ1bmN0aW9uIHBlcnNpc3RXYXRjaGxpc3QoKXsKICB0cnl7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCJlcXVpdHlzY2FuX3dhdGNobGlzdCIsIEpTT04uc3RyaW5naWZ5KHN0YXRlLndhdGNobGlzdCkp",
  "OyB9Y2F0Y2goZSl7fQp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNQQVJLTElORSAoaW5saW5lIFNWRykKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpmdW5jdGlvbiBzcGFya2xpbmVTVkcoc2VyaWVzLCBwb3NpdGl2ZSwgdywgaCl7CiAgdyA9IHd8fDEyMDsgaCA9IGh8fDM2OwogIGlmKCFzZXJpZXMgfHwgc2VyaWVzLmxlbmd0aDwyKSByZXR1cm4gIiI7CiAg",
  "Y29uc3QgbWluID0gTWF0aC5taW4oLi4uc2VyaWVzKSwgbWF4ID0gTWF0aC5tYXgoLi4uc2VyaWVzKTsKICBjb25zdCByYW5nZSA9IChtYXgtbWluKXx8MTsKICBjb25zdCBzdGVwID0gdy8oc2VyaWVzLmxlbmd0aC0xKTsKICBjb25zdCBwdHMgPSBzZXJpZXMubWFw",
  "KCh2LGkpPT5baSpzdGVwLCBoIC0gKCh2LW1pbikvcmFuZ2UpKmgqMC44NiAtIGgqMC4wN10pOwogIGNvbnN0IHBhdGggPSBwdHMubWFwKChwLGkpPT4oaT09PTA/Ik0iOiJMIikrcFswXS50b0ZpeGVkKDEpKyIsIitwWzFdLnRvRml4ZWQoMSkpLmpvaW4oIiAiKTsK",
  "ICBjb25zdCBhcmVhUGF0aCA9IHBhdGggKyBgIEwke3d9LCR7aH0gTDAsJHtofSBaYDsKICBjb25zdCBjb2xvciA9IHBvc2l0aXZlID8gInZhcigtLXBvcykiIDogInZhcigtLW5lZykiOwogIGNvbnN0IGdpZCA9ICJzZyIrTWF0aC5yYW5kb20oKS50b1N0cmluZygz",
  "Nikuc2xpY2UoMiw5KTsKICByZXR1cm4gYDxzdmcgdmlld0JveD0iMCAwICR7d30gJHtofSIgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+CiAgICA8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9IiR7Z2lkfSIgeDE9",
  "IjAiIHkxPSIwIiB4Mj0iMCIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIke2NvbG9yfSIgc3RvcC1vcGFjaXR5PSIwLjM1Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iJHtjb2xvcn0iIHN0b3Atb3Bh",
  "Y2l0eT0iMCIvPgogICAgPC9saW5lYXJHcmFkaWVudD48L2RlZnM+CiAgICA8cGF0aCBkPSIke2FyZWFQYXRofSIgZmlsbD0idXJsKCMke2dpZH0pIiBzdHJva2U9Im5vbmUiLz4KICAgIDxwYXRoIGQ9IiR7cGF0aH0iIGZpbGw9Im5vbmUiIHN0cm9rZT0iJHtjb2xv",
  "cn0iIHN0cm9rZS13aWR0aD0iMS42IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICA8L3N2Zz5gOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09CiAgIEFNQklFTlQgREVDT1JBVElWRSBMSU5FUyAoZHJhd24gb25jZSkKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwooZnVuY3Rpb24gZHJhd0FtYmllbnRMaW5lcygpewogIGNv",
  "bnN0IHN2ZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhbWJpZW50TGluZXMiKTsKICBjb25zdCB3ID0gMTQwMCwgaCA9IDgwMDsKICBzdmcuc2V0QXR0cmlidXRlKCJ2aWV3Qm94IiwgYDAgMCAke3d9ICR7aH1gKTsKICBsZXQgaHRtbCA9ICIiOwogIGZvcihs",
  "ZXQgaT0wO2k8MztpKyspewogICAgY29uc3Qgc2VlZCA9IGkqMTcrMzsKICAgIGNvbnN0IHB0cyA9IFtdOwogICAgY29uc3QgbiA9IDEyOwogICAgZm9yKGxldCBqPTA7ajw9bjtqKyspewogICAgICBjb25zdCB4ID0gKGovbikqdzsKICAgICAgY29uc3QgeSA9IGgq",
  "MC4yNSArIGkqMTMwICsgKHNlZWRlZFJhbmQoc2VlZCtqKS0wLjUpKjkwOwogICAgICBwdHMucHVzaChbeCx5XSk7CiAgICB9CiAgICBjb25zdCBwYXRoID0gcHRzLm1hcCgocCxpZHgpPT4oaWR4PT09MD8iTSI6IkwiKStwWzBdLnRvRml4ZWQoMCkrIiwiK3BbMV0u",
  "dG9GaXhlZCgwKSkuam9pbigiICIpOwogICAgY29uc3QgY29sb3JzID0gWyIjNEM3REZGIiwiIzhCNkJGMCIsIiMzMUQ1RUUiXTsKICAgIGh0bWwgKz0gYDxwYXRoIGQ9IiR7cGF0aH0iIGZpbGw9Im5vbmUiIHN0cm9rZT0iJHtjb2xvcnNbaSUzXX0iIHN0cm9rZS13",
  "aWR0aD0iMSIgb3BhY2l0eT0iMC4xMCIvPmA7CiAgfQogIHN2Zy5pbm5lckhUTUwgPSBodG1sOwp9KSgpOwoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBIRUFERVIgQkVIQVZJT1IK",
  "ICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCB0b3BiYXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidG9wYmFyIik7CndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJzY3Jv",
  "bGwiLCAoKT0+ewogIHRvcGJhci5jbGFzc0xpc3QudG9nZ2xlKCJzY3JvbGxlZCIsIHdpbmRvdy5zY3JvbGxZID4gOCk7Cn0pOwoKZnVuY3Rpb24gc2V0QWN0aXZlTmF2KHZpZXcpewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIiNtYWluTmF2IGJ1dHRvbiwg",
  "I2JvdHRvbU5hdiBidXR0b24iKS5mb3JFYWNoKGI9PnsKICAgIGIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIiwgYi5kYXRhc2V0LnZpZXc9PT12aWV3KTsKICB9KTsKfQpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibWFpbk5hdiIpLmFkZEV2ZW50TGlzdGVuZXIo",
  "ImNsaWNrIiwgZT0+ewogIGNvbnN0IGJ0biA9IGUudGFyZ2V0LmNsb3Nlc3QoImJ1dHRvbltkYXRhLXZpZXddIik7CiAgaWYoYnRuKSBuYXZpZ2F0ZShidG4uZGF0YXNldC52aWV3KTsKfSk7CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJib3R0b21OYXYiKS5hZGRF",
  "dmVudExpc3RlbmVyKCJjbGljayIsIGU9PnsKICBjb25zdCBidG4gPSBlLnRhcmdldC5jbG9zZXN0KCJidXR0b25bZGF0YS12aWV3XSIpOwogIGlmKGJ0bikgbmF2aWdhdGUoYnRuLmRhdGFzZXQudmlldyk7Cn0pOwoKZnVuY3Rpb24gbmF2aWdhdGUodmlldywgdGlj",
  "a2VyKXsKICBzdGF0ZS52aWV3ID0gdmlldzsKICBpZih0aWNrZXIpIHN0YXRlLmRldGFpbFRpY2tlciA9IHRpY2tlcjsKICBzZXRBY3RpdmVOYXYodmlldyA9PT0gImRldGFpbCIgPyAibWFya2V0cyIgOiB2aWV3KTsKICB3aW5kb3cuc2Nyb2xsVG8oe3RvcDowLCBi",
  "ZWhhdmlvcjogd2luZG93Lm1hdGNoTWVkaWEoJyhwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpJykubWF0Y2hlcyA/ICJhdXRvIiA6ICJzbW9vdGgifSk7CiAgcmVuZGVyKCk7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgTUFSS0VUIFNUQVRVUyAoSVNUIGJ1c2luZXNzIGhvdXJzLCBwdXJlbHkgcHJlc2VudGF0aW9uYWwpCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT0gKi8KKGZ1bmN0aW9uIG1hcmtldFN0YXR1cygpewogIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7CiAgY29uc3QgaXN0SG91ciA9IChub3cuZ2V0VVRDSG91cnMoKSs1KSUyNCArIChub3cuZ2V0VVRDTWludXRlcygpKzMwPj02MD8xOjApOwogIGNvbnN0IG1p",
  "bnMgPSAobm93LmdldFVUQ01pbnV0ZXMoKSszMCklNjA7CiAgY29uc3QgdG90YWxNaW4gPSAoKG5vdy5nZXRVVENIb3VycygpKzUpJTI0KSo2MCArIG1pbnM7CiAgY29uc3Qgb3BlbiA9IHRvdGFsTWluID49IDU1NSAmJiB0b3RhbE1pbiA8PSA5MzA7IC8vIDk6MTUg",
  "LSAxNTozMCBJU1QKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibWFya2V0U3RhdHVzVGV4dCIpLnRleHRDb250ZW50ID0gb3BlbiA/ICJNYXJrZXQgT3BlbiIgOiAiTWFya2V0IENsb3NlZCI7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvcigiLmRvdC1saXZlIiku",
  "c3R5bGUuYmFja2dyb3VuZCA9IG9wZW4gPyAidmFyKC0tcG9zKSIgOiAidmFyKC0tdGV4dC1mYWludCkiOwp9KSgpOwoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBSRU5ERVI6IFJP",
  "T1QKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCByb290ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm1haW5Sb290Iik7CgpmdW5jdGlvbiByZW5kZXIoKXsKICBpZihz",
  "dGF0ZS52aWV3ID09PSAiZGFzaGJvYXJkIikgcmVuZGVyRGFzaGJvYXJkKCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09PSAic2NyZWVuZXIiKSByZW5kZXJTY3JlZW5lcigpOwogIGVsc2UgaWYoc3RhdGUudmlldyA9PT0gIm1hcmtldHMiKSByZW5kZXJNYXJrZXRz",
  "KCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09PSAid2F0Y2hsaXN0IikgcmVuZGVyV2F0Y2hsaXN0KCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09PSAiZGV0YWlsIikgcmVuZGVyRGV0YWlsKCk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gREFTSEJPQVJEIC0tLS0t",
  "LS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyRGFzaGJvYXJkKCl7CiAgcm9vdC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJ2aWV3IiBpZD0iZGFzaFZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5NYXJrZXQg",
  "T3ZlcnZpZXc8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPlJlYWwtdGltZSBpbmRleCBzbmFwc2hvdDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGVyby1yb3ciIGlkPSJpbmRpY2VzUm93Ij4KICAgICAgICAke3NrZWxldG9uQ2FyZHMoMyl9CiAgICAgIDwv",
  "ZGl2PgoKICAgICAgJHtzZWFyY2hCbG9jaygpfQoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+TWFya2V0IEJyZWFkdGg8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPkFkdmFuY2VycyB2cyBkZWNsaW5lcnMsIGZ1bGwgdW5pdmVyc2U8L3NwYW4+PC9k",
  "aXY+CiAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGJyZWFkdGgtY2FyZCIgaWQ9ImJyZWFkdGhDYXJkIiBzdHlsZT0icGFkZGluZzoxOHB4IDIycHg7bWFyZ2luLWJvdHRvbTozNHB4OyI+JHtza2VsZXRvbkxpbmVzKDIpfTwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0i",
  "c2VjdGlvbi1oZWFkIj48aDI+VG9wIE1vdmVyczwvaDI+PHNwYW4gY2xhc3M9InN1YiI+QnkgYWJzb2x1dGUgY2hhbmdlIHRvZGF5PC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIGdsYXNzIiBpZD0ibW92ZXJzVGFibGVXcmFwIj48ZGl2",
  "IHN0eWxlPSJwYWRkaW5nOjIwcHg7Ij4ke3NrZWxldG9uTGluZXMoNil9PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0b2NrLWNhcmRzIiBpZD0ibW92ZXJzQ2FyZHMiPjwvZGl2PgogICAgPC9kaXY+CiAgYDsKICB3aXJlU2VhcmNoKCk7CgogIHRyeXsK",
  "ICAgIGNvbnN0IGluZGljZXMgPSBhd2FpdCBBUEkuZmV0Y2hJbmRpY2VzKCk7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiaW5kaWNlc1JvdyIpLmlubmVySFRNTCA9IGluZGljZXMubWFwKGluZGV4Q2FyZEhUTUwpLmpvaW4oIiIpOwogICAgZG9jdW1lbnQu",
  "cXVlcnlTZWxlY3RvckFsbCgiLmluZGV4LXNwYXJrIikuZm9yRWFjaCgoZWwsaSk9PnsKICAgICAgZWwuaW5uZXJIVE1MID0gc3BhcmtsaW5lU1ZHKGluZGljZXNbaV0uc2VyaWVzLCBpbmRpY2VzW2ldLmNoYW5nZT49MCk7CiAgICB9KTsKICB9Y2F0Y2goZSl7CiAg",
  "ICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiaW5kaWNlc1JvdyIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJNYXJrZXQgZGF0YSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZSIsICJXZSBjb3VsZG4ndCByZWFjaCB0aGUgaW5kaWNlcyBmZWVkLiBQbGVhc2Ug",
  "dHJ5IGFnYWluIHNob3J0bHkuIik7CiAgfQoKICB0cnl7CiAgICBjb25zdCBmdWxsID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHt9KTsKICAgIHJlbmRlckJyZWFkdGgoZnVsbCk7CiAgICBjb25zdCBtb3ZlcnMgPSBmdWxsLnNsaWNlKCkuc29ydCgo",
  "YSxiKT0+TWF0aC5hYnMoYi5wY3QpLU1hdGguYWJzKGEucGN0KSkuc2xpY2UoMCw4KTsKICAgIHJlbmRlclRhYmxlSW50bygibW92ZXJzVGFibGVXcmFwIiwgIm1vdmVyc0NhcmRzIiwgbW92ZXJzLCB7a2V5OiJwY3QiLCBkaXI6ImRlc2MifSwgZmFsc2UpOwogIH1j",
  "YXRjaChlKXsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtb3ZlcnNUYWJsZVdyYXAiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIHJldHJpZXZlIG1vdmVycyIsICJTb21ldGhpbmcgd2VudCB3cm9uZyBsb2FkaW5nIHRoaXMgbGlz",
  "dC4iKTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJicmVhZHRoQ2FyZCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJCcmVhZHRoIGRhdGEgdW5hdmFpbGFibGUiLCAiQ291bGRuJ3QgY29tcHV0ZSBhZHZhbmNlcnMgdnMgZGVjbGluZXJzLiIpOwog",
  "IH0KfQoKZnVuY3Rpb24gcmVuZGVyQnJlYWR0aChsaXN0KXsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJicmVhZHRoQ2FyZCIpOwogIGlmKCFlbCB8fCAhbGlzdC5sZW5ndGgpeyBpZihlbCkgZWwuaW5uZXJIVE1MID0gZW1wdHlTdGF0ZUhU",
  "TUwoIk5vIGJyZWFkdGggZGF0YSIsICJObyBzdG9ja3Mgd2VyZSByZXR1cm5lZCB0byBjb21wdXRlIHRoaXMgZnJvbS4iKTsgcmV0dXJuOyB9CiAgY29uc3QgYWR2YW5jZXJzID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q+MCkubGVuZ3RoOwogIGNvbnN0IGRlY2xpbmVy",
  "cyA9IGxpc3QuZmlsdGVyKHM9PnMucGN0PDApLmxlbmd0aDsKICBjb25zdCBmbGF0ID0gbGlzdC5sZW5ndGggLSBhZHZhbmNlcnMgLSBkZWNsaW5lcnM7CiAgY29uc3QgdG90YWwgPSBsaXN0Lmxlbmd0aDsKICBjb25zdCBhZHZQY3QgPSAoYWR2YW5jZXJzL3RvdGFs",
  "KSoxMDAsIGRlY1BjdCA9IChkZWNsaW5lcnMvdG90YWwpKjEwMCwgZmxhdFBjdCA9IChmbGF0L3RvdGFsKSoxMDA7CiAgZWwuaW5uZXJIVE1MID0gYAogICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWdu",
  "LWl0ZW1zOmJhc2VsaW5lO21hcmdpbi1ib3R0b206MTJweDtmbGV4LXdyYXA6d3JhcDtnYXA6OHB4OyI+CiAgICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtnYXA6MjBweDsiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIi",
  "IHN0eWxlPSJmb250LXNpemU6MjBweDtjb2xvcjp2YXIoLS1wb3Mtc29mdCk7Ij4ke2FkdmFuY2Vyc308L3NwYW4+IDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTJweDsiPmFkdmFuY2luZzwvc3Bhbj48L2Rpdj4KICAgICAgICA8",
  "ZGl2PjxzcGFuIGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFyIiBzdHlsZT0iZm9udC1zaXplOjIwcHg7Y29sb3I6dmFyKC0tbmVnLXNvZnQpOyI+JHtkZWNsaW5lcnN9PC9zcGFuPiA8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEy",
  "cHg7Ij5kZWNsaW5pbmc8L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciIgc3R5bGU9ImZvbnQtc2l6ZToyMHB4O2NvbG9yOnZhcigtLXRleHQtbWlkKTsiPiR7ZmxhdH08L3NwYW4+IDxzcGFuIHN0eWxlPSJj",
  "b2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTJweDsiPnVuY2hhbmdlZDwvc3Bhbj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMS41cHg7Y29sb3I6dmFyKC0tdGV4dC1mYWludCk7Ij5vZiAke3RvdGFsfSB0cmFj",
  "a2VkIHN0b2NrczwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7aGVpZ2h0OjEwcHg7Ym9yZGVyLXJhZGl1czo2cHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7Ij4KICAgICAgPGRpdiBzdHlsZT0i",
  "d2lkdGg6JHthZHZQY3R9JTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5MGRlZyx2YXIoLS1wb3MpLHZhcigtLXBvcy1zb2Z0KSk7Ij48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0id2lkdGg6JHtmbGF0UGN0fSU7YmFja2dyb3VuZDp2YXIoLS10ZXh0LWZhaW50",
  "KTsiPjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJ3aWR0aDoke2RlY1BjdH0lO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHZhcigtLW5lZy1zb2Z0KSx2YXIoLS1uZWcpKTsiPjwvZGl2PgogICAgPC9kaXY+CiAgYDsKfQoKZnVuY3Rpb24gaW5kZXhD",
  "YXJkSFRNTChpZHgpewogIGNvbnN0IHBvc2l0aXZlID0gaWR4LmNoYW5nZSA+PSAwOwogIHJldHVybiBgCiAgPGRpdiBjbGFzcz0iZ2xhc3MgaW5kZXgtY2FyZCI+CiAgICA8ZGl2IGNsYXNzPSJyb3cxIj4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJp",
  "bmRleC1uYW1lIj4ke2lkeC5jb2RlfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImluZGV4LWZ1bGwiPiR7aWR4LmZ1bGx9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJpbmRleC1iYWRnZSAke3Bvc2l0aXZlPydwb3MnOiduZWcnfSI+CiAg",
  "ICAgICAgJHtwb3NpdGl2ZT8n4payJzon4pa8J30gJHtwY3RTdHIoaWR4LnBjdCl9CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFyIj4ke2lkeC52YWx1ZS50b0xvY2FsZVN0cmluZygiZW4tSU4iLHttYXhp",
  "bXVtRnJhY3Rpb25EaWdpdHM6Mn0pfTwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtY2hhbmdlICR7cG9zaXRpdmU/J3Bvcyc6J25lZyd9IHRhYnVsYXIiPiR7Y2hnU3RyKGlkeC5jaGFuZ2UpfTwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtc3BhcmsiPjwv",
  "ZGl2PgogIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHNrZWxldG9uQ2FyZHMobil7CiAgcmV0dXJuIEFycmF5LmZyb20oe2xlbmd0aDpufSkubWFwKCgpPT5gPGRpdiBjbGFzcz0iZ2xhc3Mgc2tlbC1jYXJkIHNrZWwiPjwvZGl2PmApLmpvaW4oIiIpOwp9CmZ1bmN0aW9u",
  "IHNrZWxldG9uTGluZXMobil7CiAgcmV0dXJuIEFycmF5LmZyb20oe2xlbmd0aDpufSkubWFwKCgpPT5gPGRpdiBjbGFzcz0ic2tlbCBza2VsLWxpbmUiIHN0eWxlPSJ3aWR0aDokezYwK01hdGgucmFuZG9tKCkqMzV9JSI+PC9kaXY+YCkuam9pbigiIik7Cn0KCi8q",
  "IC0tLS0tLS0tLS0tLS0tLS0gU0VBUkNIIC0tLS0tLS0tLS0tLS0tLS0gKi8KZnVuY3Rpb24gc2VhcmNoQmxvY2soKXsKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9InNlYXJjaC13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHg7Ij4KICAgIDxkaXYgY2xhc3M9InNl",
  "YXJjaC1ib3ggZ2xhc3MiIGlkPSJzZWFyY2hCb3giPgogICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48Y2lyY2xlIGN4PSIx",
  "MSIgY3k9IjExIiByPSI3Ii8+PHBhdGggZD0iTTIxIDIxbC00LjMtNC4zIi8+PC9zdmc+CiAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0ic2VhcmNoSW5wdXQiIHBsYWNlaG9sZGVyPSJTZWFyY2ggc3RvY2tzIGJ5IG5hbWUgb3IgdGlja2Vy4oCmIiBhdXRvY29t",
  "cGxldGU9Im9mZiI+CiAgICAgIDxrYmQgY2xhc3M9ImtzaG9ydGN1dCI+Lzwva2JkPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtZHJvcCBnbGFzcyIgaWQ9InNlYXJjaERyb3AiIHN0eWxlPSJkaXNwbGF5Om5vbmU7Ij48L2Rpdj4KICA8L2Rpdj5g",
  "Owp9CgpsZXQgc2VhcmNoRGVib3VuY2U7CmZ1bmN0aW9uIHdpcmVTZWFyY2goKXsKICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hJbnB1dCIpOwogIGNvbnN0IGJveCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hC",
  "b3giKTsKICBjb25zdCBkcm9wID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaERyb3AiKTsKICBpZighaW5wdXQpIHJldHVybjsKCiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsIChlKT0+ewogICAgaWYoZS5rZXkgPT09ICIvIiAm",
  "JiBkb2N1bWVudC5hY3RpdmVFbGVtZW50ICE9PSBpbnB1dCl7CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgaW5wdXQuZm9jdXMoKTsKICAgIH0KICAgIGlmKGUua2V5ID09PSAiRXNjYXBlIil7IGlucHV0LmJsdXIoKTsgZHJvcC5zdHlsZS5kaXNwbGF5",
  "PSJub25lIjsgYm94LmNsYXNzTGlzdC5yZW1vdmUoImZvY3VzZWQiKTsgfQogIH0pOwoKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCJmb2N1cyIsICgpPT4gYm94LmNsYXNzTGlzdC5hZGQoImZvY3VzZWQiKSk7CiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigiYmx1",
  "ciIsICgpPT4gc2V0VGltZW91dCgoKT0+eyBib3guY2xhc3NMaXN0LnJlbW92ZSgiZm9jdXNlZCIpOyBkcm9wLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyB9LCAxNjApKTsKCiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLCAoKT0+ewogICAgY2xlYXJUaW1l",
  "b3V0KHNlYXJjaERlYm91bmNlKTsKICAgIGNvbnN0IHEgPSBpbnB1dC52YWx1ZTsKICAgIGlmKCFxLnRyaW0oKSl7IGRyb3Auc3R5bGUuZGlzcGxheT0ibm9uZSI7IHJldHVybjsgfQogICAgZHJvcC5zdHlsZS5kaXNwbGF5PSJibG9jayI7CiAgICBkcm9wLmlubmVy",
  "SFRNTCA9IGA8ZGl2IHN0eWxlPSJwYWRkaW5nOjE0cHggMTZweDsiPiR7c2tlbGV0b25MaW5lcygzKX08L2Rpdj5gOwogICAgc2VhcmNoRGVib3VuY2UgPSBzZXRUaW1lb3V0KGFzeW5jICgpPT57CiAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBBUEkuc2VhcmNo",
  "U3RvY2tzKHEpOwogICAgICBpZighcmVzdWx0cy5sZW5ndGgpewogICAgICAgIGRyb3AuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InNlYXJjaC1lbXB0eSI+Tm8gc3RvY2tzIG1hdGNoIOKAnCR7ZXNjYXBlSHRtbChxKX3igJ08L2Rpdj5gOwogICAgICAgIHJldHVy",
  "bjsKICAgICAgfQogICAgICBkcm9wLmlubmVySFRNTCA9IHJlc3VsdHMubWFwKChzLGkpPT5gCiAgICAgICAgPGRpdiBjbGFzcz0ic2VhcmNoLXJvdyIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqMjh9bXMiIGRhdGEtdGlja2VyPSIke3MudH0iPgogICAgICAg",
  "ICAgPGRpdiBjbGFzcz0ic3ItbGVmdCI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9InNyLXRpY2tlciI+JHtzLnQuc2xpY2UoMCwzKX08L2Rpdj4KICAgICAgICAgICAgPGRpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJzci1uYW1lIj4ke2VzY2FwZUh0bWwo",
  "cy5uYW1lKX08L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJzci1tZXRhIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJzci1wcmljZSB0YWJ1bGFy",
  "Ij4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgYCkuam9pbigiIik7CiAgICAgIGRyb3AucXVlcnlTZWxlY3RvckFsbCgiLnNlYXJjaC1yb3ciKS5mb3JFYWNoKHJvdz0+ewogICAgICAgIHJvdy5hZGRFdmVudExpc3RlbmVyKCJt",
  "b3VzZWRvd24iLCAoKT0+ewogICAgICAgICAgbmF2aWdhdGUoImRldGFpbCIsIHJvdy5kYXRhc2V0LnRpY2tlcik7CiAgICAgICAgfSk7CiAgICAgIH0pOwogICAgfSwgMjYwKTsKICB9KTsKfQpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoVG9nZ2xlQnRu",
  "IikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaElucHV0Iik7CiAgaWYoaW5wdXQpIGlucHV0LmZvY3VzKCk7CiAgZWxzZSBuYXZpZ2F0ZSgiZGFzaGJvYXJkIik7Cn0p",
  "OwoKLyogLS0tLS0tLS0tLS0tLS0tLSBTSEFSRUQgVEFCTEUgUkVOREVSIC0tLS0tLS0tLS0tLS0tLS0gKi8KZnVuY3Rpb24gcmVuZGVyVGFibGVJbnRvKHdyYXBJZCwgY2FyZHNJZCwgbGlzdCwgc29ydCwgc2hvd1NlY3RvckNvbCl7CiAgY29uc3Qgd3JhcCA9IGRv",
  "Y3VtZW50LmdldEVsZW1lbnRCeUlkKHdyYXBJZCk7CiAgY29uc3QgY2FyZHMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChjYXJkc0lkKTsKICBpZighbGlzdC5sZW5ndGgpewogICAgd3JhcC5pbm5lckhUTUwgPSBlbXB0eVN0YXRlSFRNTCgiTm8gc3RvY2tzIG1h",
  "dGNoIHlvdXIgZmlsdGVycyIsICJUcnkgd2lkZW5pbmcgeW91ciBwcmljZSByYW5nZSBvciBjbGVhcmluZyBhIGZpbHRlci4iKTsKICAgIGlmKGNhcmRzKSBjYXJkcy5pbm5lckhUTUwgPSAiIjsKICAgIHJldHVybjsKICB9CiAgY29uc3Qgc29ydGVkID0gc29ydFN0",
  "b2NrcyhsaXN0LCBzb3J0KTsKCiAgd3JhcC5pbm5lckhUTUwgPSBgCiAgICA8dGFibGUgY2xhc3M9InN0b2NrLXRhYmxlIj4KICAgICAgPHRoZWFkPjx0cj4KICAgICAgICA8dGg+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9Im5hbWUiPkNvbXBhbnk8L3RoPgog",
  "ICAgICAgIDx0aCBkYXRhLWtleT0icHJpY2UiPlByaWNlPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9ImNoYW5nZSI+Q2hhbmdlPC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9InBjdCI+Q2hhbmdlICU8",
  "L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0ibWFya2V0Q2FwIj5NYXJrZXQgQ2FwPC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9InZvbHVtZSI+Vm9sdW1lPC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9ImhpZ2g1MiI+NTJXIEhpZ2g8L3RoPgogICAgICAgIDx0",
  "aCBkYXRhLWtleT0ibG93NTIiPjUyVyBMb3c8L3RoPgogICAgICA8L3RyPjwvdGhlYWQ+CiAgICAgIDx0Ym9keT4KICAgICAgICAke3NvcnRlZC5tYXAoKHMsaSk9PnN0b2NrUm93SFRNTChzLGkpKS5qb2luKCIiKX0KICAgICAgPC90Ym9keT4KICAgIDwvdGFibGU+",
  "CiAgYDsKICB3cmFwLnF1ZXJ5U2VsZWN0b3JBbGwoInRoW2RhdGEta2V5XSIpLmZvckVhY2godGg9PnsKICAgIHRoLmNsYXNzTGlzdC50b2dnbGUoInNvcnRlZCIsIHRoLmRhdGFzZXQua2V5PT09c29ydC5rZXkpOwogICAgaWYodGguZGF0YXNldC5rZXk9PT1zb3J0",
  "LmtleSkgdGgucXVlcnlTZWxlY3RvcigiLnNvcnQtaW5kIikudGV4dENvbnRlbnQgPSBzb3J0LmRpcj09PSJkZXNjIj8i4pa+Ijoi4pa0IjsKICAgIHRoLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgICAgY29uc3Qga2V5ID0gdGguZGF0YXNldC5r",
  "ZXk7CiAgICAgIGNvbnN0IG5ld0RpciA9IChzb3J0LmtleT09PWtleSAmJiBzb3J0LmRpcj09PSJkZXNjIikgPyAiYXNjIiA6ICJkZXNjIjsKICAgICAgY29uc3QgbmV3U29ydCA9IHtrZXksIGRpcjpuZXdEaXJ9OwogICAgICBpZih3cmFwSWQ9PT0ic2NyZWVuZXJU",
  "YWJsZVdyYXAiKSBzdGF0ZS5zY3JlZW5lclNvcnQgPSBuZXdTb3J0OwogICAgICByZW5kZXJUYWJsZUludG8od3JhcElkLCBjYXJkc0lkLCBsaXN0LCBuZXdTb3J0LCBzaG93U2VjdG9yQ29sKTsKICAgIH0pOwogIH0pOwogIHdpcmVSb3dJbnRlcmFjdGlvbnMod3Jh",
  "cCk7CgogIGlmKGNhcmRzKXsKICAgIGNhcmRzLmlubmVySFRNTCA9IHNvcnRlZC5tYXAoKHMsaSk9PnN0b2NrQ2FyZEhUTUwocyxpKSkuam9pbigiIik7CiAgICB3aXJlUm93SW50ZXJhY3Rpb25zKGNhcmRzKTsKICB9Cn0KCmZ1bmN0aW9uIHNvcnRTdG9ja3MobGlz",
  "dCwgc29ydCl7CiAgcmV0dXJuIGxpc3Quc2xpY2UoKS5zb3J0KChhLGIpPT57CiAgICBsZXQgYXY9YVtzb3J0LmtleV0sIGJ2PWJbc29ydC5rZXldOwogICAgaWYoc29ydC5rZXk9PT0ibmFtZSIpeyBhdj1hLm5hbWU7IGJ2PWIubmFtZTsgcmV0dXJuIHNvcnQuZGly",
  "PT09ImFzYyI/IGF2LmxvY2FsZUNvbXBhcmUoYnYpIDogYnYubG9jYWxlQ29tcGFyZShhdik7IH0KICAgIHJldHVybiBzb3J0LmRpcj09PSJhc2MiID8gYXYtYnYgOiBidi1hdjsKICB9KTsKfQoKZnVuY3Rpb24gc3RvY2tSb3dIVE1MKHMsaSl7CiAgY29uc3QgcG9z",
  "ID0gcy5wY3Q+PTA7CiAgY29uc3QgaW5XYXRjaCA9IHN0YXRlLndhdGNobGlzdC5pbmNsdWRlcyhzLnQpOwogIHJldHVybiBgCiAgPHRyIGRhdGEtdGlja2VyPSIke3MudH0iIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjIyfW1zIj4KICAgIDx0ZCBvbmNsaWNr",
  "PSJldmVudC5zdG9wUHJvcGFnYXRpb24oKSI+CiAgICAgIDxidXR0b24gY2xhc3M9InN0YXItYnRuICR7aW5XYXRjaD8nYWN0aXZlJzonJ30iIGRhdGEtc3Rhcj0iJHtzLnR9IiB0aXRsZT0iJHtpbldhdGNoPydSZW1vdmUgZnJvbSB3YXRjaGxpc3QnOidBZGQgdG8g",
  "d2F0Y2hsaXN0J30iPgogICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSIke2luV2F0Y2g/J2N1cnJlbnRDb2xvcic6J25vbmUnfSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTEyIDE3LjNsLTYuMTYg",
  "My42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIgMi40bDIuOTQgNi40IDcuMDYuNi01LjQ4IDQuNiAxLjY0IDYuOXoiLz48L3N2Zz4KICAgICAgPC9idXR0b24+CiAgICA8L3RkPgogICAgPHRkPgogICAgICA8ZGl2IGNsYXNzPSJjZWxsLWNvbXBhbnkiPgogICAg",
  "ICAgIDxkaXYgY2xhc3M9ImNlbGwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgIDxkaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgICAgPGRp",
  "diBjbGFzcz0iY29tcGFueS1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdElOUihzLnByaWNlKX08L3RkPgogICAgPHRkIGNsYXNzPSJ0",
  "YWJ1bGFyIj48c3BhbiBjbGFzcz0iY2hhbmdlLXBpbGwgJHtwb3M/J3Bvcyc6J25lZyd9Ij4ke2NoZ1N0cihzLmNoYW5nZSl9PC9zcGFuPjwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPjxzcGFuIGNsYXNzPSJjaGFuZ2UtcGlsbCAke3Bvcz8ncG9zJzonbmVn",
  "J30iPiR7cGN0U3RyKHMucGN0KX08L3NwYW4+PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRDb21wYWN0KHMubWFya2V0Q2FwKX08L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdFZvbChzLnZvbHVtZSl9PC90ZD4KICAgIDx0ZCBjbGFz",
  "cz0idGFidWxhciI+JHtmbXRJTlIocy5oaWdoNTIpfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10SU5SKHMubG93NTIpfTwvdGQ+CiAgPC90cj5gOwp9CgpmdW5jdGlvbiBzdG9ja0NhcmRIVE1MKHMsaSl7CiAgY29uc3QgcG9zID0gcy5wY3Q+PTA7",
  "CiAgY29uc3QgaW5XYXRjaCA9IHN0YXRlLndhdGNobGlzdC5pbmNsdWRlcyhzLnQpOwogIHJldHVybiBgCiAgPGRpdiBjbGFzcz0iZ2xhc3Mgc3RvY2stY2FyZCIgZGF0YS10aWNrZXI9IiR7cy50fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqMjZ9bXMiPgog",
  "ICAgPGRpdiBjbGFzcz0ibGVmdCI+CiAgICAgIDxkaXYgY2xhc3M9ImNlbGwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJuYW1lLWJsb2NrIj4KICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LW5hbWUiPiR7",
  "ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJyaWdodCI+CiAgICAgIDxkaXYgY2xhc3M9",
  "InByaWNlIHRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgICA8c3BhbiBjbGFzcz0iY2hhbmdlLXBpbGwgJHtwb3M/J3Bvcyc6J25lZyd9IiBzdHlsZT0ibWFyZ2luLXRvcDo0cHg7Ij4ke3BjdFN0cihzLnBjdCl9PC9zcGFuPgogICAgPC9kaXY+",
  "CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gd2lyZVJvd0ludGVyYWN0aW9ucyhjb250YWluZXIpewogIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCJ0cltkYXRhLXRpY2tlcl0sIC5zdG9jay1jYXJkW2RhdGEtdGlja2VyXSIpLmZvckVhY2goZWw9PnsKICAgIGVs",
  "LmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PiBuYXZpZ2F0ZSgiZGV0YWlsIiwgZWwuZGF0YXNldC50aWNrZXIpKTsKICB9KTsKICBjb250YWluZXIucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtc3Rhcl0iKS5mb3JFYWNoKGJ0bj0+ewogICAgYnRuLmFkZEV2",
  "ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7CiAgICAgIHRvZ2dsZVdhdGNoKGJ0bi5kYXRhc2V0LnN0YXIpOwogICAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIik7CiAgICAgIGJ0bi5xdWVyeVNlbGVj",
  "dG9yKCJzdmciKS5zZXRBdHRyaWJ1dGUoImZpbGwiLCBidG4uY2xhc3NMaXN0LmNvbnRhaW5zKCJhY3RpdmUiKSA/ICJjdXJyZW50Q29sb3IiIDogIm5vbmUiKTsKICAgIH0pOwogIH0pOwp9CgpmdW5jdGlvbiB0b2dnbGVXYXRjaCh0aWNrZXIpewogIGNvbnN0IGlk",
  "eCA9IHN0YXRlLndhdGNobGlzdC5pbmRleE9mKHRpY2tlcik7CiAgaWYoaWR4Pj0wKSBzdGF0ZS53YXRjaGxpc3Quc3BsaWNlKGlkeCwxKTsKICBlbHNlIHN0YXRlLndhdGNobGlzdC5wdXNoKHRpY2tlcik7CiAgcGVyc2lzdFdhdGNobGlzdCgpOwp9CgovKiAtLS0t",
  "LS0tLS0tLS0tLS0tIFNDUkVFTkVSIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyU2NyZWVuZXIoKXsKICBjb25zdCBzZWN0b3JzID0gWyJBbGwiLCAuLi5BcnJheS5mcm9tKG5ldyBTZXQoVU5JVkVSU0UubWFwKHM9PnMuc2VjdG9yKSkp",
  "XTsKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5TY3JlZW5lcjwvaDI+PHNwYW4gY2xhc3M9InN1YiI+RmlsdGVyIHRoZSBtYXJrZXQgb24geW91ciB0ZXJtczwvc3Bh",
  "bj48L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGZpbHRlcnMtYmFyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCIgc3R5bGU9Im1pbi13aWR0aDoyMDBweDsiPgogICAgICAgICAgPGxhYmVsPlNlYXJjaDwvbGFiZWw+CiAgICAgICAgICA8",
  "aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImZRdWVyeSIgcGxhY2Vob2xkZXI9IlRpY2tlciBvciBjb21wYW554oCmIiB2YWx1ZT0iJHtlc2NhcGVIdG1sKHN0YXRlLnNjcmVlbmVyRmlsdGVycy5xdWVyeSl9Ij4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNz",
  "PSJmaWx0ZXItY2hpcCI+CiAgICAgICAgICA8bGFiZWw+U2VjdG9yPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9ImZTZWN0b3IiPiR7c2VjdG9ycy5tYXAocz0+YDxvcHRpb24gJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMuc2VjdG9yPT09cz8nc2VsZWN0ZWQn",
  "OicnfT4ke3N9PC9vcHRpb24+YCkuam9pbigiIil9PC9zZWxlY3Q+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmlsdGVyLWNoaXAiPgogICAgICAgICAgPGxhYmVsPk1heCBQcmljZSA8c3BhbiBjbGFzcz0icmFuZ2UtdmFsIiBpZD0iZlByaWNl",
  "VmFsIj4ke2ZtdElOUihzdGF0ZS5zY3JlZW5lckZpbHRlcnMubWF4UHJpY2UsMCl9PC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0icmFuZ2UiIGNsYXNzPSJyYW5nZS1zbGlkZXIiIGlkPSJmTWF4UHJpY2UiIG1pbj0iNTAwIiBtYXg9IjE1MDAw",
  "IiBzdGVwPSIyNTAiIHZhbHVlPSIke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQcmljZX0iPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpbHRlci1jaGlwIiBzdHlsZT0ibWluLXdpZHRoOjE5MHB4OyI+CiAgICAgICAgICA8bGFiZWw+RGly",
  "ZWN0aW9uPC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1ncm91cCI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1idG4gJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMuZGlyZWN0aW9uPT09J2FsbCc/J2FjdGl2ZSc6Jyd9IiBkYXRhLWRp",
  "cj0iYWxsIj5BbGw8L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0idG9nZ2xlLWJ0biAke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb249PT0nZ2FpbmVycyc/J2FjdGl2ZSc6Jyd9IiBkYXRhLWRpcj0iZ2FpbmVycyI+R2FpbmVyczwvZGl2PgogICAg",
  "ICAgICAgICA8ZGl2IGNsYXNzPSJ0b2dnbGUtYnRuICR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLmRpcmVjdGlvbj09PSdsb3NlcnMnPydhY3RpdmUnOicnfSIgZGF0YS1kaXI9Imxvc2VycyI+TG9zZXJzPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rp",
  "dj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZXNldC1maWx0ZXJzIiBpZD0icmVzZXRGaWx0ZXJzIj5SZXNldCBmaWx0ZXJzPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDIgaWQ9InNjcmVlbmVyQ291bnQiPlJlc3Vs",
  "dHM8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPlNvcnRlZCBieSBtYXJrZXQgY2FwPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIGdsYXNzIiBpZD0ic2NyZWVuZXJUYWJsZVdyYXAiPjxkaXYgc3R5bGU9InBhZGRpbmc6MjBweDsiPiR7c2tl",
  "bGV0b25MaW5lcyg4KX08L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RvY2stY2FyZHMiIGlkPSJzY3JlZW5lckNhcmRzIj48L2Rpdj4KICAgIDwvZGl2PgogIGA7CgogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJmUXVlcnkiKS5hZGRFdmVudExpc3Rl",
  "bmVyKCJpbnB1dCIsIGRlYm91bmNlKGU9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5xdWVyeSA9IGUudGFyZ2V0LnZhbHVlOyBydW5TY3JlZW5lcigpOwogIH0sIDI2MCkpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJmU2VjdG9yIikuYWRkRXZlbnRM",
  "aXN0ZW5lcigiY2hhbmdlIiwgZT0+ewogICAgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3RvciA9IGUudGFyZ2V0LnZhbHVlOyBydW5TY3JlZW5lcigpOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJmTWF4UHJpY2UiKS5hZGRFdmVudExpc3RlbmVy",
  "KCJpbnB1dCIsIGU9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQcmljZSA9IE51bWJlcihlLnRhcmdldC52YWx1ZSk7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZlByaWNlVmFsIikudGV4dENvbnRlbnQgPSBmbXRJTlIoc3RhdGUuc2NyZWVu",
  "ZXJGaWx0ZXJzLm1heFByaWNlLDApOwogICAgcnVuU2NyZWVuZXIoKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1kaXJdIikuZm9yRWFjaChidG49PnsKICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICAg",
  "IHN0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb24gPSBidG4uZGF0YXNldC5kaXI7CiAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWRpcl0iKS5mb3JFYWNoKGI9PmIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIiwgYj09PWJ0bikpOwog",
  "ICAgICBydW5TY3JlZW5lcigpOwogICAgfSk7CiAgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInJlc2V0RmlsdGVycyIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycyA9IHtxdWVyeToiIiwgc2Vj",
  "dG9yOiJBbGwiLCBtaW5QcmljZTowLCBtYXhQcmljZToxNTAwMCwgZGlyZWN0aW9uOiJhbGwifTsKICAgIHJlbmRlclNjcmVlbmVyKCk7CiAgfSk7CgogIHJ1blNjcmVlbmVyKCk7Cn0KCmZ1bmN0aW9uIGRlYm91bmNlKGZuLCBtcyl7CiAgbGV0IGg7CiAgcmV0dXJu",
  "ICguLi5hcmdzKT0+eyBjbGVhclRpbWVvdXQoaCk7IGg9c2V0VGltZW91dCgoKT0+Zm4oLi4uYXJncyksIG1zKTsgfTsKfQoKYXN5bmMgZnVuY3Rpb24gcnVuU2NyZWVuZXIoKXsKICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNjcmVlbmVy",
  "VGFibGVXcmFwIik7CiAgd3JhcC5zdHlsZS5vcGFjaXR5ID0gIjAuNTUiOwogIHRyeXsKICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJlc3VsdHMoc3RhdGUuc2NyZWVuZXJGaWx0ZXJzKTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRC",
  "eUlkKCJzY3JlZW5lckNvdW50IikudGV4dENvbnRlbnQgPSBgUmVzdWx0cyAoJHtyZXN1bHRzLmxlbmd0aH0pYDsKICAgIHJlbmRlclRhYmxlSW50bygic2NyZWVuZXJUYWJsZVdyYXAiLCAic2NyZWVuZXJDYXJkcyIsIHJlc3VsdHMsIHN0YXRlLnNjcmVlbmVyU29y",
  "dCwgdHJ1ZSk7CiAgfWNhdGNoKGUpewogICAgd3JhcC5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiU2NyZWVuZXIgZGF0YSB1bmF2YWlsYWJsZSIsICJXZSBjb3VsZG4ndCBsb2FkIG1hdGNoaW5nIHN0b2NrcyByaWdodCBub3cuIik7CiAgfQogIHdyYXAuc3R5",
  "bGUub3BhY2l0eSA9ICIxIjsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBNQVJLRVRTIChhbGlhcyBvZiBmdWxsIHVuaXZlcnNlIHRhYmxlKSAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlck1hcmtldHMoKXsKICByb290LmlubmVySFRNTCA9",
  "IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5NYXJrZXRzPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5GdWxsIE5TRSB1bml2ZXJzZSBzbmFwc2hvdDwvc3Bhbj48L2Rpdj4KICAgICAgJHtzZWFyY2hCbG9j",
  "aygpfQogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIGdsYXNzIiBpZD0ibWFya2V0c1RhYmxlV3JhcCI+PGRpdiBzdHlsZT0icGFkZGluZzoyMHB4OyI+JHtza2VsZXRvbkxpbmVzKDEwKX08L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RvY2stY2Fy",
  "ZHMiIGlkPSJtYXJrZXRzQ2FyZHMiPjwvZGl2PgogICAgPC9kaXY+CiAgYDsKICB3aXJlU2VhcmNoKCk7CiAgdHJ5ewogICAgY29uc3QgbGlzdCA9IGF3YWl0IEFQSS5mZXRjaFNjcmVlbmVyUmVzdWx0cyh7fSk7CiAgICByZW5kZXJUYWJsZUludG8oIm1hcmtldHNU",
  "YWJsZVdyYXAiLCAibWFya2V0c0NhcmRzIiwgbGlzdCwge2tleToibWFya2V0Q2FwIiwgZGlyOiJkZXNjIn0sIHRydWUpOwogIH1jYXRjaChlKXsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtYXJrZXRzVGFibGVXcmFwIikuaW5uZXJIVE1MID0gZXJyb3JT",
  "dGF0ZUhUTUwoIk1hcmtldCBkYXRhIHRlbXBvcmFyaWx5IHVuYXZhaWxhYmxlIiwgIlBsZWFzZSB0cnkgYWdhaW4gaW4gYSBtb21lbnQuIik7CiAgfQp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIFdBVENITElTVCAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0",
  "aW9uIHJlbmRlcldhdGNobGlzdCgpewogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPldhdGNobGlzdDwvaDI+PHNwYW4gY2xhc3M9InN1YiI+JHtzdGF0ZS53YXRjaGxp",
  "c3QubGVuZ3RofSBzdG9jayR7c3RhdGUud2F0Y2hsaXN0Lmxlbmd0aD09PTE/Jyc6J3MnfSB0cmFja2VkPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ3YXRjaGxpc3QtZ3JpZCIgaWQ9IndhdGNoR3JpZCI+JHtza2VsZXRvbkNhcmRzKE1hdGgubWF4KHN0",
  "YXRlLndhdGNobGlzdC5sZW5ndGgsMykpfTwvZGl2PgogICAgPC9kaXY+CiAgYDsKICBpZighc3RhdGUud2F0Y2hsaXN0Lmxlbmd0aCl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgid2F0Y2hHcmlkIikuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9IndhdGNo",
  "LWVtcHR5IGdsYXNzIj4ke2VtcHR5U3RhdGVJbm5lcigiWW91ciB3YXRjaGxpc3QgaXMgZW1wdHkiLCAiU3RhciBhbnkgc3RvY2sgZnJvbSB0aGUgZGFzaGJvYXJkLCBzY3JlZW5lciBvciBtYXJrZXRzIHZpZXcgdG8gdHJhY2sgaXQgaGVyZS4iKX08L2Rpdj5gOwog",
  "ICAgcmV0dXJuOwogIH0KICB0cnl7CiAgICBjb25zdCBzdG9ja3MgPSBhd2FpdCBQcm9taXNlLmFsbChzdGF0ZS53YXRjaGxpc3QubWFwKHQ9PkFQSS5mZXRjaFN0b2NrKHQpKSk7CiAgICBjb25zdCBncmlkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIndhdGNo",
  "R3JpZCIpOwogICAgZ3JpZC5pbm5lckhUTUwgPSBzdG9ja3MuZmlsdGVyKEJvb2xlYW4pLm1hcCgocyxpKT0+d2F0Y2hDYXJkSFRNTChzLGkpKS5qb2luKCIiKTsKICAgIHdpcmVXYXRjaENhcmRzKCk7CiAgfWNhdGNoKGUpewogICAgZG9jdW1lbnQuZ2V0RWxlbWVu",
  "dEJ5SWQoIndhdGNoR3JpZCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJVbmFibGUgdG8gbG9hZCB3YXRjaGxpc3QiLCAiUGxlYXNlIHRyeSBhZ2Fpbi4iKTsKICB9Cn0KCmZ1bmN0aW9uIHdhdGNoQ2FyZEhUTUwocyxpKXsKICBjb25zdCBwb3MgPSBzLnBj",
  "dD49MDsKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9ImdsYXNzIHdhdGNoLWNhcmQgZW50ZXJpbmciIGRhdGEtdGlja2VyPSIke3MudH0iIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjQwfW1zIj4KICAgIDxkaXYgY2xhc3M9IndhdGNoLXRvcCI+CiAgICAgIDxk",
  "aXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5leGNofTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRv",
  "biBjbGFzcz0ic3Rhci1idG4gYWN0aXZlIiBkYXRhLXVuc3Rhcj0iJHtzLnR9IiB0aXRsZT0iUmVtb3ZlIj4KICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRo",
  "PSIyIj48cGF0aCBkPSJNMTIgMTcuM2wtNi4xNiAzLjYgMS42NC02LjlMMiA5LjRsNy4wNi0uNkwxMiAyLjRsMi45NCA2LjQgNy4wNi42LTUuNDggNC42IDEuNjQgNi45eiIvPjwvc3ZnPgogICAgICA8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0i",
  "aW5kZXgtdmFsdWUgdGFidWxhciIgc3R5bGU9ImZvbnQtc2l6ZToyMnB4OyI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1jaGFuZ2UgJHtwb3M/J3Bvcyc6J25lZyd9IHRhYnVsYXIiPiR7Y2hnU3RyKHMuY2hhbmdlKX0gKCR7",
  "cGN0U3RyKHMucGN0KX0pPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1zcGFyayI+JHtzcGFya2xpbmVTVkcocy5zZXJpZXMsIHBvcyl9PC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gd2lyZVdhdGNoQ2FyZHMoKXsKICBkb2N1bWVudC5xdWVyeVNlbGVj",
  "dG9yQWxsKCIud2F0Y2gtY2FyZCIpLmZvckVhY2goY2FyZD0+ewogICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIChlKT0+ewogICAgICBpZihlLnRhcmdldC5jbG9zZXN0KCJbZGF0YS11bnN0YXJdIikpIHJldHVybjsKICAgICAgbmF2aWdhdGUoImRl",
  "dGFpbCIsIGNhcmQuZGF0YXNldC50aWNrZXIpOwogICAgfSk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtdW5zdGFyXSIpLmZvckVhY2goYnRuPT57CiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgICAg",
  "ZS5zdG9wUHJvcGFnYXRpb24oKTsKICAgICAgY29uc3QgY2FyZCA9IGJ0bi5jbG9zZXN0KCIud2F0Y2gtY2FyZCIpOwogICAgICBjYXJkLmNsYXNzTGlzdC5hZGQoInJlbW92aW5nIik7CiAgICAgIHRvZ2dsZVdhdGNoKGJ0bi5kYXRhc2V0LnVuc3Rhcik7CiAgICAg",
  "IHNldFRpbWVvdXQoKCk9PnsKICAgICAgICBpZighc3RhdGUud2F0Y2hsaXN0Lmxlbmd0aCkgcmVuZGVyV2F0Y2hsaXN0KCk7CiAgICAgICAgZWxzZSBjYXJkLnJlbW92ZSgpOwogICAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoIi5zZWN0aW9uLWhlYWQgLnN1",
  "YiIpLnRleHRDb250ZW50ID0gYCR7c3RhdGUud2F0Y2hsaXN0Lmxlbmd0aH0gc3RvY2ske3N0YXRlLndhdGNobGlzdC5sZW5ndGg9PT0xPycnOidzJ30gdHJhY2tlZGA7CiAgICAgIH0sIDI4MCk7CiAgICB9KTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBT",
  "VE9DSyBERVRBSUwgLS0tLS0tLS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJEZXRhaWwoKXsKICByb290LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ2aWV3IiBpZD0iZGV0YWlsU2tlbGV0b24iPgogICAgPGRpdiBjbGFzcz0iZ2xhc3Mgc2tlbC1j",
  "YXJkIHNrZWwiIHN0eWxlPSJoZWlnaHQ6ODhweDttYXJnaW4tYm90dG9tOjI0cHg7Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9Im1ldHJpY3MtZ3JpZCI+JHtza2VsZXRvbkNhcmRzKDYpfTwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ2xhc3Mgc2tlbC1jYXJkIHNrZWwi",
  "IHN0eWxlPSJoZWlnaHQ6MzIwcHg7Ij48L2Rpdj4KICA8L2Rpdj5gOwoKICBsZXQgczsKICB0cnl7IHMgPSBhd2FpdCBBUEkuZmV0Y2hTdG9jayhzdGF0ZS5kZXRhaWxUaWNrZXIpOyB9Y2F0Y2goZSl7IHMgPSBudWxsOyB9CiAgaWYoIXMpewogICAgcm9vdC5pbm5l",
  "ckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIHJldHJpZXZlIHRoaXMgc3RvY2siLCAiVGhlIHRpY2tlciB5b3UncmUgbG9va2luZyBmb3IgaXNuJ3QgYXZhaWxhYmxlIHJpZ2h0IG5vdy4iKTsKICAgIHJldHVybjsKICB9CiAgY29uc3QgcG9zID0gcy5w",
  "Y3QgPj0gMDsKICBjb25zdCBpbldhdGNoID0gc3RhdGUud2F0Y2hsaXN0LmluY2x1ZGVzKHMudCk7CgogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1oZWFkIj4KICAgICAgICA8ZGl2IGNs",
  "YXNzPSJkZXRhaWwtdGl0bGUtcm93Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC10aWNrZXItYmFkZ2UiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgICAgICA8ZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtbmFtZSI+JHtlc2Nh",
  "cGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH0gwrcgJHtzLnNlY3Rvcn08L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgc3R5bGU9",
  "ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjE0cHg7Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1wcmljZS1ibG9jayI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1wcmljZSB0YWJ1bGFyIj4ke2ZtdElOUihzLnByaWNl",
  "KX08L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLWNoYW5nZSAke3Bvcz8ncG9zJzonbmVnJ30gdGFidWxhciI+JHtjaGdTdHIocy5jaGFuZ2UpfSAoJHtwY3RTdHIocy5wY3QpfSkgdG9kYXk8L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAg",
  "ICAgPGJ1dHRvbiBjbGFzcz0iaWNvbi1idG4iIGlkPSJkZXRhaWxTdGFyIiBzdHlsZT0id2lkdGg6NDRweDtoZWlnaHQ6NDRweDtjb2xvcjoke2luV2F0Y2g/JyNGRkM4NTcnOid2YXIoLS10ZXh0LW1pZCknfSI+CiAgICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAw",
  "IDI0IDI0IiBmaWxsPSIke2luV2F0Y2g/J2N1cnJlbnRDb2xvcic6J25vbmUnfSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3R5bGU9IndpZHRoOjE5cHg7aGVpZ2h0OjE5cHg7Ij48cGF0aCBkPSJNMTIgMTcuM2wtNi4xNiAzLjYgMS42",
  "NC02LjlMMiA5LjRsNy4wNi0uNkwxMiAyLjRsMi45NCA2LjQgNy4wNi42LTUuNDggNC42IDEuNjQgNi45eiIvPjwvc3ZnPgogICAgICAgICAgPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ibWV0cmljcy1ncmlk",
  "Ij4KICAgICAgICAke21ldHJpY0NhcmQoIk9wZW4iLCBmbXRJTlIocy5vcGVuKSl9CiAgICAgICAgJHttZXRyaWNDYXJkKCJEYXkgSGlnaCIsIGZtdElOUihzLmRheUhpZ2gpKX0KICAgICAgICAke21ldHJpY0NhcmQoIkRheSBMb3ciLCBmbXRJTlIocy5kYXlMb3cp",
  "KX0KICAgICAgICAke21ldHJpY0NhcmQoIk1hcmtldCBDYXAiLCBmbXRDb21wYWN0KHMubWFya2V0Q2FwKSl9CiAgICAgICAgJHttZXRyaWNDYXJkKCJWb2x1bWUiLCBmbXRWb2wocy52b2x1bWUpKX0KICAgICAgICAke21ldHJpY0NhcmQoIjUyVyBIaWdoIC8gTG93",
  "IiwgZm10SU5SKHMuaGlnaDUyLDApKyIgLyAiK2ZtdElOUihzLmxvdzUyLDApKX0KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJnbGFzcyBjaGFydC1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC1oZWFkIj4KICAgICAgICAgIDxkaXYgY2xh",
  "c3M9InNlY3Rpb24taGVhZCIgc3R5bGU9Im1hcmdpbjowOyI+PGgyPlByaWNlIENoYXJ0PC9oMj48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InJhbmdlLXRhYnMiIGlkPSJyYW5nZVRhYnMiPgogICAgICAgICAgICAke1siMUQiLCIxVyIsIjFNIiwiM00iLCI2",
  "TSIsIjFZIl0ubWFwKHI9PmA8YnV0dG9uIGRhdGEtcmFuZ2U9IiR7cn0iIGNsYXNzPSIke3N0YXRlLmRldGFpbFJhbmdlPT09cj8nYWN0aXZlJzonJ30iPiR7cn08L2J1dHRvbj5gKS5qb2luKCIiKX0KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAg",
  "ICAgIDxkaXYgY2xhc3M9ImNoYXJ0LWNhbnZhcy13cmFwIiBpZD0iY2hhcnRXcmFwIj4KICAgICAgICAgIDxjYW52YXMgaWQ9InByaWNlQ2hhcnQiPjwvY2FudmFzPgogICAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtdG9vbHRpcCIgaWQ9ImNoYXJ0VG9vbHRpcCI+",
  "PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idm9sdW1lLXdyYXAiIGlkPSJ2b2x1bWVXcmFwIj4KICAgICAgICAgIDxkaXYgY2xhc3M9InZvbHVtZS1sYWJlbCI+Vm9sdW1lIDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZXh0LWZhaW50",
  "KTtmb250LXdlaWdodDo2MDA7Ij4ocmVsYXRpdmUsIGRlcml2ZWQgZnJvbSBwcmljZSBtb3ZlbWVudCk8L3NwYW4+PC9kaXY+CiAgICAgICAgICA8Y2FudmFzIGlkPSJ2b2x1bWVDaGFydCI+PC9jYW52YXM+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAg",
  "PC9kaXY+CiAgYDsKCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImRldGFpbFN0YXIiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICB0b2dnbGVXYXRjaChzLnQpOwogICAgcmVuZGVyRGV0YWlsKCk7CiAgfSk7CiAgZG9jdW1lbnQuZ2V0RWxl",
  "bWVudEJ5SWQoInJhbmdlVGFicyIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICBjb25zdCBidG4gPSBlLnRhcmdldC5jbG9zZXN0KCJidXR0b25bZGF0YS1yYW5nZV0iKTsKICAgIGlmKCFidG4pIHJldHVybjsKICAgIHN0YXRlLmRldGFpbFJh",
  "bmdlID0gYnRuLmRhdGFzZXQucmFuZ2U7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIjcmFuZ2VUYWJzIGJ1dHRvbiIpLmZvckVhY2goYj0+Yi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiLCBiPT09YnRuKSk7CiAgICBsb2FkQ2hhcnQocy50LCBzLnBj",
  "dD49MCk7CiAgfSk7CgogIGxvYWRDaGFydChzLnQsIHBvcyk7Cn0KCmZ1bmN0aW9uIG1ldHJpY0NhcmQobGFiZWwsIHZhbHVlKXsKICByZXR1cm4gYDxkaXYgY2xhc3M9ImdsYXNzIG1ldHJpYy1jYXJkIj48ZGl2IGNsYXNzPSJtZXRyaWMtbGFiZWwiPiR7bGFiZWx9",
  "PC9kaXY+PGRpdiBjbGFzcz0ibWV0cmljLXZhbHVlIHRhYnVsYXIiPiR7dmFsdWV9PC9kaXY+PC9kaXY+YDsKfQoKYXN5bmMgZnVuY3Rpb24gbG9hZENoYXJ0KHRpY2tlciwgcG9zaXRpdmUpewogIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgi",
  "Y2hhcnRXcmFwIik7CiAgY29uc3QgY2FudmFzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInByaWNlQ2hhcnQiKTsKICBpZighd3JhcCB8fCAhY2FudmFzKSByZXR1cm47CiAgY2FudmFzLnN0eWxlLm9wYWNpdHkgPSAiMC4yNSI7CiAgbGV0IHNlcmllczsKICB0",
  "cnl7CiAgICBzZXJpZXMgPSBhd2FpdCBBUEkuZmV0Y2hTdG9ja0hpc3RvcnkodGlja2VyLCBzdGF0ZS5kZXRhaWxSYW5nZSk7CiAgfWNhdGNoKGUpewogICAgd3JhcC5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiQ2hhcnQgZGF0YSB1bmF2YWlsYWJsZSIsICJU",
  "aGlzIHRpbWVmcmFtZSBjb3VsZG4ndCBiZSBsb2FkZWQuIFRyeSBhIGRpZmZlcmVudCByYW5nZS4iKTsKICAgIHJldHVybjsKICB9CiAgY2FudmFzLnN0eWxlLm9wYWNpdHkgPSAiMSI7CiAgZHJhd0NoYXJ0KGNhbnZhcywgc2VyaWVzLCBwb3NpdGl2ZSwgdGlja2Vy",
  "KTsKICBkcmF3Vm9sdW1lQ2hhcnQoc2VyaWVzLCBwb3NpdGl2ZSk7Cn0KCmZ1bmN0aW9uIGRyYXdWb2x1bWVDaGFydChzZXJpZXMsIHBvc2l0aXZlKXsKICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidm9sdW1lQ2hhcnQiKTsKICBpZigh",
  "Y2FudmFzKSByZXR1cm47CiAgY29uc3QgcmVjdCA9IGNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICBjb25zdCBkcHIgPSB3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpbyB8fCAxOwogIGNhbnZhcy53aWR0aCA9IHJlY3Qud2lkdGggKiBkcHI7CiAgY2FudmFz",
  "LmhlaWdodCA9IHJlY3QuaGVpZ2h0ICogZHByOwogIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KCIyZCIpOwogIGN0eC5zY2FsZShkcHIsZHByKTsKICBjb25zdCBXID0gcmVjdC53aWR0aCwgSCA9IHJlY3QuaGVpZ2h0OwogIGN0eC5jbGVhclJlY3QoMCww",
  "LFcsSCk7CgogIC8vIERlcml2ZSBhIHBsYXVzaWJsZSByZWxhdGl2ZSB2b2x1bWUgcHJvZmlsZSBmcm9tIHRoZSBwcmljZSBzZXJpZXMnCiAgLy8gcG9pbnQtdG8tcG9pbnQgdm9sYXRpbGl0eSAoYmlnZ2VyIG1vdmVzIHRlbmQgdG8gY29pbmNpZGUgd2l0aCBoaWdo",
  "ZXIKICAvLyB2b2x1bWUpIOKAlCBpbGx1c3RyYXRpdmUgb25seTsgdGhlIGJhY2tlbmQgaGFzIG5vIGhpc3RvcmljYWwgdm9sdW1lIGZlZWQuCiAgY29uc3QgZGVsdGFzID0gc2VyaWVzLm1hcCgodixpKT0+IGk9PT0wID8gMCA6IE1hdGguYWJzKHYtc2VyaWVzW2kt",
  "MV0pKTsKICBjb25zdCBtYXhEID0gTWF0aC5tYXgoLi4uZGVsdGFzLCAxZS02KTsKICBjb25zdCBiYXJXID0gVy9zZXJpZXMubGVuZ3RoOwogIGNvbnN0IGNvbG9yID0gcG9zaXRpdmUgPyAiIzMzRDZBNiIgOiAiI0ZCNkI2QiI7CiAgc2VyaWVzLmZvckVhY2goKHYs",
  "aSk9PnsKICAgIGNvbnN0IHNlZWQgPSB0aWNrZXJTZWVkKHN0YXRlLmRldGFpbFRpY2tlcikraSo3OwogICAgY29uc3QgaCA9IE1hdGgubWF4KDMsIChkZWx0YXNbaV0vbWF4RCkgKiBIICogMC44NSAqICgwLjU1ICsgc2VlZGVkUmFuZChzZWVkKSowLjYpKTsKICAg",
  "IGNvbnN0IHVwID0gaT09PTAgPyB0cnVlIDogc2VyaWVzW2ldID49IHNlcmllc1tpLTFdOwogICAgY3R4LmZpbGxTdHlsZSA9IHVwID8gInJnYmEoNTEsMjE0LDE2NiwwLjU1KSIgOiAicmdiYSgyNTEsMTA3LDEwNywwLjU1KSI7CiAgICBjdHguZmlsbFJlY3QoaSpi",
  "YXJXK2JhclcqMC4xNSwgSC1oLCBNYXRoLm1heCgxLGJhclcqMC43KSwgaCk7CiAgfSk7Cn0KCmZ1bmN0aW9uIGRyYXdDaGFydChjYW52YXMsIHNlcmllcywgcG9zaXRpdmUsIHRpY2tlcil7CiAgY29uc3Qgd3JhcCA9IGNhbnZhcy5wYXJlbnRFbGVtZW50OwogIGNv",
  "bnN0IGRwciA9IHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvIHx8IDE7CiAgY29uc3QgcmVjdCA9IHdyYXAuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgY2FudmFzLndpZHRoID0gcmVjdC53aWR0aCAqIGRwcjsKICBjYW52YXMuaGVpZ2h0ID0gcmVjdC5oZWlnaHQg",
  "KiBkcHI7CiAgY2FudmFzLnN0eWxlLndpZHRoID0gcmVjdC53aWR0aCsicHgiOwogIGNhbnZhcy5zdHlsZS5oZWlnaHQgPSByZWN0LmhlaWdodCsicHgiOwogIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KCIyZCIpOwogIGN0eC5zY2FsZShkcHIsZHByKTsK",
  "CiAgY29uc3QgVyA9IHJlY3Qud2lkdGgsIEggPSByZWN0LmhlaWdodDsKICBjb25zdCBwYWQgPSB7dG9wOjE2LCByaWdodDo4LCBib3R0b206MjQsIGxlZnQ6OH07CiAgY29uc3QgbWluID0gTWF0aC5taW4oLi4uc2VyaWVzKSwgbWF4ID0gTWF0aC5tYXgoLi4uc2Vy",
  "aWVzKTsKICBjb25zdCByYW5nZVYgPSAobWF4LW1pbikgfHwgMTsKICBjb25zdCBpbm5lclcgPSBXIC0gcGFkLmxlZnQgLSBwYWQucmlnaHQ7CiAgY29uc3QgaW5uZXJIID0gSCAtIHBhZC50b3AgLSBwYWQuYm90dG9tOwogIGNvbnN0IHN0ZXAgPSBpbm5lclcvKHNl",
  "cmllcy5sZW5ndGgtMSk7CgogIGZ1bmN0aW9uIHh5KGksdil7CiAgICByZXR1cm4gW3BhZC5sZWZ0ICsgaSpzdGVwLCBwYWQudG9wICsgaW5uZXJIIC0gKCh2LW1pbikvcmFuZ2VWKSppbm5lckhdOwogIH0KICBjb25zdCBwdHMgPSBzZXJpZXMubWFwKCh2LGkpPT54",
  "eShpLHYpKTsKCiAgY3R4LmNsZWFyUmVjdCgwLDAsVyxIKTsKCiAgLy8gZ3JpZGxpbmVzCiAgY3R4LnN0cm9rZVN0eWxlID0gInJnYmEoMTU4LDE3MSwyMTQsMC4wOCkiOwogIGN0eC5saW5lV2lkdGggPSAxOwogIGZvcihsZXQgaT0wO2k8PTM7aSsrKXsKICAgIGNv",
  "bnN0IHkgPSBwYWQudG9wICsgKGlubmVySC8zKSppOwogICAgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRvKHBhZC5sZWZ0LHkpOyBjdHgubGluZVRvKFctcGFkLnJpZ2h0LHkpOyBjdHguc3Ryb2tlKCk7CiAgfQoKICBjb25zdCBjb2xvciA9IHBvc2l0aXZlID8g",
  "IiMzM0Q2QTYiIDogIiNGQjZCNkIiOwoKICAvLyBzbW9vdGggcGF0aAogIGZ1bmN0aW9uIHNtb290aFBhdGgocG9pbnRzKXsKICAgIGlmKHBvaW50cy5sZW5ndGg8MykgcmV0dXJuIGBNJHtwb2ludHNbMF1bMF19LCR7cG9pbnRzWzBdWzFdfSBMJHtwb2ludHNbMV1b",
  "MF19LCR7cG9pbnRzWzFdWzFdfWA7CiAgICBsZXQgZCA9IGBNJHtwb2ludHNbMF1bMF19LCR7cG9pbnRzWzBdWzFdfWA7CiAgICBmb3IobGV0IGk9MDtpPHBvaW50cy5sZW5ndGgtMTtpKyspewogICAgICBjb25zdCBwMCA9IHBvaW50c1tpPT09MD8wOmktMV07CiAg",
  "ICAgIGNvbnN0IHAxID0gcG9pbnRzW2ldOwogICAgICBjb25zdCBwMiA9IHBvaW50c1tpKzFdOwogICAgICBjb25zdCBwMyA9IHBvaW50c1tpKzI8cG9pbnRzLmxlbmd0aD9pKzI6aSsxXTsKICAgICAgY29uc3QgY3AxeCA9IHAxWzBdICsgKHAyWzBdLXAwWzBdKS82",
  "OwogICAgICBjb25zdCBjcDF5ID0gcDFbMV0gKyAocDJbMV0tcDBbMV0pLzY7CiAgICAgIGNvbnN0IGNwMnggPSBwMlswXSAtIChwM1swXS1wMVswXSkvNjsKICAgICAgY29uc3QgY3AyeSA9IHAyWzFdIC0gKHAzWzFdLXAxWzFdKS82OwogICAgICBkICs9IGAgQyR7",
  "Y3AxeH0sJHtjcDF5fSAke2NwMnh9LCR7Y3AyeX0gJHtwMlswXX0sJHtwMlsxXX1gOwogICAgfQogICAgcmV0dXJuIGQ7CiAgfQogIGNvbnN0IGxpbmVQYXRoID0gbmV3IFBhdGgyRChzbW9vdGhQYXRoKHB0cykpOwoKICAvLyBhcmVhIGZpbGwKICBjb25zdCBncmFk",
  "ID0gY3R4LmNyZWF0ZUxpbmVhckdyYWRpZW50KDAscGFkLnRvcCwwLHBhZC50b3AraW5uZXJIKTsKICBncmFkLmFkZENvbG9yU3RvcCgwLCBjb2xvcisiNTUiKTsKICBncmFkLmFkZENvbG9yU3RvcCgxLCBjb2xvcisiMDIiKTsKICBjdHguc2F2ZSgpOwogIGNvbnN0",
  "IGFyZWFQYXRoID0gbmV3IFBhdGgyRChzbW9vdGhQYXRoKHB0cykpOwogIGFyZWFQYXRoLmxpbmVUbyhwdHNbcHRzLmxlbmd0aC0xXVswXSwgcGFkLnRvcCtpbm5lckgpOwogIGFyZWFQYXRoLmxpbmVUbyhwdHNbMF1bMF0sIHBhZC50b3AraW5uZXJIKTsKICBhcmVh",
  "UGF0aC5jbG9zZVBhdGgoKTsKICBjdHguZmlsbFN0eWxlID0gZ3JhZDsKICBjdHguZmlsbChhcmVhUGF0aCk7CiAgY3R4LnJlc3RvcmUoKTsKCiAgLy8gbGluZQogIGN0eC5zdHJva2VTdHlsZSA9IGNvbG9yOwogIGN0eC5saW5lV2lkdGggPSAyOwogIGN0eC5saW5l",
  "Sm9pbiA9ICJyb3VuZCI7CiAgY3R4LmxpbmVDYXAgPSAicm91bmQiOwogIGN0eC5zdHJva2UobGluZVBhdGgpOwoKICAvLyBlbnRyYW5jZSBhbmltYXRpb24gdmlhIGNsaXAgcmV2ZWFsCiAgY2FudmFzLl9jaGFydE1ldGEgPSB7cHRzLCBzZXJpZXMsIFcsIEgsIHBh",
  "ZCwgY29sb3J9OwoKICAvLyBjcm9zc2hhaXIgaW50ZXJhY3Rpdml0eQogIGNvbnN0IHRvb2x0aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiY2hhcnRUb29sdGlwIik7CiAgY2FudmFzLm9ubW91c2Vtb3ZlID0gKGUpPT57CiAgICBjb25zdCByID0gY2FudmFz",
  "LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgY29uc3QgbXggPSBlLmNsaWVudFggLSByLmxlZnQ7CiAgICBsZXQgaWR4ID0gTWF0aC5yb3VuZCgobXgtcGFkLmxlZnQpL3N0ZXApOwogICAgaWR4ID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oc2VyaWVzLmxlbmd0",
  "aC0xLCBpZHgpKTsKICAgIGNvbnN0IFtweCxweV0gPSBwdHNbaWR4XTsKCiAgICByZWRyYXdXaXRoQ3Jvc3NoYWlyKGN0eCwgY2FudmFzLl9jaGFydE1ldGEsIHB4LCBweSk7CgogICAgdG9vbHRpcC5zdHlsZS5vcGFjaXR5ID0gIjEiOwogICAgdG9vbHRpcC5zdHls",
  "ZS5sZWZ0ID0gcHgrInB4IjsKICAgIHRvb2x0aXAuc3R5bGUudG9wID0gcHkrInB4IjsKICAgIHRvb2x0aXAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InR0LXByaWNlIj4ke2ZtdElOUihzZXJpZXNbaWR4XSl9PC9kaXY+PGRpdiBjbGFzcz0idHQtZGF0ZSI+UG9p",
  "bnQgJHtpZHgrMX0gb2YgJHtzZXJpZXMubGVuZ3RofTwvZGl2PmA7CiAgfTsKICBjYW52YXMub25tb3VzZWxlYXZlID0gKCk9PnsKICAgIHRvb2x0aXAuc3R5bGUub3BhY2l0eSA9ICIwIjsKICAgIGN0eC5jbGVhclJlY3QoMCwwLFcsSCk7CiAgICByZWRyYXcoY3R4",
  "LCBjYW52YXMuX2NoYXJ0TWV0YSk7CiAgfTsKCiAgZnVuY3Rpb24gcmVkcmF3KGN0eCwgbWV0YSl7CiAgICBjb25zdCB7cHRzLCBXLCBILCBwYWQsIGNvbG9yfSA9IG1ldGE7CiAgICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwogICAgY3R4LnN0cm9rZVN0eWxlID0g",
  "InJnYmEoMTU4LDE3MSwyMTQsMC4wOCkiOwogICAgY3R4LmxpbmVXaWR0aCA9IDE7CiAgICBjb25zdCBpbm5lckgyID0gSC1wYWQudG9wLXBhZC5ib3R0b207CiAgICBmb3IobGV0IGk9MDtpPD0zO2krKyl7CiAgICAgIGNvbnN0IHkgPSBwYWQudG9wICsgKGlubmVy",
  "SDIvMykqaTsKICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRvKHBhZC5sZWZ0LHkpOyBjdHgubGluZVRvKFctcGFkLnJpZ2h0LHkpOyBjdHguc3Ryb2tlKCk7CiAgICB9CiAgICBjb25zdCBncmFkMiA9IGN0eC5jcmVhdGVMaW5lYXJHcmFkaWVudCgwLHBh",
  "ZC50b3AsMCxwYWQudG9wK2lubmVySDIpOwogICAgZ3JhZDIuYWRkQ29sb3JTdG9wKDAsIGNvbG9yKyI1NSIpOyBncmFkMi5hZGRDb2xvclN0b3AoMSwgY29sb3IrIjAyIik7CiAgICBjb25zdCBhcmVhUGF0aDIgPSBuZXcgUGF0aDJEKHNtb290aFBhdGgocHRzKSk7",
  "CiAgICBhcmVhUGF0aDIubGluZVRvKHB0c1twdHMubGVuZ3RoLTFdWzBdLCBwYWQudG9wK2lubmVySDIpOwogICAgYXJlYVBhdGgyLmxpbmVUbyhwdHNbMF1bMF0sIHBhZC50b3AraW5uZXJIMik7CiAgICBhcmVhUGF0aDIuY2xvc2VQYXRoKCk7CiAgICBjdHguZmls",
  "bFN0eWxlID0gZ3JhZDI7IGN0eC5maWxsKGFyZWFQYXRoMik7CiAgICBjdHguc3Ryb2tlU3R5bGUgPSBjb2xvcjsgY3R4LmxpbmVXaWR0aCA9IDI7IGN0eC5saW5lSm9pbj0icm91bmQiOyBjdHgubGluZUNhcD0icm91bmQiOwogICAgY3R4LnN0cm9rZShuZXcgUGF0",
  "aDJEKHNtb290aFBhdGgocHRzKSkpOwogIH0KICBmdW5jdGlvbiByZWRyYXdXaXRoQ3Jvc3NoYWlyKGN0eCwgbWV0YSwgcHgsIHB5KXsKICAgIHJlZHJhdyhjdHgsIG1ldGEpOwogICAgY29uc3Qge0gsIHBhZCwgY29sb3J9ID0gbWV0YTsKICAgIGN0eC5zYXZlKCk7",
  "CiAgICBjdHguc3Ryb2tlU3R5bGUgPSAicmdiYSgxNTgsMTcxLDIxNCwwLjM1KSI7CiAgICBjdHgubGluZVdpZHRoID0gMTsKICAgIGN0eC5zZXRMaW5lRGFzaChbMywzXSk7CiAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8ocHgsIHBhZC50b3ApOyBjdHgu",
  "bGluZVRvKHB4LCBILXBhZC5ib3R0b20pOyBjdHguc3Ryb2tlKCk7CiAgICBjdHguc2V0TGluZURhc2goW10pOwogICAgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKHB4LHB5LDQsMCxNYXRoLlBJKjIpOwogICAgY3R4LmZpbGxTdHlsZSA9IGNvbG9yOyBjdHguZmls",
  "bCgpOwogICAgY3R4LnN0cm9rZVN0eWxlID0gIiMwNTA2MEIiOyBjdHgubGluZVdpZHRoPTI7IGN0eC5zdHJva2UoKTsKICAgIGN0eC5yZXN0b3JlKCk7CiAgfQp9Cgp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigicmVzaXplIiwgZGVib3VuY2UoKCk9PnsKICBjb25z",
  "dCBjYW52YXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgicHJpY2VDaGFydCIpOwogIGlmKGNhbnZhcyAmJiBzdGF0ZS52aWV3PT09ImRldGFpbCIpIGxvYWRDaGFydChzdGF0ZS5kZXRhaWxUaWNrZXIsIHRydWUpOwp9LCAyMDApKTsKCi8qIC0tLS0tLS0tLS0t",
  "LS0tLS0gU1RBVEUgSEVMUEVSUyAtLS0tLS0tLS0tLS0tLS0tICovCmZ1bmN0aW9uIGVtcHR5U3RhdGVJbm5lcih0aXRsZSwgc3ViKXsKICByZXR1cm4gYAogICAgPGRpdiBjbGFzcz0ic3RhdGUtaWNvbiI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIy",
  "MiIgaGVpZ2h0PSIyMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iNyIvPjxwYXRoIGQ9Ik0yMSAyMWwtNC4zLTQuMyIvPjwvc3ZnPjwvZGl2PgogICAgPGRpdiBjbGFz",
  "cz0ic3RhdGUtdGl0bGUiPiR7dGl0bGV9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS1zdWIiPiR7c3VifTwvZGl2PgogIGA7Cn0KZnVuY3Rpb24gZW1wdHlTdGF0ZUhUTUwodGl0bGUsIHN1Yil7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJzdGF0ZS1ib3giPiR7",
  "ZW1wdHlTdGF0ZUlubmVyKHRpdGxlLCBzdWIpfTwvZGl2PmA7Cn0KZnVuY3Rpb24gZXJyb3JTdGF0ZUhUTUwodGl0bGUsIHN1Yil7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJzdGF0ZS1ib3giPgogICAgPGRpdiBjbGFzcz0ic3RhdGUtaWNvbiI+PHN2ZyB2aWV3Qm94",
  "PSIwIDAgMjQgMjQiIHdpZHRoPSIyMiIgaGVpZ2h0PSIyMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTEyIDl2NE0xMiAxN2guMDFNMTAuMjkgMy44NkwxLjgyIDE4YTIgMiAwIDAwMS43MSAzaDE2",
  "Ljk0YTIgMiAwIDAwMS43MS0zTDEzLjcxIDMuODZhMiAyIDAgMDAtMy40MiAweiIvPjwvc3ZnPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdGUtdGl0bGUiPiR7dGl0bGV9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS1zdWIiPiR7c3VifTwvZGl2PgogIDwv",
  "ZGl2PmA7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgQk9PVAogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09ICovCnNldEFjdGl2ZU5hdigiZGFzaGJvYXJkIik7CmNoZWNrTGl2ZUJhY2tlbmQoKS5maW5hbGx5KHJlbmRlcik7CnNldEludGVydmFsKGNoZWNrTGl2ZUJhY2tlbmQsIDQ1MDAwKTsKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo="
];

const FRONTEND_HTML = Buffer.from(
  FRONTEND_B64_CHUNKS.join(""),
  "base64"
).toString("utf8");

app.get("/", (req, res) => {
  res.type("html").send(FRONTEND_HTML);
});
// SPA-style fallback so a hard refresh on any non-API path still works.
app.get(/^(?!\/api).*/, (req, res) => {
  res.type("html").send(FRONTEND_HTML);
});

app.use("/api", (req, res, next) => next(Errors.notFound(`No route for ${req.method} ${req.originalUrl}`)));
app.use(errorMiddleware);


app.get("/debug-nse", async (req, res) => {
  try {
    const result = await nse.getEquityDetails("TCS");
    res.json({ ok: true, status: 200, result });
  } catch (err) {
    console.error("NSE ERROR:", {
      message: err.message,
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      code: err.code,
      stack: err.stack,
    });
    res.status(500).json({
      ok: false,
      message: err.message,
      status: err.response?.status ?? null,
      statusText: err.response?.statusText ?? null,
      response: err.response?.data ?? null,
      code: err.code ?? null,
    });
  }
});

app.listen(config.port, () => {
  console.log(`[EquityScan] running at http://localhost:${config.port}`);
  console.log(`[EquityScan] daily call budget: ${config.dailyCallBudget}, cache TTL: ${config.quoteCacheTtl}ms`);
  startBackgroundRefresh();
});
