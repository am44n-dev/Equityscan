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
  "LDFmcik7Z2FwOjE0cHg7fQoudHJlbmRpbmctcm93e2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTtnYXA6MTRweDttYXJnaW4tYm90dG9tOjM0cHg7fQoudHJlbmRpbmctY2FyZHtwYWRkaW5nOjE2cHggMThweDtjdXJzb3I6",
  "cG9pbnRlcjt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMnMgdmFyKC0tZWFzZS1vdXQpLGJvcmRlci1jb2xvciAuMnMgdmFyKC0tZWFzZS1vdXQpO2FuaW1hdGlvbjpjYXJkSW4gLjM4cyB2YXIoLS1lYXNlLXNwcmluZykgYm90aDt9Ci50cmVuZGluZy1jYXJkOmhvdmVy",
  "e3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO2JvcmRlci1jb2xvcjp2YXIoLS1ib3JkZXItc29mdCk7fQoudHJlbmRpbmctdG9we2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7fQoud2F0Y2gtY2Fy",
  "ZHtwYWRkaW5nOjE2cHggMThweDtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47dHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjJzIHZhcigtLWVhc2Utb3V0KTt9Ci53YXRjaC1jYXJkOmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO30KLndhdGNo",
  "LWNhcmQucmVtb3Zpbmd7YW5pbWF0aW9uOmNhcmRPdXQgLjNzIHZhcigtLWVhc2Utb3V0KSBmb3J3YXJkczt9CkBrZXlmcmFtZXMgY2FyZE91dHt0b3tvcGFjaXR5OjA7dHJhbnNmb3JtOnNjYWxlKDAuOSkgdHJhbnNsYXRlWSg2cHgpO319Ci53YXRjaC1jYXJkLmVu",
  "dGVyaW5ne2FuaW1hdGlvbjpjYXJkSW4gLjM4cyB2YXIoLS1lYXNlLXNwcmluZykgYm90aDt9CkBrZXlmcmFtZXMgY2FyZElue2Zyb217b3BhY2l0eTowO3RyYW5zZm9ybTpzY2FsZSgwLjkpIHRyYW5zbGF0ZVkoMTBweCk7fXRve29wYWNpdHk6MTt0cmFuc2Zvcm06",
  "c2NhbGUoMSkgdHJhbnNsYXRlWSgwKTt9fQoud2F0Y2gtdG9we2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpmbGV4LXN0YXJ0O21hcmdpbi1ib3R0b206MTBweDt9Ci53YXRjaC1lbXB0eXtwYWRkaW5nOjYwcHgg",
  "MjBweDt0ZXh0LWFsaWduOmNlbnRlcjtncmlkLWNvbHVtbjoxLy0xO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBTS0VMRVRPTlMKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCkBrZXlmcmFtZXMgc2hpbW1lcnswJXtiYWNrZ3JvdW5kLXBvc2l0aW9uOi0zMDBweCAwO30xMDAle2JhY2tncm91bmQtcG9zaXRpb246MzAwcHggMDt9fQouc2tlbHsKICBib3JkZXItcmFkaXVzOjhw",
  "eDsKICBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5MGRlZywgdmFyKC0tYmctZWxldmF0ZWQpIDI1JSwgdmFyKC0tYmctZWxldmF0ZWQtMikgNTAlLCB2YXIoLS1iZy1lbGV2YXRlZCkgNzUlKTsKICBiYWNrZ3JvdW5kLXNpemU6MzAwcHggMTAwJTsKICBhbmlt",
  "YXRpb246c2hpbW1lciAxLjVzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9Ci5za2VsLWxpbmV7aGVpZ2h0OjEycHg7bWFyZ2luLWJvdHRvbTo4cHg7fQouc2tlbC1jYXJke2hlaWdodDoxMTJweDtib3JkZXItcmFkaXVzOnZhcigtLXJhZGl1cy1sKTt9CgovKiA9PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgRU1QVFkgLyBFUlJPUiBTVEFURVMKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi5z",
  "dGF0ZS1ib3h7CiAgZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjt0ZXh0LWFsaWduOmNlbnRlcjsKICBwYWRkaW5nOjY0cHggMjRweDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7",
  "Z2FwOjEycHg7Cn0KLnN0YXRlLWljb257CiAgd2lkdGg6NTJweDtoZWlnaHQ6NTJweDtib3JkZXItcmFkaXVzOjE0cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyOwogIGJhY2tncm91bmQ6dmFyKC0tYmctZWxl",
  "dmF0ZWQtMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7Y29sb3I6dmFyKC0tdGV4dC1sbyk7bWFyZ2luLWJvdHRvbTo0cHg7Cn0KLnN0YXRlLXRpdGxle2ZvbnQtc2l6ZToxNC41cHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOnZhcigtLXRleHQt",
  "aGkpO30KLnN0YXRlLXN1Yntmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO21heC13aWR0aDozMjBweDt9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgQk9UVE9NIE5B",
  "ViAobW9iaWxlKQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLmJvdHRvbS1uYXZ7CiAgZGlzcGxheTpub25lO3Bvc2l0aW9uOmZpeGVkO2xlZnQ6MDtyaWdodDowO2JvdHRvbTowO3otaW5k",
  "ZXg6NTA7CiAgYmFja2dyb3VuZDpyZ2JhKDEwLDEzLDIzLDAuOSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoMThweCk7CiAgYm9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpOwogIHBhZGRpbmc6OHB4IDZweCBjYWxjKDhweCArIGVudihzYWZlLWFy",
  "ZWEtaW5zZXQtYm90dG9tKSk7CiAganVzdGlmeS1jb250ZW50OnNwYWNlLWFyb3VuZDsKfQouYm90dG9tLW5hdiBidXR0b257CiAgYmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO2NvbG9yOnZhcigtLXRleHQtbG8pO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlv",
  "bjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDozcHg7CiAgZm9udC1zaXplOjEwcHg7Zm9udC13ZWlnaHQ6NzAwO3BhZGRpbmc6NHB4IDEwcHg7Y3Vyc29yOnBvaW50ZXI7Cn0KLmJvdHRvbS1uYXYgYnV0dG9uIHN2Z3t3aWR0aDoxOXB4O2hlaWdodDoxOXB4",
  "O30KLmJvdHRvbS1uYXYgYnV0dG9uLmFjdGl2ZXtjb2xvcjp2YXIoLS1ibHVlLXNvZnQpO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBSRVNQT05TSVZFCiAgID09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpAbWVkaWEgKG1heC13aWR0aDogOTgwcHgpewogIC5oZXJvLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTt9CiAgLm1ldHJpY3MtZ3JpZHtncmlkLXRl",
  "bXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTt9CiAgLndhdGNobGlzdC1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO30KICAudHJlbmRpbmctcm93e2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO30KfQpAbWVkaWEg",
  "KG1heC13aWR0aDogNjQwcHgpewogICNiYWNrZW5kQmFkZ2V7ZGlzcGxheTpub25lO30KfQpAbWVkaWEgKG1heC13aWR0aDogNzYwcHgpewogIG5hdi5tYWlubmF2e2Rpc3BsYXk6bm9uZTt9CiAgaGVhZGVyLnRvcGJhcntwYWRkaW5nOjAgMTZweDtoZWlnaHQ6NThw",
  "eDtnYXA6MTRweDt9CiAgbWFpbntwYWRkaW5nOjIwcHggMTZweCA5NnB4O30KICAuaGVyby1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLDFmcik7Z2FwOjEwcHg7fQogIC5tZXRyaWNzLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgy",
  "LDFmcik7fQogIC53YXRjaGxpc3QtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyO30KICAudHJlbmRpbmctcm93e2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnI7fQogIC50YWJsZS13cmFwe2Rpc3BsYXk6bm9uZTt9CiAgLnN0b2NrLWNhcmRze2Rpc3BsYXk6",
  "ZmxleDt9CiAgLmJvdHRvbS1uYXZ7ZGlzcGxheTpmbGV4O30KICAuZGV0YWlsLXByaWNlLWJsb2Nre3RleHQtYWxpZ246bGVmdDt9CiAgLmRldGFpbC1oZWFke2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjt9CiAgLmZpbHRlcnMtYmFye3BhZGRpbmc6MTJweDt9CiAgLmZp",
  "bHRlci1jaGlwe21pbi13aWR0aDo0NCU7ZmxleDoxO30KfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5PgoKPGRpdiBjbGFzcz0iYW1iaWVudCI+CiAgPGRpdiBjbGFzcz0iYW1iaWVudC1ncmlkIj48L2Rpdj4KICA8c3ZnIGNsYXNzPSJhbWJpZW50LWxpbmVzIiBpZD0i",
  "YW1iaWVudExpbmVzIiB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIj48L3N2Zz4KPC9kaXY+Cgo8aGVhZGVyIGNsYXNzPSJ0b3BiYXIiIGlkPSJ0b3BiYXIiPgogIDxkaXYgY2xhc3M9ImJyYW5kIj4KICAgIDxkaXYgY2xhc3M9ImJyYW5kLW1hcmsiPgogICAgICA8",
  "c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+CiAgICAgICAgPGRlZnM+CiAgICAgICAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImxvZ29HcmFkIiB4MT0iMiIgeTE9IjIwIiB4Mj0iMjIiIHkyPSI0IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVz",
  "ZSI+CiAgICAgICAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiM0QzdERkYiLz4KICAgICAgICAgICAgPHN0b3Agb2Zmc2V0PSI1NSUiIHN0b3AtY29sb3I9IiM4QjZCRjAiLz4KICAgICAgICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNv",
  "bG9yPSIjMzFENUVFIi8+CiAgICAgICAgICA8L2xpbmVhckdyYWRpZW50PgogICAgICAgIDwvZGVmcz4KICAgICAgICA8cmVjdCB4PSIyLjUiIHk9IjEzIiB3aWR0aD0iNCIgaGVpZ2h0PSI4LjUiIHJ4PSIxLjIiIGZpbGw9InVybCgjbG9nb0dyYWQpIiBvcGFjaXR5",
  "PSIwLjU1Ii8+CiAgICAgICAgPHJlY3QgeD0iMTAiIHk9IjgiIHdpZHRoPSI0IiBoZWlnaHQ9IjEzLjUiIHJ4PSIxLjIiIGZpbGw9InVybCgjbG9nb0dyYWQpIiBvcGFjaXR5PSIwLjgiLz4KICAgICAgICA8cmVjdCB4PSIxNy41IiB5PSIyLjUiIHdpZHRoPSI0IiBo",
  "ZWlnaHQ9IjE5IiByeD0iMS4yIiBmaWxsPSJ1cmwoI2xvZ29HcmFkKSIvPgogICAgICA8L3N2Zz4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iYnJhbmQtd29yZG1hcmsiPjxzcGFuPjxzcGFuIGNsYXNzPSJlcSI+RXF1aXR5PC9zcGFuPjxzcGFuIGNsYXNzPSJz",
  "Y2FuIj5TY2FuPC9zcGFuPjwvc3Bhbj48c21hbGw+TUFSS0VUIElOVEVMTElHRU5DRTwvc21hbGw+PC9kaXY+CiAgPC9kaXY+CiAgPG5hdiBjbGFzcz0ibWFpbm5hdiIgaWQ9Im1haW5OYXYiPgogICAgPGJ1dHRvbiBkYXRhLXZpZXc9ImRhc2hib2FyZCI+RGFzaGJv",
  "YXJkPC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtdmlldz0ic2NyZWVuZXIiPlNjcmVlbmVyPC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtdmlldz0ibWFya2V0cyI+TWFya2V0czwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLXZpZXc9IndhdGNobGlzdCI+V2F0",
  "Y2hsaXN0PC9idXR0b24+CiAgPC9uYXY+CiAgPGRpdiBjbGFzcz0iaGVhZGVyLXJpZ2h0Ij4KICAgIDxkaXYgY2xhc3M9Im1hcmtldC1waWxsIj48c3BhbiBjbGFzcz0iZG90LWxpdmUiPjwvc3Bhbj48c3BhbiBpZD0ibWFya2V0U3RhdHVzVGV4dCI+TWFya2V0IE9w",
  "ZW48L3NwYW4+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJtYXJrZXQtcGlsbCIgaWQ9ImJhY2tlbmRCYWRnZSIgdGl0bGU9IkNoZWNraW5nIGJhY2tlbmQgY29ubmVjdGlvbuKApiI+PHNwYW4gY2xhc3M9ImRvdC1saXZlIj48L3NwYW4+PHNwYW4+Q2hlY2tpbmfigKY8",
  "L3NwYW4+PC9kaXY+CiAgICA8YnV0dG9uIGNsYXNzPSJpY29uLWJ0biIgaWQ9InNlYXJjaFRvZ2dsZUJ0biIgdGl0bGU9IlNlYXJjaCAoLykiPgogICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0",
  "cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48Y2lyY2xlIGN4PSIxMSIgY3k9IjExIiByPSI3Ii8+PHBhdGggZD0iTTIxIDIxbC00LjMtNC4zIi8+PC9zdmc+CiAgICA8L2J1dHRvbj4KICAgIDxidXR0b24gY2xhc3M9Imljb24tYnRuIiB0aXRs",
  "ZT0iU2V0dGluZ3MiPgogICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xl",
  "IGN4PSIxMiIgY3k9IjEyIiByPSIzIi8+PHBhdGggZD0iTTE5LjQgMTVhMS42NSAxLjY1IDAgMDAuMzMgMS44MmwuMDYuMDZhMiAyIDAgMTEtMi44MyAyLjgzbC0uMDYtLjA2YTEuNjUgMS42NSAwIDAwLTEuODItLjMzIDEuNjUgMS42NSAwIDAwLTEgMS41MVYyMWEy",
  "IDIgMCAwMS00IDB2LS4wOUExLjY1IDEuNjUgMCAwMDkgMTkuNGExLjY1IDEuNjUgMCAwMC0xLjgyLjMzbC0uMDYuMDZhMiAyIDAgMTEtMi44My0yLjgzbC4wNi0uMDZBMS42NSAxLjY1IDAgMDA0LjYgMTVhMS42NSAxLjY1IDAgMDAtMS41MS0xSDNhMiAyIDAgMDEw",
  "LTRoLjA5QTEuNjUgMS42NSAwIDAwNC42IDlhMS42NSAxLjY1IDAgMDAtLjMzLTEuODJsLS4wNi0uMDZhMiAyIDAgMTEyLjgzLTIuODNsLjA2LjA2QTEuNjUgMS42NSAwIDAwOSA0LjZhMS42NSAxLjY1IDAgMDAxLTEuNTFWM2EyIDIgMCAwMTQgMHYuMDlhMS42NSAx",
  "LjY1IDAgMDAxIDEuNTEgMS42NSAxLjY1IDAgMDAxLjgyLS4zM2wuMDYtLjA2YTIgMiAwIDExMi44MyAyLjgzbC0uMDYuMDZBMS42NSAxLjY1IDAgMDAxOS40IDlhMS42NSAxLjY1IDAgMDAxLjUxIDFIMjFhMiAyIDAgMDEwIDRoLS4wOWExLjY1IDEuNjUgMCAwMC0x",
  "LjUxIDF6Ii8+PC9zdmc+CiAgICA8L2J1dHRvbj4KICA8L2Rpdj4KPC9oZWFkZXI+Cgo8bWFpbiBpZD0ibWFpblJvb3QiPjwvbWFpbj4KCjxuYXYgY2xhc3M9ImJvdHRvbS1uYXYiIGlkPSJib3R0b21OYXYiPgogIDxidXR0b24gZGF0YS12aWV3PSJkYXNoYm9hcmQi",
  "Pjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cmVjdCB4PSIzIiB5PSIzIiB3aWR0aD0iNyIgaGVpZ2h0PSI5IiByeD0iMS41Ii8+PHJlY3QgeD0iMTQiIHk9IjMiIHdpZHRo",
  "PSI3IiBoZWlnaHQ9IjUiIHJ4PSIxLjUiLz48cmVjdCB4PSIxNCIgeT0iMTIiIHdpZHRoPSI3IiBoZWlnaHQ9IjkiIHJ4PSIxLjUiLz48cmVjdCB4PSIzIiB5PSIxNiIgd2lkdGg9IjciIGhlaWdodD0iNSIgcng9IjEuNSIvPjwvc3ZnPkRhc2hib2FyZDwvYnV0dG9u",
  "PgogIDxidXR0b24gZGF0YS12aWV3PSJzY3JlZW5lciI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik00IDZoMTZNNyAxMmgxME0xMCAxOGg0Ii8+PC9zdmc+",
  "U2NyZWVuZXI8L2J1dHRvbj4KICA8YnV0dG9uIGRhdGEtdmlldz0ibWFya2V0cyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0zIDE3bDYtNiA0IDQgOC04",
  "Ii8+PC9zdmc+TWFya2V0czwvYnV0dG9uPgogIDxidXR0b24gZGF0YS12aWV3PSJ3YXRjaGxpc3QiPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMTIgMTcu",
  "M2wtNi4xNiAzLjYgMS42NC02LjlMMiA5LjRsNy4wNi0uNkwxMiAyLjRsMi45NCA2LjQgNy4wNi42LTUuNDggNC42IDEuNjQgNi45eiIvPjwvc3ZnPldhdGNobGlzdDwvYnV0dG9uPgo8L25hdj4KCjxzY3JpcHQ+CiJ1c2Ugc3RyaWN0IjsKCi8qID09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgVklTSUJMRSBFUlJPUiBESUFHTk9TVElDUyDigJQgc2hvd3MgdW5jYXVnaHQgZXJyb3JzIG9uLXNjcmVlbiBzbyB0aGV5CiAgIGNhbiBiZSByZWFkL3JlcG9ydGVk",
  "IHdpdGhvdXQgb3BlbmluZyBicm93c2VyIGRldiB0b29scy4gU2FmZSB0bwogICBsZWF2ZSBpbjsgaXQgb25seSBhcHBlYXJzIHdoZW4gc29tZXRoaW5nIGFjdHVhbGx5IHRocm93cy4KICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PSAqLwpmdW5jdGlvbiBzaG93RXJyb3JCYW5uZXIobXNnKXsKICBsZXQgYmFubmVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImVyckJhbm5lciIpOwogIGlmKCFiYW5uZXIpewogICAgYmFubmVyID0gZG9jdW1lbnQuY3Jl",
  "YXRlRWxlbWVudCgiZGl2Iik7CiAgICBiYW5uZXIuaWQgPSAiZXJyQmFubmVyIjsKICAgIGJhbm5lci5zdHlsZS5jc3NUZXh0ID0gInBvc2l0aW9uOmZpeGVkO2xlZnQ6MTJweDtyaWdodDoxMnB4O2JvdHRvbToxMnB4O3otaW5kZXg6OTk5O2JhY2tncm91bmQ6IzJh",
  "MGUxNDtib3JkZXI6MXB4IHNvbGlkICNGQjZCNkI7Y29sb3I6I0ZGRDlEOTtwYWRkaW5nOjEycHggMTRweDtib3JkZXItcmFkaXVzOjEwcHg7Zm9udC1zaXplOjEycHg7Zm9udC1mYW1pbHk6bW9ub3NwYWNlO21heC1oZWlnaHQ6MzV2aDtvdmVyZmxvdzphdXRvO2Jv",
  "eC1zaGFkb3c6MCAyMHB4IDUwcHggcmdiYSgwLDAsMCwwLjUpOyI7CiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGJhbm5lcik7CiAgfQogIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCJkaXYiKTsKICBsaW5lLnN0eWxlLm1hcmdpbkJv",
  "dHRvbSA9ICI2cHgiOwogIGxpbmUudGV4dENvbnRlbnQgPSBuZXcgRGF0ZSgpLnRvTG9jYWxlVGltZVN0cmluZygpICsgIiDigJQgIiArIG1zZzsKICBiYW5uZXIuYXBwZW5kQ2hpbGQobGluZSk7Cn0Kd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoImVycm9yIiwgKGUp",
  "PT4gc2hvd0Vycm9yQmFubmVyKCJKUyBlcnJvcjogIiArIChlLm1lc3NhZ2V8fGUpKSk7CndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJ1bmhhbmRsZWRyZWplY3Rpb24iLCAoZSk9PiBzaG93RXJyb3JCYW5uZXIoIlVuaGFuZGxlZCBwcm9taXNlIHJlamVjdGlvbjog",
  "IiArIChlLnJlYXNvbiAmJiBlLnJlYXNvbi5tZXNzYWdlIHx8IGUucmVhc29uKSkpOwoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBJTlRFR1JBVElPTiBMQVlFUgogICBUaGlzIGZy",
  "b250ZW5kIG5vdyB0YWxrcyB0byBhIHJlYWwgRXF1aXR5U2NhbiBiYWNrZW5kIChzZWUgL2JhY2tlbmQpCiAgIHdoaWNoIHByb3hpZXMgTlNFIHZpYSBzdG9jay1uc2UtaW5kaWEsIGNhY2hlZCBhbmQgYnVkZ2V0LWxpbWl0ZWQgdG8KICAgfjUwIHVwc3RyZWFtIGNh",
  "bGxzL2RheS4gRXZlcnkgQVBJLiogbWV0aG9kIGJlbG93IHRyaWVzIHRoZSBsaXZlCiAgIGJhY2tlbmQgZmlyc3QgYW5kIGZhbGxzIGJhY2sgdG8gZGV0ZXJtaW5pc3RpYyBtb2NrIGRhdGEgaWYgdGhlCiAgIGJhY2tlbmQgaXMgdW5yZWFjaGFibGUg4oCUIHdoaWNo",
  "IGlzIGV4cGVjdGVkIHdoZW4gdGhpcyBwYWdlIGlzIG9wZW5lZAogICBhcyBhIGhvc3RlZCBwcmV2aWV3LCBzaW5jZSBhIHB1Ymxpc2hlZCBwYWdlIGNhbm5vdCByZWFjaCBhCiAgIGxvY2FsaG9zdCBzZXJ2ZXIuIFJ1biB0aGUgYmFja2VuZCBhbmQgb3BlbiB0aGlz",
  "IGZpbGUgbG9jYWxseSAobm90CiAgIHRoZSBwdWJsaXNoZWQgcHJldmlldykgdG8gc2VlIHJlYWwgTlNFIHF1b3RlcyBlbmQgdG8gZW5kLgogICBUaGUgYmFja2VuZCBoYXMgbm8gaGlzdG9yaWNhbC1wcmljZSBlbmRwb2ludCB5ZXQsIHNvIGNoYXJ0IHNlcmllcwog",
  "ICBhbmQgc3BhcmtsaW5lcyBzdGF5IHN5bnRoZXRpYyBldmVuIGluIGxpdmUgbW9kZSDigJQgZXZlcnl0aGluZyBlbHNlCiAgIChwcmljZSwgY2hhbmdlICUsIDUyVyBoaWdoL2xvdywgY29tcGFueSBuYW1lLCBtYXJrZXQgc3RhdHVzKSBpcwogICByZWFsIHdoZW4g",
  "dGhlIGJhY2tlbmQgaXMgcmVhY2hhYmxlLgogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmNvbnN0IENPTkZJRyA9IHsKICBBUElfQkFTRTogKHdpbmRvdy5sb2NhdGlvbi5wcm90b2Nv",
  "bCA9PT0gImZpbGU6IiA/ICJodHRwOi8vbG9jYWxob3N0OjMwMDAiIDogd2luZG93LmxvY2F0aW9uLm9yaWdpbikgKyAiL2FwaSIsCiAgTElWRV9USU1FT1VUX01TOiA4MDAwLAp9OwpsZXQgbGl2ZUJhY2tlbmRBdmFpbGFibGUgPSBmYWxzZTsKY29uc3QgTU9DS19M",
  "QVRFTkNZID0gNDIwOwoKZnVuY3Rpb24gZmV0Y2hXaXRoVGltZW91dCh1cmwsIG1zKXsKICBjb25zdCBjdHJsID0gbmV3IEFib3J0Q29udHJvbGxlcigpOwogIGNvbnN0IGlkID0gc2V0VGltZW91dCgoKT0+Y3RybC5hYm9ydCgpLCBtcyk7CiAgcmV0dXJuIGZldGNo",
  "KHVybCwge3NpZ25hbDogY3RybC5zaWduYWx9KS5maW5hbGx5KCgpPT5jbGVhclRpbWVvdXQoaWQpKTsKfQoKYXN5bmMgZnVuY3Rpb24gY2hlY2tMaXZlQmFja2VuZCgpewogIHRyeXsKICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KENPTkZJRy5B",
  "UElfQkFTRSArICIvaGVhbHRoIiwgQ09ORklHLkxJVkVfVElNRU9VVF9NUyk7CiAgICBsaXZlQmFja2VuZEF2YWlsYWJsZSA9ICEhKHIgJiYgci5vayk7CiAgfWNhdGNoKGUpewogICAgbGl2ZUJhY2tlbmRBdmFpbGFibGUgPSBmYWxzZTsKICB9CiAgdXBkYXRlQmFj",
  "a2VuZEJhZGdlKCk7CiAgcmV0dXJuIGxpdmVCYWNrZW5kQXZhaWxhYmxlOwp9CgpmdW5jdGlvbiB1cGRhdGVCYWNrZW5kQmFkZ2UoKXsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJiYWNrZW5kQmFkZ2UiKTsKICBpZighZWwpIHJldHVybjsK",
  "ICBlbC5jbGFzc0xpc3QudG9nZ2xlKCJsaXZlIiwgbGl2ZUJhY2tlbmRBdmFpbGFibGUpOwogIGVsLnF1ZXJ5U2VsZWN0b3IoIi5kb3QtbGl2ZSIpLnN0eWxlLmJhY2tncm91bmQgPSBsaXZlQmFja2VuZEF2YWlsYWJsZSA/ICJ2YXIoLS1wb3MpIiA6ICJ2YXIoLS10",
  "ZXh0LWZhaW50KSI7CiAgZWwucXVlcnlTZWxlY3Rvcigic3BhbjpsYXN0LWNoaWxkIikudGV4dENvbnRlbnQgPSBsaXZlQmFja2VuZEF2YWlsYWJsZSA/ICJMaXZlIE5TRSBEYXRhIiA6ICJEZW1vIERhdGEiOwogIGVsLnRpdGxlID0gbGl2ZUJhY2tlbmRBdmFpbGFi",
  "bGUKICAgID8gIkNvbm5lY3RlZCB0byB0aGUgRXF1aXR5U2NhbiBiYWNrZW5kIOKAlCBwcmljZXMgYXJlIHJlYWwgTlNFIHF1b3Rlcy4iCiAgICA6ICJCYWNrZW5kIG5vdCByZWFjaGFibGUgYXQgIiArIENPTkZJRy5BUElfQkFTRSArICIg4oCUIHNob3dpbmcgZGV0",
  "ZXJtaW5pc3RpYyBkZW1vIGRhdGEuIjsKfQoKZnVuY3Rpb24gbWFwQmFja2VuZFRvRnJvbnRlbmQoZCl7CiAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQoZC5zeW1ib2wpOwogIGNvbnN0IGJhc2lzID0gZC5jdXJyZW50UHJpY2UgfHwgMTAwMDsKICBjb25zdCBzZXJp",
  "ZXMgPSBnZW5TZXJpZXMoc2VlZCwgMjAsIDAuMDA1LCBiYXNpcyk7CiAgY29uc3Qga25vd25EZWYgPSBVTklWRVJTRS5maW5kKHU9PnUudD09PWQuc3ltYm9sKTsKICByZXR1cm4gewogICAgdDogZC5zeW1ib2wsCiAgICBuYW1lOiBkLmNvbXBhbnlOYW1lIHx8IChr",
  "bm93bkRlZiAmJiBrbm93bkRlZi5uYW1lKSB8fCBkLnN5bWJvbCwKICAgIGV4Y2g6IGQuZXhjaGFuZ2UgfHwgIk5TRSIsCiAgICAvLyBUaGUgbGl2ZSBiYWNrZW5kJ3MgaW5kdXN0cnkgbGFiZWwgZG9lc24ndCByZWxpYWJseSBtYXRjaCBvdXIgZmlsdGVyCiAgICAv",
  "LyBkcm9wZG93bidzIHZvY2FidWxhcnkgKG9yIG1heSBiZSBtaXNzaW5nKSwgc28gcHJlZmVyIG91ciBrbm93biBtYXBwaW5nCiAgICAvLyBmb3IgZmlsdGVyaW5nIHB1cnBvc2VzIGFuZCBvbmx5IGZhbGwgYmFjayB0byB0aGUgYmFja2VuZCdzIHJhdyB2YWx1ZS4K",
  "ICAgIHNlY3RvcjogKGtub3duRGVmICYmIGtub3duRGVmLnNlY3RvcikgfHwgZC5zZWN0b3IgfHwgIuKAlCIsCiAgICBwcmljZTogZC5jdXJyZW50UHJpY2UsCiAgICBjaGFuZ2U6IGQuY2hhbmdlLAogICAgcGN0OiBkLnBlcmNlbnRDaGFuZ2UsCiAgICBtYXJrZXRD",
  "YXA6IGQubWFya2V0Q2FwLAogICAgdm9sdW1lOiBkLnZvbHVtZSwKICAgIGhpZ2g1MjogZC53ZWVrNTJIaWdoLAogICAgbG93NTI6IGQud2VlazUyTG93LAogICAgb3BlbjogZC5vcGVuLAogICAgZGF5SGlnaDogZC5kYXlIaWdoLAogICAgZGF5TG93OiBkLmRheUxv",
  "dywKICAgIHNlcmllcywKICAgIGxpdmU6IHRydWUsCiAgICBkYXRhU3RhdHVzOiBkLmRhdGFTdGF0dXMsCiAgfTsKfQoKYXN5bmMgZnVuY3Rpb24gbGl2ZUZldGNoU3RvY2sodGlja2VyKXsKICBjb25zdCByID0gYXdhaXQgZmV0Y2hXaXRoVGltZW91dChgJHtDT05G",
  "SUcuQVBJX0JBU0V9L3N0b2NrLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHRpY2tlcil9YCwgQ09ORklHLkxJVkVfVElNRU9VVF9NUyk7CiAgaWYoIXIub2spIHRocm93IG5ldyBFcnJvcigiYmFja2VuZCBzdGF0dXMgIityLnN0YXR1cyk7CiAgY29uc3QganNvbiA9IGF3",
  "YWl0IHIuanNvbigpOwogIGlmKCFqc29uLnN1Y2Nlc3MgfHwgIWpzb24uZGF0YSkgdGhyb3cgbmV3IEVycm9yKCJiYWNrZW5kIHBheWxvYWQgZXJyb3IiKTsKICByZXR1cm4gbWFwQmFja2VuZFRvRnJvbnRlbmQoanNvbi5kYXRhKTsKfQoKYXN5bmMgZnVuY3Rpb24g",
  "bGl2ZUZldGNoTWFueSh0aWNrZXJzKXsKICBjb25zdCBzZXR0bGVkID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKHRpY2tlcnMubWFwKGxpdmVGZXRjaFN0b2NrKSk7CiAgcmV0dXJuIHNldHRsZWQuZmlsdGVyKHM9PnMuc3RhdHVzPT09ImZ1bGZpbGxlZCIpLm1h",
  "cChzPT5zLnZhbHVlKTsKfQoKY29uc3QgVU5JVkVSU0UgPSBbCiAge3Q6IlRDUyIsIG5hbWU6IlRhdGEgQ29uc3VsdGFuY3kgU2VydmljZXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IklUIFNlcnZpY2VzIiwgYmFzZTozODQyfSwKICB7dDoiUkVMSUFOQ0UiLCBuYW1l",
  "OiJSZWxpYW5jZSBJbmR1c3RyaWVzIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJFbmVyZ3kiLCBiYXNlOjI5NTF9LAogIHt0OiJIREZDQkFOSyIsIG5hbWU6IkhERkMgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTY4N30sCiAge3Q6IklO",
  "RlkiLCBuYW1lOiJJbmZvc3lzIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJJVCBTZXJ2aWNlcyIsIGJhc2U6MTg0MX0sCiAge3Q6IklDSUNJQkFOSyIsIG5hbWU6IklDSUNJIEJhbmsiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkJhbmtpbmciLCBiYXNlOjEyNjR9LAogIHt0",
  "OiJCSEFSVElBUlRMIiwgbmFtZToiQmhhcnRpIEFpcnRlbCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiVGVsZWNvbSIsIGJhc2U6MTY5OH0sCiAge3Q6IlNCSU4iLCBuYW1lOiJTdGF0ZSBCYW5rIG9mIEluZGlhIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwg",
  "YmFzZTo4MjR9LAogIHt0OiJJVEMiLCBuYW1lOiJJVEMgTGltaXRlZCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiRk1DRyIsIGJhc2U6NDc4fSwKICB7dDoiTFQiLCBuYW1lOiJMYXJzZW4gJiBUb3Vicm8iLCBleGNoOiJOU0UiLCBzZWN0b3I6IkluZnJhc3RydWN0dXJl",
  "IiwgYmFzZTozNjEyfSwKICB7dDoiS09UQUtCQU5LIiwgbmFtZToiS290YWsgTWFoaW5kcmEgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTc4OX0sCiAge3Q6IkhJTkRVTklMVlIiLCBuYW1lOiJIaW5kdXN0YW4gVW5pbGV2ZXIiLCBl",
  "eGNoOiJOU0UiLCBzZWN0b3I6IkZNQ0ciLCBiYXNlOjI1NDd9LAogIHt0OiJBWElTQkFOSyIsIG5hbWU6IkF4aXMgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTE0Mn0sCiAge3Q6IkJBSkZJTkFOQ0UiLCBuYW1lOiJCYWphaiBGaW5h",
  "bmNlIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJGaW5hbmNpYWwgU2VydmljZXMiLCBiYXNlOjcyODR9LAogIHt0OiJNQVJVVEkiLCBuYW1lOiJNYXJ1dGkgU3V6dWtpIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJBdXRvbW9iaWxlIiwgYmFzZToxMjQ4MH0sCiAge3Q6IkFT",
  "SUFOUEFJTlQiLCBuYW1lOiJBc2lhbiBQYWludHMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkNvbnN1bWVyIEdvb2RzIiwgYmFzZToyODk0fSwKICB7dDoiV0lQUk8iLCBuYW1lOiJXaXBybyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSVQgU2VydmljZXMiLCBiYXNlOjUx",
  "Mn0sCiAge3Q6IlRJVEFOIiwgbmFtZToiVGl0YW4gQ29tcGFueSIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQ29uc3VtZXIgR29vZHMiLCBiYXNlOjM0MjF9LAogIHt0OiJTVU5QSEFSTUEiLCBuYW1lOiJTdW4gUGhhcm1hY2V1dGljYWwiLCBleGNoOiJOU0UiLCBzZWN0",
  "b3I6IlBoYXJtYSIsIGJhc2U6MTc4Nn0sCiAge3Q6Ik5UUEMiLCBuYW1lOiJOVFBDIExpbWl0ZWQiLCBleGNoOiJOU0UiLCBzZWN0b3I6IlBvd2VyIiwgYmFzZTozNjJ9LAogIHt0OiJBREFOSUVOVCIsIG5hbWU6IkFkYW5pIEVudGVycHJpc2VzIiwgZXhjaDoiTlNF",
  "Iiwgc2VjdG9yOiJEaXZlcnNpZmllZCIsIGJhc2U6MjkxNH0sCiAge3Q6IlVMVFJBQ0VNQ08iLCBuYW1lOiJVbHRyYVRlY2ggQ2VtZW50IiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJDZW1lbnQiLCBiYXNlOjExMjQwfSwKICB7dDoiUE9XRVJHUklEIiwgbmFtZToiUG93",
  "ZXIgR3JpZCBDb3JwIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJQb3dlciIsIGJhc2U6MzE4fSwKICB7dDoiTkVTVExFSU5EIiwgbmFtZToiTmVzdGxlIEluZGlhIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJGTUNHIiwgYmFzZToyMjc4fSwKICB7dDoiVEFUQU1PVE9SUyIs",
  "IG5hbWU6IlRhdGEgTW90b3JzIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJBdXRvbW9iaWxlIiwgYmFzZTo5NDh9LAogIHt0OiJKU1dTVEVFTCIsIG5hbWU6IkpTVyBTdGVlbCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiTWV0YWxzIiwgYmFzZToxMDEyfSwKXTsKCmZ1bmN0",
  "aW9uIHNlZWRlZFJhbmQoc2VlZCl7CiAgbGV0IHggPSBNYXRoLnNpbihzZWVkKSAqIDEwMDAwOwogIHJldHVybiB4IC0gTWF0aC5mbG9vcih4KTsKfQpmdW5jdGlvbiBkYXlPZlllYXIoKXsKICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpOwogIHJldHVybiBNYXRoLmZs",
  "b29yKChub3cgLSBuZXcgRGF0ZShub3cuZ2V0RnVsbFllYXIoKSwwLDApKSAvIDg2NDAwMDAwKTsKfQpmdW5jdGlvbiBnZW5TZXJpZXMoc2VlZCwgcG9pbnRzLCB2b2xhdGlsaXR5LCBiYXNlKXsKICBjb25zdCBhcnIgPSBbXTsKICBsZXQgdiA9IGJhc2U7CiAgZm9y",
  "KGxldCBpPTA7aTxwb2ludHM7aSsrKXsKICAgIGNvbnN0IHIgPSBzZWVkZWRSYW5kKHNlZWQgKiA5Ny43ICsgaSAqIDEzLjMxKSAtIDAuNTsKICAgIHYgPSB2ICogKDEgKyByICogdm9sYXRpbGl0eSk7CiAgICBhcnIucHVzaCh2KTsKICB9CiAgcmV0dXJuIGFycjsK",
  "fQpmdW5jdGlvbiB0aWNrZXJTZWVkKHRpY2tlcil7CiAgbGV0IGggPSAwOwogIGZvcihsZXQgaT0wO2k8dGlja2VyLmxlbmd0aDtpKyspIGggPSAoaCozMSArIHRpY2tlci5jaGFyQ29kZUF0KGkpKSAlIDEwMDAwMDsKICByZXR1cm4gaCArIGRheU9mWWVhcigpOwp9",
  "CgpmdW5jdGlvbiB3aXRoTGF0ZW5jeSh2YWx1ZSl7CiAgcmV0dXJuIG5ldyBQcm9taXNlKHJlcyA9PiBzZXRUaW1lb3V0KCgpID0+IHJlcyh2YWx1ZSksIE1PQ0tfTEFURU5DWSkpOwp9Cgpjb25zdCBBUEkgPSB7CiAgYXN5bmMgZmV0Y2hJbmRpY2VzKCl7CiAgICBj",
  "b25zdCBkZWZzID0gWwogICAgICB7Y29kZToiTklGVFkgNTAiLCBmdWxsOiJOU0UgTmlmdHkgNTAgSW5kZXgiLCBiYXNlOjI0ODEyfSwKICAgICAge2NvZGU6IlNFTlNFWCIsIGZ1bGw6IkJTRSBTZW5zZXgiLCBiYXNlOjgxNjQwfSwKICAgICAge2NvZGU6Ik5JRlRZ",
  "IEJBTksiLCBmdWxsOiJOU0UgQmFuayBOaWZ0eSBJbmRleCIsIGJhc2U6NTIxNDB9LAogICAgXTsKICAgIGNvbnN0IG91dCA9IGRlZnMubWFwKGQ9PnsKICAgICAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQoZC5jb2RlKTsKICAgICAgY29uc3Qgc2VyaWVzID0gZ2Vu",
  "U2VyaWVzKHNlZWQsIDI0LCAwLjAwNiwgZC5iYXNlKTsKICAgICAgY29uc3QgbGFzdCA9IHNlcmllc1tzZXJpZXMubGVuZ3RoLTFdOwogICAgICBjb25zdCBwcmV2ID0gZC5iYXNlOwogICAgICBjb25zdCBjaGcgPSBsYXN0IC0gcHJldjsKICAgICAgY29uc3QgcGN0",
  "ID0gKGNoZy9wcmV2KSoxMDA7CiAgICAgIHJldHVybiB7Li4uZCwgdmFsdWU6bGFzdCwgY2hhbmdlOmNoZywgcGN0LCBzZXJpZXN9OwogICAgfSk7CiAgICByZXR1cm4gd2l0aExhdGVuY3kob3V0KTsKICB9LAoKICBhc3luYyBzZWFyY2hTdG9ja3MocXVlcnkpewog",
  "ICAgY29uc3QgcSA9IHF1ZXJ5LnRyaW0oKS50b0xvd2VyQ2FzZSgpOwogICAgaWYoIXEpIHJldHVybiB3aXRoTGF0ZW5jeShbXSk7CiAgICBjb25zdCBtYXRjaGVzID0gVU5JVkVSU0UuZmlsdGVyKHMgPT4gcy50LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkgfHwg",
  "cy5uYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkpLnNsaWNlKDAsOCk7CiAgICBpZihsaXZlQmFja2VuZEF2YWlsYWJsZSl7CiAgICAgIGNvbnN0IGxpdmUgPSBhd2FpdCBsaXZlRmV0Y2hNYW55KG1hdGNoZXMubWFwKG09Pm0udCkpOwogICAgICBpZihsaXZl",
  "Lmxlbmd0aCkgcmV0dXJuIGxpdmU7CiAgICB9CiAgICByZXR1cm4gd2l0aExhdGVuY3kobWF0Y2hlcy5tYXAocyA9PiBkZWNvcmF0ZVN0b2NrKHMpKSk7CiAgfSwKCiAgYXN5bmMgZmV0Y2hTY3JlZW5lclJlc3VsdHMoZmlsdGVycyl7CiAgICBsZXQgbGlzdDsKICAg",
  "IGlmKGxpdmVCYWNrZW5kQXZhaWxhYmxlKXsKICAgICAgY29uc3QgbGl2ZSA9IGF3YWl0IGxpdmVGZXRjaE1hbnkoVU5JVkVSU0UubWFwKHM9PnMudCkpOwogICAgICBsaXN0ID0gbGl2ZS5sZW5ndGggPyBsaXZlIDogVU5JVkVSU0UubWFwKHM9PmRlY29yYXRlU3Rv",
  "Y2socykpOwogICAgfSBlbHNlIHsKICAgICAgbGlzdCA9IFVOSVZFUlNFLm1hcChkZWNvcmF0ZVN0b2NrKTsKICAgICAgYXdhaXQgd2l0aExhdGVuY3kobnVsbCk7CiAgICB9CiAgICBpZihmaWx0ZXJzLnF1ZXJ5KXsKICAgICAgY29uc3QgcSA9IGZpbHRlcnMucXVl",
  "cnkudG9Mb3dlckNhc2UoKTsKICAgICAgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMudC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpfHxzLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSk7CiAgICB9CiAgICBpZihmaWx0ZXJzLnNlY3RvciAmJiBmaWx0ZXJz",
  "LnNlY3RvciAhPT0gIkFsbCIpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnNlY3Rvcj09PWZpbHRlcnMuc2VjdG9yKTsKICAgIGlmKGZpbHRlcnMubWluUHJpY2UpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnByaWNlPj1maWx0ZXJzLm1pblByaWNlKTsKICAgIGlm",
  "KGZpbHRlcnMubWF4UHJpY2UpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnByaWNlPD1maWx0ZXJzLm1heFByaWNlKTsKICAgIGlmKGZpbHRlcnMuZGlyZWN0aW9uPT09ImdhaW5lcnMiKSBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q+PTApOwogICAgaWYoZmls",
  "dGVycy5kaXJlY3Rpb249PT0ibG9zZXJzIikgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMucGN0PDApOwogICAgcmV0dXJuIGxpc3Q7CiAgfSwKCiAgYXN5bmMgZmV0Y2hTdG9jayh0aWNrZXIpewogICAgaWYobGl2ZUJhY2tlbmRBdmFpbGFibGUpewogICAgICB0cnl7",
  "IHJldHVybiBhd2FpdCBsaXZlRmV0Y2hTdG9jayh0aWNrZXIpOyB9CiAgICAgIGNhdGNoKGUpeyAvKiBmYWxsIHRocm91Z2ggdG8gbW9jayAqLyB9CiAgICB9CiAgICBjb25zdCBkZWYgPSBVTklWRVJTRS5maW5kKHM9PnMudD09PXRpY2tlcik7CiAgICBpZighZGVm",
  "KSByZXR1cm4gd2l0aExhdGVuY3kobnVsbCk7CiAgICByZXR1cm4gd2l0aExhdGVuY3koZGVjb3JhdGVTdG9jayhkZWYsIHRydWUpKTsKICB9LAoKICBhc3luYyBmZXRjaFN0b2NrSGlzdG9yeSh0aWNrZXIsIHJhbmdlKXsKICAgIGNvbnN0IHNlZWQgPSB0aWNrZXJT",
  "ZWVkKHRpY2tlcik7CiAgICBjb25zdCBjZmcgPSB7CiAgICAgICIxRCI6e3BvaW50czo3OCwgdm9sOjAuMDAxNn0sCiAgICAgICIxVyI6e3BvaW50czozNSwgdm9sOjAuMDAzfSwKICAgICAgIjFNIjp7cG9pbnRzOjIyLCB2b2w6MC4wMDh9LAogICAgICAiM00iOntw",
  "b2ludHM6NjUsIHZvbDowLjAwOX0sCiAgICAgICI2TSI6e3BvaW50czoxMzAsIHZvbDowLjAxMH0sCiAgICAgICIxWSI6e3BvaW50czoyNTAsIHZvbDowLjAxMn0sCiAgICB9W3JhbmdlXSB8fCB7cG9pbnRzOjYwLCB2b2w6MC4wMDh9OwogICAgY29uc3QgZGVmID0g",
  "VU5JVkVSU0UuZmluZChzPT5zLnQ9PT10aWNrZXIpOwogICAgY29uc3QgYmFzZSA9IGRlZiA/IGRlZi5iYXNlICogMC45NCA6IDEwMDA7CiAgICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCArIHJhbmdlLmxlbmd0aCwgY2ZnLnBvaW50cywgY2ZnLnZvbCwg",
  "YmFzZSk7CiAgICByZXR1cm4gd2l0aExhdGVuY3koc2VyaWVzKTsKICB9LAp9OwoKZnVuY3Rpb24gZGVjb3JhdGVTdG9jayhkZWYsIGRldGFpbGVkKXsKICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkZWYudCk7CiAgY29uc3Qgc2VyaWVzID0gZ2VuU2VyaWVzKHNl",
  "ZWQsIDIwLCAwLjAwNSwgZGVmLmJhc2UpOwogIGNvbnN0IHByaWNlID0gc2VyaWVzW3Nlcmllcy5sZW5ndGgtMV07CiAgY29uc3QgcHJldkNsb3NlID0gZGVmLmJhc2U7CiAgY29uc3QgY2hhbmdlID0gcHJpY2UgLSBwcmV2Q2xvc2U7CiAgY29uc3QgcGN0ID0gKGNo",
  "YW5nZS9wcmV2Q2xvc2UpKjEwMDsKICBjb25zdCBtYXJrZXRDYXAgPSBwcmljZSAqIChzZWVkZWRSYW5kKHNlZWQqMi4xKSo0MDAwKzgwMCkgKiAxZTY7CiAgY29uc3Qgdm9sdW1lID0gTWF0aC5yb3VuZChzZWVkZWRSYW5kKHNlZWQqMy4zKSo4XzAwMF8wMDAgKyAy",
  "MDBfMDAwKTsKICBjb25zdCBoaWdoNTIgPSBwcmljZSAqICgxICsgc2VlZGVkUmFuZChzZWVkKjQuNCkqMC4zNSArIDAuMDUpOwogIGNvbnN0IGxvdzUyID0gcHJpY2UgKiAoMSAtIHNlZWRlZFJhbmQoc2VlZCo1LjUpKjAuMzAgLSAwLjA0KTsKICBjb25zdCBvdXQg",
  "PSB7CiAgICB0OmRlZi50LCBuYW1lOmRlZi5uYW1lLCBleGNoOmRlZi5leGNoLCBzZWN0b3I6ZGVmLnNlY3RvciwKICAgIHByaWNlLCBjaGFuZ2UsIHBjdCwgbWFya2V0Q2FwLCB2b2x1bWUsIGhpZ2g1MiwgbG93NTIsIHNlcmllcywKICB9OwogIGlmKGRldGFpbGVk",
  "KXsKICAgIG91dC5vcGVuID0gcHJpY2UgLSBjaGFuZ2UqMC42OwogICAgb3V0LmRheUhpZ2ggPSBNYXRoLm1heChwcmljZSwgb3V0Lm9wZW4pICogKDErc2VlZGVkUmFuZChzZWVkKjYuNikqMC4wMTIpOwogICAgb3V0LmRheUxvdyA9IE1hdGgubWluKHByaWNlLCBv",
  "dXQub3BlbikgKiAoMS1zZWVkZWRSYW5kKHNlZWQqNy43KSowLjAxMik7CiAgfQogIHJldHVybiBvdXQ7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgRk9STUFUIEhFTFBFUlMK",
  "ICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpmdW5jdGlvbiBmbXRJTlIodiwgZGVjaW1hbHMpewogIGlmKHY9PT11bmRlZmluZWR8fHY9PT1udWxsfHxpc05hTih2KSkgcmV0dXJuICLi",
  "gJQiOwogIGNvbnN0IGQgPSBkZWNpbWFscz09PXVuZGVmaW5lZD8yOmRlY2ltYWxzOwogIHJldHVybiAi4oK5IiArIHYudG9Mb2NhbGVTdHJpbmcoImVuLUlOIiwge21pbmltdW1GcmFjdGlvbkRpZ2l0czpkLCBtYXhpbXVtRnJhY3Rpb25EaWdpdHM6ZH0pOwp9CmZ1",
  "bmN0aW9uIGZtdENvbXBhY3Qodil7CiAgaWYodj09PXVuZGVmaW5lZHx8dj09PW51bGx8fGlzTmFOKHYpKSByZXR1cm4gIuKAlCI7CiAgaWYodj49MWUxMikgcmV0dXJuICLigrkiKyh2LzFlMTIpLnRvRml4ZWQoMikrIlQiOwogIGlmKHY+PTFlOSkgcmV0dXJuICLi",
  "grkiKyh2LzFlOSkudG9GaXhlZCgyKSsiQiI7CiAgaWYodj49MWU3KSByZXR1cm4gIuKCuSIrKHYvMWU3KS50b0ZpeGVkKDIpKyJDciI7CiAgaWYodj49MWU1KSByZXR1cm4gIuKCuSIrKHYvMWU1KS50b0ZpeGVkKDIpKyJMIjsKICByZXR1cm4gIuKCuSIrdi50b0Zp",
  "eGVkKDApOwp9CmZ1bmN0aW9uIGZtdFZvbCh2KXsKICBpZih2Pj0xZTcpIHJldHVybiAodi8xZTcpLnRvRml4ZWQoMikrIkNyIjsKICBpZih2Pj0xZTUpIHJldHVybiAodi8xZTUpLnRvRml4ZWQoMikrIkwiOwogIGlmKHY+PTFlMykgcmV0dXJuICh2LzFlMykudG9G",
  "aXhlZCgxKSsiSyI7CiAgcmV0dXJuIFN0cmluZyh2KTsKfQpmdW5jdGlvbiBwY3RTdHIocCl7IHJldHVybiAocD49MD8iKyI6IiIpICsgcC50b0ZpeGVkKDIpICsgIiUiOyB9CmZ1bmN0aW9uIGNoZ1N0cihjKXsgcmV0dXJuIChjPj0wPyIrIjoiIikgKyBmbXRJTlIo",
  "TWF0aC5hYnMoYykpOyB9CmZ1bmN0aW9uIGVzY2FwZUh0bWwocyl7CiAgcmV0dXJuIFN0cmluZyhzKS5yZXBsYWNlKC9bJjw+IiddL2csIG0gPT4gKHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsJyInOiImcXVvdDsiLCInIjoiJiMzOTsifVttXSkp",
  "Owp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNUQVRFCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0g",
  "Ki8KY29uc3Qgc3RhdGUgPSB7CiAgdmlldzogImRhc2hib2FyZCIsCiAgd2F0Y2hsaXN0OiBbXSwKICBkZXRhaWxUaWNrZXI6ICJUQ1MiLAogIGRldGFpbFJhbmdlOiAiMU0iLAogIHNjcmVlbmVyRmlsdGVyczoge3F1ZXJ5OiIiLCBzZWN0b3I6IkFsbCIsIG1pblBy",
  "aWNlOjAsIG1heFByaWNlOjE1MDAwLCBkaXJlY3Rpb246ImFsbCJ9LAogIHNjcmVlbmVyU29ydDoge2tleToibWFya2V0Q2FwIiwgZGlyOiJkZXNjIn0sCn07Cgp0cnl7CiAgY29uc3Qgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgiZXF1aXR5c2Nhbl93YXRj",
  "aGxpc3QiKTsKICBpZihzYXZlZCkgc3RhdGUud2F0Y2hsaXN0ID0gSlNPTi5wYXJzZShzYXZlZCk7Cn1jYXRjaChlKXt9CmZ1bmN0aW9uIHBlcnNpc3RXYXRjaGxpc3QoKXsKICB0cnl7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCJlcXVpdHlzY2FuX3dhdGNobGlzdCIs",
  "IEpTT04uc3RyaW5naWZ5KHN0YXRlLndhdGNobGlzdCkpOyB9Y2F0Y2goZSl7fQp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNQQVJLTElORSAoaW5saW5lIFNWRykKICAgPT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpmdW5jdGlvbiBzcGFya2xpbmVTVkcoc2VyaWVzLCBwb3NpdGl2ZSwgdywgaCl7CiAgdyA9IHd8fDEyMDsgaCA9IGh8fDM2OwogIGlmKCFzZXJpZXMg",
  "fHwgc2VyaWVzLmxlbmd0aDwyKSByZXR1cm4gIiI7CiAgY29uc3QgbWluID0gTWF0aC5taW4oLi4uc2VyaWVzKSwgbWF4ID0gTWF0aC5tYXgoLi4uc2VyaWVzKTsKICBjb25zdCByYW5nZSA9IChtYXgtbWluKXx8MTsKICBjb25zdCBzdGVwID0gdy8oc2VyaWVzLmxl",
  "bmd0aC0xKTsKICBjb25zdCBwdHMgPSBzZXJpZXMubWFwKCh2LGkpPT5baSpzdGVwLCBoIC0gKCh2LW1pbikvcmFuZ2UpKmgqMC44NiAtIGgqMC4wN10pOwogIGNvbnN0IHBhdGggPSBwdHMubWFwKChwLGkpPT4oaT09PTA/Ik0iOiJMIikrcFswXS50b0ZpeGVkKDEp",
  "KyIsIitwWzFdLnRvRml4ZWQoMSkpLmpvaW4oIiAiKTsKICBjb25zdCBhcmVhUGF0aCA9IHBhdGggKyBgIEwke3d9LCR7aH0gTDAsJHtofSBaYDsKICBjb25zdCBjb2xvciA9IHBvc2l0aXZlID8gInZhcigtLXBvcykiIDogInZhcigtLW5lZykiOwogIGNvbnN0IGdp",
  "ZCA9ICJzZyIrTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiw5KTsKICByZXR1cm4gYDxzdmcgdmlld0JveD0iMCAwICR7d30gJHtofSIgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+CiAgICA8ZGVm",
  "cz48bGluZWFyR3JhZGllbnQgaWQ9IiR7Z2lkfSIgeDE9IjAiIHkxPSIwIiB4Mj0iMCIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIke2NvbG9yfSIgc3RvcC1vcGFjaXR5PSIwLjM1Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAw",
  "JSIgc3RvcC1jb2xvcj0iJHtjb2xvcn0iIHN0b3Atb3BhY2l0eT0iMCIvPgogICAgPC9saW5lYXJHcmFkaWVudD48L2RlZnM+CiAgICA8cGF0aCBkPSIke2FyZWFQYXRofSIgZmlsbD0idXJsKCMke2dpZH0pIiBzdHJva2U9Im5vbmUiLz4KICAgIDxwYXRoIGQ9IiR7",
  "cGF0aH0iIGZpbGw9Im5vbmUiIHN0cm9rZT0iJHtjb2xvcn0iIHN0cm9rZS13aWR0aD0iMS42IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICA8L3N2Zz5gOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEFNQklFTlQgREVDT1JBVElWRSBMSU5FUyAoZHJhd24gb25jZSkKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwoo",
  "ZnVuY3Rpb24gZHJhd0FtYmllbnRMaW5lcygpewogIGNvbnN0IHN2ZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhbWJpZW50TGluZXMiKTsKICBjb25zdCB3ID0gMTQwMCwgaCA9IDgwMDsKICBzdmcuc2V0QXR0cmlidXRlKCJ2aWV3Qm94IiwgYDAgMCAke3d9",
  "ICR7aH1gKTsKICBsZXQgaHRtbCA9ICIiOwogIGZvcihsZXQgaT0wO2k8MztpKyspewogICAgY29uc3Qgc2VlZCA9IGkqMTcrMzsKICAgIGNvbnN0IHB0cyA9IFtdOwogICAgY29uc3QgbiA9IDEyOwogICAgZm9yKGxldCBqPTA7ajw9bjtqKyspewogICAgICBjb25z",
  "dCB4ID0gKGovbikqdzsKICAgICAgY29uc3QgeSA9IGgqMC4yNSArIGkqMTMwICsgKHNlZWRlZFJhbmQoc2VlZCtqKS0wLjUpKjkwOwogICAgICBwdHMucHVzaChbeCx5XSk7CiAgICB9CiAgICBjb25zdCBwYXRoID0gcHRzLm1hcCgocCxpZHgpPT4oaWR4PT09MD8i",
  "TSI6IkwiKStwWzBdLnRvRml4ZWQoMCkrIiwiK3BbMV0udG9GaXhlZCgwKSkuam9pbigiICIpOwogICAgY29uc3QgY29sb3JzID0gWyIjNEM3REZGIiwiIzhCNkJGMCIsIiMzMUQ1RUUiXTsKICAgIGh0bWwgKz0gYDxwYXRoIGQ9IiR7cGF0aH0iIGZpbGw9Im5vbmUi",
  "IHN0cm9rZT0iJHtjb2xvcnNbaSUzXX0iIHN0cm9rZS13aWR0aD0iMSIgb3BhY2l0eT0iMC4xMCIvPmA7CiAgfQogIHN2Zy5pbm5lckhUTUwgPSBodG1sOwp9KSgpOwoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PQogICBIRUFERVIgQkVIQVZJT1IKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCB0b3BiYXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidG9wYmFy",
  "Iik7CndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJzY3JvbGwiLCAoKT0+ewogIHRvcGJhci5jbGFzc0xpc3QudG9nZ2xlKCJzY3JvbGxlZCIsIHdpbmRvdy5zY3JvbGxZID4gOCk7Cn0pOwoKZnVuY3Rpb24gc2V0QWN0aXZlTmF2KHZpZXcpewogIGRvY3VtZW50LnF1",
  "ZXJ5U2VsZWN0b3JBbGwoIiNtYWluTmF2IGJ1dHRvbiwgI2JvdHRvbU5hdiBidXR0b24iKS5mb3JFYWNoKGI9PnsKICAgIGIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIiwgYi5kYXRhc2V0LnZpZXc9PT12aWV3KTsKICB9KTsKfQpkb2N1bWVudC5nZXRFbGVtZW50",
  "QnlJZCgibWFpbk5hdiIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgZT0+ewogIGNvbnN0IGJ0biA9IGUudGFyZ2V0LmNsb3Nlc3QoImJ1dHRvbltkYXRhLXZpZXddIik7CiAgaWYoYnRuKSBuYXZpZ2F0ZShidG4uZGF0YXNldC52aWV3KTsKfSk7CmRvY3VtZW50",
  "LmdldEVsZW1lbnRCeUlkKCJib3R0b21OYXYiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIGU9PnsKICBjb25zdCBidG4gPSBlLnRhcmdldC5jbG9zZXN0KCJidXR0b25bZGF0YS12aWV3XSIpOwogIGlmKGJ0bikgbmF2aWdhdGUoYnRuLmRhdGFzZXQudmlldyk7",
  "Cn0pOwoKZnVuY3Rpb24gbmF2aWdhdGUodmlldywgdGlja2VyKXsKICBzdGF0ZS52aWV3ID0gdmlldzsKICBpZih0aWNrZXIpIHN0YXRlLmRldGFpbFRpY2tlciA9IHRpY2tlcjsKICBzZXRBY3RpdmVOYXYodmlldyA9PT0gImRldGFpbCIgPyAibWFya2V0cyIgOiB2",
  "aWV3KTsKICB3aW5kb3cuc2Nyb2xsVG8oe3RvcDowLCBiZWhhdmlvcjogd2luZG93Lm1hdGNoTWVkaWEoJyhwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpJykubWF0Y2hlcyA/ICJhdXRvIiA6ICJzbW9vdGgifSk7CiAgcmVuZGVyKCk7Cn0KCi8qID09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgTUFSS0VUIFNUQVRVUyAoSVNUIGJ1c2luZXNzIGhvdXJzLCBwdXJlbHkgcHJlc2VudGF0aW9uYWwpCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KKGZ1bmN0aW9uIG1hcmtldFN0YXR1cygpewogIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7CiAgY29uc3QgaXN0SG91ciA9IChub3cuZ2V0VVRDSG91cnMoKSs1KSUyNCArIChub3cuZ2V0VVRD",
  "TWludXRlcygpKzMwPj02MD8xOjApOwogIGNvbnN0IG1pbnMgPSAobm93LmdldFVUQ01pbnV0ZXMoKSszMCklNjA7CiAgY29uc3QgdG90YWxNaW4gPSAoKG5vdy5nZXRVVENIb3VycygpKzUpJTI0KSo2MCArIG1pbnM7CiAgY29uc3Qgb3BlbiA9IHRvdGFsTWluID49",
  "IDU1NSAmJiB0b3RhbE1pbiA8PSA5MzA7IC8vIDk6MTUgLSAxNTozMCBJU1QKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibWFya2V0U3RhdHVzVGV4dCIpLnRleHRDb250ZW50ID0gb3BlbiA/ICJNYXJrZXQgT3BlbiIgOiAiTWFya2V0IENsb3NlZCI7CiAgZG9j",
  "dW1lbnQucXVlcnlTZWxlY3RvcigiLmRvdC1saXZlIikuc3R5bGUuYmFja2dyb3VuZCA9IG9wZW4gPyAidmFyKC0tcG9zKSIgOiAidmFyKC0tdGV4dC1mYWludCkiOwp9KSgpOwoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PQogICBSRU5ERVI6IFJPT1QKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCByb290ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm1haW5S",
  "b290Iik7CgpmdW5jdGlvbiByZW5kZXIoKXsKICBpZihzdGF0ZS52aWV3ID09PSAiZGFzaGJvYXJkIikgcmVuZGVyRGFzaGJvYXJkKCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09PSAic2NyZWVuZXIiKSByZW5kZXJTY3JlZW5lcigpOwogIGVsc2UgaWYoc3RhdGUu",
  "dmlldyA9PT0gIm1hcmtldHMiKSByZW5kZXJNYXJrZXRzKCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09PSAid2F0Y2hsaXN0IikgcmVuZGVyV2F0Y2hsaXN0KCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09PSAiZGV0YWlsIikgcmVuZGVyRGV0YWlsKCk7Cn0KCi8q",
  "IC0tLS0tLS0tLS0tLS0tLS0gREFTSEJPQVJEIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyRGFzaGJvYXJkKCl7CiAgcm9vdC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJ2aWV3IiBpZD0iZGFzaFZpZXciPgogICAgICA8ZGl2",
  "IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5NYXJrZXQgT3ZlcnZpZXc8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPlJlYWwtdGltZSBpbmRleCBzbmFwc2hvdDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGVyby1yb3ciIGlkPSJpbmRpY2VzUm93Ij4KICAg",
  "ICAgICAke3NrZWxldG9uQ2FyZHMoMyl9CiAgICAgIDwvZGl2PgoKICAgICAgJHtzZWFyY2hCbG9jaygpfQoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+TWFya2V0IEJyZWFkdGg8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPkFkdmFuY2VycyB2cyBk",
  "ZWNsaW5lcnMsIGZ1bGwgdW5pdmVyc2U8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGJyZWFkdGgtY2FyZCIgaWQ9ImJyZWFkdGhDYXJkIiBzdHlsZT0icGFkZGluZzoxOHB4IDIycHg7bWFyZ2luLWJvdHRvbTozNHB4OyI+JHtza2VsZXRvbkxp",
  "bmVzKDIpfTwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+VG9wIE1vdmVyczwvaDI+PHNwYW4gY2xhc3M9InN1YiI+QnkgYWJzb2x1dGUgY2hhbmdlIHRvZGF5PC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFw",
  "IGdsYXNzIiBpZD0ibW92ZXJzVGFibGVXcmFwIj48ZGl2IHN0eWxlPSJwYWRkaW5nOjIwcHg7Ij4ke3NrZWxldG9uTGluZXMoNil9PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0b2NrLWNhcmRzIiBpZD0ibW92ZXJzQ2FyZHMiPjwvZGl2PgogICAgPC9k",
  "aXY+CiAgYDsKICB3aXJlU2VhcmNoKCk7CgogIHRyeXsKICAgIGNvbnN0IGluZGljZXMgPSBhd2FpdCBBUEkuZmV0Y2hJbmRpY2VzKCk7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiaW5kaWNlc1JvdyIpLmlubmVySFRNTCA9IGluZGljZXMubWFwKGluZGV4",
  "Q2FyZEhUTUwpLmpvaW4oIiIpOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiLmluZGV4LXNwYXJrIikuZm9yRWFjaCgoZWwsaSk9PnsKICAgICAgZWwuaW5uZXJIVE1MID0gc3BhcmtsaW5lU1ZHKGluZGljZXNbaV0uc2VyaWVzLCBpbmRpY2VzW2ldLmNo",
  "YW5nZT49MCk7CiAgICB9KTsKICB9Y2F0Y2goZSl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiaW5kaWNlc1JvdyIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJNYXJrZXQgZGF0YSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZSIsICJXZSBjb3VsZG4n",
  "dCByZWFjaCB0aGUgaW5kaWNlcyBmZWVkLiBQbGVhc2UgdHJ5IGFnYWluIHNob3J0bHkuIik7CiAgfQoKICB0cnl7CiAgICBjb25zdCBmdWxsID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHt9KTsKICAgIHRyeXsKICAgICAgcmVuZGVyQnJlYWR0aChm",
  "dWxsKTsKICAgIH1jYXRjaChlKXsKICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJyZWFkdGhDYXJkIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIkJyZWFkdGggZGF0YSB1bmF2YWlsYWJsZSIsICJDb3VsZG4ndCBjb21wdXRlIGFkdmFuY2VycyB2",
  "cyBkZWNsaW5lcnMuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgICAgc2hvd0Vycm9yQmFubmVyKCJyZW5kZXJCcmVhZHRoIGZhaWxlZDogIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSk7CiAgICB9CiAgICB0cnl7CiAgICAgIGNvbnN0IG1v",
  "dmVycyA9IGZ1bGwuc2xpY2UoKS5zb3J0KChhLGIpPT5NYXRoLmFicyhiLnBjdCktTWF0aC5hYnMoYS5wY3QpKS5zbGljZSgwLDgpOwogICAgICByZW5kZXJUYWJsZUludG8oIm1vdmVyc1RhYmxlV3JhcCIsICJtb3ZlcnNDYXJkcyIsIG1vdmVycywge2tleToicGN0",
  "IiwgZGlyOiJkZXNjIn0sIGZhbHNlKTsKICAgIH1jYXRjaChlKXsKICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm1vdmVyc1RhYmxlV3JhcCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJVbmFibGUgdG8gcmV0cmlldmUgbW92ZXJzIiwgIlNvbWV0",
  "aGluZyB3ZW50IHdyb25nIGxvYWRpbmcgdGhpcyBsaXN0LiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIik7CiAgICAgIHNob3dFcnJvckJhbm5lcigibW92ZXJzIHRhYmxlIHJlbmRlciBmYWlsZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwog",
  "ICAgfQogIH1jYXRjaChlKXsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtb3ZlcnNUYWJsZVdyYXAiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIHJldHJpZXZlIG1vdmVycyIsICJTb21ldGhpbmcgd2VudCB3cm9uZyBsb2FkaW5n",
  "IHRoaXMgbGlzdC4gKCIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkgKyAiKSIpOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJyZWFkdGhDYXJkIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIkJyZWFkdGggZGF0YSB1bmF2YWlsYWJsZSIsICJDb3Vs",
  "ZG4ndCBjb21wdXRlIGFkdmFuY2VycyB2cyBkZWNsaW5lcnMuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgIHNob3dFcnJvckJhbm5lcigiZmV0Y2hTY3JlZW5lclJlc3VsdHMgZmFpbGVkOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsK",
  "ICB9Cn0KCmZ1bmN0aW9uIHJlbmRlckJyZWFkdGgobGlzdCl7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYnJlYWR0aENhcmQiKTsKICBpZighZWwgfHwgIWxpc3QubGVuZ3RoKXsgaWYoZWwpIGVsLmlubmVySFRNTCA9IGVtcHR5U3RhdGVI",
  "VE1MKCJObyBicmVhZHRoIGRhdGEiLCAiTm8gc3RvY2tzIHdlcmUgcmV0dXJuZWQgdG8gY29tcHV0ZSB0aGlzIGZyb20uIik7IHJldHVybjsgfQogIGNvbnN0IGFkdmFuY2VycyA9IGxpc3QuZmlsdGVyKHM9PnMucGN0PjApLmxlbmd0aDsKICBjb25zdCBkZWNsaW5l",
  "cnMgPSBsaXN0LmZpbHRlcihzPT5zLnBjdDwwKS5sZW5ndGg7CiAgY29uc3QgZmxhdCA9IGxpc3QubGVuZ3RoIC0gYWR2YW5jZXJzIC0gZGVjbGluZXJzOwogIGNvbnN0IHRvdGFsID0gbGlzdC5sZW5ndGg7CiAgY29uc3QgYWR2UGN0ID0gKGFkdmFuY2Vycy90b3Rh",
  "bCkqMTAwLCBkZWNQY3QgPSAoZGVjbGluZXJzL3RvdGFsKSoxMDAsIGZsYXRQY3QgPSAoZmxhdC90b3RhbCkqMTAwOwogIGVsLmlubmVySFRNTCA9IGAKICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGln",
  "bi1pdGVtczpiYXNlbGluZTttYXJnaW4tYm90dG9tOjEycHg7ZmxleC13cmFwOndyYXA7Z2FwOjhweDsiPgogICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7Z2FwOjIwcHg7Ij4KICAgICAgICA8ZGl2PjxzcGFuIGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFy",
  "IiBzdHlsZT0iZm9udC1zaXplOjIwcHg7Y29sb3I6dmFyKC0tcG9zLXNvZnQpOyI+JHthZHZhbmNlcnN9PC9zcGFuPiA8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEycHg7Ij5hZHZhbmNpbmc8L3NwYW4+PC9kaXY+CiAgICAgICAg",
  "PGRpdj48c3BhbiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciIgc3R5bGU9ImZvbnQtc2l6ZToyMHB4O2NvbG9yOnZhcigtLW5lZy1zb2Z0KTsiPiR7ZGVjbGluZXJzfTwvc3Bhbj4gPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZTox",
  "MnB4OyI+ZGVjbGluaW5nPC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNpemU6MjBweDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7Ij4ke2ZsYXR9PC9zcGFuPiA8c3BhbiBzdHlsZT0i",
  "Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEycHg7Ij51bmNoYW5nZWQ8L3NwYW4+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJmb250LXNpemU6MTEuNXB4O2NvbG9yOnZhcigtLXRleHQtZmFpbnQpOyI+b2YgJHt0b3RhbH0gdHJh",
  "Y2tlZCBzdG9ja3M8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2hlaWdodDoxMHB4O2JvcmRlci1yYWRpdXM6NnB4O292ZXJmbG93OmhpZGRlbjtiYWNrZ3JvdW5kOnZhcigtLWJnLWJhc2UpOyI+CiAgICAgIDxkaXYgc3R5bGU9",
  "IndpZHRoOiR7YWR2UGN0fSU7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsdmFyKC0tcG9zKSx2YXIoLS1wb3Mtc29mdCkpOyI+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9IndpZHRoOiR7ZmxhdFBjdH0lO2JhY2tncm91bmQ6dmFyKC0tdGV4dC1mYWlu",
  "dCk7Ij48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0id2lkdGg6JHtkZWNQY3R9JTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5MGRlZyx2YXIoLS1uZWctc29mdCksdmFyKC0tbmVnKSk7Ij48L2Rpdj4KICAgIDwvZGl2PgogIGA7Cn0KCmZ1bmN0aW9uIGluZGV4",
  "Q2FyZEhUTUwoaWR4KXsKICBjb25zdCBwb3NpdGl2ZSA9IGlkeC5jaGFuZ2UgPj0gMDsKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9ImdsYXNzIGluZGV4LWNhcmQiPgogICAgPGRpdiBjbGFzcz0icm93MSI+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0i",
  "aW5kZXgtbmFtZSI+JHtpZHguY29kZX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJpbmRleC1mdWxsIj4ke2lkeC5mdWxsfTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtYmFkZ2UgJHtwb3NpdGl2ZT8ncG9zJzonbmVnJ30iPgog",
  "ICAgICAgICR7cG9zaXRpdmU/J+KWsic6J+KWvCd9ICR7cGN0U3RyKGlkeC5wY3QpfQogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciI+JHtpZHgudmFsdWUudG9Mb2NhbGVTdHJpbmcoImVuLUlOIix7bWF4",
  "aW11bUZyYWN0aW9uRGlnaXRzOjJ9KX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LWNoYW5nZSAke3Bvc2l0aXZlPydwb3MnOiduZWcnfSB0YWJ1bGFyIj4ke2NoZ1N0cihpZHguY2hhbmdlKX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LXNwYXJrIj48",
  "L2Rpdj4KICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiBza2VsZXRvbkNhcmRzKG4pewogIHJldHVybiBBcnJheS5mcm9tKHtsZW5ndGg6bn0pLm1hcCgoKT0+YDxkaXYgY2xhc3M9ImdsYXNzIHNrZWwtY2FyZCBza2VsIj48L2Rpdj5gKS5qb2luKCIiKTsKfQpmdW5jdGlv",
  "biBza2VsZXRvbkxpbmVzKG4pewogIHJldHVybiBBcnJheS5mcm9tKHtsZW5ndGg6bn0pLm1hcCgoKT0+YDxkaXYgY2xhc3M9InNrZWwgc2tlbC1saW5lIiBzdHlsZT0id2lkdGg6JHs2MCtNYXRoLnJhbmRvbSgpKjM1fSUiPjwvZGl2PmApLmpvaW4oIiIpOwp9Cgov",
  "KiAtLS0tLS0tLS0tLS0tLS0tIFNFQVJDSCAtLS0tLS0tLS0tLS0tLS0tICovCmZ1bmN0aW9uIHNlYXJjaEJsb2NrKCl7CiAgcmV0dXJuIGAKICA8ZGl2IGNsYXNzPSJzZWFyY2gtd3JhcCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4OyI+CiAgICA8ZGl2IGNsYXNzPSJz",
  "ZWFyY2gtYm94IGdsYXNzIiBpZD0ic2VhcmNoQm94Ij4KICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0i",
  "MTEiIGN5PSIxMSIgcj0iNyIvPjxwYXRoIGQ9Ik0yMSAyMWwtNC4zLTQuMyIvPjwvc3ZnPgogICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9InNlYXJjaElucHV0IiBwbGFjZWhvbGRlcj0iU2VhcmNoIHN0b2NrcyBieSBuYW1lIG9yIHRpY2tlcuKApiIgYXV0b2Nv",
  "bXBsZXRlPSJvZmYiPgogICAgICA8a2JkIGNsYXNzPSJrc2hvcnRjdXQiPi88L2tiZD4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0ic2VhcmNoLWRyb3AgZ2xhc3MiIGlkPSJzZWFyY2hEcm9wIiBzdHlsZT0iZGlzcGxheTpub25lOyI+PC9kaXY+CiAgPC9kaXY+",
  "YDsKfQoKbGV0IHNlYXJjaERlYm91bmNlOwpmdW5jdGlvbiB3aXJlU2VhcmNoKCl7CiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoSW5wdXQiKTsKICBjb25zdCBib3ggPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNo",
  "Qm94Iik7CiAgY29uc3QgZHJvcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hEcm9wIik7CiAgaWYoIWlucHV0KSByZXR1cm47CgogIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoImtleWRvd24iLCAoZSk9PnsKICAgIGlmKGUua2V5ID09PSAiLyIg",
  "JiYgZG9jdW1lbnQuYWN0aXZlRWxlbWVudCAhPT0gaW5wdXQpewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGlucHV0LmZvY3VzKCk7CiAgICB9CiAgICBpZihlLmtleSA9PT0gIkVzY2FwZSIpeyBpbnB1dC5ibHVyKCk7IGRyb3Auc3R5bGUuZGlzcGxh",
  "eT0ibm9uZSI7IGJveC5jbGFzc0xpc3QucmVtb3ZlKCJmb2N1c2VkIik7IH0KICB9KTsKCiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigiZm9jdXMiLCAoKT0+IGJveC5jbGFzc0xpc3QuYWRkKCJmb2N1c2VkIikpOwogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoImJs",
  "dXIiLCAoKT0+IHNldFRpbWVvdXQoKCk9PnsgYm94LmNsYXNzTGlzdC5yZW1vdmUoImZvY3VzZWQiKTsgZHJvcC5zdHlsZS5kaXNwbGF5PSJub25lIjsgfSwgMTYwKSk7CgogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoImlucHV0IiwgKCk9PnsKICAgIGNsZWFyVGlt",
  "ZW91dChzZWFyY2hEZWJvdW5jZSk7CiAgICBjb25zdCBxID0gaW5wdXQudmFsdWU7CiAgICBpZighcS50cmltKCkpeyBkcm9wLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyByZXR1cm47IH0KICAgIGRyb3Auc3R5bGUuZGlzcGxheT0iYmxvY2siOwogICAgZHJvcC5pbm5l",
  "ckhUTUwgPSBgPGRpdiBzdHlsZT0icGFkZGluZzoxNHB4IDE2cHg7Ij4ke3NrZWxldG9uTGluZXMoMyl9PC9kaXY+YDsKICAgIHNlYXJjaERlYm91bmNlID0gc2V0VGltZW91dChhc3luYyAoKT0+ewogICAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgQVBJLnNlYXJj",
  "aFN0b2NrcyhxKTsKICAgICAgaWYoIXJlc3VsdHMubGVuZ3RoKXsKICAgICAgICBkcm9wLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJzZWFyY2gtZW1wdHkiPk5vIHN0b2NrcyBtYXRjaCDigJwke2VzY2FwZUh0bWwocSl94oCdPC9kaXY+YDsKICAgICAgICByZXR1",
  "cm47CiAgICAgIH0KICAgICAgZHJvcC5pbm5lckhUTUwgPSByZXN1bHRzLm1hcCgocyxpKT0+YAogICAgICAgIDxkaXYgY2xhc3M9InNlYXJjaC1yb3ciIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjI4fW1zIiBkYXRhLXRpY2tlcj0iJHtzLnR9Ij4KICAgICAg",
  "ICAgIDxkaXYgY2xhc3M9InNyLWxlZnQiPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJzci10aWNrZXIiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ic3ItbmFtZSI+JHtlc2NhcGVIdG1s",
  "KHMubmFtZSl9PC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ic3ItbWV0YSI+JHtzLnR9IMK3ICR7cy5leGNofTwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0ic3ItcHJpY2UgdGFidWxh",
  "ciI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIGApLmpvaW4oIiIpOwogICAgICBkcm9wLnF1ZXJ5U2VsZWN0b3JBbGwoIi5zZWFyY2gtcm93IikuZm9yRWFjaChyb3c9PnsKICAgICAgICByb3cuYWRkRXZlbnRMaXN0ZW5lcigi",
  "bW91c2Vkb3duIiwgKCk9PnsKICAgICAgICAgIG5hdmlnYXRlKCJkZXRhaWwiLCByb3cuZGF0YXNldC50aWNrZXIpOwogICAgICAgIH0pOwogICAgICB9KTsKICAgIH0sIDI2MCk7CiAgfSk7Cn0KZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaFRvZ2dsZUJ0",
  "biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hJbnB1dCIpOwogIGlmKGlucHV0KSBpbnB1dC5mb2N1cygpOwogIGVsc2UgbmF2aWdhdGUoImRhc2hib2FyZCIpOwp9",
  "KTsKCi8qIC0tLS0tLS0tLS0tLS0tLS0gU0hBUkVEIFRBQkxFIFJFTkRFUiAtLS0tLS0tLS0tLS0tLS0tICovCmZ1bmN0aW9uIHJlbmRlclRhYmxlSW50byh3cmFwSWQsIGNhcmRzSWQsIGxpc3QsIHNvcnQsIHNob3dTZWN0b3JDb2wpewogIGNvbnN0IHdyYXAgPSBk",
  "b2N1bWVudC5nZXRFbGVtZW50QnlJZCh3cmFwSWQpOwogIGNvbnN0IGNhcmRzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoY2FyZHNJZCk7CiAgaWYoIWxpc3QubGVuZ3RoKXsKICAgIHdyYXAuaW5uZXJIVE1MID0gZW1wdHlTdGF0ZUhUTUwoIk5vIHN0b2NrcyBt",
  "YXRjaCB5b3VyIGZpbHRlcnMiLCAiVHJ5IHdpZGVuaW5nIHlvdXIgcHJpY2UgcmFuZ2Ugb3IgY2xlYXJpbmcgYSBmaWx0ZXIuIik7CiAgICBpZihjYXJkcykgY2FyZHMuaW5uZXJIVE1MID0gIiI7CiAgICByZXR1cm47CiAgfQogIGNvbnN0IHNvcnRlZCA9IHNvcnRT",
  "dG9ja3MobGlzdCwgc29ydCk7CgogIHdyYXAuaW5uZXJIVE1MID0gYAogICAgPHRhYmxlIGNsYXNzPSJzdG9jay10YWJsZSI+CiAgICAgIDx0aGVhZD48dHI+CiAgICAgICAgPHRoPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJuYW1lIj5Db21wYW55PHNwYW4g",
  "Y2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9InByaWNlIj5QcmljZTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJjaGFuZ2UiPkNoYW5nZTxzcGFuIGNs",
  "YXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJwY3QiPkNoYW5nZSAlPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9Im1hcmtldENhcCI+TWFya2V0IENhcDxz",
  "cGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJ2b2x1bWUiPlZvbHVtZTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJoaWdoNTIiPjUyVyBIaWdo",
  "PHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9ImxvdzUyIj41MlcgTG93PHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgPC90cj48L3RoZWFkPgogICAgICA8dGJvZHk+CiAg",
  "ICAgICAgJHtzb3J0ZWQubWFwKChzLGkpPT5zdG9ja1Jvd0hUTUwocyxpKSkuam9pbigiIil9CiAgICAgIDwvdGJvZHk+CiAgICA8L3RhYmxlPgogIGA7CiAgd3JhcC5xdWVyeVNlbGVjdG9yQWxsKCJ0aFtkYXRhLWtleV0iKS5mb3JFYWNoKHRoPT57CiAgICB0aC5j",
  "bGFzc0xpc3QudG9nZ2xlKCJzb3J0ZWQiLCB0aC5kYXRhc2V0LmtleT09PXNvcnQua2V5KTsKICAgIGlmKHRoLmRhdGFzZXQua2V5PT09c29ydC5rZXkpeyBjb25zdCBpbmQgPSB0aC5xdWVyeVNlbGVjdG9yKCIuc29ydC1pbmQiKTsgaWYoaW5kKSBpbmQudGV4dENv",
  "bnRlbnQgPSBzb3J0LmRpcj09PSJkZXNjIj8i4pa+Ijoi4pa0IjsgfQogICAgdGguYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgICBjb25zdCBrZXkgPSB0aC5kYXRhc2V0LmtleTsKICAgICAgY29uc3QgbmV3RGlyID0gKHNvcnQua2V5PT09a2V5",
  "ICYmIHNvcnQuZGlyPT09ImRlc2MiKSA/ICJhc2MiIDogImRlc2MiOwogICAgICBjb25zdCBuZXdTb3J0ID0ge2tleSwgZGlyOm5ld0Rpcn07CiAgICAgIGlmKHdyYXBJZD09PSJzY3JlZW5lclRhYmxlV3JhcCIpIHN0YXRlLnNjcmVlbmVyU29ydCA9IG5ld1NvcnQ7",
  "CiAgICAgIHJlbmRlclRhYmxlSW50byh3cmFwSWQsIGNhcmRzSWQsIGxpc3QsIG5ld1NvcnQsIHNob3dTZWN0b3JDb2wpOwogICAgfSk7CiAgfSk7CiAgd2lyZVJvd0ludGVyYWN0aW9ucyh3cmFwKTsKCiAgaWYoY2FyZHMpewogICAgY2FyZHMuaW5uZXJIVE1MID0g",
  "c29ydGVkLm1hcCgocyxpKT0+c3RvY2tDYXJkSFRNTChzLGkpKS5qb2luKCIiKTsKICAgIHdpcmVSb3dJbnRlcmFjdGlvbnMoY2FyZHMpOwogIH0KfQoKZnVuY3Rpb24gc29ydFN0b2NrcyhsaXN0LCBzb3J0KXsKICByZXR1cm4gbGlzdC5zbGljZSgpLnNvcnQoKGEs",
  "Yik9PnsKICAgIGxldCBhdj1hW3NvcnQua2V5XSwgYnY9Yltzb3J0LmtleV07CiAgICBpZihzb3J0LmtleT09PSJuYW1lIil7IGF2PWEubmFtZTsgYnY9Yi5uYW1lOyByZXR1cm4gc29ydC5kaXI9PT0iYXNjIj8gYXYubG9jYWxlQ29tcGFyZShidikgOiBidi5sb2Nh",
  "bGVDb21wYXJlKGF2KTsgfQogICAgcmV0dXJuIHNvcnQuZGlyPT09ImFzYyIgPyBhdi1idiA6IGJ2LWF2OwogIH0pOwp9CgpmdW5jdGlvbiBzdG9ja1Jvd0hUTUwocyxpKXsKICBjb25zdCBwb3MgPSBzLnBjdD49MDsKICBjb25zdCBpbldhdGNoID0gc3RhdGUud2F0",
  "Y2hsaXN0LmluY2x1ZGVzKHMudCk7CiAgcmV0dXJuIGAKICA8dHIgZGF0YS10aWNrZXI9IiR7cy50fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqMjJ9bXMiPgogICAgPHRkIG9uY2xpY2s9ImV2ZW50LnN0b3BQcm9wYWdhdGlvbigpIj4KICAgICAgPGJ1dHRv",
  "biBjbGFzcz0ic3Rhci1idG4gJHtpbldhdGNoPydhY3RpdmUnOicnfSIgZGF0YS1zdGFyPSIke3MudH0iIHRpdGxlPSIke2luV2F0Y2g/J1JlbW92ZSBmcm9tIHdhdGNobGlzdCc6J0FkZCB0byB3YXRjaGxpc3QnfSI+CiAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAg",
  "MjQgMjQiIGZpbGw9IiR7aW5XYXRjaD8nY3VycmVudENvbG9yJzonbm9uZSd9IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMTIgMTcuM2wtNi4xNiAzLjYgMS42NC02LjlMMiA5LjRsNy4wNi0uNkwxMiAyLjRsMi45NCA2",
  "LjQgNy4wNi42LTUuNDggNC42IDEuNjQgNi45eiIvPjwvc3ZnPgogICAgICA8L2J1dHRvbj4KICAgIDwvdGQ+CiAgICA8dGQ+CiAgICAgIDxkaXYgY2xhc3M9ImNlbGwtY29tcGFueSI+CiAgICAgICAgPGRpdiBjbGFzcz0iY2VsbC10aWNrZXItYmFkZ2UiPiR7cy50",
  "LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktbmFtZSI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5leGNo",
  "fTwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPjxzcGFuIGNsYXNzPSJjaGFuZ2UtcGlsbCAke3Bvcz8n",
  "cG9zJzonbmVnJ30iPiR7Y2hnU3RyKHMuY2hhbmdlKX08L3NwYW4+PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+PHNwYW4gY2xhc3M9ImNoYW5nZS1waWxsICR7cG9zPydwb3MnOiduZWcnfSI+JHtwY3RTdHIocy5wY3QpfTwvc3Bhbj48L3RkPgogICAgPHRk",
  "IGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdENvbXBhY3Qocy5tYXJrZXRDYXApfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10Vm9sKHMudm9sdW1lKX08L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdElOUihzLmhpZ2g1Mil9PC90ZD4KICAg",
  "IDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRJTlIocy5sb3c1Mil9PC90ZD4KICA8L3RyPmA7Cn0KCmZ1bmN0aW9uIHN0b2NrQ2FyZEhUTUwocyxpKXsKICBjb25zdCBwb3MgPSBzLnBjdD49MDsKICBjb25zdCBpbldhdGNoID0gc3RhdGUud2F0Y2hsaXN0LmluY2x1",
  "ZGVzKHMudCk7CiAgcmV0dXJuIGAKICA8ZGl2IGNsYXNzPSJnbGFzcyBzdG9jay1jYXJkIiBkYXRhLXRpY2tlcj0iJHtzLnR9IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSoyNn1tcyI+CiAgICA8ZGl2IGNsYXNzPSJsZWZ0Ij4KICAgICAgPGRpdiBjbGFzcz0i",
  "Y2VsbC10aWNrZXItYmFkZ2UiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im5hbWUtYmxvY2siPgogICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktbmFtZSI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgPGRpdiBj",
  "bGFzcz0iY29tcGFueS1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJpZ2h0Ij4KICAgICAgPGRpdiBjbGFzcz0icHJpY2UgdGFidWxhciI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+",
  "CiAgICAgIDxzcGFuIGNsYXNzPSJjaGFuZ2UtcGlsbCAke3Bvcz8ncG9zJzonbmVnJ30iIHN0eWxlPSJtYXJnaW4tdG9wOjRweDsiPiR7cGN0U3RyKHMucGN0KX08L3NwYW4+CiAgICA8L2Rpdj4KICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiB3aXJlUm93SW50ZXJhY3Rp",
  "b25zKGNvbnRhaW5lcil7CiAgY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoInRyW2RhdGEtdGlja2VyXSwgLnN0b2NrLWNhcmRbZGF0YS10aWNrZXJdIikuZm9yRWFjaChlbD0+ewogICAgZWwuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+IG5hdmlnYXRl",
  "KCJkZXRhaWwiLCBlbC5kYXRhc2V0LnRpY2tlcikpOwogIH0pOwogIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1zdGFyXSIpLmZvckVhY2goYnRuPT57CiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgICAgZS5zdG9w",
  "UHJvcGFnYXRpb24oKTsKICAgICAgdG9nZ2xlV2F0Y2goYnRuLmRhdGFzZXQuc3Rhcik7CiAgICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiKTsKICAgICAgYnRuLnF1ZXJ5U2VsZWN0b3IoInN2ZyIpLnNldEF0dHJpYnV0ZSgiZmlsbCIsIGJ0bi5jbGFz",
  "c0xpc3QuY29udGFpbnMoImFjdGl2ZSIpID8gImN1cnJlbnRDb2xvciIgOiAibm9uZSIpOwogICAgfSk7CiAgfSk7Cn0KCmZ1bmN0aW9uIHRvZ2dsZVdhdGNoKHRpY2tlcil7CiAgY29uc3QgaWR4ID0gc3RhdGUud2F0Y2hsaXN0LmluZGV4T2YodGlja2VyKTsKICBp",
  "ZihpZHg+PTApIHN0YXRlLndhdGNobGlzdC5zcGxpY2UoaWR4LDEpOwogIGVsc2Ugc3RhdGUud2F0Y2hsaXN0LnB1c2godGlja2VyKTsKICBwZXJzaXN0V2F0Y2hsaXN0KCk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gU0NSRUVORVIgLS0tLS0tLS0tLS0tLS0tLSAq",
  "Lwphc3luYyBmdW5jdGlvbiByZW5kZXJTY3JlZW5lcigpewogIGNvbnN0IHNlY3RvcnMgPSBbIkFsbCIsIC4uLkFycmF5LmZyb20obmV3IFNldChVTklWRVJTRS5tYXAocz0+cy5zZWN0b3IpKSldOwogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0i",
  "dmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPlNjcmVlbmVyPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5GaWx0ZXIgdGhlIG1hcmtldCBvbiB5b3VyIHRlcm1zPC9zcGFuPjwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iZ2xhc3MgZmlsdGVy",
  "cy1iYXIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpbHRlci1jaGlwIiBzdHlsZT0ibWluLXdpZHRoOjIwMHB4OyI+CiAgICAgICAgICA8bGFiZWw+U2VhcmNoPC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0iZlF1ZXJ5IiBwbGFjZWhvbGRl",
  "cj0iVGlja2VyIG9yIGNvbXBhbnnigKYiIHZhbHVlPSIke2VzY2FwZUh0bWwoc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnF1ZXJ5KX0iPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpbHRlci1jaGlwIj4KICAgICAgICAgIDxsYWJlbD5TZWN0b3I8",
  "L2xhYmVsPgogICAgICAgICAgPHNlbGVjdCBpZD0iZlNlY3RvciI+JHtzZWN0b3JzLm1hcChzPT5gPG9wdGlvbiAke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5zZWN0b3I9PT1zPydzZWxlY3RlZCc6Jyd9PiR7c308L29wdGlvbj5gKS5qb2luKCIiKX08L3NlbGVjdD4K",
  "ICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCI+CiAgICAgICAgICA8bGFiZWw+TWF4IFByaWNlIDxzcGFuIGNsYXNzPSJyYW5nZS12YWwiIGlkPSJmUHJpY2VWYWwiPiR7Zm10SU5SKHN0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQ",
  "cmljZSwwKX08L3NwYW4+PC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJyYW5nZSIgY2xhc3M9InJhbmdlLXNsaWRlciIgaWQ9ImZNYXhQcmljZSIgbWluPSI1MDAiIG1heD0iMTUwMDAiIHN0ZXA9IjI1MCIgdmFsdWU9IiR7c3RhdGUuc2NyZWVuZXJGaWx0",
  "ZXJzLm1heFByaWNlfSI+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmlsdGVyLWNoaXAiIHN0eWxlPSJtaW4td2lkdGg6MTkwcHg7Ij4KICAgICAgICAgIDxsYWJlbD5EaXJlY3Rpb248L2xhYmVsPgogICAgICAgICAgPGRpdiBjbGFzcz0idG9n",
  "Z2xlLWdyb3VwIj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0idG9nZ2xlLWJ0biAke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb249PT0nYWxsJz8nYWN0aXZlJzonJ30iIGRhdGEtZGlyPSJhbGwiPkFsbDwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNz",
  "PSJ0b2dnbGUtYnRuICR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLmRpcmVjdGlvbj09PSdnYWluZXJzJz8nYWN0aXZlJzonJ30iIGRhdGEtZGlyPSJnYWluZXJzIj5HYWluZXJzPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1idG4gJHtzdGF0ZS5z",
  "Y3JlZW5lckZpbHRlcnMuZGlyZWN0aW9uPT09J2xvc2Vycyc/J2FjdGl2ZSc6Jyd9IiBkYXRhLWRpcj0ibG9zZXJzIj5Mb3NlcnM8L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlc2V0LWZpbHRlcnMiIGlk",
  "PSJyZXNldEZpbHRlcnMiPlJlc2V0IGZpbHRlcnM8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMiBpZD0ic2NyZWVuZXJDb3VudCI+UmVzdWx0czwvaDI+PHNwYW4gY2xhc3M9InN1YiI+U29ydGVkIGJ5IG1hcmtl",
  "dCBjYXA8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAgZ2xhc3MiIGlkPSJzY3JlZW5lclRhYmxlV3JhcCI+PGRpdiBzdHlsZT0icGFkZGluZzoyMHB4OyI+JHtza2VsZXRvbkxpbmVzKDgpfTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNs",
  "YXNzPSJzdG9jay1jYXJkcyIgaWQ9InNjcmVlbmVyQ2FyZHMiPjwvZGl2PgogICAgPC9kaXY+CiAgYDsKCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImZRdWVyeSIpLmFkZEV2ZW50TGlzdGVuZXIoImlucHV0IiwgZGVib3VuY2UoZT0+ewogICAgc3RhdGUuc2Ny",
  "ZWVuZXJGaWx0ZXJzLnF1ZXJ5ID0gZS50YXJnZXQudmFsdWU7IHJ1blNjcmVlbmVyKCk7CiAgfSwgMjYwKSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImZTZWN0b3IiKS5hZGRFdmVudExpc3RlbmVyKCJjaGFuZ2UiLCBlPT57CiAgICBzdGF0ZS5zY3JlZW5l",
  "ckZpbHRlcnMuc2VjdG9yID0gZS50YXJnZXQudmFsdWU7IHJ1blNjcmVlbmVyKCk7CiAgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImZNYXhQcmljZSIpLmFkZEV2ZW50TGlzdGVuZXIoImlucHV0IiwgZT0+ewogICAgc3RhdGUuc2NyZWVuZXJGaWx0ZXJz",
  "Lm1heFByaWNlID0gTnVtYmVyKGUudGFyZ2V0LnZhbHVlKTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJmUHJpY2VWYWwiKS50ZXh0Q29udGVudCA9IGZtdElOUihzdGF0ZS5zY3JlZW5lckZpbHRlcnMubWF4UHJpY2UsMCk7CiAgICBydW5TY3JlZW5lcigp",
  "OwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWRpcl0iKS5mb3JFYWNoKGJ0bj0+ewogICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgICAgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLmRpcmVjdGlvbiA9IGJ0bi5k",
  "YXRhc2V0LmRpcjsKICAgICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtZGlyXSIpLmZvckVhY2goYj0+Yi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiLCBiPT09YnRuKSk7CiAgICAgIHJ1blNjcmVlbmVyKCk7CiAgICB9KTsKICB9KTsKICBkb2N1",
  "bWVudC5nZXRFbGVtZW50QnlJZCgicmVzZXRGaWx0ZXJzIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzID0ge3F1ZXJ5OiIiLCBzZWN0b3I6IkFsbCIsIG1pblByaWNlOjAsIG1heFByaWNlOjE1MDAwLCBk",
  "aXJlY3Rpb246ImFsbCJ9OwogICAgcmVuZGVyU2NyZWVuZXIoKTsKICB9KTsKCiAgcnVuU2NyZWVuZXIoKTsKfQoKZnVuY3Rpb24gZGVib3VuY2UoZm4sIG1zKXsKICBsZXQgaDsKICByZXR1cm4gKC4uLmFyZ3MpPT57IGNsZWFyVGltZW91dChoKTsgaD1zZXRUaW1l",
  "b3V0KCgpPT5mbiguLi5hcmdzKSwgbXMpOyB9Owp9Cgphc3luYyBmdW5jdGlvbiBydW5TY3JlZW5lcigpewogIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2NyZWVuZXJUYWJsZVdyYXAiKTsKICB3cmFwLnN0eWxlLm9wYWNpdHkgPSAiMC41",
  "NSI7CiAgdHJ5ewogICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IEFQSS5mZXRjaFNjcmVlbmVyUmVzdWx0cyhzdGF0ZS5zY3JlZW5lckZpbHRlcnMpOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNjcmVlbmVyQ291bnQiKS50ZXh0Q29udGVudCA9IGBSZXN1",
  "bHRzICgke3Jlc3VsdHMubGVuZ3RofSlgOwogICAgLy8gT25lLXRpbWUgZGlhZ25vc3RpYzogaWYgYSBzZWN0b3IgZmlsdGVyIHlpZWxkcyB6ZXJvLCBzaG93IGV4YWN0bHkgd2hhdAogICAgLy8gc2VjdG9yIHZhbHVlcyBhY3R1YWxseSBleGlzdCBpbiB0aGUgbG9h",
  "ZGVkIGRhdGEgc28gYSBtaXNtYXRjaCAodHlwbywKICAgIC8vIGNhc2luZywgc3RhbGUgZmllbGQpIGlzIHZpc2libGUgaW5zdGVhZCBvZiBndWVzc2VkIGF0LgogICAgaWYocmVzdWx0cy5sZW5ndGggPT09IDAgJiYgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3Rv",
  "ciAmJiBzdGF0ZS5zY3JlZW5lckZpbHRlcnMuc2VjdG9yICE9PSAiQWxsIil7CiAgICAgIHRyeXsKICAgICAgICBjb25zdCB1bmZpbHRlcmVkID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHsuLi5zdGF0ZS5zY3JlZW5lckZpbHRlcnMsIHNlY3Rvcjoi",
  "QWxsIn0pOwogICAgICAgIGNvbnN0IHNlZW5TZWN0b3JzID0gQXJyYXkuZnJvbShuZXcgU2V0KHVuZmlsdGVyZWQubWFwKHM9PnMuc2VjdG9yKSkpOwogICAgICAgIHNob3dFcnJvckJhbm5lcihgREVCVUc6IDAgcmVzdWx0cyBmb3Igc2VjdG9yICIke3N0YXRlLnNj",
  "cmVlbmVyRmlsdGVycy5zZWN0b3J9Ii4gJHt1bmZpbHRlcmVkLmxlbmd0aH0gc3RvY2tzIGxvYWRlZCB0b3RhbC4gU2VjdG9yIHZhbHVlcyBhY3R1YWxseSBwcmVzZW50OiAke0pTT04uc3RyaW5naWZ5KHNlZW5TZWN0b3JzKX1gKTsKICAgICAgfWNhdGNoKGUpeyAv",
  "KiBkaWFnbm9zdGljIG9ubHksIGlnbm9yZSBmYWlsdXJlcyBoZXJlICovIH0KICAgIH0KICAgIHJlbmRlclRhYmxlSW50bygic2NyZWVuZXJUYWJsZVdyYXAiLCAic2NyZWVuZXJDYXJkcyIsIHJlc3VsdHMsIHN0YXRlLnNjcmVlbmVyU29ydCwgdHJ1ZSk7CiAgfWNh",
  "dGNoKGUpewogICAgd3JhcC5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiU2NyZWVuZXIgZGF0YSB1bmF2YWlsYWJsZSIsICJXZSBjb3VsZG4ndCBsb2FkIG1hdGNoaW5nIHN0b2NrcyByaWdodCBub3cuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIiki",
  "KTsKICAgIHNob3dFcnJvckJhbm5lcigicnVuU2NyZWVuZXIgZmFpbGVkOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsKICB9CiAgd3JhcC5zdHlsZS5vcGFjaXR5ID0gIjEiOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIE1BUktFVFMgKGZ1bGwgdW5pdmVyc2Ug",
  "dGFibGUgKyB0cmVuZGluZyBoaWdobGlnaHRzKSAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlck1hcmtldHMoKXsKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9u",
  "LWhlYWQiPjxoMj5NYXJrZXRzPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5GdWxsIE5TRSB1bml2ZXJzZSBzbmFwc2hvdDwvc3Bhbj48L2Rpdj4KICAgICAgJHtzZWFyY2hCbG9jaygpfQoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+VHJlbmRpbmcg",
  "Tm93PC9oMj48c3BhbiBjbGFzcz0ic3ViIj5Ub2RheSdzIGJpZ2dlc3QgbW92ZXJzLCB1cCBvciBkb3duPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0cmVuZGluZy1yb3ciIGlkPSJ0cmVuZGluZ1JvdyI+JHtza2VsZXRvbkNhcmRzKDQpfTwvZGl2PgoK",
  "ICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHg7Ij48aDI+QWxsIFN0b2NrczwvaDI+PHNwYW4gY2xhc3M9InN1YiI+U29ydGVkIGJ5IG1hcmtldCBjYXA8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxl",
  "LXdyYXAgZ2xhc3MiIGlkPSJtYXJrZXRzVGFibGVXcmFwIj48ZGl2IHN0eWxlPSJwYWRkaW5nOjIwcHg7Ij4ke3NrZWxldG9uTGluZXMoMTApfTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdG9jay1jYXJkcyIgaWQ9Im1hcmtldHNDYXJkcyI+PC9kaXY+",
  "CiAgICA8L2Rpdj4KICBgOwogIHdpcmVTZWFyY2goKTsKICB0cnl7CiAgICBjb25zdCBsaXN0ID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHt9KTsKICAgIHJlbmRlclRyZW5kaW5nKGxpc3QpOwogICAgcmVuZGVyVGFibGVJbnRvKCJtYXJrZXRzVGFi",
  "bGVXcmFwIiwgIm1hcmtldHNDYXJkcyIsIGxpc3QsIHtrZXk6Im1hcmtldENhcCIsIGRpcjoiZGVzYyJ9LCB0cnVlKTsKICB9Y2F0Y2goZSl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibWFya2V0c1RhYmxlV3JhcCIpLmlubmVySFRNTCA9IGVycm9yU3Rh",
  "dGVIVE1MKCJNYXJrZXQgZGF0YSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZSIsICJQbGVhc2UgdHJ5IGFnYWluIGluIGEgbW9tZW50LiIpOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRyZW5kaW5nUm93IikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwo",
  "IlRyZW5kaW5nIGRhdGEgdW5hdmFpbGFibGUiLCAiUGxlYXNlIHRyeSBhZ2FpbiBpbiBhIG1vbWVudC4iKTsKICB9Cn0KCmZ1bmN0aW9uIHJlbmRlclRyZW5kaW5nKGxpc3QpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRyZW5kaW5nUm93",
  "Iik7CiAgaWYoIWVsKSByZXR1cm47CiAgaWYoIWxpc3QubGVuZ3RoKXsgZWwuaW5uZXJIVE1MID0gZW1wdHlTdGF0ZUhUTUwoIk5vIHRyZW5kaW5nIGRhdGEiLCAiTm8gc3RvY2tzIHdlcmUgcmV0dXJuZWQgdG8gcmFuay4iKTsgcmV0dXJuOyB9CiAgY29uc3QgaG90",
  "ID0gbGlzdC5zbGljZSgpLnNvcnQoKGEsYik9Pk1hdGguYWJzKGIucGN0KS1NYXRoLmFicyhhLnBjdCkpLnNsaWNlKDAsNik7CiAgZWwuaW5uZXJIVE1MID0gaG90Lm1hcCgocyxpKT0+ewogICAgY29uc3QgcG9zID0gcy5wY3Q+PTA7CiAgICByZXR1cm4gYAogICAg",
  "PGRpdiBjbGFzcz0iZ2xhc3MgdHJlbmRpbmctY2FyZCIgZGF0YS10aWNrZXI9IiR7cy50fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqNDB9bXMiPgogICAgICA8ZGl2IGNsYXNzPSJ0cmVuZGluZy10b3AiPgogICAgICAgIDxkaXYgY2xhc3M9ImNlbGwtdGlj",
  "a2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImluZGV4LWJhZGdlICR7cG9zPydwb3MnOiduZWcnfSI+JHtwb3M/J+KWsic6J+KWvCd9ICR7cGN0U3RyKHMucGN0KX08L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxk",
  "aXYgY2xhc3M9ImNvbXBhbnktbmFtZSIgc3R5bGU9Im1hcmdpbi10b3A6MTBweDsiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5leGNofTwvZGl2PgogICAgICA8ZGl2IGNsYXNz",
  "PSJpbmRleC12YWx1ZSB0YWJ1bGFyIiBzdHlsZT0iZm9udC1zaXplOjE5cHg7bWFyZ2luLXRvcDo4cHg7Ij4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtc3BhcmsiIHN0eWxlPSJoZWlnaHQ6MjhweDttYXJnaW4tdG9wOjhw",
  "eDsiPiR7c3BhcmtsaW5lU1ZHKHMuc2VyaWVzLCBwb3MpfTwvZGl2PgogICAgPC9kaXY+YDsKICB9KS5qb2luKCIiKTsKICBlbC5xdWVyeVNlbGVjdG9yQWxsKCIudHJlbmRpbmctY2FyZCIpLmZvckVhY2goY2FyZD0+ewogICAgY2FyZC5hZGRFdmVudExpc3RlbmVy",
  "KCJjbGljayIsICgpPT4gbmF2aWdhdGUoImRldGFpbCIsIGNhcmQuZGF0YXNldC50aWNrZXIpKTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBXQVRDSExJU1QgLS0tLS0tLS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJXYXRjaGxpc3QoKXsK",
  "ICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5XYXRjaGxpc3Q8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPiR7c3RhdGUud2F0Y2hsaXN0Lmxlbmd0aH0gc3RvY2ske3N0YXRl",
  "LndhdGNobGlzdC5sZW5ndGg9PT0xPycnOidzJ30gdHJhY2tlZDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0id2F0Y2hsaXN0LWdyaWQiIGlkPSJ3YXRjaEdyaWQiPiR7c2tlbGV0b25DYXJkcyhNYXRoLm1heChzdGF0ZS53YXRjaGxpc3QubGVuZ3RoLDMp",
  "KX08L2Rpdj4KICAgIDwvZGl2PgogIGA7CiAgaWYoIXN0YXRlLndhdGNobGlzdC5sZW5ndGgpewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIndhdGNoR3JpZCIpLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ3YXRjaC1lbXB0eSBnbGFzcyI+JHtlbXB0eVN0",
  "YXRlSW5uZXIoIllvdXIgd2F0Y2hsaXN0IGlzIGVtcHR5IiwgIlN0YXIgYW55IHN0b2NrIGZyb20gdGhlIGRhc2hib2FyZCwgc2NyZWVuZXIgb3IgbWFya2V0cyB2aWV3IHRvIHRyYWNrIGl0IGhlcmUuIil9PC9kaXY+YDsKICAgIHJldHVybjsKICB9CiAgdHJ5ewog",
  "ICAgY29uc3Qgc3RvY2tzID0gYXdhaXQgUHJvbWlzZS5hbGwoc3RhdGUud2F0Y2hsaXN0Lm1hcCh0PT5BUEkuZmV0Y2hTdG9jayh0KSkpOwogICAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ3YXRjaEdyaWQiKTsKICAgIGdyaWQuaW5uZXJI",
  "VE1MID0gc3RvY2tzLmZpbHRlcihCb29sZWFuKS5tYXAoKHMsaSk9PndhdGNoQ2FyZEhUTUwocyxpKSkuam9pbigiIik7CiAgICB3aXJlV2F0Y2hDYXJkcygpOwogIH1jYXRjaChlKXsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ3YXRjaEdyaWQiKS5pbm5l",
  "ckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIGxvYWQgd2F0Y2hsaXN0IiwgIlBsZWFzZSB0cnkgYWdhaW4uIik7CiAgfQp9CgpmdW5jdGlvbiB3YXRjaENhcmRIVE1MKHMsaSl7CiAgY29uc3QgcG9zID0gcy5wY3Q+PTA7CiAgcmV0dXJuIGAKICA8ZGl2",
  "IGNsYXNzPSJnbGFzcyB3YXRjaC1jYXJkIGVudGVyaW5nIiBkYXRhLXRpY2tlcj0iJHtzLnR9IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSo0MH1tcyI+CiAgICA8ZGl2IGNsYXNzPSJ3YXRjaC10b3AiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9",
  "ImNvbXBhbnktbmFtZSI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9InN0YXItYnRuIGFjdGl2",
  "ZSIgZGF0YS11bnN0YXI9IiR7cy50fSIgdGl0bGU9IlJlbW92ZSI+CiAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9ImN1cnJlbnRDb2xvciIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTEyIDE3LjNs",
  "LTYuMTYgMy42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIgMi40bDIuOTQgNi40IDcuMDYuNi01LjQ4IDQuNiAxLjY0IDYuOXoiLz48L3N2Zz4KICAgICAgPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0",
  "eWxlPSJmb250LXNpemU6MjJweDsiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtY2hhbmdlICR7cG9zPydwb3MnOiduZWcnfSB0YWJ1bGFyIj4ke2NoZ1N0cihzLmNoYW5nZSl9ICgke3BjdFN0cihzLnBjdCl9KTwvZGl2Pgog",
  "ICAgPGRpdiBjbGFzcz0iaW5kZXgtc3BhcmsiPiR7c3BhcmtsaW5lU1ZHKHMuc2VyaWVzLCBwb3MpfTwvZGl2PgogIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHdpcmVXYXRjaENhcmRzKCl7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiLndhdGNoLWNhcmQiKS5m",
  "b3JFYWNoKGNhcmQ9PnsKICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgICAgaWYoZS50YXJnZXQuY2xvc2VzdCgiW2RhdGEtdW5zdGFyXSIpKSByZXR1cm47CiAgICAgIG5hdmlnYXRlKCJkZXRhaWwiLCBjYXJkLmRhdGFzZXQudGlj",
  "a2VyKTsKICAgIH0pOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLXVuc3Rhcl0iKS5mb3JFYWNoKGJ0bj0+ewogICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7CiAg",
  "ICAgIGNvbnN0IGNhcmQgPSBidG4uY2xvc2VzdCgiLndhdGNoLWNhcmQiKTsKICAgICAgY2FyZC5jbGFzc0xpc3QuYWRkKCJyZW1vdmluZyIpOwogICAgICB0b2dnbGVXYXRjaChidG4uZGF0YXNldC51bnN0YXIpOwogICAgICBzZXRUaW1lb3V0KCgpPT57CiAgICAg",
  "ICAgaWYoIXN0YXRlLndhdGNobGlzdC5sZW5ndGgpIHJlbmRlcldhdGNobGlzdCgpOwogICAgICAgIGVsc2UgY2FyZC5yZW1vdmUoKTsKICAgICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCIuc2VjdGlvbi1oZWFkIC5zdWIiKS50ZXh0Q29udGVudCA9IGAke3N0",
  "YXRlLndhdGNobGlzdC5sZW5ndGh9IHN0b2NrJHtzdGF0ZS53YXRjaGxpc3QubGVuZ3RoPT09MT8nJzoncyd9IHRyYWNrZWRgOwogICAgICB9LCAyODApOwogICAgfSk7CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gU1RPQ0sgREVUQUlMIC0tLS0tLS0tLS0t",
  "LS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyRGV0YWlsKCl7CiAgcm9vdC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0idmlldyIgaWQ9ImRldGFpbFNrZWxldG9uIj4KICAgIDxkaXYgY2xhc3M9ImdsYXNzIHNrZWwtY2FyZCBza2VsIiBzdHlsZT0iaGVpZ2h0",
  "Ojg4cHg7bWFyZ2luLWJvdHRvbToyNHB4OyI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJtZXRyaWNzLWdyaWQiPiR7c2tlbGV0b25DYXJkcyg2KX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdsYXNzIHNrZWwtY2FyZCBza2VsIiBzdHlsZT0iaGVpZ2h0OjMyMHB4OyI+",
  "PC9kaXY+CiAgPC9kaXY+YDsKCiAgbGV0IHM7CiAgdHJ5eyBzID0gYXdhaXQgQVBJLmZldGNoU3RvY2soc3RhdGUuZGV0YWlsVGlja2VyKTsgfWNhdGNoKGUpeyBzID0gbnVsbDsgfQogIGlmKCFzKXsKICAgIHJvb3QuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwo",
  "IlVuYWJsZSB0byByZXRyaWV2ZSB0aGlzIHN0b2NrIiwgIlRoZSB0aWNrZXIgeW91J3JlIGxvb2tpbmcgZm9yIGlzbid0IGF2YWlsYWJsZSByaWdodCBub3cuIik7CiAgICByZXR1cm47CiAgfQogIGNvbnN0IHBvcyA9IHMucGN0ID49IDA7CiAgY29uc3QgaW5XYXRj",
  "aCA9IHN0YXRlLndhdGNobGlzdC5pbmNsdWRlcyhzLnQpOwoKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtaGVhZCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXRpdGxlLXJvdyI+",
  "CiAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgICAgPGRpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2Pgog",
  "ICAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9IMK3ICR7cy5zZWN0b3J9PC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRl",
  "bXM6Y2VudGVyO2dhcDoxNHB4OyI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtcHJpY2UtYmxvY2siPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtcHJpY2UgdGFidWxhciI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+CiAgICAgICAgICAgIDxk",
  "aXYgY2xhc3M9ImRldGFpbC1jaGFuZ2UgJHtwb3M/J3Bvcyc6J25lZyd9IHRhYnVsYXIiPiR7Y2hnU3RyKHMuY2hhbmdlKX0gKCR7cGN0U3RyKHMucGN0KX0pIHRvZGF5PC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9Imljb24t",
  "YnRuIiBpZD0iZGV0YWlsU3RhciIgc3R5bGU9IndpZHRoOjQ0cHg7aGVpZ2h0OjQ0cHg7Y29sb3I6JHtpbldhdGNoPycjRkZDODU3JzondmFyKC0tdGV4dC1taWQpJ30iPgogICAgICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iJHtpbldhdGNo",
  "PydjdXJyZW50Q29sb3InOidub25lJ30iIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0eWxlPSJ3aWR0aDoxOXB4O2hlaWdodDoxOXB4OyI+PHBhdGggZD0iTTEyIDE3LjNsLTYuMTYgMy42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIg",
  "Mi40bDIuOTQgNi40IDcuMDYuNi01LjQ4IDQuNiAxLjY0IDYuOXoiLz48L3N2Zz4KICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9Im1ldHJpY3MtZ3JpZCI+CiAgICAgICAgJHttZXRyaWNDYXJk",
  "KCJPcGVuIiwgZm10SU5SKHMub3BlbikpfQogICAgICAgICR7bWV0cmljQ2FyZCgiRGF5IEhpZ2giLCBmbXRJTlIocy5kYXlIaWdoKSl9CiAgICAgICAgJHttZXRyaWNDYXJkKCJEYXkgTG93IiwgZm10SU5SKHMuZGF5TG93KSl9CiAgICAgICAgJHttZXRyaWNDYXJk",
  "KCJNYXJrZXQgQ2FwIiwgZm10Q29tcGFjdChzLm1hcmtldENhcCkpfQogICAgICAgICR7bWV0cmljQ2FyZCgiVm9sdW1lIiwgZm10Vm9sKHMudm9sdW1lKSl9CiAgICAgICAgJHttZXRyaWNDYXJkKCI1MlcgSGlnaCAvIExvdyIsIGZtdElOUihzLmhpZ2g1MiwwKSsi",
  "IC8gIitmbXRJTlIocy5sb3c1MiwwKSl9CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iZ2xhc3MgY2hhcnQtY2FyZCI+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtaGVhZCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiIHN0eWxl",
  "PSJtYXJnaW46MDsiPjxoMj5QcmljZSBDaGFydDwvaDI+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJyYW5nZS10YWJzIiBpZD0icmFuZ2VUYWJzIj4KICAgICAgICAgICAgJHtbIjFEIiwiMVciLCIxTSIsIjNNIiwiNk0iLCIxWSJdLm1hcChyPT5gPGJ1dHRv",
  "biBkYXRhLXJhbmdlPSIke3J9IiBjbGFzcz0iJHtzdGF0ZS5kZXRhaWxSYW5nZT09PXI/J2FjdGl2ZSc6Jyd9Ij4ke3J9PC9idXR0b24+YCkuam9pbigiIil9CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC1j",
  "YW52YXMtd3JhcCIgaWQ9ImNoYXJ0V3JhcCI+CiAgICAgICAgICA8Y2FudmFzIGlkPSJwcmljZUNoYXJ0Ij48L2NhbnZhcz4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXRvb2x0aXAiIGlkPSJjaGFydFRvb2x0aXAiPjwvZGl2PgogICAgICAgIDwvZGl2Pgog",
  "ICAgICAgIDxkaXYgY2xhc3M9InZvbHVtZS13cmFwIiBpZD0idm9sdW1lV3JhcCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ2b2x1bWUtbGFiZWwiPlZvbHVtZSA8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tdGV4dC1mYWludCk7Zm9udC13ZWlnaHQ6NjAwOyI+KHJl",
  "bGF0aXZlLCBkZXJpdmVkIGZyb20gcHJpY2UgbW92ZW1lbnQpPC9zcGFuPjwvZGl2PgogICAgICAgICAgPGNhbnZhcyBpZD0idm9sdW1lQ2hhcnQiPjwvY2FudmFzPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIGA7CgogIGRvY3VtZW50",
  "LmdldEVsZW1lbnRCeUlkKCJkZXRhaWxTdGFyIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgdG9nZ2xlV2F0Y2gocy50KTsKICAgIHJlbmRlckRldGFpbCgpOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJyYW5nZVRhYnMiKS5h",
  "ZGRFdmVudExpc3RlbmVyKCJjbGljayIsIChlKT0+ewogICAgY29uc3QgYnRuID0gZS50YXJnZXQuY2xvc2VzdCgiYnV0dG9uW2RhdGEtcmFuZ2VdIik7CiAgICBpZighYnRuKSByZXR1cm47CiAgICBzdGF0ZS5kZXRhaWxSYW5nZSA9IGJ0bi5kYXRhc2V0LnJhbmdl",
  "OwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiI3JhbmdlVGFicyBidXR0b24iKS5mb3JFYWNoKGI9PmIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIiwgYj09PWJ0bikpOwogICAgbG9hZENoYXJ0KHMudCwgcy5wY3Q+PTApOwogIH0pOwoKICBsb2FkQ2hh",
  "cnQocy50LCBwb3MpOwp9CgpmdW5jdGlvbiBtZXRyaWNDYXJkKGxhYmVsLCB2YWx1ZSl7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJnbGFzcyBtZXRyaWMtY2FyZCI+PGRpdiBjbGFzcz0ibWV0cmljLWxhYmVsIj4ke2xhYmVsfTwvZGl2PjxkaXYgY2xhc3M9Im1ldHJp",
  "Yy12YWx1ZSB0YWJ1bGFyIj4ke3ZhbHVlfTwvZGl2PjwvZGl2PmA7Cn0KCmFzeW5jIGZ1bmN0aW9uIGxvYWRDaGFydCh0aWNrZXIsIHBvc2l0aXZlKXsKICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImNoYXJ0V3JhcCIpOwogIGNvbnN0IGNh",
  "bnZhcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJwcmljZUNoYXJ0Iik7CiAgaWYoIXdyYXAgfHwgIWNhbnZhcykgcmV0dXJuOwogIGNhbnZhcy5zdHlsZS5vcGFjaXR5ID0gIjAuMjUiOwogIGxldCBzZXJpZXM7CiAgdHJ5ewogICAgc2VyaWVzID0gYXdhaXQg",
  "QVBJLmZldGNoU3RvY2tIaXN0b3J5KHRpY2tlciwgc3RhdGUuZGV0YWlsUmFuZ2UpOwogIH1jYXRjaChlKXsKICAgIHdyYXAuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIkNoYXJ0IGRhdGEgdW5hdmFpbGFibGUiLCAiVGhpcyB0aW1lZnJhbWUgY291bGRuJ3Qg",
  "YmUgbG9hZGVkLiBUcnkgYSBkaWZmZXJlbnQgcmFuZ2UuIik7CiAgICByZXR1cm47CiAgfQogIGNhbnZhcy5zdHlsZS5vcGFjaXR5ID0gIjEiOwogIGRyYXdDaGFydChjYW52YXMsIHNlcmllcywgcG9zaXRpdmUsIHRpY2tlcik7CiAgZHJhd1ZvbHVtZUNoYXJ0KHNl",
  "cmllcywgcG9zaXRpdmUpOwp9CgpmdW5jdGlvbiBkcmF3Vm9sdW1lQ2hhcnQoc2VyaWVzLCBwb3NpdGl2ZSl7CiAgY29uc3QgY2FudmFzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInZvbHVtZUNoYXJ0Iik7CiAgaWYoIWNhbnZhcykgcmV0dXJuOwogIGNvbnN0",
  "IHJlY3QgPSBjYW52YXMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgY29uc3QgZHByID0gd2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMTsKICBjYW52YXMud2lkdGggPSByZWN0LndpZHRoICogZHByOwogIGNhbnZhcy5oZWlnaHQgPSByZWN0LmhlaWdodCAq",
  "IGRwcjsKICBjb25zdCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dCgiMmQiKTsKICBjdHguc2NhbGUoZHByLGRwcik7CiAgY29uc3QgVyA9IHJlY3Qud2lkdGgsIEggPSByZWN0LmhlaWdodDsKICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwoKICAvLyBEZXJpdmUgYSBw",
  "bGF1c2libGUgcmVsYXRpdmUgdm9sdW1lIHByb2ZpbGUgZnJvbSB0aGUgcHJpY2Ugc2VyaWVzJwogIC8vIHBvaW50LXRvLXBvaW50IHZvbGF0aWxpdHkgKGJpZ2dlciBtb3ZlcyB0ZW5kIHRvIGNvaW5jaWRlIHdpdGggaGlnaGVyCiAgLy8gdm9sdW1lKSDigJQgaWxs",
  "dXN0cmF0aXZlIG9ubHk7IHRoZSBiYWNrZW5kIGhhcyBubyBoaXN0b3JpY2FsIHZvbHVtZSBmZWVkLgogIGNvbnN0IGRlbHRhcyA9IHNlcmllcy5tYXAoKHYsaSk9PiBpPT09MCA/IDAgOiBNYXRoLmFicyh2LXNlcmllc1tpLTFdKSk7CiAgY29uc3QgbWF4RCA9IE1h",
  "dGgubWF4KC4uLmRlbHRhcywgMWUtNik7CiAgY29uc3QgYmFyVyA9IFcvc2VyaWVzLmxlbmd0aDsKICBjb25zdCBjb2xvciA9IHBvc2l0aXZlID8gIiMzM0Q2QTYiIDogIiNGQjZCNkIiOwogIHNlcmllcy5mb3JFYWNoKCh2LGkpPT57CiAgICBjb25zdCBzZWVkID0g",
  "dGlja2VyU2VlZChzdGF0ZS5kZXRhaWxUaWNrZXIpK2kqNzsKICAgIGNvbnN0IGggPSBNYXRoLm1heCgzLCAoZGVsdGFzW2ldL21heEQpICogSCAqIDAuODUgKiAoMC41NSArIHNlZWRlZFJhbmQoc2VlZCkqMC42KSk7CiAgICBjb25zdCB1cCA9IGk9PT0wID8gdHJ1",
  "ZSA6IHNlcmllc1tpXSA+PSBzZXJpZXNbaS0xXTsKICAgIGN0eC5maWxsU3R5bGUgPSB1cCA/ICJyZ2JhKDUxLDIxNCwxNjYsMC41NSkiIDogInJnYmEoMjUxLDEwNywxMDcsMC41NSkiOwogICAgY3R4LmZpbGxSZWN0KGkqYmFyVytiYXJXKjAuMTUsIEgtaCwgTWF0",
  "aC5tYXgoMSxiYXJXKjAuNyksIGgpOwogIH0pOwp9CgpmdW5jdGlvbiBkcmF3Q2hhcnQoY2FudmFzLCBzZXJpZXMsIHBvc2l0aXZlLCB0aWNrZXIpewogIGNvbnN0IHdyYXAgPSBjYW52YXMucGFyZW50RWxlbWVudDsKICBjb25zdCBkcHIgPSB3aW5kb3cuZGV2aWNl",
  "UGl4ZWxSYXRpbyB8fCAxOwogIGNvbnN0IHJlY3QgPSB3cmFwLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogIGNhbnZhcy53aWR0aCA9IHJlY3Qud2lkdGggKiBkcHI7CiAgY2FudmFzLmhlaWdodCA9IHJlY3QuaGVpZ2h0ICogZHByOwogIGNhbnZhcy5zdHlsZS53",
  "aWR0aCA9IHJlY3Qud2lkdGgrInB4IjsKICBjYW52YXMuc3R5bGUuaGVpZ2h0ID0gcmVjdC5oZWlnaHQrInB4IjsKICBjb25zdCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dCgiMmQiKTsKICBjdHguc2NhbGUoZHByLGRwcik7CgogIGNvbnN0IFcgPSByZWN0LndpZHRo",
  "LCBIID0gcmVjdC5oZWlnaHQ7CiAgY29uc3QgcGFkID0ge3RvcDoxNiwgcmlnaHQ6OCwgYm90dG9tOjI0LCBsZWZ0Ojh9OwogIGNvbnN0IG1pbiA9IE1hdGgubWluKC4uLnNlcmllcyksIG1heCA9IE1hdGgubWF4KC4uLnNlcmllcyk7CiAgY29uc3QgcmFuZ2VWID0g",
  "KG1heC1taW4pIHx8IDE7CiAgY29uc3QgaW5uZXJXID0gVyAtIHBhZC5sZWZ0IC0gcGFkLnJpZ2h0OwogIGNvbnN0IGlubmVySCA9IEggLSBwYWQudG9wIC0gcGFkLmJvdHRvbTsKICBjb25zdCBzdGVwID0gaW5uZXJXLyhzZXJpZXMubGVuZ3RoLTEpOwoKICBmdW5j",
  "dGlvbiB4eShpLHYpewogICAgcmV0dXJuIFtwYWQubGVmdCArIGkqc3RlcCwgcGFkLnRvcCArIGlubmVySCAtICgodi1taW4pL3JhbmdlVikqaW5uZXJIXTsKICB9CiAgY29uc3QgcHRzID0gc2VyaWVzLm1hcCgodixpKT0+eHkoaSx2KSk7CgogIGN0eC5jbGVhclJl",
  "Y3QoMCwwLFcsSCk7CgogIC8vIGdyaWRsaW5lcwogIGN0eC5zdHJva2VTdHlsZSA9ICJyZ2JhKDE1OCwxNzEsMjE0LDAuMDgpIjsKICBjdHgubGluZVdpZHRoID0gMTsKICBmb3IobGV0IGk9MDtpPD0zO2krKyl7CiAgICBjb25zdCB5ID0gcGFkLnRvcCArIChpbm5l",
  "ckgvMykqaTsKICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbyhwYWQubGVmdCx5KTsgY3R4LmxpbmVUbyhXLXBhZC5yaWdodCx5KTsgY3R4LnN0cm9rZSgpOwogIH0KCiAgY29uc3QgY29sb3IgPSBwb3NpdGl2ZSA/ICIjMzNENkE2IiA6ICIjRkI2QjZCIjsK",
  "CiAgLy8gc21vb3RoIHBhdGgKICBmdW5jdGlvbiBzbW9vdGhQYXRoKHBvaW50cyl7CiAgICBpZihwb2ludHMubGVuZ3RoPDMpIHJldHVybiBgTSR7cG9pbnRzWzBdWzBdfSwke3BvaW50c1swXVsxXX0gTCR7cG9pbnRzWzFdWzBdfSwke3BvaW50c1sxXVsxXX1gOwog",
  "ICAgbGV0IGQgPSBgTSR7cG9pbnRzWzBdWzBdfSwke3BvaW50c1swXVsxXX1gOwogICAgZm9yKGxldCBpPTA7aTxwb2ludHMubGVuZ3RoLTE7aSsrKXsKICAgICAgY29uc3QgcDAgPSBwb2ludHNbaT09PTA/MDppLTFdOwogICAgICBjb25zdCBwMSA9IHBvaW50c1tp",
  "XTsKICAgICAgY29uc3QgcDIgPSBwb2ludHNbaSsxXTsKICAgICAgY29uc3QgcDMgPSBwb2ludHNbaSsyPHBvaW50cy5sZW5ndGg/aSsyOmkrMV07CiAgICAgIGNvbnN0IGNwMXggPSBwMVswXSArIChwMlswXS1wMFswXSkvNjsKICAgICAgY29uc3QgY3AxeSA9IHAx",
  "WzFdICsgKHAyWzFdLXAwWzFdKS82OwogICAgICBjb25zdCBjcDJ4ID0gcDJbMF0gLSAocDNbMF0tcDFbMF0pLzY7CiAgICAgIGNvbnN0IGNwMnkgPSBwMlsxXSAtIChwM1sxXS1wMVsxXSkvNjsKICAgICAgZCArPSBgIEMke2NwMXh9LCR7Y3AxeX0gJHtjcDJ4fSwk",
  "e2NwMnl9ICR7cDJbMF19LCR7cDJbMV19YDsKICAgIH0KICAgIHJldHVybiBkOwogIH0KICBjb25zdCBsaW5lUGF0aCA9IG5ldyBQYXRoMkQoc21vb3RoUGF0aChwdHMpKTsKCiAgLy8gYXJlYSBmaWxsCiAgY29uc3QgZ3JhZCA9IGN0eC5jcmVhdGVMaW5lYXJHcmFk",
  "aWVudCgwLHBhZC50b3AsMCxwYWQudG9wK2lubmVySCk7CiAgZ3JhZC5hZGRDb2xvclN0b3AoMCwgY29sb3IrIjU1Iik7CiAgZ3JhZC5hZGRDb2xvclN0b3AoMSwgY29sb3IrIjAyIik7CiAgY3R4LnNhdmUoKTsKICBjb25zdCBhcmVhUGF0aCA9IG5ldyBQYXRoMkQo",
  "c21vb3RoUGF0aChwdHMpKTsKICBhcmVhUGF0aC5saW5lVG8ocHRzW3B0cy5sZW5ndGgtMV1bMF0sIHBhZC50b3AraW5uZXJIKTsKICBhcmVhUGF0aC5saW5lVG8ocHRzWzBdWzBdLCBwYWQudG9wK2lubmVySCk7CiAgYXJlYVBhdGguY2xvc2VQYXRoKCk7CiAgY3R4",
  "LmZpbGxTdHlsZSA9IGdyYWQ7CiAgY3R4LmZpbGwoYXJlYVBhdGgpOwogIGN0eC5yZXN0b3JlKCk7CgogIC8vIGxpbmUKICBjdHguc3Ryb2tlU3R5bGUgPSBjb2xvcjsKICBjdHgubGluZVdpZHRoID0gMjsKICBjdHgubGluZUpvaW4gPSAicm91bmQiOwogIGN0eC5s",
  "aW5lQ2FwID0gInJvdW5kIjsKICBjdHguc3Ryb2tlKGxpbmVQYXRoKTsKCiAgLy8gZW50cmFuY2UgYW5pbWF0aW9uIHZpYSBjbGlwIHJldmVhbAogIGNhbnZhcy5fY2hhcnRNZXRhID0ge3B0cywgc2VyaWVzLCBXLCBILCBwYWQsIGNvbG9yfTsKCiAgLy8gY3Jvc3No",
  "YWlyIGludGVyYWN0aXZpdHkKICBjb25zdCB0b29sdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImNoYXJ0VG9vbHRpcCIpOwogIGNhbnZhcy5vbm1vdXNlbW92ZSA9IChlKT0+ewogICAgY29uc3QgciA9IGNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3Qo",
  "KTsKICAgIGNvbnN0IG14ID0gZS5jbGllbnRYIC0gci5sZWZ0OwogICAgbGV0IGlkeCA9IE1hdGgucm91bmQoKG14LXBhZC5sZWZ0KS9zdGVwKTsKICAgIGlkeCA9IE1hdGgubWF4KDAsIE1hdGgubWluKHNlcmllcy5sZW5ndGgtMSwgaWR4KSk7CiAgICBjb25zdCBb",
  "cHgscHldID0gcHRzW2lkeF07CgogICAgcmVkcmF3V2l0aENyb3NzaGFpcihjdHgsIGNhbnZhcy5fY2hhcnRNZXRhLCBweCwgcHkpOwoKICAgIHRvb2x0aXAuc3R5bGUub3BhY2l0eSA9ICIxIjsKICAgIHRvb2x0aXAuc3R5bGUubGVmdCA9IHB4KyJweCI7CiAgICB0",
  "b29sdGlwLnN0eWxlLnRvcCA9IHB5KyJweCI7CiAgICB0b29sdGlwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ0dC1wcmljZSI+JHtmbXRJTlIoc2VyaWVzW2lkeF0pfTwvZGl2PjxkaXYgY2xhc3M9InR0LWRhdGUiPlBvaW50ICR7aWR4KzF9IG9mICR7c2VyaWVz",
  "Lmxlbmd0aH08L2Rpdj5gOwogIH07CiAgY2FudmFzLm9ubW91c2VsZWF2ZSA9ICgpPT57CiAgICB0b29sdGlwLnN0eWxlLm9wYWNpdHkgPSAiMCI7CiAgICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwogICAgcmVkcmF3KGN0eCwgY2FudmFzLl9jaGFydE1ldGEpOwog",
  "IH07CgogIGZ1bmN0aW9uIHJlZHJhdyhjdHgsIG1ldGEpewogICAgY29uc3Qge3B0cywgVywgSCwgcGFkLCBjb2xvcn0gPSBtZXRhOwogICAgY3R4LmNsZWFyUmVjdCgwLDAsVyxIKTsKICAgIGN0eC5zdHJva2VTdHlsZSA9ICJyZ2JhKDE1OCwxNzEsMjE0LDAuMDgp",
  "IjsKICAgIGN0eC5saW5lV2lkdGggPSAxOwogICAgY29uc3QgaW5uZXJIMiA9IEgtcGFkLnRvcC1wYWQuYm90dG9tOwogICAgZm9yKGxldCBpPTA7aTw9MztpKyspewogICAgICBjb25zdCB5ID0gcGFkLnRvcCArIChpbm5lckgyLzMpKmk7CiAgICAgIGN0eC5iZWdp",
  "blBhdGgoKTsgY3R4Lm1vdmVUbyhwYWQubGVmdCx5KTsgY3R4LmxpbmVUbyhXLXBhZC5yaWdodCx5KTsgY3R4LnN0cm9rZSgpOwogICAgfQogICAgY29uc3QgZ3JhZDIgPSBjdHguY3JlYXRlTGluZWFyR3JhZGllbnQoMCxwYWQudG9wLDAscGFkLnRvcCtpbm5lckgy",
  "KTsKICAgIGdyYWQyLmFkZENvbG9yU3RvcCgwLCBjb2xvcisiNTUiKTsgZ3JhZDIuYWRkQ29sb3JTdG9wKDEsIGNvbG9yKyIwMiIpOwogICAgY29uc3QgYXJlYVBhdGgyID0gbmV3IFBhdGgyRChzbW9vdGhQYXRoKHB0cykpOwogICAgYXJlYVBhdGgyLmxpbmVUbyhw",
  "dHNbcHRzLmxlbmd0aC0xXVswXSwgcGFkLnRvcCtpbm5lckgyKTsKICAgIGFyZWFQYXRoMi5saW5lVG8ocHRzWzBdWzBdLCBwYWQudG9wK2lubmVySDIpOwogICAgYXJlYVBhdGgyLmNsb3NlUGF0aCgpOwogICAgY3R4LmZpbGxTdHlsZSA9IGdyYWQyOyBjdHguZmls",
  "bChhcmVhUGF0aDIpOwogICAgY3R4LnN0cm9rZVN0eWxlID0gY29sb3I7IGN0eC5saW5lV2lkdGggPSAyOyBjdHgubGluZUpvaW49InJvdW5kIjsgY3R4LmxpbmVDYXA9InJvdW5kIjsKICAgIGN0eC5zdHJva2UobmV3IFBhdGgyRChzbW9vdGhQYXRoKHB0cykpKTsK",
  "ICB9CiAgZnVuY3Rpb24gcmVkcmF3V2l0aENyb3NzaGFpcihjdHgsIG1ldGEsIHB4LCBweSl7CiAgICByZWRyYXcoY3R4LCBtZXRhKTsKICAgIGNvbnN0IHtILCBwYWQsIGNvbG9yfSA9IG1ldGE7CiAgICBjdHguc2F2ZSgpOwogICAgY3R4LnN0cm9rZVN0eWxlID0g",
  "InJnYmEoMTU4LDE3MSwyMTQsMC4zNSkiOwogICAgY3R4LmxpbmVXaWR0aCA9IDE7CiAgICBjdHguc2V0TGluZURhc2goWzMsM10pOwogICAgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRvKHB4LCBwYWQudG9wKTsgY3R4LmxpbmVUbyhweCwgSC1wYWQuYm90dG9t",
  "KTsgY3R4LnN0cm9rZSgpOwogICAgY3R4LnNldExpbmVEYXNoKFtdKTsKICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYyhweCxweSw0LDAsTWF0aC5QSSoyKTsKICAgIGN0eC5maWxsU3R5bGUgPSBjb2xvcjsgY3R4LmZpbGwoKTsKICAgIGN0eC5zdHJva2VTdHls",
  "ZSA9ICIjMDUwNjBCIjsgY3R4LmxpbmVXaWR0aD0yOyBjdHguc3Ryb2tlKCk7CiAgICBjdHgucmVzdG9yZSgpOwogIH0KfQoKd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoInJlc2l6ZSIsIGRlYm91bmNlKCgpPT57CiAgY29uc3QgY2FudmFzID0gZG9jdW1lbnQuZ2V0",
  "RWxlbWVudEJ5SWQoInByaWNlQ2hhcnQiKTsKICBpZihjYW52YXMgJiYgc3RhdGUudmlldz09PSJkZXRhaWwiKSBsb2FkQ2hhcnQoc3RhdGUuZGV0YWlsVGlja2VyLCB0cnVlKTsKfSwgMjAwKSk7CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNUQVRFIEhFTFBFUlMgLS0t",
  "LS0tLS0tLS0tLS0tLSAqLwpmdW5jdGlvbiBlbXB0eVN0YXRlSW5uZXIodGl0bGUsIHN1Yil7CiAgcmV0dXJuIGAKICAgIDxkaXYgY2xhc3M9InN0YXRlLWljb24iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMjIiIGhlaWdodD0iMjIiIGZpbGw9Im5v",
  "bmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxjaXJjbGUgY3g9IjExIiBjeT0iMTEiIHI9IjciLz48cGF0aCBkPSJNMjEgMjFsLTQuMy00LjMiLz48L3N2Zz48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRlLXRpdGxlIj4ke3RpdGxl",
  "fTwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdGUtc3ViIj4ke3N1Yn08L2Rpdj4KICBgOwp9CmZ1bmN0aW9uIGVtcHR5U3RhdGVIVE1MKHRpdGxlLCBzdWIpewogIHJldHVybiBgPGRpdiBjbGFzcz0ic3RhdGUtYm94Ij4ke2VtcHR5U3RhdGVJbm5lcih0aXRsZSwg",
  "c3ViKX08L2Rpdj5gOwp9CmZ1bmN0aW9uIGVycm9yU3RhdGVIVE1MKHRpdGxlLCBzdWIpewogIHJldHVybiBgPGRpdiBjbGFzcz0ic3RhdGUtYm94Ij4KICAgIDxkaXYgY2xhc3M9InN0YXRlLWljb24iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMjIi",
  "IGhlaWdodD0iMjIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiA5djRNMTIgMTdoLjAxTTEwLjI5IDMuODZMMS44MiAxOGEyIDIgMCAwMDEuNzEgM2gxNi45NGEyIDIgMCAwMDEuNzEtM0wxMy43",
  "MSAzLjg2YTIgMiAwIDAwLTMuNDIgMHoiLz48L3N2Zz48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRlLXRpdGxlIj4ke3RpdGxlfTwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdGUtc3ViIj4ke3N1Yn08L2Rpdj4KICA8L2Rpdj5gOwp9CgovKiA9PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEJPT1QKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpzZXRBY3RpdmVOYXYoImRh",
  "c2hib2FyZCIpOwpjaGVja0xpdmVCYWNrZW5kKCkuZmluYWxseShyZW5kZXIpOwpzZXRJbnRlcnZhbChjaGVja0xpdmVCYWNrZW5kLCA0NTAwMCk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K"
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
