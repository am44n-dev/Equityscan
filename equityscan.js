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
  res.json({ provider: "stock-nse-india", status: "available", cacheEnabled: true, dailyBudget: budget.status() });
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
  "IDYuOXoiLz48L3N2Zz5XYXRjaGxpc3Q8L2J1dHRvbj4KPC9uYXY+Cgo8c2NyaXB0PgoidXNlIHN0cmljdCI7CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFZJU0lCTEUgRVJST1Ig",
  "RElBR05PU1RJQ1Mg4oCUIHNob3dzIHVuY2F1Z2h0IGVycm9ycyBvbi1zY3JlZW4gc28gdGhleQogICBjYW4gYmUgcmVhZC9yZXBvcnRlZCB3aXRob3V0IG9wZW5pbmcgYnJvd3NlciBkZXYgdG9vbHMuIFNhZmUgdG8KICAgbGVhdmUgaW47IGl0IG9ubHkgYXBwZWFy",
  "cyB3aGVuIHNvbWV0aGluZyBhY3R1YWxseSB0aHJvd3MuCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KZnVuY3Rpb24gc2hvd0Vycm9yQmFubmVyKG1zZyl7CiAgbGV0IGJhbm5lciA9",
  "IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJlcnJCYW5uZXIiKTsKICBpZighYmFubmVyKXsKICAgIGJhbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImRpdiIpOwogICAgYmFubmVyLmlkID0gImVyckJhbm5lciI7CiAgICBiYW5uZXIuc3R5bGUuY3NzVGV4",
  "dCA9ICJwb3NpdGlvbjpmaXhlZDtsZWZ0OjEycHg7cmlnaHQ6MTJweDtib3R0b206MTJweDt6LWluZGV4Ojk5OTtiYWNrZ3JvdW5kOiMyYTBlMTQ7Ym9yZGVyOjFweCBzb2xpZCAjRkI2QjZCO2NvbG9yOiNGRkQ5RDk7cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyLXJh",
  "ZGl1czoxMHB4O2ZvbnQtc2l6ZToxMnB4O2ZvbnQtZmFtaWx5Om1vbm9zcGFjZTttYXgtaGVpZ2h0OjM1dmg7b3ZlcmZsb3c6YXV0bztib3gtc2hhZG93OjAgMjBweCA1MHB4IHJnYmEoMCwwLDAsMC41KTsiOwogICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChi",
  "YW5uZXIpOwogIH0KICBjb25zdCBsaW5lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgiZGl2Iik7CiAgbGluZS5zdHlsZS5tYXJnaW5Cb3R0b20gPSAiNnB4IjsKICBsaW5lLnRleHRDb250ZW50ID0gbmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKSArICIg",
  "4oCUICIgKyBtc2c7CiAgYmFubmVyLmFwcGVuZENoaWxkKGxpbmUpOwp9CndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJlcnJvciIsIChlKT0+IHNob3dFcnJvckJhbm5lcigiSlMgZXJyb3I6ICIgKyAoZS5tZXNzYWdlfHxlKSkpOwp3aW5kb3cuYWRkRXZlbnRMaXN0",
  "ZW5lcigidW5oYW5kbGVkcmVqZWN0aW9uIiwgKGUpPT4gc2hvd0Vycm9yQmFubmVyKCJVbmhhbmRsZWQgcHJvbWlzZSByZWplY3Rpb246ICIgKyAoZS5yZWFzb24gJiYgZS5yZWFzb24ubWVzc2FnZSB8fCBlLnJlYXNvbikpKTsKCi8qID09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgSU5URUdSQVRJT04gTEFZRVIKICAgVGhpcyBmcm9udGVuZCBub3cgdGFsa3MgdG8gYSByZWFsIEVxdWl0eVNjYW4gYmFja2VuZCAoc2VlIC9iYWNrZW5kKQogICB3aGljaCBw",
  "cm94aWVzIE5TRSB2aWEgc3RvY2stbnNlLWluZGlhLCBjYWNoZWQgYW5kIGJ1ZGdldC1saW1pdGVkIHRvCiAgIH41MCB1cHN0cmVhbSBjYWxscy9kYXkuIEV2ZXJ5IEFQSS4qIG1ldGhvZCBiZWxvdyB0cmllcyB0aGUgbGl2ZQogICBiYWNrZW5kIGZpcnN0IGFuZCBm",
  "YWxscyBiYWNrIHRvIGRldGVybWluaXN0aWMgbW9jayBkYXRhIGlmIHRoZQogICBiYWNrZW5kIGlzIHVucmVhY2hhYmxlIOKAlCB3aGljaCBpcyBleHBlY3RlZCB3aGVuIHRoaXMgcGFnZSBpcyBvcGVuZWQKICAgYXMgYSBob3N0ZWQgcHJldmlldywgc2luY2UgYSBw",
  "dWJsaXNoZWQgcGFnZSBjYW5ub3QgcmVhY2ggYQogICBsb2NhbGhvc3Qgc2VydmVyLiBSdW4gdGhlIGJhY2tlbmQgYW5kIG9wZW4gdGhpcyBmaWxlIGxvY2FsbHkgKG5vdAogICB0aGUgcHVibGlzaGVkIHByZXZpZXcpIHRvIHNlZSByZWFsIE5TRSBxdW90ZXMgZW5k",
  "IHRvIGVuZC4KICAgVGhlIGJhY2tlbmQgaGFzIG5vIGhpc3RvcmljYWwtcHJpY2UgZW5kcG9pbnQgeWV0LCBzbyBjaGFydCBzZXJpZXMKICAgYW5kIHNwYXJrbGluZXMgc3RheSBzeW50aGV0aWMgZXZlbiBpbiBsaXZlIG1vZGUg4oCUIGV2ZXJ5dGhpbmcgZWxzZQog",
  "ICAocHJpY2UsIGNoYW5nZSAlLCA1MlcgaGlnaC9sb3csIGNvbXBhbnkgbmFtZSwgbWFya2V0IHN0YXR1cykgaXMKICAgcmVhbCB3aGVuIHRoZSBiYWNrZW5kIGlzIHJlYWNoYWJsZS4KICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCBDT05GSUcgPSB7CiAgQVBJX0JBU0U6ICh3aW5kb3cubG9jYXRpb24ucHJvdG9jb2wgPT09ICJmaWxlOiIgPyAiaHR0cDovL2xvY2FsaG9zdDozMDAwIiA6IHdpbmRvdy5sb2NhdGlvbi5vcmlnaW4pICsgIi9h",
  "cGkiLAogIExJVkVfVElNRU9VVF9NUzogODAwMCwKfTsKbGV0IGxpdmVCYWNrZW5kQXZhaWxhYmxlID0gZmFsc2U7CmNvbnN0IE1PQ0tfTEFURU5DWSA9IDQyMDsKCmZ1bmN0aW9uIGZldGNoV2l0aFRpbWVvdXQodXJsLCBtcyl7CiAgY29uc3QgY3RybCA9IG5ldyBB",
  "Ym9ydENvbnRyb2xsZXIoKTsKICBjb25zdCBpZCA9IHNldFRpbWVvdXQoKCk9PmN0cmwuYWJvcnQoKSwgbXMpOwogIHJldHVybiBmZXRjaCh1cmwsIHtzaWduYWw6IGN0cmwuc2lnbmFsfSkuZmluYWxseSgoKT0+Y2xlYXJUaW1lb3V0KGlkKSk7Cn0KCmFzeW5jIGZ1",
  "bmN0aW9uIGNoZWNrTGl2ZUJhY2tlbmQoKXsKICB0cnl7CiAgICBjb25zdCByID0gYXdhaXQgZmV0Y2hXaXRoVGltZW91dChDT05GSUcuQVBJX0JBU0UgKyAiL2hlYWx0aCIsIENPTkZJRy5MSVZFX1RJTUVPVVRfTVMpOwogICAgbGl2ZUJhY2tlbmRBdmFpbGFibGUg",
  "PSAhIShyICYmIHIub2spOwogIH1jYXRjaChlKXsKICAgIGxpdmVCYWNrZW5kQXZhaWxhYmxlID0gZmFsc2U7CiAgfQogIHVwZGF0ZUJhY2tlbmRCYWRnZSgpOwogIHJldHVybiBsaXZlQmFja2VuZEF2YWlsYWJsZTsKfQoKZnVuY3Rpb24gdXBkYXRlQmFja2VuZEJh",
  "ZGdlKCl7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYmFja2VuZEJhZGdlIik7CiAgaWYoIWVsKSByZXR1cm47CiAgZWwuY2xhc3NMaXN0LnRvZ2dsZSgibGl2ZSIsIGxpdmVCYWNrZW5kQXZhaWxhYmxlKTsKICBlbC5xdWVyeVNlbGVjdG9y",
  "KCIuZG90LWxpdmUiKS5zdHlsZS5iYWNrZ3JvdW5kID0gbGl2ZUJhY2tlbmRBdmFpbGFibGUgPyAidmFyKC0tcG9zKSIgOiAidmFyKC0tdGV4dC1mYWludCkiOwogIGVsLnF1ZXJ5U2VsZWN0b3IoInNwYW46bGFzdC1jaGlsZCIpLnRleHRDb250ZW50ID0gbGl2ZUJh",
  "Y2tlbmRBdmFpbGFibGUgPyAiTGl2ZSBOU0UgRGF0YSIgOiAiRGVtbyBEYXRhIjsKICBlbC50aXRsZSA9IGxpdmVCYWNrZW5kQXZhaWxhYmxlCiAgICA/ICJDb25uZWN0ZWQgdG8gdGhlIEVxdWl0eVNjYW4gYmFja2VuZCDigJQgcHJpY2VzIGFyZSByZWFsIE5TRSBx",
  "dW90ZXMuIgogICAgOiAiQmFja2VuZCBub3QgcmVhY2hhYmxlIGF0ICIgKyBDT05GSUcuQVBJX0JBU0UgKyAiIOKAlCBzaG93aW5nIGRldGVybWluaXN0aWMgZGVtbyBkYXRhLiI7Cn0KCmZ1bmN0aW9uIG1hcEJhY2tlbmRUb0Zyb250ZW5kKGQpewogIGNvbnN0IHNl",
  "ZWQgPSB0aWNrZXJTZWVkKGQuc3ltYm9sKTsKICBjb25zdCBiYXNpcyA9IGQuY3VycmVudFByaWNlIHx8IDEwMDA7CiAgY29uc3Qgc2VyaWVzID0gZ2VuU2VyaWVzKHNlZWQsIDIwLCAwLjAwNSwgYmFzaXMpOwogIGNvbnN0IGtub3duRGVmID0gVU5JVkVSU0UuZmlu",
  "ZCh1PT51LnQ9PT1kLnN5bWJvbCk7CiAgcmV0dXJuIHsKICAgIHQ6IGQuc3ltYm9sLAogICAgbmFtZTogZC5jb21wYW55TmFtZSB8fCAoa25vd25EZWYgJiYga25vd25EZWYubmFtZSkgfHwgZC5zeW1ib2wsCiAgICBleGNoOiBkLmV4Y2hhbmdlIHx8ICJOU0UiLAog",
  "ICAgLy8gVGhlIGxpdmUgYmFja2VuZCdzIGluZHVzdHJ5IGxhYmVsIGRvZXNuJ3QgcmVsaWFibHkgbWF0Y2ggb3VyIGZpbHRlcgogICAgLy8gZHJvcGRvd24ncyB2b2NhYnVsYXJ5IChvciBtYXkgYmUgbWlzc2luZyksIHNvIHByZWZlciBvdXIga25vd24gbWFwcGlu",
  "ZwogICAgLy8gZm9yIGZpbHRlcmluZyBwdXJwb3NlcyBhbmQgb25seSBmYWxsIGJhY2sgdG8gdGhlIGJhY2tlbmQncyByYXcgdmFsdWUuCiAgICBzZWN0b3I6IChrbm93bkRlZiAmJiBrbm93bkRlZi5zZWN0b3IpIHx8IGQuc2VjdG9yIHx8ICLigJQiLAogICAgcHJp",
  "Y2U6IGQuY3VycmVudFByaWNlLAogICAgY2hhbmdlOiBkLmNoYW5nZSwKICAgIHBjdDogZC5wZXJjZW50Q2hhbmdlLAogICAgbWFya2V0Q2FwOiBkLm1hcmtldENhcCwKICAgIHZvbHVtZTogZC52b2x1bWUsCiAgICBoaWdoNTI6IGQud2VlazUySGlnaCwKICAgIGxv",
  "dzUyOiBkLndlZWs1MkxvdywKICAgIG9wZW46IGQub3BlbiwKICAgIGRheUhpZ2g6IGQuZGF5SGlnaCwKICAgIGRheUxvdzogZC5kYXlMb3csCiAgICBzZXJpZXMsCiAgICBsaXZlOiB0cnVlLAogICAgZGF0YVN0YXR1czogZC5kYXRhU3RhdHVzLAogIH07Cn0KCmFz",
  "eW5jIGZ1bmN0aW9uIGxpdmVGZXRjaFN0b2NrKHRpY2tlcil7CiAgY29uc3QgciA9IGF3YWl0IGZldGNoV2l0aFRpbWVvdXQoYCR7Q09ORklHLkFQSV9CQVNFfS9zdG9jay8ke2VuY29kZVVSSUNvbXBvbmVudCh0aWNrZXIpfWAsIENPTkZJRy5MSVZFX1RJTUVPVVRf",
  "TVMpOwogIGlmKCFyLm9rKSB0aHJvdyBuZXcgRXJyb3IoImJhY2tlbmQgc3RhdHVzICIrci5zdGF0dXMpOwogIGNvbnN0IGpzb24gPSBhd2FpdCByLmpzb24oKTsKICBpZighanNvbi5zdWNjZXNzIHx8ICFqc29uLmRhdGEpIHRocm93IG5ldyBFcnJvcigiYmFja2Vu",
  "ZCBwYXlsb2FkIGVycm9yIik7CiAgcmV0dXJuIG1hcEJhY2tlbmRUb0Zyb250ZW5kKGpzb24uZGF0YSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGxpdmVGZXRjaE1hbnkodGlja2Vycyl7CiAgY29uc3Qgc2V0dGxlZCA9IGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZCh0aWNr",
  "ZXJzLm1hcChsaXZlRmV0Y2hTdG9jaykpOwogIHJldHVybiBzZXR0bGVkLmZpbHRlcihzPT5zLnN0YXR1cz09PSJmdWxmaWxsZWQiKS5tYXAocz0+cy52YWx1ZSk7Cn0KCmNvbnN0IFVOSVZFUlNFID0gWwogIHt0OiJUQ1MiLCBuYW1lOiJUYXRhIENvbnN1bHRhbmN5",
  "IFNlcnZpY2VzIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJJVCBTZXJ2aWNlcyIsIGJhc2U6Mzg0Mn0sCiAge3Q6IlJFTElBTkNFIiwgbmFtZToiUmVsaWFuY2UgSW5kdXN0cmllcyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiRW5lcmd5IiwgYmFzZToyOTUxfSwKICB7dDoi",
  "SERGQ0JBTksiLCBuYW1lOiJIREZDIEJhbmsiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkJhbmtpbmciLCBiYXNlOjE2ODd9LAogIHt0OiJJTkZZIiwgbmFtZToiSW5mb3N5cyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSVQgU2VydmljZXMiLCBiYXNlOjE4NDF9LAogIHt0",
  "OiJJQ0lDSUJBTksiLCBuYW1lOiJJQ0lDSSBCYW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZToxMjY0fSwKICB7dDoiQkhBUlRJQVJUTCIsIG5hbWU6IkJoYXJ0aSBBaXJ0ZWwiLCBleGNoOiJOU0UiLCBzZWN0b3I6IlRlbGVjb20iLCBiYXNl",
  "OjE2OTh9LAogIHt0OiJTQklOIiwgbmFtZToiU3RhdGUgQmFuayBvZiBJbmRpYSIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6ODI0fSwKICB7dDoiSVRDIiwgbmFtZToiSVRDIExpbWl0ZWQiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkZNQ0ciLCBi",
  "YXNlOjQ3OH0sCiAge3Q6IkxUIiwgbmFtZToiTGFyc2VuICYgVG91YnJvIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJJbmZyYXN0cnVjdHVyZSIsIGJhc2U6MzYxMn0sCiAge3Q6IktPVEFLQkFOSyIsIG5hbWU6IktvdGFrIE1haGluZHJhIEJhbmsiLCBleGNoOiJOU0Ui",
  "LCBzZWN0b3I6IkJhbmtpbmciLCBiYXNlOjE3ODl9LAogIHt0OiJISU5EVU5JTFZSIiwgbmFtZToiSGluZHVzdGFuIFVuaWxldmVyIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJGTUNHIiwgYmFzZToyNTQ3fSwKICB7dDoiQVhJU0JBTksiLCBuYW1lOiJBeGlzIEJhbmsi",
  "LCBleGNoOiJOU0UiLCBzZWN0b3I6IkJhbmtpbmciLCBiYXNlOjExNDJ9LAogIHt0OiJCQUpGSU5BTkNFIiwgbmFtZToiQmFqYWogRmluYW5jZSIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiRmluYW5jaWFsIFNlcnZpY2VzIiwgYmFzZTo3Mjg0fSwKICB7dDoiTUFSVVRJ",
  "IiwgbmFtZToiTWFydXRpIFN1enVraSIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQXV0b21vYmlsZSIsIGJhc2U6MTI0ODB9LAogIHt0OiJBU0lBTlBBSU5UIiwgbmFtZToiQXNpYW4gUGFpbnRzIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJDb25zdW1lciBHb29kcyIsIGJh",
  "c2U6Mjg5NH0sCiAge3Q6IldJUFJPIiwgbmFtZToiV2lwcm8iLCBleGNoOiJOU0UiLCBzZWN0b3I6IklUIFNlcnZpY2VzIiwgYmFzZTo1MTJ9LAogIHt0OiJUSVRBTiIsIG5hbWU6IlRpdGFuIENvbXBhbnkiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkNvbnN1bWVyIEdv",
  "b2RzIiwgYmFzZTozNDIxfSwKICB7dDoiU1VOUEhBUk1BIiwgbmFtZToiU3VuIFBoYXJtYWNldXRpY2FsIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJQaGFybWEiLCBiYXNlOjE3ODZ9LAogIHt0OiJOVFBDIiwgbmFtZToiTlRQQyBMaW1pdGVkIiwgZXhjaDoiTlNFIiwg",
  "c2VjdG9yOiJQb3dlciIsIGJhc2U6MzYyfSwKICB7dDoiQURBTklFTlQiLCBuYW1lOiJBZGFuaSBFbnRlcnByaXNlcyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiRGl2ZXJzaWZpZWQiLCBiYXNlOjI5MTR9LAogIHt0OiJVTFRSQUNFTUNPIiwgbmFtZToiVWx0cmFUZWNo",
  "IENlbWVudCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQ2VtZW50IiwgYmFzZToxMTI0MH0sCiAge3Q6IlBPV0VSR1JJRCIsIG5hbWU6IlBvd2VyIEdyaWQgQ29ycCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiUG93ZXIiLCBiYXNlOjMxOH0sCiAge3Q6Ik5FU1RMRUlORCIs",
  "IG5hbWU6Ik5lc3RsZSBJbmRpYSIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiRk1DRyIsIGJhc2U6MjI3OH0sCiAge3Q6IlRBVEFNT1RPUlMiLCBuYW1lOiJUYXRhIE1vdG9ycyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQXV0b21vYmlsZSIsIGJhc2U6OTQ4fSwKICB7dDoi",
  "SlNXU1RFRUwiLCBuYW1lOiJKU1cgU3RlZWwiLCBleGNoOiJOU0UiLCBzZWN0b3I6Ik1ldGFscyIsIGJhc2U6MTAxMn0sCl07CgpmdW5jdGlvbiBzZWVkZWRSYW5kKHNlZWQpewogIGxldCB4ID0gTWF0aC5zaW4oc2VlZCkgKiAxMDAwMDsKICByZXR1cm4geCAtIE1h",
  "dGguZmxvb3IoeCk7Cn0KZnVuY3Rpb24gZGF5T2ZZZWFyKCl7CiAgY29uc3Qgbm93ID0gbmV3IERhdGUoKTsKICByZXR1cm4gTWF0aC5mbG9vcigobm93IC0gbmV3IERhdGUobm93LmdldEZ1bGxZZWFyKCksMCwwKSkgLyA4NjQwMDAwMCk7Cn0KZnVuY3Rpb24gZ2Vu",
  "U2VyaWVzKHNlZWQsIHBvaW50cywgdm9sYXRpbGl0eSwgYmFzZSl7CiAgY29uc3QgYXJyID0gW107CiAgbGV0IHYgPSBiYXNlOwogIGZvcihsZXQgaT0wO2k8cG9pbnRzO2krKyl7CiAgICBjb25zdCByID0gc2VlZGVkUmFuZChzZWVkICogOTcuNyArIGkgKiAxMy4z",
  "MSkgLSAwLjU7CiAgICB2ID0gdiAqICgxICsgciAqIHZvbGF0aWxpdHkpOwogICAgYXJyLnB1c2godik7CiAgfQogIHJldHVybiBhcnI7Cn0KZnVuY3Rpb24gdGlja2VyU2VlZCh0aWNrZXIpewogIGxldCBoID0gMDsKICBmb3IobGV0IGk9MDtpPHRpY2tlci5sZW5n",
  "dGg7aSsrKSBoID0gKGgqMzEgKyB0aWNrZXIuY2hhckNvZGVBdChpKSkgJSAxMDAwMDA7CiAgcmV0dXJuIGggKyBkYXlPZlllYXIoKTsKfQoKZnVuY3Rpb24gd2l0aExhdGVuY3kodmFsdWUpewogIHJldHVybiBuZXcgUHJvbWlzZShyZXMgPT4gc2V0VGltZW91dCgo",
  "KSA9PiByZXModmFsdWUpLCBNT0NLX0xBVEVOQ1kpKTsKfQoKY29uc3QgQVBJID0gewogIGFzeW5jIGZldGNoSW5kaWNlcygpewogICAgY29uc3QgZGVmcyA9IFsKICAgICAge2NvZGU6Ik5JRlRZIDUwIiwgZnVsbDoiTlNFIE5pZnR5IDUwIEluZGV4IiwgYmFzZToy",
  "NDgxMn0sCiAgICAgIHtjb2RlOiJTRU5TRVgiLCBmdWxsOiJCU0UgU2Vuc2V4IiwgYmFzZTo4MTY0MH0sCiAgICAgIHtjb2RlOiJOSUZUWSBCQU5LIiwgZnVsbDoiTlNFIEJhbmsgTmlmdHkgSW5kZXgiLCBiYXNlOjUyMTQwfSwKICAgIF07CiAgICBjb25zdCBvdXQg",
  "PSBkZWZzLm1hcChkPT57CiAgICAgIGNvbnN0IHNlZWQgPSB0aWNrZXJTZWVkKGQuY29kZSk7CiAgICAgIGNvbnN0IHNlcmllcyA9IGdlblNlcmllcyhzZWVkLCAyNCwgMC4wMDYsIGQuYmFzZSk7CiAgICAgIGNvbnN0IGxhc3QgPSBzZXJpZXNbc2VyaWVzLmxlbmd0",
  "aC0xXTsKICAgICAgY29uc3QgcHJldiA9IGQuYmFzZTsKICAgICAgY29uc3QgY2hnID0gbGFzdCAtIHByZXY7CiAgICAgIGNvbnN0IHBjdCA9IChjaGcvcHJldikqMTAwOwogICAgICByZXR1cm4gey4uLmQsIHZhbHVlOmxhc3QsIGNoYW5nZTpjaGcsIHBjdCwgc2Vy",
  "aWVzfTsKICAgIH0pOwogICAgcmV0dXJuIHdpdGhMYXRlbmN5KG91dCk7CiAgfSwKCiAgYXN5bmMgc2VhcmNoU3RvY2tzKHF1ZXJ5KXsKICAgIGNvbnN0IHEgPSBxdWVyeS50cmltKCkudG9Mb3dlckNhc2UoKTsKICAgIGlmKCFxKSByZXR1cm4gd2l0aExhdGVuY3ko",
  "W10pOwogICAgY29uc3QgbWF0Y2hlcyA9IFVOSVZFUlNFLmZpbHRlcihzID0+IHMudC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpIHx8IHMubmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKS5zbGljZSgwLDgpOwogICAgaWYobGl2ZUJhY2tlbmRBdmFpbGFi",
  "bGUpewogICAgICBjb25zdCBsaXZlID0gYXdhaXQgbGl2ZUZldGNoTWFueShtYXRjaGVzLm1hcChtPT5tLnQpKTsKICAgICAgaWYobGl2ZS5sZW5ndGgpIHJldHVybiBsaXZlOwogICAgfQogICAgcmV0dXJuIHdpdGhMYXRlbmN5KG1hdGNoZXMubWFwKHMgPT4gZGVj",
  "b3JhdGVTdG9jayhzKSkpOwogIH0sCgogIGFzeW5jIGZldGNoU2NyZWVuZXJSZXN1bHRzKGZpbHRlcnMpewogICAgbGV0IGxpc3Q7CiAgICBpZihsaXZlQmFja2VuZEF2YWlsYWJsZSl7CiAgICAgIGNvbnN0IGxpdmUgPSBhd2FpdCBsaXZlRmV0Y2hNYW55KFVOSVZF",
  "UlNFLm1hcChzPT5zLnQpKTsKICAgICAgbGlzdCA9IGxpdmUubGVuZ3RoID8gbGl2ZSA6IFVOSVZFUlNFLm1hcChzPT5kZWNvcmF0ZVN0b2NrKHMpKTsKICAgIH0gZWxzZSB7CiAgICAgIGxpc3QgPSBVTklWRVJTRS5tYXAoZGVjb3JhdGVTdG9jayk7CiAgICAgIGF3",
  "YWl0IHdpdGhMYXRlbmN5KG51bGwpOwogICAgfQogICAgaWYoZmlsdGVycy5xdWVyeSl7CiAgICAgIGNvbnN0IHEgPSBmaWx0ZXJzLnF1ZXJ5LnRvTG93ZXJDYXNlKCk7CiAgICAgIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnQudG9Mb3dlckNhc2UoKS5pbmNsdWRl",
  "cyhxKXx8cy5uYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkpOwogICAgfQogICAgaWYoZmlsdGVycy5zZWN0b3IgJiYgZmlsdGVycy5zZWN0b3IgIT09ICJBbGwiKSBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy5zZWN0b3I9PT1maWx0ZXJzLnNlY3Rvcik7CiAg",
  "ICBpZihmaWx0ZXJzLm1pblByaWNlKSBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy5wcmljZT49ZmlsdGVycy5taW5QcmljZSk7CiAgICBpZihmaWx0ZXJzLm1heFByaWNlKSBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy5wcmljZTw9ZmlsdGVycy5tYXhQcmljZSk7CiAg",
  "ICBpZihmaWx0ZXJzLmRpcmVjdGlvbj09PSJnYWluZXJzIikgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMucGN0Pj0wKTsKICAgIGlmKGZpbHRlcnMuZGlyZWN0aW9uPT09Imxvc2VycyIpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnBjdDwwKTsKICAgIHJldHVybiBs",
  "aXN0OwogIH0sCgogIGFzeW5jIGZldGNoU3RvY2sodGlja2VyKXsKICAgIGlmKGxpdmVCYWNrZW5kQXZhaWxhYmxlKXsKICAgICAgdHJ5eyByZXR1cm4gYXdhaXQgbGl2ZUZldGNoU3RvY2sodGlja2VyKTsgfQogICAgICBjYXRjaChlKXsgLyogZmFsbCB0aHJvdWdo",
  "IHRvIG1vY2sgKi8gfQogICAgfQogICAgY29uc3QgZGVmID0gVU5JVkVSU0UuZmluZChzPT5zLnQ9PT10aWNrZXIpOwogICAgaWYoIWRlZikgcmV0dXJuIHdpdGhMYXRlbmN5KG51bGwpOwogICAgcmV0dXJuIHdpdGhMYXRlbmN5KGRlY29yYXRlU3RvY2soZGVmLCB0",
  "cnVlKSk7CiAgfSwKCiAgYXN5bmMgZmV0Y2hTdG9ja0hpc3RvcnkodGlja2VyLCByYW5nZSl7CiAgICBjb25zdCBzZWVkID0gdGlja2VyU2VlZCh0aWNrZXIpOwogICAgY29uc3QgY2ZnID0gewogICAgICAiMUQiOntwb2ludHM6NzgsIHZvbDowLjAwMTZ9LAogICAg",
  "ICAiMVciOntwb2ludHM6MzUsIHZvbDowLjAwM30sCiAgICAgICIxTSI6e3BvaW50czoyMiwgdm9sOjAuMDA4fSwKICAgICAgIjNNIjp7cG9pbnRzOjY1LCB2b2w6MC4wMDl9LAogICAgICAiNk0iOntwb2ludHM6MTMwLCB2b2w6MC4wMTB9LAogICAgICAiMVkiOntw",
  "b2ludHM6MjUwLCB2b2w6MC4wMTJ9LAogICAgfVtyYW5nZV0gfHwge3BvaW50czo2MCwgdm9sOjAuMDA4fTsKICAgIGNvbnN0IGRlZiA9IFVOSVZFUlNFLmZpbmQocz0+cy50PT09dGlja2VyKTsKICAgIGNvbnN0IGJhc2UgPSBkZWYgPyBkZWYuYmFzZSAqIDAuOTQg",
  "OiAxMDAwOwogICAgY29uc3Qgc2VyaWVzID0gZ2VuU2VyaWVzKHNlZWQgKyByYW5nZS5sZW5ndGgsIGNmZy5wb2ludHMsIGNmZy52b2wsIGJhc2UpOwogICAgcmV0dXJuIHdpdGhMYXRlbmN5KHNlcmllcyk7CiAgfSwKfTsKCmZ1bmN0aW9uIGRlY29yYXRlU3RvY2so",
  "ZGVmLCBkZXRhaWxlZCl7CiAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQoZGVmLnQpOwogIGNvbnN0IHNlcmllcyA9IGdlblNlcmllcyhzZWVkLCAyMCwgMC4wMDUsIGRlZi5iYXNlKTsKICBjb25zdCBwcmljZSA9IHNlcmllc1tzZXJpZXMubGVuZ3RoLTFdOwogIGNv",
  "bnN0IHByZXZDbG9zZSA9IGRlZi5iYXNlOwogIGNvbnN0IGNoYW5nZSA9IHByaWNlIC0gcHJldkNsb3NlOwogIGNvbnN0IHBjdCA9IChjaGFuZ2UvcHJldkNsb3NlKSoxMDA7CiAgY29uc3QgbWFya2V0Q2FwID0gcHJpY2UgKiAoc2VlZGVkUmFuZChzZWVkKjIuMSkq",
  "NDAwMCs4MDApICogMWU2OwogIGNvbnN0IHZvbHVtZSA9IE1hdGgucm91bmQoc2VlZGVkUmFuZChzZWVkKjMuMykqOF8wMDBfMDAwICsgMjAwXzAwMCk7CiAgY29uc3QgaGlnaDUyID0gcHJpY2UgKiAoMSArIHNlZWRlZFJhbmQoc2VlZCo0LjQpKjAuMzUgKyAwLjA1",
  "KTsKICBjb25zdCBsb3c1MiA9IHByaWNlICogKDEgLSBzZWVkZWRSYW5kKHNlZWQqNS41KSowLjMwIC0gMC4wNCk7CiAgY29uc3Qgb3V0ID0gewogICAgdDpkZWYudCwgbmFtZTpkZWYubmFtZSwgZXhjaDpkZWYuZXhjaCwgc2VjdG9yOmRlZi5zZWN0b3IsCiAgICBw",
  "cmljZSwgY2hhbmdlLCBwY3QsIG1hcmtldENhcCwgdm9sdW1lLCBoaWdoNTIsIGxvdzUyLCBzZXJpZXMsCiAgfTsKICBpZihkZXRhaWxlZCl7CiAgICBvdXQub3BlbiA9IHByaWNlIC0gY2hhbmdlKjAuNjsKICAgIG91dC5kYXlIaWdoID0gTWF0aC5tYXgocHJpY2Us",
  "IG91dC5vcGVuKSAqICgxK3NlZWRlZFJhbmQoc2VlZCo2LjYpKjAuMDEyKTsKICAgIG91dC5kYXlMb3cgPSBNYXRoLm1pbihwcmljZSwgb3V0Lm9wZW4pICogKDEtc2VlZGVkUmFuZChzZWVkKjcuNykqMC4wMTIpOwogIH0KICByZXR1cm4gb3V0Owp9CgovKiA9PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEZPUk1BVCBIRUxQRVJTCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8K",
  "ZnVuY3Rpb24gZm10SU5SKHYsIGRlY2ltYWxzKXsKICBpZih2PT09dW5kZWZpbmVkfHx2PT09bnVsbHx8aXNOYU4odikpIHJldHVybiAi4oCUIjsKICBjb25zdCBkID0gZGVjaW1hbHM9PT11bmRlZmluZWQ/MjpkZWNpbWFsczsKICByZXR1cm4gIuKCuSIgKyB2LnRv",
  "TG9jYWxlU3RyaW5nKCJlbi1JTiIsIHttaW5pbXVtRnJhY3Rpb25EaWdpdHM6ZCwgbWF4aW11bUZyYWN0aW9uRGlnaXRzOmR9KTsKfQpmdW5jdGlvbiBmbXRDb21wYWN0KHYpewogIGlmKHY9PT11bmRlZmluZWR8fHY9PT1udWxsfHxpc05hTih2KSkgcmV0dXJuICLi",
  "gJQiOwogIGlmKHY+PTFlMTIpIHJldHVybiAi4oK5Iisodi8xZTEyKS50b0ZpeGVkKDIpKyJUIjsKICBpZih2Pj0xZTkpIHJldHVybiAi4oK5Iisodi8xZTkpLnRvRml4ZWQoMikrIkIiOwogIGlmKHY+PTFlNykgcmV0dXJuICLigrkiKyh2LzFlNykudG9GaXhlZCgy",
  "KSsiQ3IiOwogIGlmKHY+PTFlNSkgcmV0dXJuICLigrkiKyh2LzFlNSkudG9GaXhlZCgyKSsiTCI7CiAgcmV0dXJuICLigrkiK3YudG9GaXhlZCgwKTsKfQpmdW5jdGlvbiBmbXRWb2wodil7CiAgaWYodj49MWU3KSByZXR1cm4gKHYvMWU3KS50b0ZpeGVkKDIpKyJD",
  "ciI7CiAgaWYodj49MWU1KSByZXR1cm4gKHYvMWU1KS50b0ZpeGVkKDIpKyJMIjsKICBpZih2Pj0xZTMpIHJldHVybiAodi8xZTMpLnRvRml4ZWQoMSkrIksiOwogIHJldHVybiBTdHJpbmcodik7Cn0KZnVuY3Rpb24gcGN0U3RyKHApeyByZXR1cm4gKHA+PTA/Iisi",
  "OiIiKSArIHAudG9GaXhlZCgyKSArICIlIjsgfQpmdW5jdGlvbiBjaGdTdHIoYyl7IHJldHVybiAoYz49MD8iKyI6IiIpICsgZm10SU5SKE1hdGguYWJzKGMpKTsgfQpmdW5jdGlvbiBlc2NhcGVIdG1sKHMpewogIHJldHVybiBTdHJpbmcocykucmVwbGFjZSgvWyY8",
  "PiInXS9nLCBtID0+ICh7IiYiOiImYW1wOyIsIjwiOiImbHQ7IiwiPiI6IiZndDsiLCciJzoiJnF1b3Q7IiwiJyI6IiYjMzk7In1bbV0pKTsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PQogICBTVEFURQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmNvbnN0IHN0YXRlID0gewogIHZpZXc6ICJkYXNoYm9hcmQiLAogIHdhdGNobGlzdDogW10sCiAgZGV0YWlsVGlja2Vy",
  "OiAiVENTIiwKICBkZXRhaWxSYW5nZTogIjFNIiwKICBzY3JlZW5lckZpbHRlcnM6IHtxdWVyeToiIiwgc2VjdG9yOiJBbGwiLCBtaW5QcmljZTowLCBtYXhQcmljZToxNTAwMCwgZGlyZWN0aW9uOiJhbGwifSwKICBzY3JlZW5lclNvcnQ6IHtrZXk6Im1hcmtldENh",
  "cCIsIGRpcjoiZGVzYyJ9LAp9OwoKdHJ5ewogIGNvbnN0IHNhdmVkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oImVxdWl0eXNjYW5fd2F0Y2hsaXN0Iik7CiAgaWYoc2F2ZWQpIHN0YXRlLndhdGNobGlzdCA9IEpTT04ucGFyc2Uoc2F2ZWQpOwp9Y2F0Y2goZSl7fQpm",
  "dW5jdGlvbiBwZXJzaXN0V2F0Y2hsaXN0KCl7CiAgdHJ5eyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgiZXF1aXR5c2Nhbl93YXRjaGxpc3QiLCBKU09OLnN0cmluZ2lmeShzdGF0ZS53YXRjaGxpc3QpKTsgfWNhdGNoKGUpe30KfQoKLyogPT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBTUEFSS0xJTkUgKGlubGluZSBTVkcpCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KZnVuY3Rp",
  "b24gc3BhcmtsaW5lU1ZHKHNlcmllcywgcG9zaXRpdmUsIHcsIGgpewogIHcgPSB3fHwxMjA7IGggPSBofHwzNjsKICBpZighc2VyaWVzIHx8IHNlcmllcy5sZW5ndGg8MikgcmV0dXJuICIiOwogIGNvbnN0IG1pbiA9IE1hdGgubWluKC4uLnNlcmllcyksIG1heCA9",
  "IE1hdGgubWF4KC4uLnNlcmllcyk7CiAgY29uc3QgcmFuZ2UgPSAobWF4LW1pbil8fDE7CiAgY29uc3Qgc3RlcCA9IHcvKHNlcmllcy5sZW5ndGgtMSk7CiAgY29uc3QgcHRzID0gc2VyaWVzLm1hcCgodixpKT0+W2kqc3RlcCwgaCAtICgodi1taW4pL3JhbmdlKSpo",
  "KjAuODYgLSBoKjAuMDddKTsKICBjb25zdCBwYXRoID0gcHRzLm1hcCgocCxpKT0+KGk9PT0wPyJNIjoiTCIpK3BbMF0udG9GaXhlZCgxKSsiLCIrcFsxXS50b0ZpeGVkKDEpKS5qb2luKCIgIik7CiAgY29uc3QgYXJlYVBhdGggPSBwYXRoICsgYCBMJHt3fSwke2h9",
  "IEwwLCR7aH0gWmA7CiAgY29uc3QgY29sb3IgPSBwb3NpdGl2ZSA/ICJ2YXIoLS1wb3MpIiA6ICJ2YXIoLS1uZWcpIjsKICBjb25zdCBnaWQgPSAic2ciK01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsOSk7CiAgcmV0dXJuIGA8c3ZnIHZpZXdCb3g9",
  "IjAgMCAke3d9ICR7aH0iIHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIHByZXNlcnZlQXNwZWN0UmF0aW89Im5vbmUiPgogICAgPGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSIke2dpZH0iIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj4KICAgICAgPHN0b3Ag",
  "b2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iJHtjb2xvcn0iIHN0b3Atb3BhY2l0eT0iMC4zNSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiR7Y29sb3J9IiBzdG9wLW9wYWNpdHk9IjAiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+PC9kZWZz",
  "PgogICAgPHBhdGggZD0iJHthcmVhUGF0aH0iIGZpbGw9InVybCgjJHtnaWR9KSIgc3Ryb2tlPSJub25lIi8+CiAgICA8cGF0aCBkPSIke3BhdGh9IiBmaWxsPSJub25lIiBzdHJva2U9IiR7Y29sb3J9IiBzdHJva2Utd2lkdGg9IjEuNiIgc3Ryb2tlLWxpbmVjYXA9",
  "InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgPC9zdmc+YDsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBBTUJJRU5UIERFQ09SQVRJVkUgTElORVMgKGRyYXdu",
  "IG9uY2UpCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KKGZ1bmN0aW9uIGRyYXdBbWJpZW50TGluZXMoKXsKICBjb25zdCBzdmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYW1i",
  "aWVudExpbmVzIik7CiAgY29uc3QgdyA9IDE0MDAsIGggPSA4MDA7CiAgc3ZnLnNldEF0dHJpYnV0ZSgidmlld0JveCIsIGAwIDAgJHt3fSAke2h9YCk7CiAgbGV0IGh0bWwgPSAiIjsKICBmb3IobGV0IGk9MDtpPDM7aSsrKXsKICAgIGNvbnN0IHNlZWQgPSBpKjE3",
  "KzM7CiAgICBjb25zdCBwdHMgPSBbXTsKICAgIGNvbnN0IG4gPSAxMjsKICAgIGZvcihsZXQgaj0wO2o8PW47aisrKXsKICAgICAgY29uc3QgeCA9IChqL24pKnc7CiAgICAgIGNvbnN0IHkgPSBoKjAuMjUgKyBpKjEzMCArIChzZWVkZWRSYW5kKHNlZWQraiktMC41",
  "KSo5MDsKICAgICAgcHRzLnB1c2goW3gseV0pOwogICAgfQogICAgY29uc3QgcGF0aCA9IHB0cy5tYXAoKHAsaWR4KT0+KGlkeD09PTA/Ik0iOiJMIikrcFswXS50b0ZpeGVkKDApKyIsIitwWzFdLnRvRml4ZWQoMCkpLmpvaW4oIiAiKTsKICAgIGNvbnN0IGNvbG9y",
  "cyA9IFsiIzRDN0RGRiIsIiM4QjZCRjAiLCIjMzFENUVFIl07CiAgICBodG1sICs9IGA8cGF0aCBkPSIke3BhdGh9IiBmaWxsPSJub25lIiBzdHJva2U9IiR7Y29sb3JzW2klM119IiBzdHJva2Utd2lkdGg9IjEiIG9wYWNpdHk9IjAuMTAiLz5gOwogIH0KICBzdmcu",
  "aW5uZXJIVE1MID0gaHRtbDsKfSkoKTsKCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgSEVBREVSIEJFSEFWSU9SCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3QgdG9wYmFyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRvcGJhciIpOwp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigic2Nyb2xsIiwgKCk9PnsKICB0b3BiYXIuY2xhc3NMaXN0LnRvZ2dsZSgi",
  "c2Nyb2xsZWQiLCB3aW5kb3cuc2Nyb2xsWSA+IDgpOwp9KTsKCmZ1bmN0aW9uIHNldEFjdGl2ZU5hdih2aWV3KXsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIjbWFpbk5hdiBidXR0b24sICNib3R0b21OYXYgYnV0dG9uIikuZm9yRWFjaChiPT57CiAgICBi",
  "LmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsIGIuZGF0YXNldC52aWV3PT09dmlldyk7CiAgfSk7Cn0KZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm1haW5OYXYiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIGU9PnsKICBjb25zdCBidG4gPSBlLnRhcmdldC5j",
  "bG9zZXN0KCJidXR0b25bZGF0YS12aWV3XSIpOwogIGlmKGJ0bikgbmF2aWdhdGUoYnRuLmRhdGFzZXQudmlldyk7Cn0pOwpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYm90dG9tTmF2IikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCBlPT57CiAgY29uc3QgYnRu",
  "ID0gZS50YXJnZXQuY2xvc2VzdCgiYnV0dG9uW2RhdGEtdmlld10iKTsKICBpZihidG4pIG5hdmlnYXRlKGJ0bi5kYXRhc2V0LnZpZXcpOwp9KTsKCmZ1bmN0aW9uIG5hdmlnYXRlKHZpZXcsIHRpY2tlcil7CiAgc3RhdGUudmlldyA9IHZpZXc7CiAgaWYodGlja2Vy",
  "KSBzdGF0ZS5kZXRhaWxUaWNrZXIgPSB0aWNrZXI7CiAgc2V0QWN0aXZlTmF2KHZpZXcgPT09ICJkZXRhaWwiID8gIm1hcmtldHMiIDogdmlldyk7CiAgd2luZG93LnNjcm9sbFRvKHt0b3A6MCwgYmVoYXZpb3I6IHdpbmRvdy5tYXRjaE1lZGlhKCcocHJlZmVycy1y",
  "ZWR1Y2VkLW1vdGlvbjogcmVkdWNlKScpLm1hdGNoZXMgPyAiYXV0byIgOiAic21vb3RoIn0pOwogIHJlbmRlcigpOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIE1BUktFVCBT",
  "VEFUVVMgKElTVCBidXNpbmVzcyBob3VycywgcHVyZWx5IHByZXNlbnRhdGlvbmFsKQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCihmdW5jdGlvbiBtYXJrZXRTdGF0dXMoKXsKICBj",
  "b25zdCBub3cgPSBuZXcgRGF0ZSgpOwogIGNvbnN0IGlzdEhvdXIgPSAobm93LmdldFVUQ0hvdXJzKCkrNSklMjQgKyAobm93LmdldFVUQ01pbnV0ZXMoKSszMD49NjA/MTowKTsKICBjb25zdCBtaW5zID0gKG5vdy5nZXRVVENNaW51dGVzKCkrMzApJTYwOwogIGNv",
  "bnN0IHRvdGFsTWluID0gKChub3cuZ2V0VVRDSG91cnMoKSs1KSUyNCkqNjAgKyBtaW5zOwogIGNvbnN0IG9wZW4gPSB0b3RhbE1pbiA+PSA1NTUgJiYgdG90YWxNaW4gPD0gOTMwOyAvLyA5OjE1IC0gMTU6MzAgSVNUCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQo",
  "Im1hcmtldFN0YXR1c1RleHQiKS50ZXh0Q29udGVudCA9IG9wZW4gPyAiTWFya2V0IE9wZW4iIDogIk1hcmtldCBDbG9zZWQiOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoIi5kb3QtbGl2ZSIpLnN0eWxlLmJhY2tncm91bmQgPSBvcGVuID8gInZhcigtLXBvcyki",
  "IDogInZhcigtLXRleHQtZmFpbnQpIjsKfSkoKTsKCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgUkVOREVSOiBST09UCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3Qgcm9vdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtYWluUm9vdCIpOwoKZnVuY3Rpb24gcmVuZGVyKCl7CiAgaWYoc3RhdGUudmlldyA9PT0gImRhc2hib2FyZCIpIHJlbmRlckRhc2hi",
  "b2FyZCgpOwogIGVsc2UgaWYoc3RhdGUudmlldyA9PT0gInNjcmVlbmVyIikgcmVuZGVyU2NyZWVuZXIoKTsKICBlbHNlIGlmKHN0YXRlLnZpZXcgPT09ICJtYXJrZXRzIikgcmVuZGVyTWFya2V0cygpOwogIGVsc2UgaWYoc3RhdGUudmlldyA9PT0gIndhdGNobGlz",
  "dCIpIHJlbmRlcldhdGNobGlzdCgpOwogIGVsc2UgaWYoc3RhdGUudmlldyA9PT0gImRldGFpbCIpIHJlbmRlckRldGFpbCgpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIERBU0hCT0FSRCAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlckRh",
  "c2hib2FyZCgpewogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyIgaWQ9ImRhc2hWaWV3Ij4KICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+TWFya2V0IE92ZXJ2aWV3PC9oMj48c3BhbiBjbGFzcz0ic3ViIj5SZWFsLXRp",
  "bWUgaW5kZXggc25hcHNob3Q8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Imhlcm8tcm93IiBpZD0iaW5kaWNlc1JvdyI+CiAgICAgICAgJHtza2VsZXRvbkNhcmRzKDMpfQogICAgICA8L2Rpdj4KCiAgICAgICR7c2VhcmNoQmxvY2soKX0KCiAgICAgIDxk",
  "aXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPk1hcmtldCBCcmVhZHRoPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5BZHZhbmNlcnMgdnMgZGVjbGluZXJzLCBmdWxsIHVuaXZlcnNlPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJnbGFzcyBicmVhZHRoLWNh",
  "cmQiIGlkPSJicmVhZHRoQ2FyZCIgc3R5bGU9InBhZGRpbmc6MThweCAyMnB4O21hcmdpbi1ib3R0b206MzRweDsiPiR7c2tlbGV0b25MaW5lcygyKX08L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPlRvcCBNb3ZlcnM8L2gyPjxzcGFu",
  "IGNsYXNzPSJzdWIiPkJ5IGFic29sdXRlIGNoYW5nZSB0b2RheTwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCBnbGFzcyIgaWQ9Im1vdmVyc1RhYmxlV3JhcCI+PGRpdiBzdHlsZT0icGFkZGluZzoyMHB4OyI+JHtza2VsZXRvbkxpbmVz",
  "KDYpfTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdG9jay1jYXJkcyIgaWQ9Im1vdmVyc0NhcmRzIj48L2Rpdj4KICAgIDwvZGl2PgogIGA7CiAgd2lyZVNlYXJjaCgpOwoKICB0cnl7CiAgICBjb25zdCBpbmRpY2VzID0gYXdhaXQgQVBJLmZldGNoSW5k",
  "aWNlcygpOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImluZGljZXNSb3ciKS5pbm5lckhUTUwgPSBpbmRpY2VzLm1hcChpbmRleENhcmRIVE1MKS5qb2luKCIiKTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi5pbmRleC1zcGFyayIpLmZvckVh",
  "Y2goKGVsLGkpPT57CiAgICAgIGVsLmlubmVySFRNTCA9IHNwYXJrbGluZVNWRyhpbmRpY2VzW2ldLnNlcmllcywgaW5kaWNlc1tpXS5jaGFuZ2U+PTApOwogICAgfSk7CiAgfWNhdGNoKGUpewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImluZGljZXNSb3ci",
  "KS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiTWFya2V0IGRhdGEgdGVtcG9yYXJpbHkgdW5hdmFpbGFibGUiLCAiV2UgY291bGRuJ3QgcmVhY2ggdGhlIGluZGljZXMgZmVlZC4gUGxlYXNlIHRyeSBhZ2FpbiBzaG9ydGx5LiIpOwogIH0KCiAgdHJ5ewogICAg",
  "Y29uc3QgZnVsbCA9IGF3YWl0IEFQSS5mZXRjaFNjcmVlbmVyUmVzdWx0cyh7fSk7CiAgICB0cnl7CiAgICAgIHJlbmRlckJyZWFkdGgoZnVsbCk7CiAgICB9Y2F0Y2goZSl7CiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJicmVhZHRoQ2FyZCIpLmlubmVy",
  "SFRNTCA9IGVycm9yU3RhdGVIVE1MKCJCcmVhZHRoIGRhdGEgdW5hdmFpbGFibGUiLCAiQ291bGRuJ3QgY29tcHV0ZSBhZHZhbmNlcnMgdnMgZGVjbGluZXJzLiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIik7CiAgICAgIHNob3dFcnJvckJhbm5lcigi",
  "cmVuZGVyQnJlYWR0aCBmYWlsZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogICAgfQogICAgdHJ5ewogICAgICBjb25zdCBtb3ZlcnMgPSBmdWxsLnNsaWNlKCkuc29ydCgoYSxiKT0+TWF0aC5hYnMoYi5wY3QpLU1hdGguYWJzKGEucGN0KSkuc2xpY2Uo",
  "MCw4KTsKICAgICAgcmVuZGVyVGFibGVJbnRvKCJtb3ZlcnNUYWJsZVdyYXAiLCAibW92ZXJzQ2FyZHMiLCBtb3ZlcnMsIHtrZXk6InBjdCIsIGRpcjoiZGVzYyJ9LCBmYWxzZSk7CiAgICB9Y2F0Y2goZSl7CiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJt",
  "b3ZlcnNUYWJsZVdyYXAiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIHJldHJpZXZlIG1vdmVycyIsICJTb21ldGhpbmcgd2VudCB3cm9uZyBsb2FkaW5nIHRoaXMgbGlzdC4gKCIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkgKyAiKSIpOwog",
  "ICAgICBzaG93RXJyb3JCYW5uZXIoIm1vdmVycyB0YWJsZSByZW5kZXIgZmFpbGVkOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsKICAgIH0KICB9Y2F0Y2goZSl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibW92ZXJzVGFibGVXcmFwIikuaW5uZXJI",
  "VE1MID0gZXJyb3JTdGF0ZUhUTUwoIlVuYWJsZSB0byByZXRyaWV2ZSBtb3ZlcnMiLCAiU29tZXRoaW5nIHdlbnQgd3JvbmcgbG9hZGluZyB0aGlzIGxpc3QuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRC",
  "eUlkKCJicmVhZHRoQ2FyZCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJCcmVhZHRoIGRhdGEgdW5hdmFpbGFibGUiLCAiQ291bGRuJ3QgY29tcHV0ZSBhZHZhbmNlcnMgdnMgZGVjbGluZXJzLiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIik7",
  "CiAgICBzaG93RXJyb3JCYW5uZXIoImZldGNoU2NyZWVuZXJSZXN1bHRzIGZhaWxlZDogIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSk7CiAgfQp9CgpmdW5jdGlvbiByZW5kZXJCcmVhZHRoKGxpc3QpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5",
  "SWQoImJyZWFkdGhDYXJkIik7CiAgaWYoIWVsIHx8ICFsaXN0Lmxlbmd0aCl7IGlmKGVsKSBlbC5pbm5lckhUTUwgPSBlbXB0eVN0YXRlSFRNTCgiTm8gYnJlYWR0aCBkYXRhIiwgIk5vIHN0b2NrcyB3ZXJlIHJldHVybmVkIHRvIGNvbXB1dGUgdGhpcyBmcm9tLiIp",
  "OyByZXR1cm47IH0KICBjb25zdCBhZHZhbmNlcnMgPSBsaXN0LmZpbHRlcihzPT5zLnBjdD4wKS5sZW5ndGg7CiAgY29uc3QgZGVjbGluZXJzID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q8MCkubGVuZ3RoOwogIGNvbnN0IGZsYXQgPSBsaXN0Lmxlbmd0aCAtIGFkdmFu",
  "Y2VycyAtIGRlY2xpbmVyczsKICBjb25zdCB0b3RhbCA9IGxpc3QubGVuZ3RoOwogIGNvbnN0IGFkdlBjdCA9IChhZHZhbmNlcnMvdG90YWwpKjEwMCwgZGVjUGN0ID0gKGRlY2xpbmVycy90b3RhbCkqMTAwLCBmbGF0UGN0ID0gKGZsYXQvdG90YWwpKjEwMDsKICBl",
  "bC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6YmFzZWxpbmU7bWFyZ2luLWJvdHRvbToxMnB4O2ZsZXgtd3JhcDp3cmFwO2dhcDo4cHg7Ij4KICAgICAgPGRp",
  "diBzdHlsZT0iZGlzcGxheTpmbGV4O2dhcDoyMHB4OyI+CiAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciIgc3R5bGU9ImZvbnQtc2l6ZToyMHB4O2NvbG9yOnZhcigtLXBvcy1zb2Z0KTsiPiR7YWR2YW5jZXJzfTwvc3Bhbj4gPHNw",
  "YW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMnB4OyI+YWR2YW5jaW5nPC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNpemU6MjBweDtjb2xvcjp2YXIo",
  "LS1uZWctc29mdCk7Ij4ke2RlY2xpbmVyc308L3NwYW4+IDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTJweDsiPmRlY2xpbmluZzwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2PjxzcGFuIGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1",
  "bGFyIiBzdHlsZT0iZm9udC1zaXplOjIwcHg7Y29sb3I6dmFyKC0tdGV4dC1taWQpOyI+JHtmbGF0fTwvc3Bhbj4gPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMnB4OyI+dW5jaGFuZ2VkPC9zcGFuPjwvZGl2PgogICAgICA8L2Rp",
  "dj4KICAgICAgPGRpdiBzdHlsZT0iZm9udC1zaXplOjExLjVweDtjb2xvcjp2YXIoLS10ZXh0LWZhaW50KTsiPm9mICR7dG90YWx9IHRyYWNrZWQgc3RvY2tzPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtoZWlnaHQ6MTBweDti",
  "b3JkZXItcmFkaXVzOjZweDtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDp2YXIoLS1iZy1iYXNlKTsiPgogICAgICA8ZGl2IHN0eWxlPSJ3aWR0aDoke2FkdlBjdH0lO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHZhcigtLXBvcyksdmFyKC0tcG9z",
  "LXNvZnQpKTsiPjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJ3aWR0aDoke2ZsYXRQY3R9JTtiYWNrZ3JvdW5kOnZhcigtLXRleHQtZmFpbnQpOyI+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9IndpZHRoOiR7ZGVjUGN0fSU7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGll",
  "bnQoOTBkZWcsdmFyKC0tbmVnLXNvZnQpLHZhcigtLW5lZykpOyI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwp9CgpmdW5jdGlvbiBpbmRleENhcmRIVE1MKGlkeCl7CiAgY29uc3QgcG9zaXRpdmUgPSBpZHguY2hhbmdlID49IDA7CiAgcmV0dXJuIGAKICA8ZGl2IGNs",
  "YXNzPSJnbGFzcyBpbmRleC1jYXJkIj4KICAgIDxkaXYgY2xhc3M9InJvdzEiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImluZGV4LW5hbWUiPiR7aWR4LmNvZGV9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtZnVsbCI+JHtpZHguZnVs",
  "bH08L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImluZGV4LWJhZGdlICR7cG9zaXRpdmU/J3Bvcyc6J25lZyd9Ij4KICAgICAgICAke3Bvc2l0aXZlPyfilrInOifilrwnfSAke3BjdFN0cihpZHgucGN0KX0KICAgICAgPC9kaXY+CiAgICA8L2Rp",
  "dj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiPiR7aWR4LnZhbHVlLnRvTG9jYWxlU3RyaW5nKCJlbi1JTiIse21heGltdW1GcmFjdGlvbkRpZ2l0czoyfSl9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1jaGFuZ2UgJHtwb3NpdGl2ZT8n",
  "cG9zJzonbmVnJ30gdGFidWxhciI+JHtjaGdTdHIoaWR4LmNoYW5nZSl9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1zcGFyayI+PC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gc2tlbGV0b25DYXJkcyhuKXsKICByZXR1cm4gQXJyYXkuZnJvbSh7bGVu",
  "Z3RoOm59KS5tYXAoKCk9PmA8ZGl2IGNsYXNzPSJnbGFzcyBza2VsLWNhcmQgc2tlbCI+PC9kaXY+YCkuam9pbigiIik7Cn0KZnVuY3Rpb24gc2tlbGV0b25MaW5lcyhuKXsKICByZXR1cm4gQXJyYXkuZnJvbSh7bGVuZ3RoOm59KS5tYXAoKCk9PmA8ZGl2IGNsYXNz",
  "PSJza2VsIHNrZWwtbGluZSIgc3R5bGU9IndpZHRoOiR7NjArTWF0aC5yYW5kb20oKSozNX0lIj48L2Rpdj5gKS5qb2luKCIiKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBTRUFSQ0ggLS0tLS0tLS0tLS0tLS0tLSAqLwpmdW5jdGlvbiBzZWFyY2hCbG9jaygpewog",
  "IHJldHVybiBgCiAgPGRpdiBjbGFzcz0ic2VhcmNoLXdyYXAiIHN0eWxlPSJtYXJnaW4tdG9wOjhweDsiPgogICAgPGRpdiBjbGFzcz0ic2VhcmNoLWJveCBnbGFzcyIgaWQ9InNlYXJjaEJveCI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJu",
  "b25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxjaXJjbGUgY3g9IjExIiBjeT0iMTEiIHI9IjciLz48cGF0aCBkPSJNMjEgMjFsLTQuMy00LjMiLz48L3N2Zz4KICAgICAgPGlucHV0IHR5cGU9",
  "InRleHQiIGlkPSJzZWFyY2hJbnB1dCIgcGxhY2Vob2xkZXI9IlNlYXJjaCBzdG9ja3MgYnkgbmFtZSBvciB0aWNrZXLigKYiIGF1dG9jb21wbGV0ZT0ib2ZmIj4KICAgICAgPGtiZCBjbGFzcz0ia3Nob3J0Y3V0Ij4vPC9rYmQ+CiAgICA8L2Rpdj4KICAgIDxkaXYg",
  "Y2xhc3M9InNlYXJjaC1kcm9wIGdsYXNzIiBpZD0ic2VhcmNoRHJvcCIgc3R5bGU9ImRpc3BsYXk6bm9uZTsiPjwvZGl2PgogIDwvZGl2PmA7Cn0KCmxldCBzZWFyY2hEZWJvdW5jZTsKZnVuY3Rpb24gd2lyZVNlYXJjaCgpewogIGNvbnN0IGlucHV0ID0gZG9jdW1l",
  "bnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaElucHV0Iik7CiAgY29uc3QgYm94ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaEJveCIpOwogIGNvbnN0IGRyb3AgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoRHJvcCIpOwogIGlmKCFpbnB1",
  "dCkgcmV0dXJuOwoKICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCJrZXlkb3duIiwgKGUpPT57CiAgICBpZihlLmtleSA9PT0gIi8iICYmIGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgIT09IGlucHV0KXsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBp",
  "bnB1dC5mb2N1cygpOwogICAgfQogICAgaWYoZS5rZXkgPT09ICJFc2NhcGUiKXsgaW5wdXQuYmx1cigpOyBkcm9wLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyBib3guY2xhc3NMaXN0LnJlbW92ZSgiZm9jdXNlZCIpOyB9CiAgfSk7CgogIGlucHV0LmFkZEV2ZW50TGlz",
  "dGVuZXIoImZvY3VzIiwgKCk9PiBib3guY2xhc3NMaXN0LmFkZCgiZm9jdXNlZCIpKTsKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCJibHVyIiwgKCk9PiBzZXRUaW1lb3V0KCgpPT57IGJveC5jbGFzc0xpc3QucmVtb3ZlKCJmb2N1c2VkIik7IGRyb3Auc3R5bGUu",
  "ZGlzcGxheT0ibm9uZSI7IH0sIDE2MCkpOwoKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsICgpPT57CiAgICBjbGVhclRpbWVvdXQoc2VhcmNoRGVib3VuY2UpOwogICAgY29uc3QgcSA9IGlucHV0LnZhbHVlOwogICAgaWYoIXEudHJpbSgpKXsgZHJv",
  "cC5zdHlsZS5kaXNwbGF5PSJub25lIjsgcmV0dXJuOyB9CiAgICBkcm9wLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjsKICAgIGRyb3AuaW5uZXJIVE1MID0gYDxkaXYgc3R5bGU9InBhZGRpbmc6MTRweCAxNnB4OyI+JHtza2VsZXRvbkxpbmVzKDMpfTwvZGl2PmA7CiAg",
  "ICBzZWFyY2hEZWJvdW5jZSA9IHNldFRpbWVvdXQoYXN5bmMgKCk9PnsKICAgICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IEFQSS5zZWFyY2hTdG9ja3MocSk7CiAgICAgIGlmKCFyZXN1bHRzLmxlbmd0aCl7CiAgICAgICAgZHJvcC5pbm5lckhUTUwgPSBgPGRpdiBj",
  "bGFzcz0ic2VhcmNoLWVtcHR5Ij5ObyBzdG9ja3MgbWF0Y2gg4oCcJHtlc2NhcGVIdG1sKHEpfeKAnTwvZGl2PmA7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGRyb3AuaW5uZXJIVE1MID0gcmVzdWx0cy5tYXAoKHMsaSk9PmAKICAgICAgICA8ZGl2IGNs",
  "YXNzPSJzZWFyY2gtcm93IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSoyOH1tcyIgZGF0YS10aWNrZXI9IiR7cy50fSI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJzci1sZWZ0Ij4KICAgICAgICAgICAgPGRpdiBjbGFzcz0ic3ItdGlja2VyIj4ke3MudC5zbGlj",
  "ZSgwLDMpfTwvZGl2PgogICAgICAgICAgICA8ZGl2PgogICAgICAgICAgICAgIDxkaXYgY2xhc3M9InNyLW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgICAgICAgIDxkaXYgY2xhc3M9InNyLW1ldGEiPiR7cy50fSDCtyAke3MuZXhjaH08",
  "L2Rpdj4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InNyLXByaWNlIHRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICBgKS5qb2luKCIiKTsKICAgICAgZHJv",
  "cC5xdWVyeVNlbGVjdG9yQWxsKCIuc2VhcmNoLXJvdyIpLmZvckVhY2gocm93PT57CiAgICAgICAgcm93LmFkZEV2ZW50TGlzdGVuZXIoIm1vdXNlZG93biIsICgpPT57CiAgICAgICAgICBuYXZpZ2F0ZSgiZGV0YWlsIiwgcm93LmRhdGFzZXQudGlja2VyKTsKICAg",
  "ICAgICB9KTsKICAgICAgfSk7CiAgICB9LCAyNjApOwogIH0pOwp9CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hUb2dnbGVCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50",
  "QnlJZCgic2VhcmNoSW5wdXQiKTsKICBpZihpbnB1dCkgaW5wdXQuZm9jdXMoKTsKICBlbHNlIG5hdmlnYXRlKCJkYXNoYm9hcmQiKTsKfSk7CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNIQVJFRCBUQUJMRSBSRU5ERVIgLS0tLS0tLS0tLS0tLS0tLSAqLwpmdW5jdGlv",
  "biByZW5kZXJUYWJsZUludG8od3JhcElkLCBjYXJkc0lkLCBsaXN0LCBzb3J0LCBzaG93U2VjdG9yQ29sKXsKICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQod3JhcElkKTsKICBjb25zdCBjYXJkcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlk",
  "KGNhcmRzSWQpOwogIGlmKCFsaXN0Lmxlbmd0aCl7CiAgICB3cmFwLmlubmVySFRNTCA9IGVtcHR5U3RhdGVIVE1MKCJObyBzdG9ja3MgbWF0Y2ggeW91ciBmaWx0ZXJzIiwgIlRyeSB3aWRlbmluZyB5b3VyIHByaWNlIHJhbmdlIG9yIGNsZWFyaW5nIGEgZmlsdGVy",
  "LiIpOwogICAgaWYoY2FyZHMpIGNhcmRzLmlubmVySFRNTCA9ICIiOwogICAgcmV0dXJuOwogIH0KICBjb25zdCBzb3J0ZWQgPSBzb3J0U3RvY2tzKGxpc3QsIHNvcnQpOwoKICB3cmFwLmlubmVySFRNTCA9IGAKICAgIDx0YWJsZSBjbGFzcz0ic3RvY2stdGFibGUi",
  "PgogICAgICA8dGhlYWQ+PHRyPgogICAgICAgIDx0aD48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0ibmFtZSI+Q29tcGFueTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJwcmljZSI+UHJpY2U8c3Bh",
  "biBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0iY2hhbmdlIj5DaGFuZ2U8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0icGN0Ij5DaGFuZ2UgJTxzcGFu",
  "IGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJtYXJrZXRDYXAiPk1hcmtldCBDYXA8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0idm9sdW1lIj5Wb2x1",
  "bWU8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0iaGlnaDUyIj41MlcgSGlnaDxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJsb3c1MiI+NTJX",
  "IExvdzxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgIDwvdHI+PC90aGVhZD4KICAgICAgPHRib2R5PgogICAgICAgICR7c29ydGVkLm1hcCgocyxpKT0+c3RvY2tSb3dIVE1MKHMsaSkpLmpvaW4oIiIpfQogICAgICA8L3Rib2R5Pgog",
  "ICAgPC90YWJsZT4KICBgOwogIHdyYXAucXVlcnlTZWxlY3RvckFsbCgidGhbZGF0YS1rZXldIikuZm9yRWFjaCh0aD0+ewogICAgdGguY2xhc3NMaXN0LnRvZ2dsZSgic29ydGVkIiwgdGguZGF0YXNldC5rZXk9PT1zb3J0LmtleSk7CiAgICBpZih0aC5kYXRhc2V0",
  "LmtleT09PXNvcnQua2V5KXsgY29uc3QgaW5kID0gdGgucXVlcnlTZWxlY3RvcigiLnNvcnQtaW5kIik7IGlmKGluZCkgaW5kLnRleHRDb250ZW50ID0gc29ydC5kaXI9PT0iZGVzYyI/IuKWviI6IuKWtCI7IH0KICAgIHRoLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNr",
  "IiwgKCk9PnsKICAgICAgY29uc3Qga2V5ID0gdGguZGF0YXNldC5rZXk7CiAgICAgIGNvbnN0IG5ld0RpciA9IChzb3J0LmtleT09PWtleSAmJiBzb3J0LmRpcj09PSJkZXNjIikgPyAiYXNjIiA6ICJkZXNjIjsKICAgICAgY29uc3QgbmV3U29ydCA9IHtrZXksIGRp",
  "cjpuZXdEaXJ9OwogICAgICBpZih3cmFwSWQ9PT0ic2NyZWVuZXJUYWJsZVdyYXAiKSBzdGF0ZS5zY3JlZW5lclNvcnQgPSBuZXdTb3J0OwogICAgICByZW5kZXJUYWJsZUludG8od3JhcElkLCBjYXJkc0lkLCBsaXN0LCBuZXdTb3J0LCBzaG93U2VjdG9yQ29sKTsK",
  "ICAgIH0pOwogIH0pOwogIHdpcmVSb3dJbnRlcmFjdGlvbnMod3JhcCk7CgogIGlmKGNhcmRzKXsKICAgIGNhcmRzLmlubmVySFRNTCA9IHNvcnRlZC5tYXAoKHMsaSk9PnN0b2NrQ2FyZEhUTUwocyxpKSkuam9pbigiIik7CiAgICB3aXJlUm93SW50ZXJhY3Rpb25z",
  "KGNhcmRzKTsKICB9Cn0KCmZ1bmN0aW9uIHNvcnRTdG9ja3MobGlzdCwgc29ydCl7CiAgcmV0dXJuIGxpc3Quc2xpY2UoKS5zb3J0KChhLGIpPT57CiAgICBsZXQgYXY9YVtzb3J0LmtleV0sIGJ2PWJbc29ydC5rZXldOwogICAgaWYoc29ydC5rZXk9PT0ibmFtZSIp",
  "eyBhdj1hLm5hbWU7IGJ2PWIubmFtZTsgcmV0dXJuIHNvcnQuZGlyPT09ImFzYyI/IGF2LmxvY2FsZUNvbXBhcmUoYnYpIDogYnYubG9jYWxlQ29tcGFyZShhdik7IH0KICAgIHJldHVybiBzb3J0LmRpcj09PSJhc2MiID8gYXYtYnYgOiBidi1hdjsKICB9KTsKfQoK",
  "ZnVuY3Rpb24gc3RvY2tSb3dIVE1MKHMsaSl7CiAgY29uc3QgcG9zID0gcy5wY3Q+PTA7CiAgY29uc3QgaW5XYXRjaCA9IHN0YXRlLndhdGNobGlzdC5pbmNsdWRlcyhzLnQpOwogIHJldHVybiBgCiAgPHRyIGRhdGEtdGlja2VyPSIke3MudH0iIHN0eWxlPSJhbmlt",
  "YXRpb24tZGVsYXk6JHtpKjIyfW1zIj4KICAgIDx0ZCBvbmNsaWNrPSJldmVudC5zdG9wUHJvcGFnYXRpb24oKSI+CiAgICAgIDxidXR0b24gY2xhc3M9InN0YXItYnRuICR7aW5XYXRjaD8nYWN0aXZlJzonJ30iIGRhdGEtc3Rhcj0iJHtzLnR9IiB0aXRsZT0iJHtp",
  "bldhdGNoPydSZW1vdmUgZnJvbSB3YXRjaGxpc3QnOidBZGQgdG8gd2F0Y2hsaXN0J30iPgogICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSIke2luV2F0Y2g/J2N1cnJlbnRDb2xvcic6J25vbmUnfSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0",
  "cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTEyIDE3LjNsLTYuMTYgMy42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIgMi40bDIuOTQgNi40IDcuMDYuNi01LjQ4IDQuNiAxLjY0IDYuOXoiLz48L3N2Zz4KICAgICAgPC9idXR0b24+CiAgICA8L3RkPgogICAgPHRk",
  "PgogICAgICA8ZGl2IGNsYXNzPSJjZWxsLWNvbXBhbnkiPgogICAgICAgIDxkaXYgY2xhc3M9ImNlbGwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgIDxkaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LW5hbWUiPiR7",
  "ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4k",
  "e2ZtdElOUihzLnByaWNlKX08L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj48c3BhbiBjbGFzcz0iY2hhbmdlLXBpbGwgJHtwb3M/J3Bvcyc6J25lZyd9Ij4ke2NoZ1N0cihzLmNoYW5nZSl9PC9zcGFuPjwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPjxz",
  "cGFuIGNsYXNzPSJjaGFuZ2UtcGlsbCAke3Bvcz8ncG9zJzonbmVnJ30iPiR7cGN0U3RyKHMucGN0KX08L3NwYW4+PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRDb21wYWN0KHMubWFya2V0Q2FwKX08L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFy",
  "Ij4ke2ZtdFZvbChzLnZvbHVtZSl9PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRJTlIocy5oaWdoNTIpfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10SU5SKHMubG93NTIpfTwvdGQ+CiAgPC90cj5gOwp9CgpmdW5jdGlvbiBzdG9j",
  "a0NhcmRIVE1MKHMsaSl7CiAgY29uc3QgcG9zID0gcy5wY3Q+PTA7CiAgY29uc3QgaW5XYXRjaCA9IHN0YXRlLndhdGNobGlzdC5pbmNsdWRlcyhzLnQpOwogIHJldHVybiBgCiAgPGRpdiBjbGFzcz0iZ2xhc3Mgc3RvY2stY2FyZCIgZGF0YS10aWNrZXI9IiR7cy50",
  "fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqMjZ9bXMiPgogICAgPGRpdiBjbGFzcz0ibGVmdCI+CiAgICAgIDxkaXYgY2xhc3M9ImNlbGwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJuYW1lLWJsb2Nr",
  "Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAg",
  "ICA8ZGl2IGNsYXNzPSJyaWdodCI+CiAgICAgIDxkaXYgY2xhc3M9InByaWNlIHRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgICA8c3BhbiBjbGFzcz0iY2hhbmdlLXBpbGwgJHtwb3M/J3Bvcyc6J25lZyd9IiBzdHlsZT0ibWFyZ2luLXRvcDo0",
  "cHg7Ij4ke3BjdFN0cihzLnBjdCl9PC9zcGFuPgogICAgPC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gd2lyZVJvd0ludGVyYWN0aW9ucyhjb250YWluZXIpewogIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCJ0cltkYXRhLXRpY2tlcl0sIC5zdG9jay1j",
  "YXJkW2RhdGEtdGlja2VyXSIpLmZvckVhY2goZWw9PnsKICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PiBuYXZpZ2F0ZSgiZGV0YWlsIiwgZWwuZGF0YXNldC50aWNrZXIpKTsKICB9KTsKICBjb250YWluZXIucXVlcnlTZWxlY3RvckFsbCgiW2Rh",
  "dGEtc3Rhcl0iKS5mb3JFYWNoKGJ0bj0+ewogICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7CiAgICAgIHRvZ2dsZVdhdGNoKGJ0bi5kYXRhc2V0LnN0YXIpOwogICAgICBidG4uY2xhc3NMaXN0",
  "LnRvZ2dsZSgiYWN0aXZlIik7CiAgICAgIGJ0bi5xdWVyeVNlbGVjdG9yKCJzdmciKS5zZXRBdHRyaWJ1dGUoImZpbGwiLCBidG4uY2xhc3NMaXN0LmNvbnRhaW5zKCJhY3RpdmUiKSA/ICJjdXJyZW50Q29sb3IiIDogIm5vbmUiKTsKICAgIH0pOwogIH0pOwp9Cgpm",
  "dW5jdGlvbiB0b2dnbGVXYXRjaCh0aWNrZXIpewogIGNvbnN0IGlkeCA9IHN0YXRlLndhdGNobGlzdC5pbmRleE9mKHRpY2tlcik7CiAgaWYoaWR4Pj0wKSBzdGF0ZS53YXRjaGxpc3Quc3BsaWNlKGlkeCwxKTsKICBlbHNlIHN0YXRlLndhdGNobGlzdC5wdXNoKHRp",
  "Y2tlcik7CiAgcGVyc2lzdFdhdGNobGlzdCgpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNDUkVFTkVSIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyU2NyZWVuZXIoKXsKICBjb25zdCBzZWN0b3JzID0gWyJBbGwiLCAuLi5BcnJheS5m",
  "cm9tKG5ldyBTZXQoVU5JVkVSU0UubWFwKHM9PnMuc2VjdG9yKSkpXTsKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5TY3JlZW5lcjwvaDI+PHNwYW4gY2xhc3M9InN1",
  "YiI+RmlsdGVyIHRoZSBtYXJrZXQgb24geW91ciB0ZXJtczwvc3Bhbj48L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGZpbHRlcnMtYmFyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCIgc3R5bGU9Im1pbi13aWR0aDoyMDBweDsiPgogICAg",
  "ICAgICAgPGxhYmVsPlNlYXJjaDwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImZRdWVyeSIgcGxhY2Vob2xkZXI9IlRpY2tlciBvciBjb21wYW554oCmIiB2YWx1ZT0iJHtlc2NhcGVIdG1sKHN0YXRlLnNjcmVlbmVyRmlsdGVycy5xdWVy",
  "eSl9Ij4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCI+CiAgICAgICAgICA8bGFiZWw+U2VjdG9yPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9ImZTZWN0b3IiPiR7c2VjdG9ycy5tYXAocz0+YDxvcHRpb24gJHtzdGF0",
  "ZS5zY3JlZW5lckZpbHRlcnMuc2VjdG9yPT09cz8nc2VsZWN0ZWQnOicnfT4ke3N9PC9vcHRpb24+YCkuam9pbigiIil9PC9zZWxlY3Q+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmlsdGVyLWNoaXAiPgogICAgICAgICAgPGxhYmVsPk1heCBQ",
  "cmljZSA8c3BhbiBjbGFzcz0icmFuZ2UtdmFsIiBpZD0iZlByaWNlVmFsIj4ke2ZtdElOUihzdGF0ZS5zY3JlZW5lckZpbHRlcnMubWF4UHJpY2UsMCl9PC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0icmFuZ2UiIGNsYXNzPSJyYW5nZS1zbGlk",
  "ZXIiIGlkPSJmTWF4UHJpY2UiIG1pbj0iNTAwIiBtYXg9IjE1MDAwIiBzdGVwPSIyNTAiIHZhbHVlPSIke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQcmljZX0iPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpbHRlci1jaGlwIiBzdHlsZT0i",
  "bWluLXdpZHRoOjE5MHB4OyI+CiAgICAgICAgICA8bGFiZWw+RGlyZWN0aW9uPC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1ncm91cCI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1idG4gJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMu",
  "ZGlyZWN0aW9uPT09J2FsbCc/J2FjdGl2ZSc6Jyd9IiBkYXRhLWRpcj0iYWxsIj5BbGw8L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0idG9nZ2xlLWJ0biAke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb249PT0nZ2FpbmVycyc/J2FjdGl2ZSc6Jyd9",
  "IiBkYXRhLWRpcj0iZ2FpbmVycyI+R2FpbmVyczwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJ0b2dnbGUtYnRuICR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLmRpcmVjdGlvbj09PSdsb3NlcnMnPydhY3RpdmUnOicnfSIgZGF0YS1kaXI9Imxvc2VycyI+TG9z",
  "ZXJzPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZXNldC1maWx0ZXJzIiBpZD0icmVzZXRGaWx0ZXJzIj5SZXNldCBmaWx0ZXJzPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic2Vj",
  "dGlvbi1oZWFkIj48aDIgaWQ9InNjcmVlbmVyQ291bnQiPlJlc3VsdHM8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPlNvcnRlZCBieSBtYXJrZXQgY2FwPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIGdsYXNzIiBpZD0ic2NyZWVuZXJUYWJs",
  "ZVdyYXAiPjxkaXYgc3R5bGU9InBhZGRpbmc6MjBweDsiPiR7c2tlbGV0b25MaW5lcyg4KX08L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RvY2stY2FyZHMiIGlkPSJzY3JlZW5lckNhcmRzIj48L2Rpdj4KICAgIDwvZGl2PgogIGA7CgogIGRvY3VtZW50",
  "LmdldEVsZW1lbnRCeUlkKCJmUXVlcnkiKS5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsIGRlYm91bmNlKGU9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5xdWVyeSA9IGUudGFyZ2V0LnZhbHVlOyBydW5TY3JlZW5lcigpOwogIH0sIDI2MCkpOwogIGRvY3Vt",
  "ZW50LmdldEVsZW1lbnRCeUlkKCJmU2VjdG9yIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwgZT0+ewogICAgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3RvciA9IGUudGFyZ2V0LnZhbHVlOyBydW5TY3JlZW5lcigpOwogIH0pOwogIGRvY3VtZW50LmdldEVs",
  "ZW1lbnRCeUlkKCJmTWF4UHJpY2UiKS5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsIGU9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQcmljZSA9IE51bWJlcihlLnRhcmdldC52YWx1ZSk7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZlByaWNl",
  "VmFsIikudGV4dENvbnRlbnQgPSBmbXRJTlIoc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLm1heFByaWNlLDApOwogICAgcnVuU2NyZWVuZXIoKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1kaXJdIikuZm9yRWFjaChidG49PnsKICAgIGJ0",
  "bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb24gPSBidG4uZGF0YXNldC5kaXI7CiAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWRpcl0iKS5mb3JFYWNoKGI9PmIu",
  "Y2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIiwgYj09PWJ0bikpOwogICAgICBydW5TY3JlZW5lcigpOwogICAgfSk7CiAgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInJlc2V0RmlsdGVycyIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAg",
  "IHN0YXRlLnNjcmVlbmVyRmlsdGVycyA9IHtxdWVyeToiIiwgc2VjdG9yOiJBbGwiLCBtaW5QcmljZTowLCBtYXhQcmljZToxNTAwMCwgZGlyZWN0aW9uOiJhbGwifTsKICAgIHJlbmRlclNjcmVlbmVyKCk7CiAgfSk7CgogIHJ1blNjcmVlbmVyKCk7Cn0KCmZ1bmN0",
  "aW9uIGRlYm91bmNlKGZuLCBtcyl7CiAgbGV0IGg7CiAgcmV0dXJuICguLi5hcmdzKT0+eyBjbGVhclRpbWVvdXQoaCk7IGg9c2V0VGltZW91dCgoKT0+Zm4oLi4uYXJncyksIG1zKTsgfTsKfQoKYXN5bmMgZnVuY3Rpb24gcnVuU2NyZWVuZXIoKXsKICBjb25zdCB3",
  "cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNjcmVlbmVyVGFibGVXcmFwIik7CiAgd3JhcC5zdHlsZS5vcGFjaXR5ID0gIjAuNTUiOwogIHRyeXsKICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJlc3VsdHMoc3RhdGUuc2Ny",
  "ZWVuZXJGaWx0ZXJzKTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzY3JlZW5lckNvdW50IikudGV4dENvbnRlbnQgPSBgUmVzdWx0cyAoJHtyZXN1bHRzLmxlbmd0aH0pYDsKICAgIHJlbmRlclRhYmxlSW50bygic2NyZWVuZXJUYWJsZVdyYXAiLCAic2Ny",
  "ZWVuZXJDYXJkcyIsIHJlc3VsdHMsIHN0YXRlLnNjcmVlbmVyU29ydCwgdHJ1ZSk7CiAgfWNhdGNoKGUpewogICAgd3JhcC5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiU2NyZWVuZXIgZGF0YSB1bmF2YWlsYWJsZSIsICJXZSBjb3VsZG4ndCBsb2FkIG1hdGNo",
  "aW5nIHN0b2NrcyByaWdodCBub3cuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgIHNob3dFcnJvckJhbm5lcigicnVuU2NyZWVuZXIgZmFpbGVkOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsKICB9CiAgd3JhcC5zdHlsZS5vcGFjaXR5",
  "ID0gIjEiOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIE1BUktFVFMgKGFsaWFzIG9mIGZ1bGwgdW5pdmVyc2UgdGFibGUpIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyTWFya2V0cygpewogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRp",
  "diBjbGFzcz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPk1hcmtldHM8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPkZ1bGwgTlNFIHVuaXZlcnNlIHNuYXBzaG90PC9zcGFuPjwvZGl2PgogICAgICAke3NlYXJjaEJsb2NrKCl9CiAgICAg",
  "IDxkaXYgY2xhc3M9InRhYmxlLXdyYXAgZ2xhc3MiIGlkPSJtYXJrZXRzVGFibGVXcmFwIj48ZGl2IHN0eWxlPSJwYWRkaW5nOjIwcHg7Ij4ke3NrZWxldG9uTGluZXMoMTApfTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdG9jay1jYXJkcyIgaWQ9Im1h",
  "cmtldHNDYXJkcyI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwogIHdpcmVTZWFyY2goKTsKICB0cnl7CiAgICBjb25zdCBsaXN0ID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHt9KTsKICAgIHJlbmRlclRhYmxlSW50bygibWFya2V0c1RhYmxlV3JhcCIs",
  "ICJtYXJrZXRzQ2FyZHMiLCBsaXN0LCB7a2V5OiJtYXJrZXRDYXAiLCBkaXI6ImRlc2MifSwgdHJ1ZSk7CiAgfWNhdGNoKGUpewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm1hcmtldHNUYWJsZVdyYXAiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgi",
  "TWFya2V0IGRhdGEgdGVtcG9yYXJpbHkgdW5hdmFpbGFibGUiLCAiUGxlYXNlIHRyeSBhZ2FpbiBpbiBhIG1vbWVudC4iKTsKICB9Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gV0FUQ0hMSVNUIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVy",
  "V2F0Y2hsaXN0KCl7CiAgcm9vdC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJ2aWV3Ij4KICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+V2F0Y2hsaXN0PC9oMj48c3BhbiBjbGFzcz0ic3ViIj4ke3N0YXRlLndhdGNobGlzdC5sZW5ndGh9",
  "IHN0b2NrJHtzdGF0ZS53YXRjaGxpc3QubGVuZ3RoPT09MT8nJzoncyd9IHRyYWNrZWQ8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9IndhdGNobGlzdC1ncmlkIiBpZD0id2F0Y2hHcmlkIj4ke3NrZWxldG9uQ2FyZHMoTWF0aC5tYXgoc3RhdGUud2F0Y2hs",
  "aXN0Lmxlbmd0aCwzKSl9PC9kaXY+CiAgICA8L2Rpdj4KICBgOwogIGlmKCFzdGF0ZS53YXRjaGxpc3QubGVuZ3RoKXsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ3YXRjaEdyaWQiKS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0id2F0Y2gtZW1wdHkgZ2xh",
  "c3MiPiR7ZW1wdHlTdGF0ZUlubmVyKCJZb3VyIHdhdGNobGlzdCBpcyBlbXB0eSIsICJTdGFyIGFueSBzdG9jayBmcm9tIHRoZSBkYXNoYm9hcmQsIHNjcmVlbmVyIG9yIG1hcmtldHMgdmlldyB0byB0cmFjayBpdCBoZXJlLiIpfTwvZGl2PmA7CiAgICByZXR1cm47",
  "CiAgfQogIHRyeXsKICAgIGNvbnN0IHN0b2NrcyA9IGF3YWl0IFByb21pc2UuYWxsKHN0YXRlLndhdGNobGlzdC5tYXAodD0+QVBJLmZldGNoU3RvY2sodCkpKTsKICAgIGNvbnN0IGdyaWQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgid2F0Y2hHcmlkIik7CiAg",
  "ICBncmlkLmlubmVySFRNTCA9IHN0b2Nrcy5maWx0ZXIoQm9vbGVhbikubWFwKChzLGkpPT53YXRjaENhcmRIVE1MKHMsaSkpLmpvaW4oIiIpOwogICAgd2lyZVdhdGNoQ2FyZHMoKTsKICB9Y2F0Y2goZSl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgid2F0",
  "Y2hHcmlkIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIlVuYWJsZSB0byBsb2FkIHdhdGNobGlzdCIsICJQbGVhc2UgdHJ5IGFnYWluLiIpOwogIH0KfQoKZnVuY3Rpb24gd2F0Y2hDYXJkSFRNTChzLGkpewogIGNvbnN0IHBvcyA9IHMucGN0Pj0wOwogIHJl",
  "dHVybiBgCiAgPGRpdiBjbGFzcz0iZ2xhc3Mgd2F0Y2gtY2FyZCBlbnRlcmluZyIgZGF0YS10aWNrZXI9IiR7cy50fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqNDB9bXMiPgogICAgPGRpdiBjbGFzcz0id2F0Y2gtdG9wIj4KICAgICAgPGRpdj4KICAgICAg",
  "ICA8ZGl2IGNsYXNzPSJjb21wYW55LW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJz",
  "dGFyLWJ0biBhY3RpdmUiIGRhdGEtdW5zdGFyPSIke3MudH0iIHRpdGxlPSJSZW1vdmUiPgogICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJjdXJyZW50Q29sb3IiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRo",
  "IGQ9Ik0xMiAxNy4zbC02LjE2IDMuNiAxLjY0LTYuOUwyIDkuNGw3LjA2LS42TDEyIDIuNGwyLjk0IDYuNCA3LjA2LjYtNS40OCA0LjYgMS42NCA2Ljl6Ii8+PC9zdmc+CiAgICAgIDwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC12YWx1",
  "ZSB0YWJ1bGFyIiBzdHlsZT0iZm9udC1zaXplOjIycHg7Ij4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LWNoYW5nZSAke3Bvcz8ncG9zJzonbmVnJ30gdGFidWxhciI+JHtjaGdTdHIocy5jaGFuZ2UpfSAoJHtwY3RTdHIocy5w",
  "Y3QpfSk8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LXNwYXJrIj4ke3NwYXJrbGluZVNWRyhzLnNlcmllcywgcG9zKX08L2Rpdj4KICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiB3aXJlV2F0Y2hDYXJkcygpewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi53",
  "YXRjaC1jYXJkIikuZm9yRWFjaChjYXJkPT57CiAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICAgIGlmKGUudGFyZ2V0LmNsb3Nlc3QoIltkYXRhLXVuc3Rhcl0iKSkgcmV0dXJuOwogICAgICBuYXZpZ2F0ZSgiZGV0YWlsIiwgY2Fy",
  "ZC5kYXRhc2V0LnRpY2tlcik7CiAgICB9KTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS11bnN0YXJdIikuZm9yRWFjaChidG49PnsKICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIChlKT0+ewogICAgICBlLnN0b3BQcm9w",
  "YWdhdGlvbigpOwogICAgICBjb25zdCBjYXJkID0gYnRuLmNsb3Nlc3QoIi53YXRjaC1jYXJkIik7CiAgICAgIGNhcmQuY2xhc3NMaXN0LmFkZCgicmVtb3ZpbmciKTsKICAgICAgdG9nZ2xlV2F0Y2goYnRuLmRhdGFzZXQudW5zdGFyKTsKICAgICAgc2V0VGltZW91",
  "dCgoKT0+ewogICAgICAgIGlmKCFzdGF0ZS53YXRjaGxpc3QubGVuZ3RoKSByZW5kZXJXYXRjaGxpc3QoKTsKICAgICAgICBlbHNlIGNhcmQucmVtb3ZlKCk7CiAgICAgICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvcigiLnNlY3Rpb24taGVhZCAuc3ViIikudGV4dENv",
  "bnRlbnQgPSBgJHtzdGF0ZS53YXRjaGxpc3QubGVuZ3RofSBzdG9jayR7c3RhdGUud2F0Y2hsaXN0Lmxlbmd0aD09PTE/Jyc6J3MnfSB0cmFja2VkYDsKICAgICAgfSwgMjgwKTsKICAgIH0pOwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNUT0NLIERFVEFJ",
  "TCAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlckRldGFpbCgpewogIHJvb3QuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InZpZXciIGlkPSJkZXRhaWxTa2VsZXRvbiI+CiAgICA8ZGl2IGNsYXNzPSJnbGFzcyBza2VsLWNhcmQgc2tlbCIg",
  "c3R5bGU9ImhlaWdodDo4OHB4O21hcmdpbi1ib3R0b206MjRweDsiPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ibWV0cmljcy1ncmlkIj4ke3NrZWxldG9uQ2FyZHMoNil9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJnbGFzcyBza2VsLWNhcmQgc2tlbCIgc3R5bGU9Imhl",
  "aWdodDozMjBweDsiPjwvZGl2PgogIDwvZGl2PmA7CgogIGxldCBzOwogIHRyeXsgcyA9IGF3YWl0IEFQSS5mZXRjaFN0b2NrKHN0YXRlLmRldGFpbFRpY2tlcik7IH1jYXRjaChlKXsgcyA9IG51bGw7IH0KICBpZighcyl7CiAgICByb290LmlubmVySFRNTCA9IGVy",
  "cm9yU3RhdGVIVE1MKCJVbmFibGUgdG8gcmV0cmlldmUgdGhpcyBzdG9jayIsICJUaGUgdGlja2VyIHlvdSdyZSBsb29raW5nIGZvciBpc24ndCBhdmFpbGFibGUgcmlnaHQgbm93LiIpOwogICAgcmV0dXJuOwogIH0KICBjb25zdCBwb3MgPSBzLnBjdCA+PSAwOwog",
  "IGNvbnN0IGluV2F0Y2ggPSBzdGF0ZS53YXRjaGxpc3QuaW5jbHVkZXMocy50KTsKCiAgcm9vdC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJ2aWV3Ij4KICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLWhlYWQiPgogICAgICAgIDxkaXYgY2xhc3M9ImRldGFp",
  "bC10aXRsZS1yb3ciPgogICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXRpY2tlci1iYWRnZSI+JHtzLnQuc2xpY2UoMCwzKX08L2Rpdj4KICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1uYW1lIj4ke2VzY2FwZUh0bWwocy5u",
  "YW1lKX08L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXN1YiI+JHtzLnR9IMK3ICR7cy5leGNofSDCtyAke3Muc2VjdG9yfTwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBzdHlsZT0iZGlzcGxheTpm",
  "bGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTRweDsiPgogICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXByaWNlLWJsb2NrIj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXByaWNlIHRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2Pgog",
  "ICAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtY2hhbmdlICR7cG9zPydwb3MnOiduZWcnfSB0YWJ1bGFyIj4ke2NoZ1N0cihzLmNoYW5nZSl9ICgke3BjdFN0cihzLnBjdCl9KSB0b2RheTwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8YnV0dG9u",
  "IGNsYXNzPSJpY29uLWJ0biIgaWQ9ImRldGFpbFN0YXIiIHN0eWxlPSJ3aWR0aDo0NHB4O2hlaWdodDo0NHB4O2NvbG9yOiR7aW5XYXRjaD8nI0ZGQzg1Nyc6J3ZhcigtLXRleHQtbWlkKSd9Ij4KICAgICAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZp",
  "bGw9IiR7aW5XYXRjaD8nY3VycmVudENvbG9yJzonbm9uZSd9IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHlsZT0id2lkdGg6MTlweDtoZWlnaHQ6MTlweDsiPjxwYXRoIGQ9Ik0xMiAxNy4zbC02LjE2IDMuNiAxLjY0LTYuOUwyIDku",
  "NGw3LjA2LS42TDEyIDIuNGwyLjk0IDYuNCA3LjA2LjYtNS40OCA0LjYgMS42NCA2Ljl6Ii8+PC9zdmc+CiAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJtZXRyaWNzLWdyaWQiPgogICAgICAg",
  "ICR7bWV0cmljQ2FyZCgiT3BlbiIsIGZtdElOUihzLm9wZW4pKX0KICAgICAgICAke21ldHJpY0NhcmQoIkRheSBIaWdoIiwgZm10SU5SKHMuZGF5SGlnaCkpfQogICAgICAgICR7bWV0cmljQ2FyZCgiRGF5IExvdyIsIGZtdElOUihzLmRheUxvdykpfQogICAgICAg",
  "ICR7bWV0cmljQ2FyZCgiTWFya2V0IENhcCIsIGZtdENvbXBhY3Qocy5tYXJrZXRDYXApKX0KICAgICAgICAke21ldHJpY0NhcmQoIlZvbHVtZSIsIGZtdFZvbChzLnZvbHVtZSkpfQogICAgICAgICR7bWV0cmljQ2FyZCgiNTJXIEhpZ2ggLyBMb3ciLCBmbXRJTlIo",
  "cy5oaWdoNTIsMCkrIiAvICIrZm10SU5SKHMubG93NTIsMCkpfQogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGNoYXJ0LWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LWhlYWQiPgogICAgICAgICAgPGRpdiBjbGFzcz0ic2VjdGlv",
  "bi1oZWFkIiBzdHlsZT0ibWFyZ2luOjA7Ij48aDI+UHJpY2UgQ2hhcnQ8L2gyPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0icmFuZ2UtdGFicyIgaWQ9InJhbmdlVGFicyI+CiAgICAgICAgICAgICR7WyIxRCIsIjFXIiwiMU0iLCIzTSIsIjZNIiwiMVkiXS5t",
  "YXAocj0+YDxidXR0b24gZGF0YS1yYW5nZT0iJHtyfSIgY2xhc3M9IiR7c3RhdGUuZGV0YWlsUmFuZ2U9PT1yPydhY3RpdmUnOicnfSI+JHtyfTwvYnV0dG9uPmApLmpvaW4oIiIpfQogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBj",
  "bGFzcz0iY2hhcnQtY2FudmFzLXdyYXAiIGlkPSJjaGFydFdyYXAiPgogICAgICAgICAgPGNhbnZhcyBpZD0icHJpY2VDaGFydCI+PC9jYW52YXM+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC10b29sdGlwIiBpZD0iY2hhcnRUb29sdGlwIj48L2Rpdj4KICAg",
  "ICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ2b2x1bWUtd3JhcCIgaWQ9InZvbHVtZVdyYXAiPgogICAgICAgICAgPGRpdiBjbGFzcz0idm9sdW1lLWxhYmVsIj5Wb2x1bWUgPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQtZmFpbnQpO2ZvbnQtd2Vp",
  "Z2h0OjYwMDsiPihyZWxhdGl2ZSwgZGVyaXZlZCBmcm9tIHByaWNlIG1vdmVtZW50KTwvc3Bhbj48L2Rpdj4KICAgICAgICAgIDxjYW52YXMgaWQ9InZvbHVtZUNoYXJ0Ij48L2NhbnZhcz4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICBg",
  "OwoKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZGV0YWlsU3RhciIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgIHRvZ2dsZVdhdGNoKHMudCk7CiAgICByZW5kZXJEZXRhaWwoKTsKICB9KTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgi",
  "cmFuZ2VUYWJzIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgIGNvbnN0IGJ0biA9IGUudGFyZ2V0LmNsb3Nlc3QoImJ1dHRvbltkYXRhLXJhbmdlXSIpOwogICAgaWYoIWJ0bikgcmV0dXJuOwogICAgc3RhdGUuZGV0YWlsUmFuZ2UgPSBidG4u",
  "ZGF0YXNldC5yYW5nZTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIiNyYW5nZVRhYnMgYnV0dG9uIikuZm9yRWFjaChiPT5iLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsIGI9PT1idG4pKTsKICAgIGxvYWRDaGFydChzLnQsIHMucGN0Pj0wKTsKICB9",
  "KTsKCiAgbG9hZENoYXJ0KHMudCwgcG9zKTsKfQoKZnVuY3Rpb24gbWV0cmljQ2FyZChsYWJlbCwgdmFsdWUpewogIHJldHVybiBgPGRpdiBjbGFzcz0iZ2xhc3MgbWV0cmljLWNhcmQiPjxkaXYgY2xhc3M9Im1ldHJpYy1sYWJlbCI+JHtsYWJlbH08L2Rpdj48ZGl2",
  "IGNsYXNzPSJtZXRyaWMtdmFsdWUgdGFidWxhciI+JHt2YWx1ZX08L2Rpdj48L2Rpdj5gOwp9Cgphc3luYyBmdW5jdGlvbiBsb2FkQ2hhcnQodGlja2VyLCBwb3NpdGl2ZSl7CiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJjaGFydFdyYXAi",
  "KTsKICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgicHJpY2VDaGFydCIpOwogIGlmKCF3cmFwIHx8ICFjYW52YXMpIHJldHVybjsKICBjYW52YXMuc3R5bGUub3BhY2l0eSA9ICIwLjI1IjsKICBsZXQgc2VyaWVzOwogIHRyeXsKICAgIHNl",
  "cmllcyA9IGF3YWl0IEFQSS5mZXRjaFN0b2NrSGlzdG9yeSh0aWNrZXIsIHN0YXRlLmRldGFpbFJhbmdlKTsKICB9Y2F0Y2goZSl7CiAgICB3cmFwLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJDaGFydCBkYXRhIHVuYXZhaWxhYmxlIiwgIlRoaXMgdGltZWZy",
  "YW1lIGNvdWxkbid0IGJlIGxvYWRlZC4gVHJ5IGEgZGlmZmVyZW50IHJhbmdlLiIpOwogICAgcmV0dXJuOwogIH0KICBjYW52YXMuc3R5bGUub3BhY2l0eSA9ICIxIjsKICBkcmF3Q2hhcnQoY2FudmFzLCBzZXJpZXMsIHBvc2l0aXZlLCB0aWNrZXIpOwogIGRyYXdW",
  "b2x1bWVDaGFydChzZXJpZXMsIHBvc2l0aXZlKTsKfQoKZnVuY3Rpb24gZHJhd1ZvbHVtZUNoYXJ0KHNlcmllcywgcG9zaXRpdmUpewogIGNvbnN0IGNhbnZhcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ2b2x1bWVDaGFydCIpOwogIGlmKCFjYW52YXMpIHJl",
  "dHVybjsKICBjb25zdCByZWN0ID0gY2FudmFzLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogIGNvbnN0IGRwciA9IHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvIHx8IDE7CiAgY2FudmFzLndpZHRoID0gcmVjdC53aWR0aCAqIGRwcjsKICBjYW52YXMuaGVpZ2h0ID0g",
  "cmVjdC5oZWlnaHQgKiBkcHI7CiAgY29uc3QgY3R4ID0gY2FudmFzLmdldENvbnRleHQoIjJkIik7CiAgY3R4LnNjYWxlKGRwcixkcHIpOwogIGNvbnN0IFcgPSByZWN0LndpZHRoLCBIID0gcmVjdC5oZWlnaHQ7CiAgY3R4LmNsZWFyUmVjdCgwLDAsVyxIKTsKCiAg",
  "Ly8gRGVyaXZlIGEgcGxhdXNpYmxlIHJlbGF0aXZlIHZvbHVtZSBwcm9maWxlIGZyb20gdGhlIHByaWNlIHNlcmllcycKICAvLyBwb2ludC10by1wb2ludCB2b2xhdGlsaXR5IChiaWdnZXIgbW92ZXMgdGVuZCB0byBjb2luY2lkZSB3aXRoIGhpZ2hlcgogIC8vIHZv",
  "bHVtZSkg4oCUIGlsbHVzdHJhdGl2ZSBvbmx5OyB0aGUgYmFja2VuZCBoYXMgbm8gaGlzdG9yaWNhbCB2b2x1bWUgZmVlZC4KICBjb25zdCBkZWx0YXMgPSBzZXJpZXMubWFwKCh2LGkpPT4gaT09PTAgPyAwIDogTWF0aC5hYnModi1zZXJpZXNbaS0xXSkpOwogIGNv",
  "bnN0IG1heEQgPSBNYXRoLm1heCguLi5kZWx0YXMsIDFlLTYpOwogIGNvbnN0IGJhclcgPSBXL3Nlcmllcy5sZW5ndGg7CiAgY29uc3QgY29sb3IgPSBwb3NpdGl2ZSA/ICIjMzNENkE2IiA6ICIjRkI2QjZCIjsKICBzZXJpZXMuZm9yRWFjaCgodixpKT0+ewogICAg",
  "Y29uc3Qgc2VlZCA9IHRpY2tlclNlZWQoc3RhdGUuZGV0YWlsVGlja2VyKStpKjc7CiAgICBjb25zdCBoID0gTWF0aC5tYXgoMywgKGRlbHRhc1tpXS9tYXhEKSAqIEggKiAwLjg1ICogKDAuNTUgKyBzZWVkZWRSYW5kKHNlZWQpKjAuNikpOwogICAgY29uc3QgdXAg",
  "PSBpPT09MCA/IHRydWUgOiBzZXJpZXNbaV0gPj0gc2VyaWVzW2ktMV07CiAgICBjdHguZmlsbFN0eWxlID0gdXAgPyAicmdiYSg1MSwyMTQsMTY2LDAuNTUpIiA6ICJyZ2JhKDI1MSwxMDcsMTA3LDAuNTUpIjsKICAgIGN0eC5maWxsUmVjdChpKmJhclcrYmFyVyow",
  "LjE1LCBILWgsIE1hdGgubWF4KDEsYmFyVyowLjcpLCBoKTsKICB9KTsKfQoKZnVuY3Rpb24gZHJhd0NoYXJ0KGNhbnZhcywgc2VyaWVzLCBwb3NpdGl2ZSwgdGlja2VyKXsKICBjb25zdCB3cmFwID0gY2FudmFzLnBhcmVudEVsZW1lbnQ7CiAgY29uc3QgZHByID0g",
  "d2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMTsKICBjb25zdCByZWN0ID0gd3JhcC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICBjYW52YXMud2lkdGggPSByZWN0LndpZHRoICogZHByOwogIGNhbnZhcy5oZWlnaHQgPSByZWN0LmhlaWdodCAqIGRwcjsKICBj",
  "YW52YXMuc3R5bGUud2lkdGggPSByZWN0LndpZHRoKyJweCI7CiAgY2FudmFzLnN0eWxlLmhlaWdodCA9IHJlY3QuaGVpZ2h0KyJweCI7CiAgY29uc3QgY3R4ID0gY2FudmFzLmdldENvbnRleHQoIjJkIik7CiAgY3R4LnNjYWxlKGRwcixkcHIpOwoKICBjb25zdCBX",
  "ID0gcmVjdC53aWR0aCwgSCA9IHJlY3QuaGVpZ2h0OwogIGNvbnN0IHBhZCA9IHt0b3A6MTYsIHJpZ2h0OjgsIGJvdHRvbToyNCwgbGVmdDo4fTsKICBjb25zdCBtaW4gPSBNYXRoLm1pbiguLi5zZXJpZXMpLCBtYXggPSBNYXRoLm1heCguLi5zZXJpZXMpOwogIGNv",
  "bnN0IHJhbmdlViA9IChtYXgtbWluKSB8fCAxOwogIGNvbnN0IGlubmVyVyA9IFcgLSBwYWQubGVmdCAtIHBhZC5yaWdodDsKICBjb25zdCBpbm5lckggPSBIIC0gcGFkLnRvcCAtIHBhZC5ib3R0b207CiAgY29uc3Qgc3RlcCA9IGlubmVyVy8oc2VyaWVzLmxlbmd0",
  "aC0xKTsKCiAgZnVuY3Rpb24geHkoaSx2KXsKICAgIHJldHVybiBbcGFkLmxlZnQgKyBpKnN0ZXAsIHBhZC50b3AgKyBpbm5lckggLSAoKHYtbWluKS9yYW5nZVYpKmlubmVySF07CiAgfQogIGNvbnN0IHB0cyA9IHNlcmllcy5tYXAoKHYsaSk9Pnh5KGksdikpOwoK",
  "ICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwoKICAvLyBncmlkbGluZXMKICBjdHguc3Ryb2tlU3R5bGUgPSAicmdiYSgxNTgsMTcxLDIxNCwwLjA4KSI7CiAgY3R4LmxpbmVXaWR0aCA9IDE7CiAgZm9yKGxldCBpPTA7aTw9MztpKyspewogICAgY29uc3QgeSA9IHBh",
  "ZC50b3AgKyAoaW5uZXJILzMpKmk7CiAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8ocGFkLmxlZnQseSk7IGN0eC5saW5lVG8oVy1wYWQucmlnaHQseSk7IGN0eC5zdHJva2UoKTsKICB9CgogIGNvbnN0IGNvbG9yID0gcG9zaXRpdmUgPyAiIzMzRDZBNiIg",
  "OiAiI0ZCNkI2QiI7CgogIC8vIHNtb290aCBwYXRoCiAgZnVuY3Rpb24gc21vb3RoUGF0aChwb2ludHMpewogICAgaWYocG9pbnRzLmxlbmd0aDwzKSByZXR1cm4gYE0ke3BvaW50c1swXVswXX0sJHtwb2ludHNbMF1bMV19IEwke3BvaW50c1sxXVswXX0sJHtwb2lu",
  "dHNbMV1bMV19YDsKICAgIGxldCBkID0gYE0ke3BvaW50c1swXVswXX0sJHtwb2ludHNbMF1bMV19YDsKICAgIGZvcihsZXQgaT0wO2k8cG9pbnRzLmxlbmd0aC0xO2krKyl7CiAgICAgIGNvbnN0IHAwID0gcG9pbnRzW2k9PT0wPzA6aS0xXTsKICAgICAgY29uc3Qg",
  "cDEgPSBwb2ludHNbaV07CiAgICAgIGNvbnN0IHAyID0gcG9pbnRzW2krMV07CiAgICAgIGNvbnN0IHAzID0gcG9pbnRzW2krMjxwb2ludHMubGVuZ3RoP2krMjppKzFdOwogICAgICBjb25zdCBjcDF4ID0gcDFbMF0gKyAocDJbMF0tcDBbMF0pLzY7CiAgICAgIGNv",
  "bnN0IGNwMXkgPSBwMVsxXSArIChwMlsxXS1wMFsxXSkvNjsKICAgICAgY29uc3QgY3AyeCA9IHAyWzBdIC0gKHAzWzBdLXAxWzBdKS82OwogICAgICBjb25zdCBjcDJ5ID0gcDJbMV0gLSAocDNbMV0tcDFbMV0pLzY7CiAgICAgIGQgKz0gYCBDJHtjcDF4fSwke2Nw",
  "MXl9ICR7Y3AyeH0sJHtjcDJ5fSAke3AyWzBdfSwke3AyWzFdfWA7CiAgICB9CiAgICByZXR1cm4gZDsKICB9CiAgY29uc3QgbGluZVBhdGggPSBuZXcgUGF0aDJEKHNtb290aFBhdGgocHRzKSk7CgogIC8vIGFyZWEgZmlsbAogIGNvbnN0IGdyYWQgPSBjdHguY3Jl",
  "YXRlTGluZWFyR3JhZGllbnQoMCxwYWQudG9wLDAscGFkLnRvcCtpbm5lckgpOwogIGdyYWQuYWRkQ29sb3JTdG9wKDAsIGNvbG9yKyI1NSIpOwogIGdyYWQuYWRkQ29sb3JTdG9wKDEsIGNvbG9yKyIwMiIpOwogIGN0eC5zYXZlKCk7CiAgY29uc3QgYXJlYVBhdGgg",
  "PSBuZXcgUGF0aDJEKHNtb290aFBhdGgocHRzKSk7CiAgYXJlYVBhdGgubGluZVRvKHB0c1twdHMubGVuZ3RoLTFdWzBdLCBwYWQudG9wK2lubmVySCk7CiAgYXJlYVBhdGgubGluZVRvKHB0c1swXVswXSwgcGFkLnRvcCtpbm5lckgpOwogIGFyZWFQYXRoLmNsb3Nl",
  "UGF0aCgpOwogIGN0eC5maWxsU3R5bGUgPSBncmFkOwogIGN0eC5maWxsKGFyZWFQYXRoKTsKICBjdHgucmVzdG9yZSgpOwoKICAvLyBsaW5lCiAgY3R4LnN0cm9rZVN0eWxlID0gY29sb3I7CiAgY3R4LmxpbmVXaWR0aCA9IDI7CiAgY3R4LmxpbmVKb2luID0gInJv",
  "dW5kIjsKICBjdHgubGluZUNhcCA9ICJyb3VuZCI7CiAgY3R4LnN0cm9rZShsaW5lUGF0aCk7CgogIC8vIGVudHJhbmNlIGFuaW1hdGlvbiB2aWEgY2xpcCByZXZlYWwKICBjYW52YXMuX2NoYXJ0TWV0YSA9IHtwdHMsIHNlcmllcywgVywgSCwgcGFkLCBjb2xvcn07",
  "CgogIC8vIGNyb3NzaGFpciBpbnRlcmFjdGl2aXR5CiAgY29uc3QgdG9vbHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJjaGFydFRvb2x0aXAiKTsKICBjYW52YXMub25tb3VzZW1vdmUgPSAoZSk9PnsKICAgIGNvbnN0IHIgPSBjYW52YXMuZ2V0Qm91bmRp",
  "bmdDbGllbnRSZWN0KCk7CiAgICBjb25zdCBteCA9IGUuY2xpZW50WCAtIHIubGVmdDsKICAgIGxldCBpZHggPSBNYXRoLnJvdW5kKChteC1wYWQubGVmdCkvc3RlcCk7CiAgICBpZHggPSBNYXRoLm1heCgwLCBNYXRoLm1pbihzZXJpZXMubGVuZ3RoLTEsIGlkeCkp",
  "OwogICAgY29uc3QgW3B4LHB5XSA9IHB0c1tpZHhdOwoKICAgIHJlZHJhd1dpdGhDcm9zc2hhaXIoY3R4LCBjYW52YXMuX2NoYXJ0TWV0YSwgcHgsIHB5KTsKCiAgICB0b29sdGlwLnN0eWxlLm9wYWNpdHkgPSAiMSI7CiAgICB0b29sdGlwLnN0eWxlLmxlZnQgPSBw",
  "eCsicHgiOwogICAgdG9vbHRpcC5zdHlsZS50b3AgPSBweSsicHgiOwogICAgdG9vbHRpcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0idHQtcHJpY2UiPiR7Zm10SU5SKHNlcmllc1tpZHhdKX08L2Rpdj48ZGl2IGNsYXNzPSJ0dC1kYXRlIj5Qb2ludCAke2lkeCsx",
  "fSBvZiAke3Nlcmllcy5sZW5ndGh9PC9kaXY+YDsKICB9OwogIGNhbnZhcy5vbm1vdXNlbGVhdmUgPSAoKT0+ewogICAgdG9vbHRpcC5zdHlsZS5vcGFjaXR5ID0gIjAiOwogICAgY3R4LmNsZWFyUmVjdCgwLDAsVyxIKTsKICAgIHJlZHJhdyhjdHgsIGNhbnZhcy5f",
  "Y2hhcnRNZXRhKTsKICB9OwoKICBmdW5jdGlvbiByZWRyYXcoY3R4LCBtZXRhKXsKICAgIGNvbnN0IHtwdHMsIFcsIEgsIHBhZCwgY29sb3J9ID0gbWV0YTsKICAgIGN0eC5jbGVhclJlY3QoMCwwLFcsSCk7CiAgICBjdHguc3Ryb2tlU3R5bGUgPSAicmdiYSgxNTgs",
  "MTcxLDIxNCwwLjA4KSI7CiAgICBjdHgubGluZVdpZHRoID0gMTsKICAgIGNvbnN0IGlubmVySDIgPSBILXBhZC50b3AtcGFkLmJvdHRvbTsKICAgIGZvcihsZXQgaT0wO2k8PTM7aSsrKXsKICAgICAgY29uc3QgeSA9IHBhZC50b3AgKyAoaW5uZXJIMi8zKSppOwog",
  "ICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8ocGFkLmxlZnQseSk7IGN0eC5saW5lVG8oVy1wYWQucmlnaHQseSk7IGN0eC5zdHJva2UoKTsKICAgIH0KICAgIGNvbnN0IGdyYWQyID0gY3R4LmNyZWF0ZUxpbmVhckdyYWRpZW50KDAscGFkLnRvcCwwLHBh",
  "ZC50b3AraW5uZXJIMik7CiAgICBncmFkMi5hZGRDb2xvclN0b3AoMCwgY29sb3IrIjU1Iik7IGdyYWQyLmFkZENvbG9yU3RvcCgxLCBjb2xvcisiMDIiKTsKICAgIGNvbnN0IGFyZWFQYXRoMiA9IG5ldyBQYXRoMkQoc21vb3RoUGF0aChwdHMpKTsKICAgIGFyZWFQ",
  "YXRoMi5saW5lVG8ocHRzW3B0cy5sZW5ndGgtMV1bMF0sIHBhZC50b3AraW5uZXJIMik7CiAgICBhcmVhUGF0aDIubGluZVRvKHB0c1swXVswXSwgcGFkLnRvcCtpbm5lckgyKTsKICAgIGFyZWFQYXRoMi5jbG9zZVBhdGgoKTsKICAgIGN0eC5maWxsU3R5bGUgPSBn",
  "cmFkMjsgY3R4LmZpbGwoYXJlYVBhdGgyKTsKICAgIGN0eC5zdHJva2VTdHlsZSA9IGNvbG9yOyBjdHgubGluZVdpZHRoID0gMjsgY3R4LmxpbmVKb2luPSJyb3VuZCI7IGN0eC5saW5lQ2FwPSJyb3VuZCI7CiAgICBjdHguc3Ryb2tlKG5ldyBQYXRoMkQoc21vb3Ro",
  "UGF0aChwdHMpKSk7CiAgfQogIGZ1bmN0aW9uIHJlZHJhd1dpdGhDcm9zc2hhaXIoY3R4LCBtZXRhLCBweCwgcHkpewogICAgcmVkcmF3KGN0eCwgbWV0YSk7CiAgICBjb25zdCB7SCwgcGFkLCBjb2xvcn0gPSBtZXRhOwogICAgY3R4LnNhdmUoKTsKICAgIGN0eC5z",
  "dHJva2VTdHlsZSA9ICJyZ2JhKDE1OCwxNzEsMjE0LDAuMzUpIjsKICAgIGN0eC5saW5lV2lkdGggPSAxOwogICAgY3R4LnNldExpbmVEYXNoKFszLDNdKTsKICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbyhweCwgcGFkLnRvcCk7IGN0eC5saW5lVG8ocHgs",
  "IEgtcGFkLmJvdHRvbSk7IGN0eC5zdHJva2UoKTsKICAgIGN0eC5zZXRMaW5lRGFzaChbXSk7CiAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmMocHgscHksNCwwLE1hdGguUEkqMik7CiAgICBjdHguZmlsbFN0eWxlID0gY29sb3I7IGN0eC5maWxsKCk7CiAgICBj",
  "dHguc3Ryb2tlU3R5bGUgPSAiIzA1MDYwQiI7IGN0eC5saW5lV2lkdGg9MjsgY3R4LnN0cm9rZSgpOwogICAgY3R4LnJlc3RvcmUoKTsKICB9Cn0KCndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJyZXNpemUiLCBkZWJvdW5jZSgoKT0+ewogIGNvbnN0IGNhbnZhcyA9",
  "IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJwcmljZUNoYXJ0Iik7CiAgaWYoY2FudmFzICYmIHN0YXRlLnZpZXc9PT0iZGV0YWlsIikgbG9hZENoYXJ0KHN0YXRlLmRldGFpbFRpY2tlciwgdHJ1ZSk7Cn0sIDIwMCkpOwoKLyogLS0tLS0tLS0tLS0tLS0tLSBTVEFU",
  "RSBIRUxQRVJTIC0tLS0tLS0tLS0tLS0tLS0gKi8KZnVuY3Rpb24gZW1wdHlTdGF0ZUlubmVyKHRpdGxlLCBzdWIpewogIHJldHVybiBgCiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS1pY29uIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjIyIiBoZWlnaHQ9",
  "IjIyIiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48Y2lyY2xlIGN4PSIxMSIgY3k9IjExIiByPSI3Ii8+PHBhdGggZD0iTTIxIDIxbC00LjMtNC4zIi8+PC9zdmc+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS10",
  "aXRsZSI+JHt0aXRsZX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRlLXN1YiI+JHtzdWJ9PC9kaXY+CiAgYDsKfQpmdW5jdGlvbiBlbXB0eVN0YXRlSFRNTCh0aXRsZSwgc3ViKXsKICByZXR1cm4gYDxkaXYgY2xhc3M9InN0YXRlLWJveCI+JHtlbXB0eVN0YXRl",
  "SW5uZXIodGl0bGUsIHN1Yil9PC9kaXY+YDsKfQpmdW5jdGlvbiBlcnJvclN0YXRlSFRNTCh0aXRsZSwgc3ViKXsKICByZXR1cm4gYDxkaXYgY2xhc3M9InN0YXRlLWJveCI+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS1pY29uIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAy",
  "NCIgd2lkdGg9IjIyIiBoZWlnaHQ9IjIyIiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMTIgOXY0TTEyIDE3aC4wMU0xMC4yOSAzLjg2TDEuODIgMThhMiAyIDAgMDAxLjcxIDNoMTYuOTRhMiAyIDAg",
  "MDAxLjcxLTNMMTMuNzEgMy44NmEyIDIgMCAwMC0zLjQyIDB6Ii8+PC9zdmc+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS10aXRsZSI+JHt0aXRsZX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRlLXN1YiI+JHtzdWJ9PC9kaXY+CiAgPC9kaXY+YDsKfQoK",
  "LyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBCT09UCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8Kc2V0",
  "QWN0aXZlTmF2KCJkYXNoYm9hcmQiKTsKY2hlY2tMaXZlQmFja2VuZCgpLmZpbmFsbHkocmVuZGVyKTsKc2V0SW50ZXJ2YWwoY2hlY2tMaXZlQmFja2VuZCwgNDUwMDApOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg=="
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

app.listen(config.port, () => {
  console.log(`[EquityScan] running at http://localhost:${config.port}`);
  console.log(`[EquityScan] daily call budget: ${config.dailyCallBudget}, cache TTL: ${config.quoteCacheTtl}ms`);
  startBackgroundRefresh();
});
