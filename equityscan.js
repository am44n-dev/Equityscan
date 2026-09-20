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

  // AI assistant (Groq) — optional. Feature simply reports "not configured"
  // if GROQ_API_KEY isn't set; nothing else in the app depends on it.
  groqApiKey: process.env.GROQ_API_KEY || null,
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  groqDailyBudget: num("GROQ_DAILY_BUDGET", 500),
  groqRequestTimeout: num("GROQ_REQUEST_TIMEOUT", 15000),
  explainCacheTtl: num("EXPLAIN_CACHE_TTL", 10 * 60 * 1000),
  chatDedupeTtl: num("CHAT_DEDUPE_TTL", 60 * 1000),

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
  aiNotConfigured: () => new ApiError("AI_NOT_CONFIGURED", "GROQ_API_KEY is not set on the server, so the AI assistant is unavailable.", 503),
  aiBudgetExhausted: () => new ApiError("RATE_LIMITED", "Daily AI call budget is exhausted; try again after reset.", 429),
  aiUnavailable: (msg) => new ApiError("PROVIDER_UNAVAILABLE", msg || "The AI assistant is temporarily unavailable.", 503),
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
function istDateKey(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}
// Generic persisted daily-call budget — used separately for NSE calls and
// for Groq AI calls, so exhausting one never affects the other.
class BudgetService {
  constructor(stateFileName, limit) {
    this.stateFile = path.join(__dirname, stateFileName);
    this.limit = limit;
    this.load();
  }
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (parsed.date === istDateKey()) { this.date = parsed.date; this.used = parsed.used; return; }
    } catch (e) { /* no state file yet, or corrupt — start fresh */ }
    this.date = istDateKey(); this.used = 0; this.persist();
  }
  persist() {
    try { fs.writeFileSync(this.stateFile, JSON.stringify({ date: this.date, used: this.used })); }
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
const budget = new BudgetService(".budget-state.json", config.dailyCallBudget);
const groqBudget = new BudgetService(".groq-budget-state.json", config.groqDailyBudget);

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
   GROQ CLIENT — the only place that talks to Groq's API.
   Uses the global fetch available in Node 18+. Grounded, short,
   no-advice system framing lives in the routes that call this.
   ============================================================ */
async function callGroq(messages, { maxTokens = 500, temperature = 0.3 } = {}) {
  if (!config.groqApiKey) throw Errors.aiNotConfigured();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.groqRequestTimeout);
  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify({
        model: config.groqModel,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw Errors.timeout();
    throw Errors.aiUnavailable(err.message);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) throw Errors.aiUnavailable("Groq rejected the API key (401) — check GROQ_API_KEY on the server.");
  if (res.status === 429) throw Errors.aiBudgetExhausted();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Errors.aiUnavailable(`Groq returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw Errors.invalidProviderResponse();
  return content.trim();
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

/* ============================================================
   AI ASSISTANT (Groq) — explain a stock, and free-form chat.
   Both are grounded only in data this app actually fetched from
   NSE (or whatever the frontend passes as context), and both
   explicitly decline to give buy/sell advice. Neither endpoint
   fabricates news or "why" behind a move unless it's a plain
   inference from the numbers themselves.
   ============================================================ */
app.get("/api/ai/status", (req, res) => {
  res.json({
    configured: !!config.groqApiKey,
    model: config.groqModel,
    dailyBudget: groqBudget.status(),
  });
});

const EXPLAIN_SYSTEM_PROMPT = `You are EquityScan's data explainer. You are given a single JSON object
describing one NSE-listed stock's current quote data. Write a short, plain-English
explanation (3-5 sentences) of what the numbers show: today's price move, where the
price sits relative to its 52-week range, and anything else notable in the given
fields. Rules:
- Only use the numbers given to you. Never invent a reason (news, earnings, sector
  trend) for a price move unless it's a direct, obvious inference from the numbers
  themselves (e.g. "near its 52-week low").
- If a field is null, say that data point isn't available rather than guessing.
- Do not give investment advice, price targets, or a buy/sell/hold recommendation.
- Plain sentences, no markdown headers or bullet lists, no disclaimers beyond a
  brief closing note that this isn't financial advice.`;

app.get("/api/explain/:symbol", async (req, res, next) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);
    const cacheKey = `explain:${symbol}`;

    const fresh = cache.get(cacheKey);
    if (fresh) return res.json({ success: true, data: fresh, cached: true });

    const result = await cache.dedupe(cacheKey, async () => {
      const freshAfterWait = cache.get(cacheKey);
      if (freshAfterWait) return freshAfterWait;

      const { data: equity } = await getNormalizedEquity(symbol);

      if (!groqBudget.canSpend(1)) {
        const stale = cache.getStale(cacheKey);
        if (stale) return stale;
        throw Errors.aiBudgetExhausted();
      }

      const explanation = await callGroq(
        [
          { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(equity) },
        ],
        { maxTokens: 260, temperature: 0.3 }
      );
      groqBudget.spend(1);

      const payload = { symbol, explanation, basedOn: equity, generatedAt: new Date().toISOString() };
      cache.set(cacheKey, payload, config.explainCacheTtl);
      return payload;
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

const CHAT_SYSTEM_PROMPT = `You are the EquityScan Assistant, built into an NSE stock-market dashboard.
You answer questions using ONLY the JSON "context" data provided with each message
(current stock quotes, watchlist, market breadth, etc. — whatever the app included).
Rules:
- Do not claim knowledge of news, earnings calls, or events not present in the
  context. If something isn't in the context, say you don't have that data rather
  than guessing.
- Never give investment advice, price targets, or a buy/sell/hold recommendation.
  You can describe what the numbers show; you cannot tell the user what to do
  with their money. If asked directly, decline briefly and explain why.
- Keep answers concise — a few sentences unless the question genuinely needs more.
- Plain text, no markdown headers.`;

function truncateJSON(obj, maxChars) {
  let str = JSON.stringify(obj ?? {});
  if (str.length > maxChars) str = str.slice(0, maxChars) + "...(truncated)";
  return str;
}

app.post("/api/chat", async (req, res, next) => {
  try {
    const { question, context, history } = req.body || {};
    if (typeof question !== "string" || !question.trim()) {
      throw Errors.invalidParameters('"question" is required and must be a non-empty string.');
    }
    if (question.length > 2000) throw Errors.invalidParameters('"question" is too long (max 2000 characters).');

    const safeHistory = Array.isArray(history)
      ? history.slice(-6).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }))
      : [];

    const contextStr = truncateJSON(context, 6000);
    const dedupeKey = `chat:${question.trim()}:${contextStr}`;

    const cachedAnswer = cache.get(dedupeKey);
    if (cachedAnswer) return res.json({ success: true, data: cachedAnswer, cached: true });

    const result = await cache.dedupe(dedupeKey, async () => {
      const freshAfterWait = cache.get(dedupeKey);
      if (freshAfterWait) return freshAfterWait;

      if (!groqBudget.canSpend(1)) throw Errors.aiBudgetExhausted();

      const messages = [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "system", content: `Context data (JSON):\n${contextStr}` },
        ...safeHistory,
        { role: "user", content: question.trim() },
      ];

      const answer = await callGroq(messages, { maxTokens: 400, temperature: 0.4 });
      groqBudget.spend(1);

      const payload = { answer, generatedAt: new Date().toISOString() };
      cache.set(dedupeKey, payload, config.chatDedupeTtl);
      return payload;
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
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
  "bXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTt9CiAgLndhdGNobGlzdC1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO30KICAudHJlbmRpbmctcm93e2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO30KfQovKiA9PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgQUkgQVNTSVNUQU5UIOKAlCBmbG9hdGluZyBidXR0b24gKyBjaGF0IHBhbmVsLCBleHBsYWluLXN0b2NrIGNhcmQKICAgPT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi5haS1mYWJ7CiAgcG9zaXRpb246Zml4ZWQ7cmlnaHQ6MjJweDtib3R0b206MjJweDt6LWluZGV4OjYwOwogIHdpZHRoOjUycHg7aGVpZ2h0OjUycHg7Ym9yZGVyLXJhZGl1czoxNnB4O2Jv",
  "cmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpOwogIGJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDE1MGRlZyx2YXIoLS1ibHVlKSx2YXIoLS12aW9sZXQpIDcwJSx2YXIoLS1jeWFuKSk7CiAgY29sb3I6I2ZmZjtkaXNwbGF5OmZsZXg7YWxpZ24taXRl",
  "bXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y3Vyc29yOnBvaW50ZXI7CiAgYm94LXNoYWRvdzowIDE0cHggMzRweCAtMTJweCByZ2JhKDc2LDEyNSwyNTUsMC41NSk7CiAgdHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjJzIHZhcigtLWVhc2Utc3ByaW5nKTsK",
  "fQouYWktZmFiOmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpIHNjYWxlKDEuMDQpO30KLmFpLWZhYiBzdmd7d2lkdGg6MjJweDtoZWlnaHQ6MjJweDt9Ci5haS1mYWIuaGlkZGVuLCAuYWktcGFuZWwuaGlkZGVue2Rpc3BsYXk6bm9uZTt9CgouYWktcGFu",
  "ZWx7CiAgcG9zaXRpb246Zml4ZWQ7cmlnaHQ6MjJweDtib3R0b206ODhweDt6LWluZGV4OjYxOwogIHdpZHRoOjM2MHB4O21heC13aWR0aDpjYWxjKDEwMHZ3IC0gMzJweCk7aGVpZ2h0Om1pbig1MjBweCwgNzB2aCk7CiAgZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0",
  "aW9uOmNvbHVtbjtib3JkZXItcmFkaXVzOnZhcigtLXJhZGl1cy1sKTtvdmVyZmxvdzpoaWRkZW47CiAgYmFja2dyb3VuZDp2YXIoLS1iZy1lbGV2YXRlZCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItc29mdCk7CiAgYm94LXNoYWRvdzowIDMwcHggNzBw",
  "eCAtMjBweCByZ2JhKDAsMCwwLDAuNjUpOwogIGFuaW1hdGlvbjpwYW5lbEluIC4yOHMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5haS1wYW5lbC5oaWRkZW57ZGlzcGxheTpub25lO30KQGtleWZyYW1lcyBwYW5lbElue2Zyb217b3BhY2l0eTowO3RyYW5zZm9ybTp0cmFu",
  "c2xhdGVZKDEwcHgpIHNjYWxlKDAuOTgpO310b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMCkgc2NhbGUoMSk7fX0KLmFpLXBhbmVsLWhlYWR7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2Vl",
  "bjtwYWRkaW5nOjEycHggMTRweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7ZmxleC1zaHJpbms6MDt9Ci5haS1hdmF0YXJ7d2lkdGg6MjhweDtoZWlnaHQ6MjhweDtib3JkZXItcmFkaXVzOjlweDtiYWNrZ3JvdW5kOmxpbmVhci1n",
  "cmFkaWVudCgxNTBkZWcsdmFyKC0tYmx1ZSksdmFyKC0tdmlvbGV0KSk7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiNmZmY7Zm9udC1zaXplOjE0cHg7ZmxleC1zaHJpbms6MDt9Ci5haS1tZXNzYWdl",
  "c3tmbGV4OjE7b3ZlcmZsb3cteTphdXRvO3BhZGRpbmc6MTRweDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDoxMHB4O30KLmFpLW1zZ3tmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU7cGFkZGluZzoxMHB4IDEycHg7Ym9yZGVyLXJh",
  "ZGl1czoxMXB4O21heC13aWR0aDo4OCU7d2hpdGUtc3BhY2U6cHJlLXdyYXA7fQouYWktbXNnLmFzc2lzdGFudHtiYWNrZ3JvdW5kOnZhcigtLWJnLWJhc2UpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpO2NvbG9yOnZhcigtLXRleHQtbWlkKTth",
  "bGlnbi1zZWxmOmZsZXgtc3RhcnQ7fQouYWktbXNnLnVzZXJ7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHZhcigtLWJsdWUpLHZhcigtLXZpb2xldCkpO2NvbG9yOiNmZmY7YWxpZ24tc2VsZjpmbGV4LWVuZDt9Ci5haS1tc2cucGVuZGluZ3tjb2xv",
  "cjp2YXIoLS10ZXh0LWZhaW50KTtmb250LXN0eWxlOml0YWxpYzt9Ci5haS1tc2cuZXJyb3J7YmFja2dyb3VuZDp2YXIoLS1uZWctYmcpO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTEsMTA3LDEwNywwLjMpO2NvbG9yOnZhcigtLW5lZy1zb2Z0KTthbGlnbi1zZWxm",
  "OmZsZXgtc3RhcnQ7fQouYWktaW5wdXQtcm93e2Rpc3BsYXk6ZmxleDtnYXA6OHB4O3BhZGRpbmc6MTBweDtib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7ZmxleC1zaHJpbms6MDt9Ci5haS1pbnB1dC1yb3cgaW5wdXR7ZmxleDoxO2JhY2tn",
  "cm91bmQ6dmFyKC0tYmctYmFzZSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7Ym9yZGVyLXJhZGl1czoxMHB4O3BhZGRpbmc6OXB4IDEycHg7Y29sb3I6dmFyKC0tdGV4dC1oaSk7Zm9udC1zaXplOjEzcHg7Zm9udC1mYW1pbHk6dmFyKC0tZm9u",
  "dC11aSk7b3V0bGluZTpub25lO30KLmFpLWlucHV0LXJvdyBpbnB1dDpmb2N1c3tib3JkZXItY29sb3I6cmdiYSgxMjQsMTUwLDI1NSwwLjUpO30KLmFpLXNlbmQtYnRue3dpZHRoOjM4cHg7aGVpZ2h0OjM4cHg7Ym9yZGVyLXJhZGl1czoxMHB4O2JvcmRlcjpub25l",
  "O2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyx2YXIoLS1ibHVlKSx2YXIoLS12aW9sZXQpKTtjb2xvcjojZmZmO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjdXJzb3I6cG9pbnRlcjtmbGV4LXNo",
  "cmluazowO30KLmFpLXNlbmQtYnRuOmRpc2FibGVke29wYWNpdHk6MC41O2N1cnNvcjpkZWZhdWx0O30KLmFpLXNlbmQtYnRuIHN2Z3t3aWR0aDoxNXB4O2hlaWdodDoxNXB4O30KCi5leHBsYWluLWNhcmR7cGFkZGluZzoxOHB4IDIwcHg7bWFyZ2luLXRvcDoxNHB4",
  "O30KLmV4cGxhaW4taGVhZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo5cHg7bWFyZ2luLWJvdHRvbToxMHB4O30KLmV4cGxhaW4tdGV4dHtmb250LXNpemU6MTMuNXB4O2xpbmUtaGVpZ2h0OjEuNjU7Y29sb3I6dmFyKC0tdGV4dC1taWQpO3do",
  "aXRlLXNwYWNlOnByZS13cmFwO30KLmV4cGxhaW4tYnRuewogIGRpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo3cHg7cGFkZGluZzo4cHggMTRweDtib3JkZXItcmFkaXVzOjlweDsKICBiYWNrZ3JvdW5kOnZhcigtLWJnLWVsZXZhdGVk",
  "LTIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpO2NvbG9yOnZhcigtLXRleHQtaGkpOwogIGZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NzAwO2N1cnNvcjpwb2ludGVyO3RyYW5zaXRpb246YWxsIC4xOHMgdmFyKC0tZWFzZS1vdXQpOwp9",
  "Ci5leHBsYWluLWJ0bjpob3Zlcntib3JkZXItY29sb3I6cmdiYSgxMjQsMTUwLDI1NSwwLjUpO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpO30KLmV4cGxhaW4tYnRuIHN2Z3t3aWR0aDoxNHB4O2hlaWdodDoxNHB4O30KLmV4cGxhaW4tYnRuOmRpc2FibGVke29w",
  "YWNpdHk6MC41O2N1cnNvcjpkZWZhdWx0O3RyYW5zZm9ybTpub25lO30KCkBtZWRpYSAobWF4LXdpZHRoOiA2NDBweCl7CiAgI2JhY2tlbmRCYWRnZXtkaXNwbGF5Om5vbmU7fQogIC5haS1wYW5lbHtyaWdodDoxMnB4O2xlZnQ6MTJweDt3aWR0aDphdXRvO2JvdHRv",
  "bTo4MHB4O30KICAuYWktZmFie3JpZ2h0OjE2cHg7Ym90dG9tOjc2cHg7fQp9CkBtZWRpYSAobWF4LXdpZHRoOiA3NjBweCl7CiAgbmF2Lm1haW5uYXZ7ZGlzcGxheTpub25lO30KICBoZWFkZXIudG9wYmFye3BhZGRpbmc6MCAxNnB4O2hlaWdodDo1OHB4O2dhcDox",
  "NHB4O30KICBtYWlue3BhZGRpbmc6MjBweCAxNnB4IDk2cHg7fQogIC5oZXJvLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsMWZyKTtnYXA6MTBweDt9CiAgLm1ldHJpY3MtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsMWZyKTt9",
  "CiAgLndhdGNobGlzdC1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnI7fQogIC50cmVuZGluZy1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcjt9CiAgLnRhYmxlLXdyYXB7ZGlzcGxheTpub25lO30KICAuc3RvY2stY2FyZHN7ZGlzcGxheTpmbGV4O30K",
  "ICAuYm90dG9tLW5hdntkaXNwbGF5OmZsZXg7fQogIC5kZXRhaWwtcHJpY2UtYmxvY2t7dGV4dC1hbGlnbjpsZWZ0O30KICAuZGV0YWlsLWhlYWR7ZmxleC1kaXJlY3Rpb246Y29sdW1uO30KICAuZmlsdGVycy1iYXJ7cGFkZGluZzoxMnB4O30KICAuZmlsdGVyLWNo",
  "aXB7bWluLXdpZHRoOjQ0JTtmbGV4OjE7fQp9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+Cgo8ZGl2IGNsYXNzPSJhbWJpZW50Ij4KICA8ZGl2IGNsYXNzPSJhbWJpZW50LWdyaWQiPjwvZGl2PgogIDxzdmcgY2xhc3M9ImFtYmllbnQtbGluZXMiIGlkPSJhbWJpZW50",
  "TGluZXMiIHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiPjwvc3ZnPgo8L2Rpdj4KCjxoZWFkZXIgY2xhc3M9InRvcGJhciIgaWQ9InRvcGJhciI+CiAgPGRpdiBjbGFzcz0iYnJhbmQiPgogICAgPGRpdiBjbGFzcz0iYnJhbmQtbWFyayI+CiAgICAgIDxzdmcgdmll",
  "d0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj4KICAgICAgICA8ZGVmcz4KICAgICAgICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ibG9nb0dyYWQiIHgxPSIyIiB5MT0iMjAiIHgyPSIyMiIgeTI9IjQiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAg",
  "ICAgICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzRDN0RGRiIvPgogICAgICAgICAgICA8c3RvcCBvZmZzZXQ9IjU1JSIgc3RvcC1jb2xvcj0iIzhCNkJGMCIvPgogICAgICAgICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMz",
  "MUQ1RUUiLz4KICAgICAgICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICAgICAgPC9kZWZzPgogICAgICAgIDxyZWN0IHg9IjIuNSIgeT0iMTMiIHdpZHRoPSI0IiBoZWlnaHQ9IjguNSIgcng9IjEuMiIgZmlsbD0idXJsKCNsb2dvR3JhZCkiIG9wYWNpdHk9IjAuNTUi",
  "Lz4KICAgICAgICA8cmVjdCB4PSIxMCIgeT0iOCIgd2lkdGg9IjQiIGhlaWdodD0iMTMuNSIgcng9IjEuMiIgZmlsbD0idXJsKCNsb2dvR3JhZCkiIG9wYWNpdHk9IjAuOCIvPgogICAgICAgIDxyZWN0IHg9IjE3LjUiIHk9IjIuNSIgd2lkdGg9IjQiIGhlaWdodD0i",
  "MTkiIHJ4PSIxLjIiIGZpbGw9InVybCgjbG9nb0dyYWQpIi8+CiAgICAgIDwvc3ZnPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJicmFuZC13b3JkbWFyayI+PHNwYW4+PHNwYW4gY2xhc3M9ImVxIj5FcXVpdHk8L3NwYW4+PHNwYW4gY2xhc3M9InNjYW4iPlNj",
  "YW48L3NwYW4+PC9zcGFuPjxzbWFsbD5NQVJLRVQgSU5URUxMSUdFTkNFPC9zbWFsbD48L2Rpdj4KICA8L2Rpdj4KICA8bmF2IGNsYXNzPSJtYWlubmF2IiBpZD0ibWFpbk5hdiI+CiAgICA8YnV0dG9uIGRhdGEtdmlldz0iZGFzaGJvYXJkIj5EYXNoYm9hcmQ8L2J1",
  "dHRvbj4KICAgIDxidXR0b24gZGF0YS12aWV3PSJzY3JlZW5lciI+U2NyZWVuZXI8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS12aWV3PSJtYXJrZXRzIj5NYXJrZXRzPC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtdmlldz0id2F0Y2hsaXN0Ij5XYXRjaGxpc3Q8",
  "L2J1dHRvbj4KICA8L25hdj4KICA8ZGl2IGNsYXNzPSJoZWFkZXItcmlnaHQiPgogICAgPGRpdiBjbGFzcz0ibWFya2V0LXBpbGwiPjxzcGFuIGNsYXNzPSJkb3QtbGl2ZSI+PC9zcGFuPjxzcGFuIGlkPSJtYXJrZXRTdGF0dXNUZXh0Ij5NYXJrZXQgT3Blbjwvc3Bh",
  "bj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9Im1hcmtldC1waWxsIiBpZD0iYmFja2VuZEJhZGdlIiB0aXRsZT0iQ2hlY2tpbmcgYmFja2VuZCBjb25uZWN0aW9u4oCmIj48c3BhbiBjbGFzcz0iZG90LWxpdmUiPjwvc3Bhbj48c3Bhbj5DaGVja2luZ+KApjwvc3Bhbj48",
  "L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9Imljb24tYnRuIiBpZD0ic2VhcmNoVG9nZ2xlQnRuIiB0aXRsZT0iU2VhcmNoICgvKSI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdp",
  "ZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxjaXJjbGUgY3g9IjExIiBjeT0iMTEiIHI9IjciLz48cGF0aCBkPSJNMjEgMjFsLTQuMy00LjMiLz48L3N2Zz4KICAgIDwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iaWNvbi1idG4iIHRpdGxlPSJTZXR0",
  "aW5ncyI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjEy",
  "IiBjeT0iMTIiIHI9IjMiLz48cGF0aCBkPSJNMTkuNCAxNWExLjY1IDEuNjUgMCAwMC4zMyAxLjgybC4wNi4wNmEyIDIgMCAxMS0yLjgzIDIuODNsLS4wNi0uMDZhMS42NSAxLjY1IDAgMDAtMS44Mi0uMzMgMS42NSAxLjY1IDAgMDAtMSAxLjUxVjIxYTIgMiAwIDAx",
  "LTQgMHYtLjA5QTEuNjUgMS42NSAwIDAwOSAxOS40YTEuNjUgMS42NSAwIDAwLTEuODIuMzNsLS4wNi4wNmEyIDIgMCAxMS0yLjgzLTIuODNsLjA2LS4wNkExLjY1IDEuNjUgMCAwMDQuNiAxNWExLjY1IDEuNjUgMCAwMC0xLjUxLTFIM2EyIDIgMCAwMTAtNGguMDlB",
  "MS42NSAxLjY1IDAgMDA0LjYgOWExLjY1IDEuNjUgMCAwMC0uMzMtMS44MmwtLjA2LS4wNmEyIDIgMCAxMTIuODMtMi44M2wuMDYuMDZBMS42NSAxLjY1IDAgMDA5IDQuNmExLjY1IDEuNjUgMCAwMDEtMS41MVYzYTIgMiAwIDAxNCAwdi4wOWExLjY1IDEuNjUgMCAw",
  "MDEgMS41MSAxLjY1IDEuNjUgMCAwMDEuODItLjMzbC4wNi0uMDZhMiAyIDAgMTEyLjgzIDIuODNsLS4wNi4wNkExLjY1IDEuNjUgMCAwMDE5LjQgOWExLjY1IDEuNjUgMCAwMDEuNTEgMUgyMWEyIDIgMCAwMTAgNGgtLjA5YTEuNjUgMS42NSAwIDAwLTEuNTEgMXoi",
  "Lz48L3N2Zz4KICAgIDwvYnV0dG9uPgogIDwvZGl2Pgo8L2hlYWRlcj4KCjxtYWluIGlkPSJtYWluUm9vdCI+PC9tYWluPgoKPG5hdiBjbGFzcz0iYm90dG9tLW5hdiIgaWQ9ImJvdHRvbU5hdiI+CiAgPGJ1dHRvbiBkYXRhLXZpZXc9ImRhc2hib2FyZCI+PHN2ZyB2",
  "aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxyZWN0IHg9IjMiIHk9IjMiIHdpZHRoPSI3IiBoZWlnaHQ9IjkiIHJ4PSIxLjUiLz48cmVjdCB4PSIxNCIgeT0iMyIgd2lkdGg9IjciIGhl",
  "aWdodD0iNSIgcng9IjEuNSIvPjxyZWN0IHg9IjE0IiB5PSIxMiIgd2lkdGg9IjciIGhlaWdodD0iOSIgcng9IjEuNSIvPjxyZWN0IHg9IjMiIHk9IjE2IiB3aWR0aD0iNyIgaGVpZ2h0PSI1IiByeD0iMS41Ii8+PC9zdmc+RGFzaGJvYXJkPC9idXR0b24+CiAgPGJ1",
  "dHRvbiBkYXRhLXZpZXc9InNjcmVlbmVyIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTQgNmgxNk03IDEyaDEwTTEwIDE4aDQiLz48L3N2Zz5TY3JlZW5l",
  "cjwvYnV0dG9uPgogIDxidXR0b24gZGF0YS12aWV3PSJtYXJrZXRzIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTMgMTdsNi02IDQgNCA4LTgiLz48L3N2",
  "Zz5NYXJrZXRzPC9idXR0b24+CiAgPGJ1dHRvbiBkYXRhLXZpZXc9IndhdGNobGlzdCI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiAxNy4zbC02LjE2",
  "IDMuNiAxLjY0LTYuOUwyIDkuNGw3LjA2LS42TDEyIDIuNGwyLjk0IDYuNCA3LjA2LjYtNS40OCA0LjYgMS42NCA2Ljl6Ii8+PC9zdmc+V2F0Y2hsaXN0PC9idXR0b24+CjwvbmF2PgoKPGJ1dHRvbiBjbGFzcz0iYWktZmFiIiBpZD0iYWlGYWIiIHRpdGxlPSJBc2sg",
  "dGhlIEVxdWl0eVNjYW4gQXNzaXN0YW50Ij4KICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5k",
  "Ij48cGF0aCBkPSJNMTIgOFY0SDgiLz48cmVjdCB4PSI0IiB5PSI4IiB3aWR0aD0iMTYiIGhlaWdodD0iMTIiIHJ4PSIyIi8+PHBhdGggZD0iTTIgMTRoMk0yMCAxNGgyTTkgMTN2Mk0xNSAxM3YyIi8+PC9zdmc+CjwvYnV0dG9uPgoKPGRpdiBjbGFzcz0iYWktcGFu",
  "ZWwiIGlkPSJhaVBhbmVsIj4KICA8ZGl2IGNsYXNzPSJhaS1wYW5lbC1oZWFkIj4KICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjlweDsiPgogICAgICA8ZGl2IGNsYXNzPSJhaS1hdmF0YXIiPuKcpjwvZGl2PgogICAg",
  "ICA8ZGl2PgogICAgICAgIDxkaXYgc3R5bGU9ImZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTMuNXB4OyI+RXF1aXR5U2NhbiBBc3Npc3RhbnQ8L2Rpdj4KICAgICAgICA8ZGl2IHN0eWxlPSJmb250LXNpemU6MTAuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pOyIg",
  "aWQ9ImFpU3RhdHVzTGluZSI+Q2hlY2tpbmfigKY8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9Imljb24tYnRuIiBpZD0iYWlDbG9zZUJ0biIgc3R5bGU9IndpZHRoOjMwcHg7aGVpZ2h0OjMwcHg7Ij4KICAgICAgPHN2ZyB2",
  "aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PHBhdGggZD0iTTE4IDZMNiAxOE02IDZsMTIgMTIiLz48L3N2Zz4KICAgIDwvYnV0dG9uPgogIDwv",
  "ZGl2PgogIDxkaXYgY2xhc3M9ImFpLW1lc3NhZ2VzIiBpZD0iYWlNZXNzYWdlcyI+CiAgICA8ZGl2IGNsYXNzPSJhaS1tc2cgYXNzaXN0YW50Ij5IaSDigJQgYXNrIG1lIGFib3V0IGEgc3RvY2sncyBudW1iZXJzLCB5b3VyIHdhdGNobGlzdCwgb3Igd2hhdCdzIGhh",
  "cHBlbmluZyBvbiB0aGUgZGFzaGJvYXJkIHJpZ2h0IG5vdy4gSSBvbmx5IGtub3cgd2hhdCdzIGxvYWRlZCBpbiB0aGUgYXBwLCBhbmQgSSB3b24ndCB0ZWxsIHlvdSB3aGF0IHRvIGJ1eSBvciBzZWxsLjwvZGl2PgogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImFpLWlu",
  "cHV0LXJvdyI+CiAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImFpSW5wdXQiIHBsYWNlaG9sZGVyPSJBc2sgYWJvdXQgdGhlIGRhdGHigKYiIGF1dG9jb21wbGV0ZT0ib2ZmIj4KICAgIDxidXR0b24gY2xhc3M9ImFpLXNlbmQtYnRuIiBpZD0iYWlTZW5kQnRuIiB0",
  "aXRsZT0iU2VuZCI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9",
  "Ik0yMiAyTDExIDEzTTIyIDJsLTcgMjAtNC05LTktNCAyMC03eiIvPjwvc3ZnPgogICAgPC9idXR0b24+CiAgPC9kaXY+CjwvZGl2PgoKPHNjcmlwdD4KInVzZSBzdHJpY3QiOwoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PQogICBWSVNJQkxFIEVSUk9SIERJQUdOT1NUSUNTIOKAlCBzaG93cyB1bmNhdWdodCBlcnJvcnMgb24tc2NyZWVuIHNvIHRoZXkKICAgY2FuIGJlIHJlYWQvcmVwb3J0ZWQgd2l0aG91dCBvcGVuaW5nIGJyb3dzZXIgZGV2IHRvb2xz",
  "LiBTYWZlIHRvCiAgIGxlYXZlIGluOyBpdCBvbmx5IGFwcGVhcnMgd2hlbiBzb21ldGhpbmcgYWN0dWFsbHkgdGhyb3dzLgogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmZ1bmN0aW9u",
  "IHNob3dFcnJvckJhbm5lcihtc2cpewogIGxldCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZXJyQmFubmVyIik7CiAgaWYoIWJhbm5lcil7CiAgICBiYW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCJkaXYiKTsKICAgIGJhbm5lci5pZCA9",
  "ICJlcnJCYW5uZXIiOwogICAgYmFubmVyLnN0eWxlLmNzc1RleHQgPSAicG9zaXRpb246Zml4ZWQ7bGVmdDoxMnB4O3JpZ2h0OjEycHg7Ym90dG9tOjEycHg7ei1pbmRleDo5OTk7YmFja2dyb3VuZDojMmEwZTE0O2JvcmRlcjoxcHggc29saWQgI0ZCNkI2Qjtjb2xv",
  "cjojRkZEOUQ5O3BhZGRpbmc6MTJweCAxNHB4O2JvcmRlci1yYWRpdXM6MTBweDtmb250LXNpemU6MTJweDtmb250LWZhbWlseTptb25vc3BhY2U7bWF4LWhlaWdodDozNXZoO292ZXJmbG93OmF1dG87Ym94LXNoYWRvdzowIDIwcHggNTBweCByZ2JhKDAsMCwwLDAu",
  "NSk7IjsKICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYmFubmVyKTsKICB9CiAgY29uc3QgbGluZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImRpdiIpOwogIGxpbmUuc3R5bGUubWFyZ2luQm90dG9tID0gIjZweCI7CiAgbGluZS50ZXh0Q29udGVudCA9",
  "IG5ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCkgKyAiIOKAlCAiICsgbXNnOwogIGJhbm5lci5hcHBlbmRDaGlsZChsaW5lKTsKfQp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigiZXJyb3IiLCAoZSk9PiBzaG93RXJyb3JCYW5uZXIoIkpTIGVycm9yOiAiICsg",
  "KGUubWVzc2FnZXx8ZSkpKTsKd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoInVuaGFuZGxlZHJlamVjdGlvbiIsIChlKT0+IHNob3dFcnJvckJhbm5lcigiVW5oYW5kbGVkIHByb21pc2UgcmVqZWN0aW9uOiAiICsgKGUucmVhc29uICYmIGUucmVhc29uLm1lc3NhZ2Ug",
  "fHwgZS5yZWFzb24pKSk7CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIElOVEVHUkFUSU9OIExBWUVSCiAgIFRoaXMgZnJvbnRlbmQgbm93IHRhbGtzIHRvIGEgcmVhbCBFcXVpdHlT",
  "Y2FuIGJhY2tlbmQgKHNlZSAvYmFja2VuZCkKICAgd2hpY2ggcHJveGllcyBOU0UgdmlhIHN0b2NrLW5zZS1pbmRpYSwgY2FjaGVkIGFuZCBidWRnZXQtbGltaXRlZCB0bwogICB+NTAgdXBzdHJlYW0gY2FsbHMvZGF5LiBFdmVyeSBBUEkuKiBtZXRob2QgYmVsb3cg",
  "dHJpZXMgdGhlIGxpdmUKICAgYmFja2VuZCBmaXJzdCBhbmQgZmFsbHMgYmFjayB0byBkZXRlcm1pbmlzdGljIG1vY2sgZGF0YSBpZiB0aGUKICAgYmFja2VuZCBpcyB1bnJlYWNoYWJsZSDigJQgd2hpY2ggaXMgZXhwZWN0ZWQgd2hlbiB0aGlzIHBhZ2UgaXMgb3Bl",
  "bmVkCiAgIGFzIGEgaG9zdGVkIHByZXZpZXcsIHNpbmNlIGEgcHVibGlzaGVkIHBhZ2UgY2Fubm90IHJlYWNoIGEKICAgbG9jYWxob3N0IHNlcnZlci4gUnVuIHRoZSBiYWNrZW5kIGFuZCBvcGVuIHRoaXMgZmlsZSBsb2NhbGx5IChub3QKICAgdGhlIHB1Ymxpc2hl",
  "ZCBwcmV2aWV3KSB0byBzZWUgcmVhbCBOU0UgcXVvdGVzIGVuZCB0byBlbmQuCiAgIFRoZSBiYWNrZW5kIGhhcyBubyBoaXN0b3JpY2FsLXByaWNlIGVuZHBvaW50IHlldCwgc28gY2hhcnQgc2VyaWVzCiAgIGFuZCBzcGFya2xpbmVzIHN0YXkgc3ludGhldGljIGV2",
  "ZW4gaW4gbGl2ZSBtb2RlIOKAlCBldmVyeXRoaW5nIGVsc2UKICAgKHByaWNlLCBjaGFuZ2UgJSwgNTJXIGhpZ2gvbG93LCBjb21wYW55IG5hbWUsIG1hcmtldCBzdGF0dXMpIGlzCiAgIHJlYWwgd2hlbiB0aGUgYmFja2VuZCBpcyByZWFjaGFibGUuCiAgID09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3QgQ09ORklHID0gewogIEFQSV9CQVNFOiAod2luZG93LmxvY2F0aW9uLnByb3RvY29sID09PSAiZmlsZToiID8gImh0dHA6Ly9sb2NhbGhvc3Q6",
  "MzAwMCIgOiB3aW5kb3cubG9jYXRpb24ub3JpZ2luKSArICIvYXBpIiwKICBMSVZFX1RJTUVPVVRfTVM6IDgwMDAsCn07CmxldCBsaXZlQmFja2VuZEF2YWlsYWJsZSA9IGZhbHNlOwpjb25zdCBNT0NLX0xBVEVOQ1kgPSA0MjA7CgpmdW5jdGlvbiBmZXRjaFdpdGhU",
  "aW1lb3V0KHVybCwgbXMpewogIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7CiAgY29uc3QgaWQgPSBzZXRUaW1lb3V0KCgpPT5jdHJsLmFib3J0KCksIG1zKTsKICByZXR1cm4gZmV0Y2godXJsLCB7c2lnbmFsOiBjdHJsLnNpZ25hbH0pLmZpbmFs",
  "bHkoKCk9PmNsZWFyVGltZW91dChpZCkpOwp9Cgphc3luYyBmdW5jdGlvbiBjaGVja0xpdmVCYWNrZW5kKCl7CiAgdHJ5ewogICAgY29uc3QgciA9IGF3YWl0IGZldGNoV2l0aFRpbWVvdXQoQ09ORklHLkFQSV9CQVNFICsgIi9oZWFsdGgiLCBDT05GSUcuTElWRV9U",
  "SU1FT1VUX01TKTsKICAgIGxpdmVCYWNrZW5kQXZhaWxhYmxlID0gISEociAmJiByLm9rKTsKICB9Y2F0Y2goZSl7CiAgICBsaXZlQmFja2VuZEF2YWlsYWJsZSA9IGZhbHNlOwogIH0KICB1cGRhdGVCYWNrZW5kQmFkZ2UoKTsKICByZXR1cm4gbGl2ZUJhY2tlbmRB",
  "dmFpbGFibGU7Cn0KCmZ1bmN0aW9uIHVwZGF0ZUJhY2tlbmRCYWRnZSgpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJhY2tlbmRCYWRnZSIpOwogIGlmKCFlbCkgcmV0dXJuOwogIGVsLmNsYXNzTGlzdC50b2dnbGUoImxpdmUiLCBsaXZl",
  "QmFja2VuZEF2YWlsYWJsZSk7CiAgZWwucXVlcnlTZWxlY3RvcigiLmRvdC1saXZlIikuc3R5bGUuYmFja2dyb3VuZCA9IGxpdmVCYWNrZW5kQXZhaWxhYmxlID8gInZhcigtLXBvcykiIDogInZhcigtLXRleHQtZmFpbnQpIjsKICBlbC5xdWVyeVNlbGVjdG9yKCJz",
  "cGFuOmxhc3QtY2hpbGQiKS50ZXh0Q29udGVudCA9IGxpdmVCYWNrZW5kQXZhaWxhYmxlID8gIkxpdmUgTlNFIERhdGEiIDogIkRlbW8gRGF0YSI7CiAgZWwudGl0bGUgPSBsaXZlQmFja2VuZEF2YWlsYWJsZQogICAgPyAiQ29ubmVjdGVkIHRvIHRoZSBFcXVpdHlT",
  "Y2FuIGJhY2tlbmQg4oCUIHByaWNlcyBhcmUgcmVhbCBOU0UgcXVvdGVzLiIKICAgIDogIkJhY2tlbmQgbm90IHJlYWNoYWJsZSBhdCAiICsgQ09ORklHLkFQSV9CQVNFICsgIiDigJQgc2hvd2luZyBkZXRlcm1pbmlzdGljIGRlbW8gZGF0YS4iOwp9CgpmdW5jdGlv",
  "biBtYXBCYWNrZW5kVG9Gcm9udGVuZChkKXsKICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkLnN5bWJvbCk7CiAgY29uc3QgYmFzaXMgPSBkLmN1cnJlbnRQcmljZSB8fCAxMDAwOwogIGNvbnN0IHNlcmllcyA9IGdlblNlcmllcyhzZWVkLCAyMCwgMC4wMDUsIGJh",
  "c2lzKTsKICBjb25zdCBrbm93bkRlZiA9IFVOSVZFUlNFLmZpbmQodT0+dS50PT09ZC5zeW1ib2wpOwogIHJldHVybiB7CiAgICB0OiBkLnN5bWJvbCwKICAgIG5hbWU6IGQuY29tcGFueU5hbWUgfHwgKGtub3duRGVmICYmIGtub3duRGVmLm5hbWUpIHx8IGQuc3lt",
  "Ym9sLAogICAgZXhjaDogZC5leGNoYW5nZSB8fCAiTlNFIiwKICAgIC8vIFRoZSBsaXZlIGJhY2tlbmQncyBpbmR1c3RyeSBsYWJlbCBkb2Vzbid0IHJlbGlhYmx5IG1hdGNoIG91ciBmaWx0ZXIKICAgIC8vIGRyb3Bkb3duJ3Mgdm9jYWJ1bGFyeSAob3IgbWF5IGJl",
  "IG1pc3NpbmcpLCBzbyBwcmVmZXIgb3VyIGtub3duIG1hcHBpbmcKICAgIC8vIGZvciBmaWx0ZXJpbmcgcHVycG9zZXMgYW5kIG9ubHkgZmFsbCBiYWNrIHRvIHRoZSBiYWNrZW5kJ3MgcmF3IHZhbHVlLgogICAgc2VjdG9yOiAoa25vd25EZWYgJiYga25vd25EZWYu",
  "c2VjdG9yKSB8fCBkLnNlY3RvciB8fCAi4oCUIiwKICAgIHByaWNlOiBkLmN1cnJlbnRQcmljZSwKICAgIGNoYW5nZTogZC5jaGFuZ2UsCiAgICBwY3Q6IGQucGVyY2VudENoYW5nZSwKICAgIG1hcmtldENhcDogZC5tYXJrZXRDYXAsCiAgICB2b2x1bWU6IGQudm9s",
  "dW1lLAogICAgaGlnaDUyOiBkLndlZWs1MkhpZ2gsCiAgICBsb3c1MjogZC53ZWVrNTJMb3csCiAgICBvcGVuOiBkLm9wZW4sCiAgICBkYXlIaWdoOiBkLmRheUhpZ2gsCiAgICBkYXlMb3c6IGQuZGF5TG93LAogICAgc2VyaWVzLAogICAgbGl2ZTogdHJ1ZSwKICAg",
  "IGRhdGFTdGF0dXM6IGQuZGF0YVN0YXR1cywKICB9Owp9Cgphc3luYyBmdW5jdGlvbiBsaXZlRmV0Y2hTdG9jayh0aWNrZXIpewogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KGAke0NPTkZJRy5BUElfQkFTRX0vc3RvY2svJHtlbmNvZGVVUklDb21w",
  "b25lbnQodGlja2VyKX1gLCBDT05GSUcuTElWRV9USU1FT1VUX01TKTsKICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKCJiYWNrZW5kIHN0YXR1cyAiK3Iuc3RhdHVzKTsKICBjb25zdCBqc29uID0gYXdhaXQgci5qc29uKCk7CiAgaWYoIWpzb24uc3VjY2VzcyB8",
  "fCAhanNvbi5kYXRhKSB0aHJvdyBuZXcgRXJyb3IoImJhY2tlbmQgcGF5bG9hZCBlcnJvciIpOwogIHJldHVybiBtYXBCYWNrZW5kVG9Gcm9udGVuZChqc29uLmRhdGEpOwp9Cgphc3luYyBmdW5jdGlvbiBsaXZlRmV0Y2hNYW55KHRpY2tlcnMpewogIGNvbnN0IHNl",
  "dHRsZWQgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQodGlja2Vycy5tYXAobGl2ZUZldGNoU3RvY2spKTsKICByZXR1cm4gc2V0dGxlZC5maWx0ZXIocz0+cy5zdGF0dXM9PT0iZnVsZmlsbGVkIikubWFwKHM9PnMudmFsdWUpOwp9Cgpjb25zdCBVTklWRVJTRSA9",
  "IFsKICB7dDoiVENTIiwgbmFtZToiVGF0YSBDb25zdWx0YW5jeSBTZXJ2aWNlcyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSVQgU2VydmljZXMiLCBiYXNlOjM4NDJ9LAogIHt0OiJSRUxJQU5DRSIsIG5hbWU6IlJlbGlhbmNlIEluZHVzdHJpZXMiLCBleGNoOiJOU0Ui",
  "LCBzZWN0b3I6IkVuZXJneSIsIGJhc2U6Mjk1MX0sCiAge3Q6IkhERkNCQU5LIiwgbmFtZToiSERGQyBCYW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZToxNjg3fSwKICB7dDoiSU5GWSIsIG5hbWU6IkluZm9zeXMiLCBleGNoOiJOU0UiLCBz",
  "ZWN0b3I6IklUIFNlcnZpY2VzIiwgYmFzZToxODQxfSwKICB7dDoiSUNJQ0lCQU5LIiwgbmFtZToiSUNJQ0kgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTI2NH0sCiAge3Q6IkJIQVJUSUFSVEwiLCBuYW1lOiJCaGFydGkgQWlydGVs",
  "IiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJUZWxlY29tIiwgYmFzZToxNjk4fSwKICB7dDoiU0JJTiIsIG5hbWU6IlN0YXRlIEJhbmsgb2YgSW5kaWEiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkJhbmtpbmciLCBiYXNlOjgyNH0sCiAge3Q6IklUQyIsIG5hbWU6IklUQyBM",
  "aW1pdGVkIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJGTUNHIiwgYmFzZTo0Nzh9LAogIHt0OiJMVCIsIG5hbWU6IkxhcnNlbiAmIFRvdWJybyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSW5mcmFzdHJ1Y3R1cmUiLCBiYXNlOjM2MTJ9LAogIHt0OiJLT1RBS0JBTksiLCBu",
  "YW1lOiJLb3RhayBNYWhpbmRyYSBCYW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZToxNzg5fSwKICB7dDoiSElORFVOSUxWUiIsIG5hbWU6IkhpbmR1c3RhbiBVbmlsZXZlciIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiRk1DRyIsIGJhc2U6MjU0",
  "N30sCiAge3Q6IkFYSVNCQU5LIiwgbmFtZToiQXhpcyBCYW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZToxMTQyfSwKICB7dDoiQkFKRklOQU5DRSIsIG5hbWU6IkJhamFqIEZpbmFuY2UiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkZpbmFuY2lh",
  "bCBTZXJ2aWNlcyIsIGJhc2U6NzI4NH0sCiAge3Q6Ik1BUlVUSSIsIG5hbWU6Ik1hcnV0aSBTdXp1a2kiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkF1dG9tb2JpbGUiLCBiYXNlOjEyNDgwfSwKICB7dDoiQVNJQU5QQUlOVCIsIG5hbWU6IkFzaWFuIFBhaW50cyIsIGV4",
  "Y2g6Ik5TRSIsIHNlY3RvcjoiQ29uc3VtZXIgR29vZHMiLCBiYXNlOjI4OTR9LAogIHt0OiJXSVBSTyIsIG5hbWU6IldpcHJvIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJJVCBTZXJ2aWNlcyIsIGJhc2U6NTEyfSwKICB7dDoiVElUQU4iLCBuYW1lOiJUaXRhbiBDb21w",
  "YW55IiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJDb25zdW1lciBHb29kcyIsIGJhc2U6MzQyMX0sCiAge3Q6IlNVTlBIQVJNQSIsIG5hbWU6IlN1biBQaGFybWFjZXV0aWNhbCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiUGhhcm1hIiwgYmFzZToxNzg2fSwKICB7dDoiTlRQ",
  "QyIsIG5hbWU6Ik5UUEMgTGltaXRlZCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiUG93ZXIiLCBiYXNlOjM2Mn0sCiAge3Q6IkFEQU5JRU5UIiwgbmFtZToiQWRhbmkgRW50ZXJwcmlzZXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkRpdmVyc2lmaWVkIiwgYmFzZToyOTE0",
  "fSwKICB7dDoiVUxUUkFDRU1DTyIsIG5hbWU6IlVsdHJhVGVjaCBDZW1lbnQiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkNlbWVudCIsIGJhc2U6MTEyNDB9LAogIHt0OiJQT1dFUkdSSUQiLCBuYW1lOiJQb3dlciBHcmlkIENvcnAiLCBleGNoOiJOU0UiLCBzZWN0b3I6",
  "IlBvd2VyIiwgYmFzZTozMTh9LAogIHt0OiJORVNUTEVJTkQiLCBuYW1lOiJOZXN0bGUgSW5kaWEiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkZNQ0ciLCBiYXNlOjIyNzh9LAogIHt0OiJUQVRBTU9UT1JTIiwgbmFtZToiVGF0YSBNb3RvcnMiLCBleGNoOiJOU0UiLCBz",
  "ZWN0b3I6IkF1dG9tb2JpbGUiLCBiYXNlOjk0OH0sCiAge3Q6IkpTV1NURUVMIiwgbmFtZToiSlNXIFN0ZWVsIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJNZXRhbHMiLCBiYXNlOjEwMTJ9LApdOwoKZnVuY3Rpb24gc2VlZGVkUmFuZChzZWVkKXsKICBsZXQgeCA9IE1h",
  "dGguc2luKHNlZWQpICogMTAwMDA7CiAgcmV0dXJuIHggLSBNYXRoLmZsb29yKHgpOwp9CmZ1bmN0aW9uIGRheU9mWWVhcigpewogIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7CiAgcmV0dXJuIE1hdGguZmxvb3IoKG5vdyAtIG5ldyBEYXRlKG5vdy5nZXRGdWxsWWVh",
  "cigpLDAsMCkpIC8gODY0MDAwMDApOwp9CmZ1bmN0aW9uIGdlblNlcmllcyhzZWVkLCBwb2ludHMsIHZvbGF0aWxpdHksIGJhc2UpewogIGNvbnN0IGFyciA9IFtdOwogIGxldCB2ID0gYmFzZTsKICBmb3IobGV0IGk9MDtpPHBvaW50cztpKyspewogICAgY29uc3Qg",
  "ciA9IHNlZWRlZFJhbmQoc2VlZCAqIDk3LjcgKyBpICogMTMuMzEpIC0gMC41OwogICAgdiA9IHYgKiAoMSArIHIgKiB2b2xhdGlsaXR5KTsKICAgIGFyci5wdXNoKHYpOwogIH0KICByZXR1cm4gYXJyOwp9CmZ1bmN0aW9uIHRpY2tlclNlZWQodGlja2VyKXsKICBs",
  "ZXQgaCA9IDA7CiAgZm9yKGxldCBpPTA7aTx0aWNrZXIubGVuZ3RoO2krKykgaCA9IChoKjMxICsgdGlja2VyLmNoYXJDb2RlQXQoaSkpICUgMTAwMDAwOwogIHJldHVybiBoICsgZGF5T2ZZZWFyKCk7Cn0KCmZ1bmN0aW9uIHdpdGhMYXRlbmN5KHZhbHVlKXsKICBy",
  "ZXR1cm4gbmV3IFByb21pc2UocmVzID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzKHZhbHVlKSwgTU9DS19MQVRFTkNZKSk7Cn0KCmNvbnN0IEFQSSA9IHsKICBhc3luYyBmZXRjaEluZGljZXMoKXsKICAgIGNvbnN0IGRlZnMgPSBbCiAgICAgIHtjb2RlOiJOSUZUWSA1",
  "MCIsIGZ1bGw6Ik5TRSBOaWZ0eSA1MCBJbmRleCIsIGJhc2U6MjQ4MTJ9LAogICAgICB7Y29kZToiU0VOU0VYIiwgZnVsbDoiQlNFIFNlbnNleCIsIGJhc2U6ODE2NDB9LAogICAgICB7Y29kZToiTklGVFkgQkFOSyIsIGZ1bGw6Ik5TRSBCYW5rIE5pZnR5IEluZGV4",
  "IiwgYmFzZTo1MjE0MH0sCiAgICBdOwogICAgY29uc3Qgb3V0ID0gZGVmcy5tYXAoZD0+ewogICAgICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkLmNvZGUpOwogICAgICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCwgMjQsIDAuMDA2LCBkLmJhc2UpOwog",
  "ICAgICBjb25zdCBsYXN0ID0gc2VyaWVzW3Nlcmllcy5sZW5ndGgtMV07CiAgICAgIGNvbnN0IHByZXYgPSBkLmJhc2U7CiAgICAgIGNvbnN0IGNoZyA9IGxhc3QgLSBwcmV2OwogICAgICBjb25zdCBwY3QgPSAoY2hnL3ByZXYpKjEwMDsKICAgICAgcmV0dXJuIHsu",
  "Li5kLCB2YWx1ZTpsYXN0LCBjaGFuZ2U6Y2hnLCBwY3QsIHNlcmllc307CiAgICB9KTsKICAgIHJldHVybiB3aXRoTGF0ZW5jeShvdXQpOwogIH0sCgogIGFzeW5jIHNlYXJjaFN0b2NrcyhxdWVyeSl7CiAgICBjb25zdCBxID0gcXVlcnkudHJpbSgpLnRvTG93ZXJD",
  "YXNlKCk7CiAgICBpZighcSkgcmV0dXJuIHdpdGhMYXRlbmN5KFtdKTsKICAgIGNvbnN0IG1hdGNoZXMgPSBVTklWRVJTRS5maWx0ZXIocyA9PiBzLnQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSB8fCBzLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSku",
  "c2xpY2UoMCw4KTsKICAgIGlmKGxpdmVCYWNrZW5kQXZhaWxhYmxlKXsKICAgICAgY29uc3QgbGl2ZSA9IGF3YWl0IGxpdmVGZXRjaE1hbnkobWF0Y2hlcy5tYXAobT0+bS50KSk7CiAgICAgIGlmKGxpdmUubGVuZ3RoKSByZXR1cm4gbGl2ZTsKICAgIH0KICAgIHJl",
  "dHVybiB3aXRoTGF0ZW5jeShtYXRjaGVzLm1hcChzID0+IGRlY29yYXRlU3RvY2socykpKTsKICB9LAoKICBhc3luYyBmZXRjaFNjcmVlbmVyUmVzdWx0cyhmaWx0ZXJzKXsKICAgIGxldCBsaXN0OwogICAgaWYobGl2ZUJhY2tlbmRBdmFpbGFibGUpewogICAgICBj",
  "b25zdCBsaXZlID0gYXdhaXQgbGl2ZUZldGNoTWFueShVTklWRVJTRS5tYXAocz0+cy50KSk7CiAgICAgIGxpc3QgPSBsaXZlLmxlbmd0aCA/IGxpdmUgOiBVTklWRVJTRS5tYXAocz0+ZGVjb3JhdGVTdG9jayhzKSk7CiAgICB9IGVsc2UgewogICAgICBsaXN0ID0g",
  "VU5JVkVSU0UubWFwKGRlY29yYXRlU3RvY2spOwogICAgICBhd2FpdCB3aXRoTGF0ZW5jeShudWxsKTsKICAgIH0KICAgIGlmKGZpbHRlcnMucXVlcnkpewogICAgICBjb25zdCBxID0gZmlsdGVycy5xdWVyeS50b0xvd2VyQ2FzZSgpOwogICAgICBsaXN0ID0gbGlz",
  "dC5maWx0ZXIocz0+cy50LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSl8fHMubmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTsKICAgIH0KICAgIGlmKGZpbHRlcnMuc2VjdG9yICYmIGZpbHRlcnMuc2VjdG9yICE9PSAiQWxsIikgbGlzdCA9IGxpc3QuZmls",
  "dGVyKHM9PnMuc2VjdG9yPT09ZmlsdGVycy5zZWN0b3IpOwogICAgaWYoZmlsdGVycy5taW5QcmljZSkgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMucHJpY2U+PWZpbHRlcnMubWluUHJpY2UpOwogICAgaWYoZmlsdGVycy5tYXhQcmljZSkgbGlzdCA9IGxpc3QuZmls",
  "dGVyKHM9PnMucHJpY2U8PWZpbHRlcnMubWF4UHJpY2UpOwogICAgaWYoZmlsdGVycy5kaXJlY3Rpb249PT0iZ2FpbmVycyIpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnBjdD49MCk7CiAgICBpZihmaWx0ZXJzLmRpcmVjdGlvbj09PSJsb3NlcnMiKSBsaXN0ID0g",
  "bGlzdC5maWx0ZXIocz0+cy5wY3Q8MCk7CiAgICByZXR1cm4gbGlzdDsKICB9LAoKICBhc3luYyBmZXRjaFN0b2NrKHRpY2tlcil7CiAgICBpZihsaXZlQmFja2VuZEF2YWlsYWJsZSl7CiAgICAgIHRyeXsgcmV0dXJuIGF3YWl0IGxpdmVGZXRjaFN0b2NrKHRpY2tl",
  "cik7IH0KICAgICAgY2F0Y2goZSl7IC8qIGZhbGwgdGhyb3VnaCB0byBtb2NrICovIH0KICAgIH0KICAgIGNvbnN0IGRlZiA9IFVOSVZFUlNFLmZpbmQocz0+cy50PT09dGlja2VyKTsKICAgIGlmKCFkZWYpIHJldHVybiB3aXRoTGF0ZW5jeShudWxsKTsKICAgIHJl",
  "dHVybiB3aXRoTGF0ZW5jeShkZWNvcmF0ZVN0b2NrKGRlZiwgdHJ1ZSkpOwogIH0sCgogIGFzeW5jIGZldGNoU3RvY2tIaXN0b3J5KHRpY2tlciwgcmFuZ2UpewogICAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQodGlja2VyKTsKICAgIGNvbnN0IGNmZyA9IHsKICAg",
  "ICAgIjFEIjp7cG9pbnRzOjc4LCB2b2w6MC4wMDE2fSwKICAgICAgIjFXIjp7cG9pbnRzOjM1LCB2b2w6MC4wMDN9LAogICAgICAiMU0iOntwb2ludHM6MjIsIHZvbDowLjAwOH0sCiAgICAgICIzTSI6e3BvaW50czo2NSwgdm9sOjAuMDA5fSwKICAgICAgIjZNIjp7",
  "cG9pbnRzOjEzMCwgdm9sOjAuMDEwfSwKICAgICAgIjFZIjp7cG9pbnRzOjI1MCwgdm9sOjAuMDEyfSwKICAgIH1bcmFuZ2VdIHx8IHtwb2ludHM6NjAsIHZvbDowLjAwOH07CiAgICBjb25zdCBkZWYgPSBVTklWRVJTRS5maW5kKHM9PnMudD09PXRpY2tlcik7CiAg",
  "ICBjb25zdCBiYXNlID0gZGVmID8gZGVmLmJhc2UgKiAwLjk0IDogMTAwMDsKICAgIGNvbnN0IHNlcmllcyA9IGdlblNlcmllcyhzZWVkICsgcmFuZ2UubGVuZ3RoLCBjZmcucG9pbnRzLCBjZmcudm9sLCBiYXNlKTsKICAgIHJldHVybiB3aXRoTGF0ZW5jeShzZXJp",
  "ZXMpOwogIH0sCn07CgpmdW5jdGlvbiBkZWNvcmF0ZVN0b2NrKGRlZiwgZGV0YWlsZWQpewogIGNvbnN0IHNlZWQgPSB0aWNrZXJTZWVkKGRlZi50KTsKICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCwgMjAsIDAuMDA1LCBkZWYuYmFzZSk7CiAgY29uc3Qg",
  "cHJpY2UgPSBzZXJpZXNbc2VyaWVzLmxlbmd0aC0xXTsKICBjb25zdCBwcmV2Q2xvc2UgPSBkZWYuYmFzZTsKICBjb25zdCBjaGFuZ2UgPSBwcmljZSAtIHByZXZDbG9zZTsKICBjb25zdCBwY3QgPSAoY2hhbmdlL3ByZXZDbG9zZSkqMTAwOwogIGNvbnN0IG1hcmtl",
  "dENhcCA9IHByaWNlICogKHNlZWRlZFJhbmQoc2VlZCoyLjEpKjQwMDArODAwKSAqIDFlNjsKICBjb25zdCB2b2x1bWUgPSBNYXRoLnJvdW5kKHNlZWRlZFJhbmQoc2VlZCozLjMpKjhfMDAwXzAwMCArIDIwMF8wMDApOwogIGNvbnN0IGhpZ2g1MiA9IHByaWNlICog",
  "KDEgKyBzZWVkZWRSYW5kKHNlZWQqNC40KSowLjM1ICsgMC4wNSk7CiAgY29uc3QgbG93NTIgPSBwcmljZSAqICgxIC0gc2VlZGVkUmFuZChzZWVkKjUuNSkqMC4zMCAtIDAuMDQpOwogIGNvbnN0IG91dCA9IHsKICAgIHQ6ZGVmLnQsIG5hbWU6ZGVmLm5hbWUsIGV4",
  "Y2g6ZGVmLmV4Y2gsIHNlY3RvcjpkZWYuc2VjdG9yLAogICAgcHJpY2UsIGNoYW5nZSwgcGN0LCBtYXJrZXRDYXAsIHZvbHVtZSwgaGlnaDUyLCBsb3c1Miwgc2VyaWVzLAogIH07CiAgaWYoZGV0YWlsZWQpewogICAgb3V0Lm9wZW4gPSBwcmljZSAtIGNoYW5nZSow",
  "LjY7CiAgICBvdXQuZGF5SGlnaCA9IE1hdGgubWF4KHByaWNlLCBvdXQub3BlbikgKiAoMStzZWVkZWRSYW5kKHNlZWQqNi42KSowLjAxMik7CiAgICBvdXQuZGF5TG93ID0gTWF0aC5taW4ocHJpY2UsIG91dC5vcGVuKSAqICgxLXNlZWRlZFJhbmQoc2VlZCo3Ljcp",
  "KjAuMDEyKTsKICB9CiAgcmV0dXJuIG91dDsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBGT1JNQVQgSEVMUEVSUwogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmZ1bmN0aW9uIGZtdElOUih2LCBkZWNpbWFscyl7CiAgaWYodj09PXVuZGVmaW5lZHx8dj09PW51bGx8fGlzTmFOKHYpKSByZXR1cm4gIuKAlCI7CiAgY29uc3QgZCA9IGRlY2ltYWxzPT09dW5kZWZp",
  "bmVkPzI6ZGVjaW1hbHM7CiAgcmV0dXJuICLigrkiICsgdi50b0xvY2FsZVN0cmluZygiZW4tSU4iLCB7bWluaW11bUZyYWN0aW9uRGlnaXRzOmQsIG1heGltdW1GcmFjdGlvbkRpZ2l0czpkfSk7Cn0KZnVuY3Rpb24gZm10Q29tcGFjdCh2KXsKICBpZih2PT09dW5k",
  "ZWZpbmVkfHx2PT09bnVsbHx8aXNOYU4odikpIHJldHVybiAi4oCUIjsKICBpZih2Pj0xZTEyKSByZXR1cm4gIuKCuSIrKHYvMWUxMikudG9GaXhlZCgyKSsiVCI7CiAgaWYodj49MWU5KSByZXR1cm4gIuKCuSIrKHYvMWU5KS50b0ZpeGVkKDIpKyJCIjsKICBpZih2",
  "Pj0xZTcpIHJldHVybiAi4oK5Iisodi8xZTcpLnRvRml4ZWQoMikrIkNyIjsKICBpZih2Pj0xZTUpIHJldHVybiAi4oK5Iisodi8xZTUpLnRvRml4ZWQoMikrIkwiOwogIHJldHVybiAi4oK5Iit2LnRvRml4ZWQoMCk7Cn0KZnVuY3Rpb24gZm10Vm9sKHYpewogIGlm",
  "KHY+PTFlNykgcmV0dXJuICh2LzFlNykudG9GaXhlZCgyKSsiQ3IiOwogIGlmKHY+PTFlNSkgcmV0dXJuICh2LzFlNSkudG9GaXhlZCgyKSsiTCI7CiAgaWYodj49MWUzKSByZXR1cm4gKHYvMWUzKS50b0ZpeGVkKDEpKyJLIjsKICByZXR1cm4gU3RyaW5nKHYpOwp9",
  "CmZ1bmN0aW9uIHBjdFN0cihwKXsgcmV0dXJuIChwPj0wPyIrIjoiIikgKyBwLnRvRml4ZWQoMikgKyAiJSI7IH0KZnVuY3Rpb24gY2hnU3RyKGMpeyByZXR1cm4gKGM+PTA/IisiOiIiKSArIGZtdElOUihNYXRoLmFicyhjKSk7IH0KZnVuY3Rpb24gZXNjYXBlSHRt",
  "bChzKXsKICByZXR1cm4gU3RyaW5nKHMpLnJlcGxhY2UoL1smPD4iJ10vZywgbSA9PiAoeyImIjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwnIic6IiZxdW90OyIsIiciOiImIzM5OyJ9W21dKSk7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgU1RBVEUKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCBzdGF0ZSA9IHsKICB2aWV3OiAiZGFzaGJv",
  "YXJkIiwKICB3YXRjaGxpc3Q6IFtdLAogIGRldGFpbFRpY2tlcjogIlRDUyIsCiAgZGV0YWlsUmFuZ2U6ICIxTSIsCiAgc2NyZWVuZXJGaWx0ZXJzOiB7cXVlcnk6IiIsIHNlY3RvcjoiQWxsIiwgbWluUHJpY2U6MCwgbWF4UHJpY2U6MTUwMDAsIGRpcmVjdGlvbjoi",
  "YWxsIn0sCiAgc2NyZWVuZXJTb3J0OiB7a2V5OiJtYXJrZXRDYXAiLCBkaXI6ImRlc2MifSwKfTsKCnRyeXsKICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCJlcXVpdHlzY2FuX3dhdGNobGlzdCIpOwogIGlmKHNhdmVkKSBzdGF0ZS53YXRjaGxp",
  "c3QgPSBKU09OLnBhcnNlKHNhdmVkKTsKfWNhdGNoKGUpe30KZnVuY3Rpb24gcGVyc2lzdFdhdGNobGlzdCgpewogIHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oImVxdWl0eXNjYW5fd2F0Y2hsaXN0IiwgSlNPTi5zdHJpbmdpZnkoc3RhdGUud2F0Y2hsaXN0KSk7",
  "IH1jYXRjaChlKXt9Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgU1BBUktMSU5FIChpbmxpbmUgU1ZHKQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmZ1bmN0aW9uIHNwYXJrbGluZVNWRyhzZXJpZXMsIHBvc2l0aXZlLCB3LCBoKXsKICB3ID0gd3x8MTIwOyBoID0gaHx8MzY7CiAgaWYoIXNlcmllcyB8fCBzZXJpZXMubGVuZ3RoPDIpIHJldHVybiAiIjsKICBj",
  "b25zdCBtaW4gPSBNYXRoLm1pbiguLi5zZXJpZXMpLCBtYXggPSBNYXRoLm1heCguLi5zZXJpZXMpOwogIGNvbnN0IHJhbmdlID0gKG1heC1taW4pfHwxOwogIGNvbnN0IHN0ZXAgPSB3LyhzZXJpZXMubGVuZ3RoLTEpOwogIGNvbnN0IHB0cyA9IHNlcmllcy5tYXAo",
  "KHYsaSk9PltpKnN0ZXAsIGggLSAoKHYtbWluKS9yYW5nZSkqaCowLjg2IC0gaCowLjA3XSk7CiAgY29uc3QgcGF0aCA9IHB0cy5tYXAoKHAsaSk9PihpPT09MD8iTSI6IkwiKStwWzBdLnRvRml4ZWQoMSkrIiwiK3BbMV0udG9GaXhlZCgxKSkuam9pbigiICIpOwog",
  "IGNvbnN0IGFyZWFQYXRoID0gcGF0aCArIGAgTCR7d30sJHtofSBMMCwke2h9IFpgOwogIGNvbnN0IGNvbG9yID0gcG9zaXRpdmUgPyAidmFyKC0tcG9zKSIgOiAidmFyKC0tbmVnKSI7CiAgY29uc3QgZ2lkID0gInNnIitNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2",
  "KS5zbGljZSgyLDkpOwogIHJldHVybiBgPHN2ZyB2aWV3Qm94PSIwIDAgJHt3fSAke2h9IiB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJub25lIj4KICAgIDxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iJHtnaWR9IiB4MT0i",
  "MCIgeTE9IjAiIHgyPSIwIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiR7Y29sb3J9IiBzdG9wLW9wYWNpdHk9IjAuMzUiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIke2NvbG9yfSIgc3RvcC1vcGFj",
  "aXR5PSIwIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KICAgIDxwYXRoIGQ9IiR7YXJlYVBhdGh9IiBmaWxsPSJ1cmwoIyR7Z2lkfSkiIHN0cm9rZT0ibm9uZSIvPgogICAgPHBhdGggZD0iJHtwYXRofSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIke2NvbG9y",
  "fSIgc3Ryb2tlLXdpZHRoPSIxLjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogIDwvc3ZnPmA7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT0KICAgQU1CSUVOVCBERUNPUkFUSVZFIExJTkVTIChkcmF3biBvbmNlKQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCihmdW5jdGlvbiBkcmF3QW1iaWVudExpbmVzKCl7CiAgY29u",
  "c3Qgc3ZnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFtYmllbnRMaW5lcyIpOwogIGNvbnN0IHcgPSAxNDAwLCBoID0gODAwOwogIHN2Zy5zZXRBdHRyaWJ1dGUoInZpZXdCb3giLCBgMCAwICR7d30gJHtofWApOwogIGxldCBodG1sID0gIiI7CiAgZm9yKGxl",
  "dCBpPTA7aTwzO2krKyl7CiAgICBjb25zdCBzZWVkID0gaSoxNyszOwogICAgY29uc3QgcHRzID0gW107CiAgICBjb25zdCBuID0gMTI7CiAgICBmb3IobGV0IGo9MDtqPD1uO2orKyl7CiAgICAgIGNvbnN0IHggPSAoai9uKSp3OwogICAgICBjb25zdCB5ID0gaCow",
  "LjI1ICsgaSoxMzAgKyAoc2VlZGVkUmFuZChzZWVkK2opLTAuNSkqOTA7CiAgICAgIHB0cy5wdXNoKFt4LHldKTsKICAgIH0KICAgIGNvbnN0IHBhdGggPSBwdHMubWFwKChwLGlkeCk9PihpZHg9PT0wPyJNIjoiTCIpK3BbMF0udG9GaXhlZCgwKSsiLCIrcFsxXS50",
  "b0ZpeGVkKDApKS5qb2luKCIgIik7CiAgICBjb25zdCBjb2xvcnMgPSBbIiM0QzdERkYiLCIjOEI2QkYwIiwiIzMxRDVFRSJdOwogICAgaHRtbCArPSBgPHBhdGggZD0iJHtwYXRofSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIke2NvbG9yc1tpJTNdfSIgc3Ryb2tlLXdp",
  "ZHRoPSIxIiBvcGFjaXR5PSIwLjEwIi8+YDsKICB9CiAgc3ZnLmlubmVySFRNTCA9IGh0bWw7Cn0pKCk7CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEhFQURFUiBCRUhBVklPUgog",
  "ICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmNvbnN0IHRvcGJhciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0b3BiYXIiKTsKd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoInNjcm9s",
  "bCIsICgpPT57CiAgdG9wYmFyLmNsYXNzTGlzdC50b2dnbGUoInNjcm9sbGVkIiwgd2luZG93LnNjcm9sbFkgPiA4KTsKfSk7CgpmdW5jdGlvbiBzZXRBY3RpdmVOYXYodmlldyl7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiI21haW5OYXYgYnV0dG9uLCAj",
  "Ym90dG9tTmF2IGJ1dHRvbiIpLmZvckVhY2goYj0+ewogICAgYi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiLCBiLmRhdGFzZXQudmlldz09PXZpZXcpOwogIH0pOwp9CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtYWluTmF2IikuYWRkRXZlbnRMaXN0ZW5lcigi",
  "Y2xpY2siLCBlPT57CiAgY29uc3QgYnRuID0gZS50YXJnZXQuY2xvc2VzdCgiYnV0dG9uW2RhdGEtdmlld10iKTsKICBpZihidG4pIG5hdmlnYXRlKGJ0bi5kYXRhc2V0LnZpZXcpOwp9KTsKZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJvdHRvbU5hdiIpLmFkZEV2",
  "ZW50TGlzdGVuZXIoImNsaWNrIiwgZT0+ewogIGNvbnN0IGJ0biA9IGUudGFyZ2V0LmNsb3Nlc3QoImJ1dHRvbltkYXRhLXZpZXddIik7CiAgaWYoYnRuKSBuYXZpZ2F0ZShidG4uZGF0YXNldC52aWV3KTsKfSk7CgpmdW5jdGlvbiBuYXZpZ2F0ZSh2aWV3LCB0aWNr",
  "ZXIpewogIHN0YXRlLnZpZXcgPSB2aWV3OwogIGlmKHRpY2tlcikgc3RhdGUuZGV0YWlsVGlja2VyID0gdGlja2VyOwogIHNldEFjdGl2ZU5hdih2aWV3ID09PSAiZGV0YWlsIiA/ICJtYXJrZXRzIiA6IHZpZXcpOwogIHdpbmRvdy5zY3JvbGxUbyh7dG9wOjAsIGJl",
  "aGF2aW9yOiB3aW5kb3cubWF0Y2hNZWRpYSgnKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246IHJlZHVjZSknKS5tYXRjaGVzID8gImF1dG8iIDogInNtb290aCJ9KTsKICByZW5kZXIoKTsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PQogICBNQVJLRVQgU1RBVFVTIChJU1QgYnVzaW5lc3MgaG91cnMsIHB1cmVseSBwcmVzZW50YXRpb25hbCkKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PSAqLwooZnVuY3Rpb24gbWFya2V0U3RhdHVzKCl7CiAgY29uc3Qgbm93ID0gbmV3IERhdGUoKTsKICBjb25zdCBpc3RIb3VyID0gKG5vdy5nZXRVVENIb3VycygpKzUpJTI0ICsgKG5vdy5nZXRVVENNaW51dGVzKCkrMzA+PTYwPzE6MCk7CiAgY29uc3QgbWlu",
  "cyA9IChub3cuZ2V0VVRDTWludXRlcygpKzMwKSU2MDsKICBjb25zdCB0b3RhbE1pbiA9ICgobm93LmdldFVUQ0hvdXJzKCkrNSklMjQpKjYwICsgbWluczsKICBjb25zdCBvcGVuID0gdG90YWxNaW4gPj0gNTU1ICYmIHRvdGFsTWluIDw9IDkzMDsgLy8gOToxNSAt",
  "IDE1OjMwIElTVAogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtYXJrZXRTdGF0dXNUZXh0IikudGV4dENvbnRlbnQgPSBvcGVuID8gIk1hcmtldCBPcGVuIiA6ICJNYXJrZXQgQ2xvc2VkIjsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCIuZG90LWxpdmUiKS5z",
  "dHlsZS5iYWNrZ3JvdW5kID0gb3BlbiA/ICJ2YXIoLS1wb3MpIiA6ICJ2YXIoLS10ZXh0LWZhaW50KSI7Cn0pKCk7CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFJFTkRFUjogUk9P",
  "VAogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmNvbnN0IHJvb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibWFpblJvb3QiKTsKCmZ1bmN0aW9uIHJlbmRlcigpewogIGlmKHN0",
  "YXRlLnZpZXcgPT09ICJkYXNoYm9hcmQiKSByZW5kZXJEYXNoYm9hcmQoKTsKICBlbHNlIGlmKHN0YXRlLnZpZXcgPT09ICJzY3JlZW5lciIpIHJlbmRlclNjcmVlbmVyKCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09PSAibWFya2V0cyIpIHJlbmRlck1hcmtldHMo",
  "KTsKICBlbHNlIGlmKHN0YXRlLnZpZXcgPT09ICJ3YXRjaGxpc3QiKSByZW5kZXJXYXRjaGxpc3QoKTsKICBlbHNlIGlmKHN0YXRlLnZpZXcgPT09ICJkZXRhaWwiKSByZW5kZXJEZXRhaWwoKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBEQVNIQk9BUkQgLS0tLS0t",
  "LS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJEYXNoYm9hcmQoKXsKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciIGlkPSJkYXNoVmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPk1hcmtldCBP",
  "dmVydmlldzwvaDI+PHNwYW4gY2xhc3M9InN1YiI+UmVhbC10aW1lIGluZGV4IHNuYXBzaG90PC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoZXJvLXJvdyIgaWQ9ImluZGljZXNSb3ciPgogICAgICAgICR7c2tlbGV0b25DYXJkcygzKX0KICAgICAgPC9k",
  "aXY+CgogICAgICAke3NlYXJjaEJsb2NrKCl9CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5NYXJrZXQgQnJlYWR0aDwvaDI+PHNwYW4gY2xhc3M9InN1YiI+QWR2YW5jZXJzIHZzIGRlY2xpbmVycywgZnVsbCB1bml2ZXJzZTwvc3Bhbj48L2Rp",
  "dj4KICAgICAgPGRpdiBjbGFzcz0iZ2xhc3MgYnJlYWR0aC1jYXJkIiBpZD0iYnJlYWR0aENhcmQiIHN0eWxlPSJwYWRkaW5nOjE4cHggMjJweDttYXJnaW4tYm90dG9tOjM0cHg7Ij4ke3NrZWxldG9uTGluZXMoMil9PC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJz",
  "ZWN0aW9uLWhlYWQiPjxoMj5Ub3AgTW92ZXJzPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5CeSBhYnNvbHV0ZSBjaGFuZ2UgdG9kYXk8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAgZ2xhc3MiIGlkPSJtb3ZlcnNUYWJsZVdyYXAiPjxkaXYg",
  "c3R5bGU9InBhZGRpbmc6MjBweDsiPiR7c2tlbGV0b25MaW5lcyg2KX08L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RvY2stY2FyZHMiIGlkPSJtb3ZlcnNDYXJkcyI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwogIHdpcmVTZWFyY2goKTsKCiAgdHJ5ewog",
  "ICAgY29uc3QgaW5kaWNlcyA9IGF3YWl0IEFQSS5mZXRjaEluZGljZXMoKTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJpbmRpY2VzUm93IikuaW5uZXJIVE1MID0gaW5kaWNlcy5tYXAoaW5kZXhDYXJkSFRNTCkuam9pbigiIik7CiAgICBkb2N1bWVudC5x",
  "dWVyeVNlbGVjdG9yQWxsKCIuaW5kZXgtc3BhcmsiKS5mb3JFYWNoKChlbCxpKT0+ewogICAgICBlbC5pbm5lckhUTUwgPSBzcGFya2xpbmVTVkcoaW5kaWNlc1tpXS5zZXJpZXMsIGluZGljZXNbaV0uY2hhbmdlPj0wKTsKICAgIH0pOwogIH1jYXRjaChlKXsKICAg",
  "IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJpbmRpY2VzUm93IikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIk1hcmtldCBkYXRhIHRlbXBvcmFyaWx5IHVuYXZhaWxhYmxlIiwgIldlIGNvdWxkbid0IHJlYWNoIHRoZSBpbmRpY2VzIGZlZWQuIFBsZWFzZSB0",
  "cnkgYWdhaW4gc2hvcnRseS4iKTsKICB9CgogIHRyeXsKICAgIGNvbnN0IGZ1bGwgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJlc3VsdHMoe30pOwogICAgdHJ5ewogICAgICByZW5kZXJCcmVhZHRoKGZ1bGwpOwogICAgfWNhdGNoKGUpewogICAgICBkb2N1bWVu",
  "dC5nZXRFbGVtZW50QnlJZCgiYnJlYWR0aENhcmQiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiQnJlYWR0aCBkYXRhIHVuYXZhaWxhYmxlIiwgIkNvdWxkbid0IGNvbXB1dGUgYWR2YW5jZXJzIHZzIGRlY2xpbmVycy4gKCIgKyAoZSAmJiBlLm1lc3NhZ2Ug",
  "fHwgZSkgKyAiKSIpOwogICAgICBzaG93RXJyb3JCYW5uZXIoInJlbmRlckJyZWFkdGggZmFpbGVkOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsKICAgIH0KICAgIHRyeXsKICAgICAgY29uc3QgbW92ZXJzID0gZnVsbC5zbGljZSgpLnNvcnQoKGEsYik9Pk1h",
  "dGguYWJzKGIucGN0KS1NYXRoLmFicyhhLnBjdCkpLnNsaWNlKDAsOCk7CiAgICAgIHJlbmRlclRhYmxlSW50bygibW92ZXJzVGFibGVXcmFwIiwgIm1vdmVyc0NhcmRzIiwgbW92ZXJzLCB7a2V5OiJwY3QiLCBkaXI6ImRlc2MifSwgZmFsc2UpOwogICAgfWNhdGNo",
  "KGUpewogICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibW92ZXJzVGFibGVXcmFwIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIlVuYWJsZSB0byByZXRyaWV2ZSBtb3ZlcnMiLCAiU29tZXRoaW5nIHdlbnQgd3JvbmcgbG9hZGluZyB0aGlzIGxpc3Qu",
  "ICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgICAgc2hvd0Vycm9yQmFubmVyKCJtb3ZlcnMgdGFibGUgcmVuZGVyIGZhaWxlZDogIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSk7CiAgICB9CiAgfWNhdGNoKGUpewogICAgZG9jdW1lbnQuZ2V0",
  "RWxlbWVudEJ5SWQoIm1vdmVyc1RhYmxlV3JhcCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJVbmFibGUgdG8gcmV0cmlldmUgbW92ZXJzIiwgIlNvbWV0aGluZyB3ZW50IHdyb25nIGxvYWRpbmcgdGhpcyBsaXN0LiAoIiArIChlICYmIGUubWVzc2FnZSB8",
  "fCBlKSArICIpIik7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYnJlYWR0aENhcmQiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiQnJlYWR0aCBkYXRhIHVuYXZhaWxhYmxlIiwgIkNvdWxkbid0IGNvbXB1dGUgYWR2YW5jZXJzIHZzIGRlY2xpbmVy",
  "cy4gKCIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkgKyAiKSIpOwogICAgc2hvd0Vycm9yQmFubmVyKCJmZXRjaFNjcmVlbmVyUmVzdWx0cyBmYWlsZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogIH0KfQoKZnVuY3Rpb24gcmVuZGVyQnJlYWR0aChsaXN0",
  "KXsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJicmVhZHRoQ2FyZCIpOwogIGlmKCFlbCB8fCAhbGlzdC5sZW5ndGgpeyBpZihlbCkgZWwuaW5uZXJIVE1MID0gZW1wdHlTdGF0ZUhUTUwoIk5vIGJyZWFkdGggZGF0YSIsICJObyBzdG9ja3Mg",
  "d2VyZSByZXR1cm5lZCB0byBjb21wdXRlIHRoaXMgZnJvbS4iKTsgcmV0dXJuOyB9CiAgY29uc3QgYWR2YW5jZXJzID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q+MCkubGVuZ3RoOwogIGNvbnN0IGRlY2xpbmVycyA9IGxpc3QuZmlsdGVyKHM9PnMucGN0PDApLmxlbmd0",
  "aDsKICBjb25zdCBmbGF0ID0gbGlzdC5sZW5ndGggLSBhZHZhbmNlcnMgLSBkZWNsaW5lcnM7CiAgY29uc3QgdG90YWwgPSBsaXN0Lmxlbmd0aDsKICBjb25zdCBhZHZQY3QgPSAoYWR2YW5jZXJzL3RvdGFsKSoxMDAsIGRlY1BjdCA9IChkZWNsaW5lcnMvdG90YWwp",
  "KjEwMCwgZmxhdFBjdCA9IChmbGF0L3RvdGFsKSoxMDA7CiAgZWwuaW5uZXJIVE1MID0gYAogICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmJhc2VsaW5lO21hcmdpbi1ib3R0b206MTJw",
  "eDtmbGV4LXdyYXA6d3JhcDtnYXA6OHB4OyI+CiAgICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtnYXA6MjBweDsiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNpemU6MjBweDtjb2xvcjp2YXIo",
  "LS1wb3Mtc29mdCk7Ij4ke2FkdmFuY2Vyc308L3NwYW4+IDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTJweDsiPmFkdmFuY2luZzwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2PjxzcGFuIGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1",
  "bGFyIiBzdHlsZT0iZm9udC1zaXplOjIwcHg7Y29sb3I6dmFyKC0tbmVnLXNvZnQpOyI+JHtkZWNsaW5lcnN9PC9zcGFuPiA8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEycHg7Ij5kZWNsaW5pbmc8L3NwYW4+PC9kaXY+CiAgICAg",
  "ICAgPGRpdj48c3BhbiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciIgc3R5bGU9ImZvbnQtc2l6ZToyMHB4O2NvbG9yOnZhcigtLXRleHQtbWlkKTsiPiR7ZmxhdH08L3NwYW4+IDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTJw",
  "eDsiPnVuY2hhbmdlZDwvc3Bhbj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMS41cHg7Y29sb3I6dmFyKC0tdGV4dC1mYWludCk7Ij5vZiAke3RvdGFsfSB0cmFja2VkIHN0b2NrczwvZGl2PgogICAgPC9kaXY+CiAgICA8",
  "ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7aGVpZ2h0OjEwcHg7Ym9yZGVyLXJhZGl1czo2cHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7Ij4KICAgICAgPGRpdiBzdHlsZT0id2lkdGg6JHthZHZQY3R9JTtiYWNrZ3JvdW5kOmxpbmVh",
  "ci1ncmFkaWVudCg5MGRlZyx2YXIoLS1wb3MpLHZhcigtLXBvcy1zb2Z0KSk7Ij48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0id2lkdGg6JHtmbGF0UGN0fSU7YmFja2dyb3VuZDp2YXIoLS10ZXh0LWZhaW50KTsiPjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJ3aWR0",
  "aDoke2RlY1BjdH0lO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHZhcigtLW5lZy1zb2Z0KSx2YXIoLS1uZWcpKTsiPjwvZGl2PgogICAgPC9kaXY+CiAgYDsKfQoKZnVuY3Rpb24gaW5kZXhDYXJkSFRNTChpZHgpewogIGNvbnN0IHBvc2l0aXZlID0g",
  "aWR4LmNoYW5nZSA+PSAwOwogIHJldHVybiBgCiAgPGRpdiBjbGFzcz0iZ2xhc3MgaW5kZXgtY2FyZCI+CiAgICA8ZGl2IGNsYXNzPSJyb3cxIj4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJpbmRleC1uYW1lIj4ke2lkeC5jb2RlfTwvZGl2PgogICAg",
  "ICAgIDxkaXYgY2xhc3M9ImluZGV4LWZ1bGwiPiR7aWR4LmZ1bGx9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJpbmRleC1iYWRnZSAke3Bvc2l0aXZlPydwb3MnOiduZWcnfSI+CiAgICAgICAgJHtwb3NpdGl2ZT8n4payJzon4pa8J30gJHtw",
  "Y3RTdHIoaWR4LnBjdCl9CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFyIj4ke2lkeC52YWx1ZS50b0xvY2FsZVN0cmluZygiZW4tSU4iLHttYXhpbXVtRnJhY3Rpb25EaWdpdHM6Mn0pfTwvZGl2PgogICAg",
  "PGRpdiBjbGFzcz0iaW5kZXgtY2hhbmdlICR7cG9zaXRpdmU/J3Bvcyc6J25lZyd9IHRhYnVsYXIiPiR7Y2hnU3RyKGlkeC5jaGFuZ2UpfTwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtc3BhcmsiPjwvZGl2PgogIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHNrZWxl",
  "dG9uQ2FyZHMobil7CiAgcmV0dXJuIEFycmF5LmZyb20oe2xlbmd0aDpufSkubWFwKCgpPT5gPGRpdiBjbGFzcz0iZ2xhc3Mgc2tlbC1jYXJkIHNrZWwiPjwvZGl2PmApLmpvaW4oIiIpOwp9CmZ1bmN0aW9uIHNrZWxldG9uTGluZXMobil7CiAgcmV0dXJuIEFycmF5",
  "LmZyb20oe2xlbmd0aDpufSkubWFwKCgpPT5gPGRpdiBjbGFzcz0ic2tlbCBza2VsLWxpbmUiIHN0eWxlPSJ3aWR0aDokezYwK01hdGgucmFuZG9tKCkqMzV9JSI+PC9kaXY+YCkuam9pbigiIik7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gU0VBUkNIIC0tLS0tLS0t",
  "LS0tLS0tLS0gKi8KZnVuY3Rpb24gc2VhcmNoQmxvY2soKXsKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9InNlYXJjaC13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHg7Ij4KICAgIDxkaXYgY2xhc3M9InNlYXJjaC1ib3ggZ2xhc3MiIGlkPSJzZWFyY2hCb3giPgog",
  "ICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48Y2lyY2xlIGN4PSIxMSIgY3k9IjExIiByPSI3Ii8+PHBhdGggZD0iTTIxIDIx",
  "bC00LjMtNC4zIi8+PC9zdmc+CiAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0ic2VhcmNoSW5wdXQiIHBsYWNlaG9sZGVyPSJTZWFyY2ggc3RvY2tzIGJ5IG5hbWUgb3IgdGlja2Vy4oCmIiBhdXRvY29tcGxldGU9Im9mZiI+CiAgICAgIDxrYmQgY2xhc3M9Imtz",
  "aG9ydGN1dCI+Lzwva2JkPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtZHJvcCBnbGFzcyIgaWQ9InNlYXJjaERyb3AiIHN0eWxlPSJkaXNwbGF5Om5vbmU7Ij48L2Rpdj4KICA8L2Rpdj5gOwp9CgpsZXQgc2VhcmNoRGVib3VuY2U7CmZ1bmN0aW9u",
  "IHdpcmVTZWFyY2goKXsKICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hJbnB1dCIpOwogIGNvbnN0IGJveCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hCb3giKTsKICBjb25zdCBkcm9wID0gZG9jdW1lbnQuZ2V0",
  "RWxlbWVudEJ5SWQoInNlYXJjaERyb3AiKTsKICBpZighaW5wdXQpIHJldHVybjsKCiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsIChlKT0+ewogICAgaWYoZS5rZXkgPT09ICIvIiAmJiBkb2N1bWVudC5hY3RpdmVFbGVtZW50ICE9PSBpbnB1",
  "dCl7CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgaW5wdXQuZm9jdXMoKTsKICAgIH0KICAgIGlmKGUua2V5ID09PSAiRXNjYXBlIil7IGlucHV0LmJsdXIoKTsgZHJvcC5zdHlsZS5kaXNwbGF5PSJub25lIjsgYm94LmNsYXNzTGlzdC5yZW1vdmUoImZv",
  "Y3VzZWQiKTsgfQogIH0pOwoKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCJmb2N1cyIsICgpPT4gYm94LmNsYXNzTGlzdC5hZGQoImZvY3VzZWQiKSk7CiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigiYmx1ciIsICgpPT4gc2V0VGltZW91dCgoKT0+eyBib3guY2xh",
  "c3NMaXN0LnJlbW92ZSgiZm9jdXNlZCIpOyBkcm9wLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyB9LCAxNjApKTsKCiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLCAoKT0+ewogICAgY2xlYXJUaW1lb3V0KHNlYXJjaERlYm91bmNlKTsKICAgIGNvbnN0IHEg",
  "PSBpbnB1dC52YWx1ZTsKICAgIGlmKCFxLnRyaW0oKSl7IGRyb3Auc3R5bGUuZGlzcGxheT0ibm9uZSI7IHJldHVybjsgfQogICAgZHJvcC5zdHlsZS5kaXNwbGF5PSJibG9jayI7CiAgICBkcm9wLmlubmVySFRNTCA9IGA8ZGl2IHN0eWxlPSJwYWRkaW5nOjE0cHgg",
  "MTZweDsiPiR7c2tlbGV0b25MaW5lcygzKX08L2Rpdj5gOwogICAgc2VhcmNoRGVib3VuY2UgPSBzZXRUaW1lb3V0KGFzeW5jICgpPT57CiAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBBUEkuc2VhcmNoU3RvY2tzKHEpOwogICAgICBpZighcmVzdWx0cy5sZW5n",
  "dGgpewogICAgICAgIGRyb3AuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InNlYXJjaC1lbXB0eSI+Tm8gc3RvY2tzIG1hdGNoIOKAnCR7ZXNjYXBlSHRtbChxKX3igJ08L2Rpdj5gOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBkcm9wLmlubmVySFRNTCA9",
  "IHJlc3VsdHMubWFwKChzLGkpPT5gCiAgICAgICAgPGRpdiBjbGFzcz0ic2VhcmNoLXJvdyIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqMjh9bXMiIGRhdGEtdGlja2VyPSIke3MudH0iPgogICAgICAgICAgPGRpdiBjbGFzcz0ic3ItbGVmdCI+CiAgICAgICAg",
  "ICAgIDxkaXYgY2xhc3M9InNyLXRpY2tlciI+JHtzLnQuc2xpY2UoMCwzKX08L2Rpdj4KICAgICAgICAgICAgPGRpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJzci1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAgICAgICAgICA8ZGl2",
  "IGNsYXNzPSJzci1tZXRhIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJzci1wcmljZSB0YWJ1bGFyIj4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgICAg",
  "ICA8L2Rpdj4KICAgICAgYCkuam9pbigiIik7CiAgICAgIGRyb3AucXVlcnlTZWxlY3RvckFsbCgiLnNlYXJjaC1yb3ciKS5mb3JFYWNoKHJvdz0+ewogICAgICAgIHJvdy5hZGRFdmVudExpc3RlbmVyKCJtb3VzZWRvd24iLCAoKT0+ewogICAgICAgICAgbmF2aWdh",
  "dGUoImRldGFpbCIsIHJvdy5kYXRhc2V0LnRpY2tlcik7CiAgICAgICAgfSk7CiAgICAgIH0pOwogICAgfSwgMjYwKTsKICB9KTsKfQpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoVG9nZ2xlQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+",
  "ewogIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaElucHV0Iik7CiAgaWYoaW5wdXQpIGlucHV0LmZvY3VzKCk7CiAgZWxzZSBuYXZpZ2F0ZSgiZGFzaGJvYXJkIik7Cn0pOwoKLyogLS0tLS0tLS0tLS0tLS0tLSBTSEFSRUQgVEFC",
  "TEUgUkVOREVSIC0tLS0tLS0tLS0tLS0tLS0gKi8KZnVuY3Rpb24gcmVuZGVyVGFibGVJbnRvKHdyYXBJZCwgY2FyZHNJZCwgbGlzdCwgc29ydCwgc2hvd1NlY3RvckNvbCl7CiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKHdyYXBJZCk7CiAg",
  "Y29uc3QgY2FyZHMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChjYXJkc0lkKTsKICBpZighbGlzdC5sZW5ndGgpewogICAgd3JhcC5pbm5lckhUTUwgPSBlbXB0eVN0YXRlSFRNTCgiTm8gc3RvY2tzIG1hdGNoIHlvdXIgZmlsdGVycyIsICJUcnkgd2lkZW5pbmcg",
  "eW91ciBwcmljZSByYW5nZSBvciBjbGVhcmluZyBhIGZpbHRlci4iKTsKICAgIGlmKGNhcmRzKSBjYXJkcy5pbm5lckhUTUwgPSAiIjsKICAgIHJldHVybjsKICB9CiAgY29uc3Qgc29ydGVkID0gc29ydFN0b2NrcyhsaXN0LCBzb3J0KTsKCiAgd3JhcC5pbm5lckhU",
  "TUwgPSBgCiAgICA8dGFibGUgY2xhc3M9InN0b2NrLXRhYmxlIj4KICAgICAgPHRoZWFkPjx0cj4KICAgICAgICA8dGg+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9Im5hbWUiPkNvbXBhbnk8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgog",
  "ICAgICAgIDx0aCBkYXRhLWtleT0icHJpY2UiPlByaWNlPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9ImNoYW5nZSI+Q2hhbmdlPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAg",
  "ICAgICA8dGggZGF0YS1rZXk9InBjdCI+Q2hhbmdlICU8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0ibWFya2V0Q2FwIj5NYXJrZXQgQ2FwPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90",
  "aD4KICAgICAgICA8dGggZGF0YS1rZXk9InZvbHVtZSI+Vm9sdW1lPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9ImhpZ2g1MiI+NTJXIEhpZ2g8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48",
  "L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0ibG93NTIiPjUyVyBMb3c8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICA8L3RyPjwvdGhlYWQ+CiAgICAgIDx0Ym9keT4KICAgICAgICAke3NvcnRlZC5tYXAoKHMsaSk9PnN0b2NrUm93",
  "SFRNTChzLGkpKS5qb2luKCIiKX0KICAgICAgPC90Ym9keT4KICAgIDwvdGFibGU+CiAgYDsKICB3cmFwLnF1ZXJ5U2VsZWN0b3JBbGwoInRoW2RhdGEta2V5XSIpLmZvckVhY2godGg9PnsKICAgIHRoLmNsYXNzTGlzdC50b2dnbGUoInNvcnRlZCIsIHRoLmRhdGFz",
  "ZXQua2V5PT09c29ydC5rZXkpOwogICAgaWYodGguZGF0YXNldC5rZXk9PT1zb3J0LmtleSl7IGNvbnN0IGluZCA9IHRoLnF1ZXJ5U2VsZWN0b3IoIi5zb3J0LWluZCIpOyBpZihpbmQpIGluZC50ZXh0Q29udGVudCA9IHNvcnQuZGlyPT09ImRlc2MiPyLilr4iOiLi",
  "lrQiOyB9CiAgICB0aC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICAgIGNvbnN0IGtleSA9IHRoLmRhdGFzZXQua2V5OwogICAgICBjb25zdCBuZXdEaXIgPSAoc29ydC5rZXk9PT1rZXkgJiYgc29ydC5kaXI9PT0iZGVzYyIpID8gImFzYyIgOiAi",
  "ZGVzYyI7CiAgICAgIGNvbnN0IG5ld1NvcnQgPSB7a2V5LCBkaXI6bmV3RGlyfTsKICAgICAgaWYod3JhcElkPT09InNjcmVlbmVyVGFibGVXcmFwIikgc3RhdGUuc2NyZWVuZXJTb3J0ID0gbmV3U29ydDsKICAgICAgcmVuZGVyVGFibGVJbnRvKHdyYXBJZCwgY2Fy",
  "ZHNJZCwgbGlzdCwgbmV3U29ydCwgc2hvd1NlY3RvckNvbCk7CiAgICB9KTsKICB9KTsKICB3aXJlUm93SW50ZXJhY3Rpb25zKHdyYXApOwoKICBpZihjYXJkcyl7CiAgICBjYXJkcy5pbm5lckhUTUwgPSBzb3J0ZWQubWFwKChzLGkpPT5zdG9ja0NhcmRIVE1MKHMs",
  "aSkpLmpvaW4oIiIpOwogICAgd2lyZVJvd0ludGVyYWN0aW9ucyhjYXJkcyk7CiAgfQp9CgpmdW5jdGlvbiBzb3J0U3RvY2tzKGxpc3QsIHNvcnQpewogIHJldHVybiBsaXN0LnNsaWNlKCkuc29ydCgoYSxiKT0+ewogICAgbGV0IGF2PWFbc29ydC5rZXldLCBidj1i",
  "W3NvcnQua2V5XTsKICAgIGlmKHNvcnQua2V5PT09Im5hbWUiKXsgYXY9YS5uYW1lOyBidj1iLm5hbWU7IHJldHVybiBzb3J0LmRpcj09PSJhc2MiPyBhdi5sb2NhbGVDb21wYXJlKGJ2KSA6IGJ2LmxvY2FsZUNvbXBhcmUoYXYpOyB9CiAgICByZXR1cm4gc29ydC5k",
  "aXI9PT0iYXNjIiA/IGF2LWJ2IDogYnYtYXY7CiAgfSk7Cn0KCmZ1bmN0aW9uIHN0b2NrUm93SFRNTChzLGkpewogIGNvbnN0IHBvcyA9IHMucGN0Pj0wOwogIGNvbnN0IGluV2F0Y2ggPSBzdGF0ZS53YXRjaGxpc3QuaW5jbHVkZXMocy50KTsKICByZXR1cm4gYAog",
  "IDx0ciBkYXRhLXRpY2tlcj0iJHtzLnR9IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSoyMn1tcyI+CiAgICA8dGQgb25jbGljaz0iZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCkiPgogICAgICA8YnV0dG9uIGNsYXNzPSJzdGFyLWJ0biAke2luV2F0Y2g/J2FjdGl2",
  "ZSc6Jyd9IiBkYXRhLXN0YXI9IiR7cy50fSIgdGl0bGU9IiR7aW5XYXRjaD8nUmVtb3ZlIGZyb20gd2F0Y2hsaXN0JzonQWRkIHRvIHdhdGNobGlzdCd9Ij4KICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iJHtpbldhdGNoPydjdXJyZW50Q29s",
  "b3InOidub25lJ30iIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiAxNy4zbC02LjE2IDMuNiAxLjY0LTYuOUwyIDkuNGw3LjA2LS42TDEyIDIuNGwyLjk0IDYuNCA3LjA2LjYtNS40OCA0LjYgMS42NCA2Ljl6Ii8+PC9z",
  "dmc+CiAgICAgIDwvYnV0dG9uPgogICAgPC90ZD4KICAgIDx0ZD4KICAgICAgPGRpdiBjbGFzcz0iY2VsbC1jb21wYW55Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJjZWxsLXRpY2tlci1iYWRnZSI+JHtzLnQuc2xpY2UoMCwzKX08L2Rpdj4KICAgICAgICA8ZGl2Pgog",
  "ICAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2",
  "PgogICAgPC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRJTlIocy5wcmljZSl9PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+PHNwYW4gY2xhc3M9ImNoYW5nZS1waWxsICR7cG9zPydwb3MnOiduZWcnfSI+JHtjaGdTdHIocy5jaGFuZ2UpfTwv",
  "c3Bhbj48L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj48c3BhbiBjbGFzcz0iY2hhbmdlLXBpbGwgJHtwb3M/J3Bvcyc6J25lZyd9Ij4ke3BjdFN0cihzLnBjdCl9PC9zcGFuPjwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10Q29tcGFjdChzLm1h",
  "cmtldENhcCl9PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRWb2wocy52b2x1bWUpfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10SU5SKHMuaGlnaDUyKX08L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdElOUihzLmxv",
  "dzUyKX08L3RkPgogIDwvdHI+YDsKfQoKZnVuY3Rpb24gc3RvY2tDYXJkSFRNTChzLGkpewogIGNvbnN0IHBvcyA9IHMucGN0Pj0wOwogIGNvbnN0IGluV2F0Y2ggPSBzdGF0ZS53YXRjaGxpc3QuaW5jbHVkZXMocy50KTsKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9",
  "ImdsYXNzIHN0b2NrLWNhcmQiIGRhdGEtdGlja2VyPSIke3MudH0iIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjI2fW1zIj4KICAgIDxkaXYgY2xhc3M9ImxlZnQiPgogICAgICA8ZGl2IGNsYXNzPSJjZWxsLXRpY2tlci1iYWRnZSI+JHtzLnQuc2xpY2UoMCwz",
  "KX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibmFtZS1ibG9jayI+CiAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5l",
  "eGNofTwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0icmlnaHQiPgogICAgICA8ZGl2IGNsYXNzPSJwcmljZSB0YWJ1bGFyIj4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgICAgPHNwYW4gY2xhc3M9ImNoYW5nZS1waWxsICR7",
  "cG9zPydwb3MnOiduZWcnfSIgc3R5bGU9Im1hcmdpbi10b3A6NHB4OyI+JHtwY3RTdHIocy5wY3QpfTwvc3Bhbj4KICAgIDwvZGl2PgogIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHdpcmVSb3dJbnRlcmFjdGlvbnMoY29udGFpbmVyKXsKICBjb250YWluZXIucXVlcnlT",
  "ZWxlY3RvckFsbCgidHJbZGF0YS10aWNrZXJdLCAuc3RvY2stY2FyZFtkYXRhLXRpY2tlcl0iKS5mb3JFYWNoKGVsPT57CiAgICBlbC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT4gbmF2aWdhdGUoImRldGFpbCIsIGVsLmRhdGFzZXQudGlja2VyKSk7CiAg",
  "fSk7CiAgY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLXN0YXJdIikuZm9yRWFjaChidG49PnsKICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIChlKT0+ewogICAgICBlLnN0b3BQcm9wYWdhdGlvbigpOwogICAgICB0b2dnbGVXYXRjaChi",
  "dG4uZGF0YXNldC5zdGFyKTsKICAgICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIpOwogICAgICBidG4ucXVlcnlTZWxlY3Rvcigic3ZnIikuc2V0QXR0cmlidXRlKCJmaWxsIiwgYnRuLmNsYXNzTGlzdC5jb250YWlucygiYWN0aXZlIikgPyAiY3VycmVu",
  "dENvbG9yIiA6ICJub25lIik7CiAgICB9KTsKICB9KTsKfQoKZnVuY3Rpb24gdG9nZ2xlV2F0Y2godGlja2VyKXsKICBjb25zdCBpZHggPSBzdGF0ZS53YXRjaGxpc3QuaW5kZXhPZih0aWNrZXIpOwogIGlmKGlkeD49MCkgc3RhdGUud2F0Y2hsaXN0LnNwbGljZShp",
  "ZHgsMSk7CiAgZWxzZSBzdGF0ZS53YXRjaGxpc3QucHVzaCh0aWNrZXIpOwogIHBlcnNpc3RXYXRjaGxpc3QoKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBTQ1JFRU5FUiAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlclNjcmVlbmVyKCl7",
  "CiAgY29uc3Qgc2VjdG9ycyA9IFsiQWxsIiwgLi4uQXJyYXkuZnJvbShuZXcgU2V0KFVOSVZFUlNFLm1hcChzPT5zLnNlY3RvcikpKV07CiAgcm9vdC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJ2aWV3Ij4KICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1o",
  "ZWFkIj48aDI+U2NyZWVuZXI8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPkZpbHRlciB0aGUgbWFya2V0IG9uIHlvdXIgdGVybXM8L3NwYW4+PC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJnbGFzcyBmaWx0ZXJzLWJhciI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmlsdGVy",
  "LWNoaXAiIHN0eWxlPSJtaW4td2lkdGg6MjAwcHg7Ij4KICAgICAgICAgIDxsYWJlbD5TZWFyY2g8L2xhYmVsPgogICAgICAgICAgPGlucHV0IHR5cGU9InRleHQiIGlkPSJmUXVlcnkiIHBsYWNlaG9sZGVyPSJUaWNrZXIgb3IgY29tcGFueeKApiIgdmFsdWU9IiR7",
  "ZXNjYXBlSHRtbChzdGF0ZS5zY3JlZW5lckZpbHRlcnMucXVlcnkpfSI+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmlsdGVyLWNoaXAiPgogICAgICAgICAgPGxhYmVsPlNlY3RvcjwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJmU2Vj",
  "dG9yIj4ke3NlY3RvcnMubWFwKHM9PmA8b3B0aW9uICR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3Rvcj09PXM/J3NlbGVjdGVkJzonJ30+JHtzfTwvb3B0aW9uPmApLmpvaW4oIiIpfTwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9",
  "ImZpbHRlci1jaGlwIj4KICAgICAgICAgIDxsYWJlbD5NYXggUHJpY2UgPHNwYW4gY2xhc3M9InJhbmdlLXZhbCIgaWQ9ImZQcmljZVZhbCI+JHtmbXRJTlIoc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLm1heFByaWNlLDApfTwvc3Bhbj48L2xhYmVsPgogICAgICAgICAg",
  "PGlucHV0IHR5cGU9InJhbmdlIiBjbGFzcz0icmFuZ2Utc2xpZGVyIiBpZD0iZk1heFByaWNlIiBtaW49IjUwMCIgbWF4PSIxNTAwMCIgc3RlcD0iMjUwIiB2YWx1ZT0iJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMubWF4UHJpY2V9Ij4KICAgICAgICA8L2Rpdj4KICAg",
  "ICAgICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCIgc3R5bGU9Im1pbi13aWR0aDoxOTBweDsiPgogICAgICAgICAgPGxhYmVsPkRpcmVjdGlvbjwvbGFiZWw+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0b2dnbGUtZ3JvdXAiPgogICAgICAgICAgICA8ZGl2IGNsYXNz",
  "PSJ0b2dnbGUtYnRuICR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLmRpcmVjdGlvbj09PSdhbGwnPydhY3RpdmUnOicnfSIgZGF0YS1kaXI9ImFsbCI+QWxsPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1idG4gJHtzdGF0ZS5zY3JlZW5lckZpbHRl",
  "cnMuZGlyZWN0aW9uPT09J2dhaW5lcnMnPydhY3RpdmUnOicnfSIgZGF0YS1kaXI9ImdhaW5lcnMiPkdhaW5lcnM8L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0idG9nZ2xlLWJ0biAke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb249PT0nbG9zZXJz",
  "Jz8nYWN0aXZlJzonJ30iIGRhdGEtZGlyPSJsb3NlcnMiPkxvc2VyczwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVzZXQtZmlsdGVycyIgaWQ9InJlc2V0RmlsdGVycyI+UmVzZXQgZmlsdGVyczwvZGl2",
  "PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyIGlkPSJzY3JlZW5lckNvdW50Ij5SZXN1bHRzPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5Tb3J0ZWQgYnkgbWFya2V0IGNhcDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFz",
  "cz0idGFibGUtd3JhcCBnbGFzcyIgaWQ9InNjcmVlbmVyVGFibGVXcmFwIj48ZGl2IHN0eWxlPSJwYWRkaW5nOjIwcHg7Ij4ke3NrZWxldG9uTGluZXMoOCl9PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0b2NrLWNhcmRzIiBpZD0ic2NyZWVuZXJDYXJk",
  "cyI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwoKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZlF1ZXJ5IikuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLCBkZWJvdW5jZShlPT57CiAgICBzdGF0ZS5zY3JlZW5lckZpbHRlcnMucXVlcnkgPSBlLnRhcmdldC52YWx1",
  "ZTsgcnVuU2NyZWVuZXIoKTsKICB9LCAyNjApKTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZlNlY3RvciIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIsIGU9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5zZWN0b3IgPSBlLnRhcmdldC52YWx1ZTsg",
  "cnVuU2NyZWVuZXIoKTsKICB9KTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZk1heFByaWNlIikuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLCBlPT57CiAgICBzdGF0ZS5zY3JlZW5lckZpbHRlcnMubWF4UHJpY2UgPSBOdW1iZXIoZS50YXJnZXQudmFsdWUp",
  "OwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImZQcmljZVZhbCIpLnRleHRDb250ZW50ID0gZm10SU5SKHN0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQcmljZSwwKTsKICAgIHJ1blNjcmVlbmVyKCk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFs",
  "bCgiW2RhdGEtZGlyXSIpLmZvckVhY2goYnRuPT57CiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgICBzdGF0ZS5zY3JlZW5lckZpbHRlcnMuZGlyZWN0aW9uID0gYnRuLmRhdGFzZXQuZGlyOwogICAgICBkb2N1bWVudC5xdWVyeVNl",
  "bGVjdG9yQWxsKCJbZGF0YS1kaXJdIikuZm9yRWFjaChiPT5iLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsIGI9PT1idG4pKTsKICAgICAgcnVuU2NyZWVuZXIoKTsKICAgIH0pOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJyZXNldEZpbHRlcnMi",
  "KS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICBzdGF0ZS5zY3JlZW5lckZpbHRlcnMgPSB7cXVlcnk6IiIsIHNlY3RvcjoiQWxsIiwgbWluUHJpY2U6MCwgbWF4UHJpY2U6MTUwMDAsIGRpcmVjdGlvbjoiYWxsIn07CiAgICByZW5kZXJTY3JlZW5l",
  "cigpOwogIH0pOwoKICBydW5TY3JlZW5lcigpOwp9CgpmdW5jdGlvbiBkZWJvdW5jZShmbiwgbXMpewogIGxldCBoOwogIHJldHVybiAoLi4uYXJncyk9PnsgY2xlYXJUaW1lb3V0KGgpOyBoPXNldFRpbWVvdXQoKCk9PmZuKC4uLmFyZ3MpLCBtcyk7IH07Cn0KCmFz",
  "eW5jIGZ1bmN0aW9uIHJ1blNjcmVlbmVyKCl7CiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzY3JlZW5lclRhYmxlV3JhcCIpOwogIHdyYXAuc3R5bGUub3BhY2l0eSA9ICIwLjU1IjsKICB0cnl7CiAgICBjb25zdCByZXN1bHRzID0gYXdh",
  "aXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHN0YXRlLnNjcmVlbmVyRmlsdGVycyk7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2NyZWVuZXJDb3VudCIpLnRleHRDb250ZW50ID0gYFJlc3VsdHMgKCR7cmVzdWx0cy5sZW5ndGh9KWA7CiAgICAvLyBP",
  "bmUtdGltZSBkaWFnbm9zdGljOiBpZiBhIHNlY3RvciBmaWx0ZXIgeWllbGRzIHplcm8sIHNob3cgZXhhY3RseSB3aGF0CiAgICAvLyBzZWN0b3IgdmFsdWVzIGFjdHVhbGx5IGV4aXN0IGluIHRoZSBsb2FkZWQgZGF0YSBzbyBhIG1pc21hdGNoICh0eXBvLAogICAg",
  "Ly8gY2FzaW5nLCBzdGFsZSBmaWVsZCkgaXMgdmlzaWJsZSBpbnN0ZWFkIG9mIGd1ZXNzZWQgYXQuCiAgICBpZihyZXN1bHRzLmxlbmd0aCA9PT0gMCAmJiBzdGF0ZS5zY3JlZW5lckZpbHRlcnMuc2VjdG9yICYmIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5zZWN0b3Ig",
  "IT09ICJBbGwiKXsKICAgICAgdHJ5ewogICAgICAgIGNvbnN0IHVuZmlsdGVyZWQgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJlc3VsdHMoey4uLnN0YXRlLnNjcmVlbmVyRmlsdGVycywgc2VjdG9yOiJBbGwifSk7CiAgICAgICAgY29uc3Qgc2VlblNlY3RvcnMg",
  "PSBBcnJheS5mcm9tKG5ldyBTZXQodW5maWx0ZXJlZC5tYXAocz0+cy5zZWN0b3IpKSk7CiAgICAgICAgc2hvd0Vycm9yQmFubmVyKGBERUJVRzogMCByZXN1bHRzIGZvciBzZWN0b3IgIiR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3Rvcn0iLiAke3VuZmlsdGVy",
  "ZWQubGVuZ3RofSBzdG9ja3MgbG9hZGVkIHRvdGFsLiBTZWN0b3IgdmFsdWVzIGFjdHVhbGx5IHByZXNlbnQ6ICR7SlNPTi5zdHJpbmdpZnkoc2VlblNlY3RvcnMpfWApOwogICAgICB9Y2F0Y2goZSl7IC8qIGRpYWdub3N0aWMgb25seSwgaWdub3JlIGZhaWx1cmVz",
  "IGhlcmUgKi8gfQogICAgfQogICAgcmVuZGVyVGFibGVJbnRvKCJzY3JlZW5lclRhYmxlV3JhcCIsICJzY3JlZW5lckNhcmRzIiwgcmVzdWx0cywgc3RhdGUuc2NyZWVuZXJTb3J0LCB0cnVlKTsKICB9Y2F0Y2goZSl7CiAgICB3cmFwLmlubmVySFRNTCA9IGVycm9y",
  "U3RhdGVIVE1MKCJTY3JlZW5lciBkYXRhIHVuYXZhaWxhYmxlIiwgIldlIGNvdWxkbid0IGxvYWQgbWF0Y2hpbmcgc3RvY2tzIHJpZ2h0IG5vdy4gKCIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkgKyAiKSIpOwogICAgc2hvd0Vycm9yQmFubmVyKCJydW5TY3JlZW5l",
  "ciBmYWlsZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogIH0KICB3cmFwLnN0eWxlLm9wYWNpdHkgPSAiMSI7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gTUFSS0VUUyAoZnVsbCB1bml2ZXJzZSB0YWJsZSArIHRyZW5kaW5nIGhpZ2hsaWdodHMpIC0tLS0t",
  "LS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyTWFya2V0cygpewogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPk1hcmtldHM8L2gyPjxzcGFuIGNsYXNz",
  "PSJzdWIiPkZ1bGwgTlNFIHVuaXZlcnNlIHNuYXBzaG90PC9zcGFuPjwvZGl2PgogICAgICAke3NlYXJjaEJsb2NrKCl9CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5UcmVuZGluZyBOb3c8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPlRvZGF5J3Mg",
  "YmlnZ2VzdCBtb3ZlcnMsIHVwIG9yIGRvd248L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRyZW5kaW5nLXJvdyIgaWQ9InRyZW5kaW5nUm93Ij4ke3NrZWxldG9uQ2FyZHMoNCl9PC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiIHN0",
  "eWxlPSJtYXJnaW4tdG9wOjhweDsiPjxoMj5BbGwgU3RvY2tzPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5Tb3J0ZWQgYnkgbWFya2V0IGNhcDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCBnbGFzcyIgaWQ9Im1hcmtldHNUYWJsZVdyYXAi",
  "PjxkaXYgc3R5bGU9InBhZGRpbmc6MjBweDsiPiR7c2tlbGV0b25MaW5lcygxMCl9PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0b2NrLWNhcmRzIiBpZD0ibWFya2V0c0NhcmRzIj48L2Rpdj4KICAgIDwvZGl2PgogIGA7CiAgd2lyZVNlYXJjaCgpOwog",
  "IHRyeXsKICAgIGNvbnN0IGxpc3QgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJlc3VsdHMoe30pOwogICAgcmVuZGVyVHJlbmRpbmcobGlzdCk7CiAgICByZW5kZXJUYWJsZUludG8oIm1hcmtldHNUYWJsZVdyYXAiLCAibWFya2V0c0NhcmRzIiwgbGlzdCwge2tl",
  "eToibWFya2V0Q2FwIiwgZGlyOiJkZXNjIn0sIHRydWUpOwogIH1jYXRjaChlKXsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtYXJrZXRzVGFibGVXcmFwIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIk1hcmtldCBkYXRhIHRlbXBvcmFyaWx5IHVu",
  "YXZhaWxhYmxlIiwgIlBsZWFzZSB0cnkgYWdhaW4gaW4gYSBtb21lbnQuIik7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidHJlbmRpbmdSb3ciKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVHJlbmRpbmcgZGF0YSB1bmF2YWlsYWJsZSIsICJQbGVh",
  "c2UgdHJ5IGFnYWluIGluIGEgbW9tZW50LiIpOwogIH0KfQoKZnVuY3Rpb24gcmVuZGVyVHJlbmRpbmcobGlzdCl7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidHJlbmRpbmdSb3ciKTsKICBpZighZWwpIHJldHVybjsKICBpZighbGlzdC5s",
  "ZW5ndGgpeyBlbC5pbm5lckhUTUwgPSBlbXB0eVN0YXRlSFRNTCgiTm8gdHJlbmRpbmcgZGF0YSIsICJObyBzdG9ja3Mgd2VyZSByZXR1cm5lZCB0byByYW5rLiIpOyByZXR1cm47IH0KICBjb25zdCBob3QgPSBsaXN0LnNsaWNlKCkuc29ydCgoYSxiKT0+TWF0aC5h",
  "YnMoYi5wY3QpLU1hdGguYWJzKGEucGN0KSkuc2xpY2UoMCw2KTsKICBlbC5pbm5lckhUTUwgPSBob3QubWFwKChzLGkpPT57CiAgICBjb25zdCBwb3MgPSBzLnBjdD49MDsKICAgIHJldHVybiBgCiAgICA8ZGl2IGNsYXNzPSJnbGFzcyB0cmVuZGluZy1jYXJkIiBk",
  "YXRhLXRpY2tlcj0iJHtzLnR9IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSo0MH1tcyI+CiAgICAgIDxkaXYgY2xhc3M9InRyZW5kaW5nLXRvcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iY2VsbC10aWNrZXItYmFkZ2UiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+",
  "CiAgICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtYmFkZ2UgJHtwb3M/J3Bvcyc6J25lZyd9Ij4ke3Bvcz8n4payJzon4pa8J30gJHtwY3RTdHIocy5wY3QpfTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1uYW1lIiBzdHlsZT0ibWFy",
  "Z2luLXRvcDoxMHB4OyI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250",
  "LXNpemU6MTlweDttYXJnaW4tdG9wOjhweDsiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJpbmRleC1zcGFyayIgc3R5bGU9ImhlaWdodDoyOHB4O21hcmdpbi10b3A6OHB4OyI+JHtzcGFya2xpbmVTVkcocy5zZXJpZXMsIHBvcyl9",
  "PC9kaXY+CiAgICA8L2Rpdj5gOwogIH0pLmpvaW4oIiIpOwogIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoIi50cmVuZGluZy1jYXJkIikuZm9yRWFjaChjYXJkPT57CiAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PiBuYXZpZ2F0ZSgiZGV0YWlsIiwg",
  "Y2FyZC5kYXRhc2V0LnRpY2tlcikpOwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIFdBVENITElTVCAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlcldhdGNobGlzdCgpewogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFz",
  "cz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPldhdGNobGlzdDwvaDI+PHNwYW4gY2xhc3M9InN1YiI+JHtzdGF0ZS53YXRjaGxpc3QubGVuZ3RofSBzdG9jayR7c3RhdGUud2F0Y2hsaXN0Lmxlbmd0aD09PTE/Jyc6J3MnfSB0cmFj",
  "a2VkPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ3YXRjaGxpc3QtZ3JpZCIgaWQ9IndhdGNoR3JpZCI+JHtza2VsZXRvbkNhcmRzKE1hdGgubWF4KHN0YXRlLndhdGNobGlzdC5sZW5ndGgsMykpfTwvZGl2PgogICAgPC9kaXY+CiAgYDsKICBpZighc3Rh",
  "dGUud2F0Y2hsaXN0Lmxlbmd0aCl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgid2F0Y2hHcmlkIikuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9IndhdGNoLWVtcHR5IGdsYXNzIj4ke2VtcHR5U3RhdGVJbm5lcigiWW91ciB3YXRjaGxpc3QgaXMgZW1wdHki",
  "LCAiU3RhciBhbnkgc3RvY2sgZnJvbSB0aGUgZGFzaGJvYXJkLCBzY3JlZW5lciBvciBtYXJrZXRzIHZpZXcgdG8gdHJhY2sgaXQgaGVyZS4iKX08L2Rpdj5gOwogICAgcmV0dXJuOwogIH0KICB0cnl7CiAgICBjb25zdCBzdG9ja3MgPSBhd2FpdCBQcm9taXNlLmFs",
  "bChzdGF0ZS53YXRjaGxpc3QubWFwKHQ9PkFQSS5mZXRjaFN0b2NrKHQpKSk7CiAgICBjb25zdCBncmlkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIndhdGNoR3JpZCIpOwogICAgZ3JpZC5pbm5lckhUTUwgPSBzdG9ja3MuZmlsdGVyKEJvb2xlYW4pLm1hcCgo",
  "cyxpKT0+d2F0Y2hDYXJkSFRNTChzLGkpKS5qb2luKCIiKTsKICAgIHdpcmVXYXRjaENhcmRzKCk7CiAgfWNhdGNoKGUpewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIndhdGNoR3JpZCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJVbmFibGUgdG8g",
  "bG9hZCB3YXRjaGxpc3QiLCAiUGxlYXNlIHRyeSBhZ2Fpbi4iKTsKICB9Cn0KCmZ1bmN0aW9uIHdhdGNoQ2FyZEhUTUwocyxpKXsKICBjb25zdCBwb3MgPSBzLnBjdD49MDsKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9ImdsYXNzIHdhdGNoLWNhcmQgZW50ZXJpbmci",
  "IGRhdGEtdGlja2VyPSIke3MudH0iIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjQwfW1zIj4KICAgIDxkaXYgY2xhc3M9IndhdGNoLXRvcCI+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1l",
  "KX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5leGNofTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0ic3Rhci1idG4gYWN0aXZlIiBkYXRhLXVuc3Rhcj0iJHtzLnR9IiB0aXRsZT0iUmVt",
  "b3ZlIj4KICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMTIgMTcuM2wtNi4xNiAzLjYgMS42NC02LjlMMiA5LjRsNy4wNi0uNkwx",
  "MiAyLjRsMi45NCA2LjQgNy4wNi42LTUuNDggNC42IDEuNjQgNi45eiIvPjwvc3ZnPgogICAgICA8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciIgc3R5bGU9ImZvbnQtc2l6ZToyMnB4OyI+JHtmbXRJTlIocy5w",
  "cmljZSl9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1jaGFuZ2UgJHtwb3M/J3Bvcyc6J25lZyd9IHRhYnVsYXIiPiR7Y2hnU3RyKHMuY2hhbmdlKX0gKCR7cGN0U3RyKHMucGN0KX0pPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1zcGFyayI+JHtzcGFy",
  "a2xpbmVTVkcocy5zZXJpZXMsIHBvcyl9PC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gd2lyZVdhdGNoQ2FyZHMoKXsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIud2F0Y2gtY2FyZCIpLmZvckVhY2goY2FyZD0+ewogICAgY2FyZC5hZGRFdmVudExp",
  "c3RlbmVyKCJjbGljayIsIChlKT0+ewogICAgICBpZihlLnRhcmdldC5jbG9zZXN0KCJbZGF0YS11bnN0YXJdIikpIHJldHVybjsKICAgICAgbmF2aWdhdGUoImRldGFpbCIsIGNhcmQuZGF0YXNldC50aWNrZXIpOwogICAgfSk7CiAgfSk7CiAgZG9jdW1lbnQucXVl",
  "cnlTZWxlY3RvckFsbCgiW2RhdGEtdW5zdGFyXSIpLmZvckVhY2goYnRuPT57CiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTsKICAgICAgY29uc3QgY2FyZCA9IGJ0bi5jbG9zZXN0KCIud2F0",
  "Y2gtY2FyZCIpOwogICAgICBjYXJkLmNsYXNzTGlzdC5hZGQoInJlbW92aW5nIik7CiAgICAgIHRvZ2dsZVdhdGNoKGJ0bi5kYXRhc2V0LnVuc3Rhcik7CiAgICAgIHNldFRpbWVvdXQoKCk9PnsKICAgICAgICBpZighc3RhdGUud2F0Y2hsaXN0Lmxlbmd0aCkgcmVu",
  "ZGVyV2F0Y2hsaXN0KCk7CiAgICAgICAgZWxzZSBjYXJkLnJlbW92ZSgpOwogICAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoIi5zZWN0aW9uLWhlYWQgLnN1YiIpLnRleHRDb250ZW50ID0gYCR7c3RhdGUud2F0Y2hsaXN0Lmxlbmd0aH0gc3RvY2ske3N0YXRl",
  "LndhdGNobGlzdC5sZW5ndGg9PT0xPycnOidzJ30gdHJhY2tlZGA7CiAgICAgIH0sIDI4MCk7CiAgICB9KTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBTVE9DSyBERVRBSUwgLS0tLS0tLS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJEZXRh",
  "aWwoKXsKICByb290LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ2aWV3IiBpZD0iZGV0YWlsU2tlbGV0b24iPgogICAgPGRpdiBjbGFzcz0iZ2xhc3Mgc2tlbC1jYXJkIHNrZWwiIHN0eWxlPSJoZWlnaHQ6ODhweDttYXJnaW4tYm90dG9tOjI0cHg7Ij48L2Rpdj4K",
  "ICAgIDxkaXYgY2xhc3M9Im1ldHJpY3MtZ3JpZCI+JHtza2VsZXRvbkNhcmRzKDYpfTwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ2xhc3Mgc2tlbC1jYXJkIHNrZWwiIHN0eWxlPSJoZWlnaHQ6MzIwcHg7Ij48L2Rpdj4KICA8L2Rpdj5gOwoKICBsZXQgczsKICB0cnl7",
  "IHMgPSBhd2FpdCBBUEkuZmV0Y2hTdG9jayhzdGF0ZS5kZXRhaWxUaWNrZXIpOyB9Y2F0Y2goZSl7IHMgPSBudWxsOyB9CiAgaWYoIXMpewogICAgcm9vdC5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIHJldHJpZXZlIHRoaXMgc3RvY2siLCAi",
  "VGhlIHRpY2tlciB5b3UncmUgbG9va2luZyBmb3IgaXNuJ3QgYXZhaWxhYmxlIHJpZ2h0IG5vdy4iKTsKICAgIHJldHVybjsKICB9CiAgY29uc3QgcG9zID0gcy5wY3QgPj0gMDsKICBjb25zdCBpbldhdGNoID0gc3RhdGUud2F0Y2hsaXN0LmluY2x1ZGVzKHMudCk7",
  "CgogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1oZWFkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtdGl0bGUtcm93Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC10aWNr",
  "ZXItYmFkZ2UiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgICAgICA8ZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtbmFtZSI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1zdWIi",
  "PiR7cy50fSDCtyAke3MuZXhjaH0gwrcgJHtzLnNlY3Rvcn08L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjE0cHg7Ij4KICAgICAgICAgIDxk",
  "aXYgY2xhc3M9ImRldGFpbC1wcmljZS1ibG9jayI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1wcmljZSB0YWJ1bGFyIj4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLWNoYW5nZSAke3Bvcz8ncG9z",
  "JzonbmVnJ30gdGFidWxhciI+JHtjaGdTdHIocy5jaGFuZ2UpfSAoJHtwY3RTdHIocy5wY3QpfSkgdG9kYXk8L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iaWNvbi1idG4iIGlkPSJkZXRhaWxTdGFyIiBzdHlsZT0id2lkdGg6",
  "NDRweDtoZWlnaHQ6NDRweDtjb2xvcjoke2luV2F0Y2g/JyNGRkM4NTcnOid2YXIoLS10ZXh0LW1pZCknfSI+CiAgICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSIke2luV2F0Y2g/J2N1cnJlbnRDb2xvcic6J25vbmUnfSIgc3Ryb2tlPSJj",
  "dXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3R5bGU9IndpZHRoOjE5cHg7aGVpZ2h0OjE5cHg7Ij48cGF0aCBkPSJNMTIgMTcuM2wtNi4xNiAzLjYgMS42NC02LjlMMiA5LjRsNy4wNi0uNkwxMiAyLjRsMi45NCA2LjQgNy4wNi42LTUuNDggNC42IDEuNjQg",
  "Ni45eiIvPjwvc3ZnPgogICAgICAgICAgPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ibWV0cmljcy1ncmlkIj4KICAgICAgICAke21ldHJpY0NhcmQoIk9wZW4iLCBmbXRJTlIocy5vcGVuKSl9CiAgICAgICAg",
  "JHttZXRyaWNDYXJkKCJEYXkgSGlnaCIsIGZtdElOUihzLmRheUhpZ2gpKX0KICAgICAgICAke21ldHJpY0NhcmQoIkRheSBMb3ciLCBmbXRJTlIocy5kYXlMb3cpKX0KICAgICAgICAke21ldHJpY0NhcmQoIk1hcmtldCBDYXAiLCBmbXRDb21wYWN0KHMubWFya2V0",
  "Q2FwKSl9CiAgICAgICAgJHttZXRyaWNDYXJkKCJWb2x1bWUiLCBmbXRWb2wocy52b2x1bWUpKX0KICAgICAgICAke21ldHJpY0NhcmQoIjUyVyBIaWdoIC8gTG93IiwgZm10SU5SKHMuaGlnaDUyLDApKyIgLyAiK2ZtdElOUihzLmxvdzUyLDApKX0KICAgICAgPC9k",
  "aXY+CgogICAgICA8ZGl2IGNsYXNzPSJnbGFzcyBjaGFydC1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC1oZWFkIj4KICAgICAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCIgc3R5bGU9Im1hcmdpbjowOyI+PGgyPlByaWNlIENoYXJ0PC9oMj48",
  "L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InJhbmdlLXRhYnMiIGlkPSJyYW5nZVRhYnMiPgogICAgICAgICAgICAke1siMUQiLCIxVyIsIjFNIiwiM00iLCI2TSIsIjFZIl0ubWFwKHI9PmA8YnV0dG9uIGRhdGEtcmFuZ2U9IiR7cn0iIGNsYXNzPSIke3N0YXRl",
  "LmRldGFpbFJhbmdlPT09cj8nYWN0aXZlJzonJ30iPiR7cn08L2J1dHRvbj5gKS5qb2luKCIiKX0KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LWNhbnZhcy13cmFwIiBpZD0iY2hhcnRXcmFwIj4KICAgICAg",
  "ICAgIDxjYW52YXMgaWQ9InByaWNlQ2hhcnQiPjwvY2FudmFzPgogICAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtdG9vbHRpcCIgaWQ9ImNoYXJ0VG9vbHRpcCI+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idm9sdW1lLXdyYXAiIGlk",
  "PSJ2b2x1bWVXcmFwIj4KICAgICAgICAgIDxkaXYgY2xhc3M9InZvbHVtZS1sYWJlbCI+Vm9sdW1lIDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZXh0LWZhaW50KTtmb250LXdlaWdodDo2MDA7Ij4ocmVsYXRpdmUsIGRlcml2ZWQgZnJvbSBwcmljZSBtb3ZlbWVu",
  "dCk8L3NwYW4+PC9kaXY+CiAgICAgICAgICA8Y2FudmFzIGlkPSJ2b2x1bWVDaGFydCI+PC9jYW52YXM+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBzdHlsZT0ibWFyZ2luLWJvdHRvbToyOHB4OyI+CiAgICAgICAgPGJ1dHRvbiBjbGFz",
  "cz0iZXhwbGFpbi1idG4iIGlkPSJleHBsYWluQnRuIj4KICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1s",
  "aW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0xMiA4VjRIOCIvPjxyZWN0IHg9IjQiIHk9IjgiIHdpZHRoPSIxNiIgaGVpZ2h0PSIxMiIgcng9IjIiLz48cGF0aCBkPSJNMiAxNGgyTTIwIDE0aDJNOSAxM3YyTTE1IDEzdjIiLz48L3N2Zz4KICAgICAgICAgIEV4cGxh",
  "aW4gdGhpcyBzdG9jawogICAgICAgIDwvYnV0dG9uPgogICAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGV4cGxhaW4tY2FyZCIgaWQ9ImV4cGxhaW5DYXJkIiBzdHlsZT0iZGlzcGxheTpub25lOyI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgYDsKCiAg",
  "ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImRldGFpbFN0YXIiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICB0b2dnbGVXYXRjaChzLnQpOwogICAgcmVuZGVyRGV0YWlsKCk7CiAgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInJhbmdl",
  "VGFicyIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICBjb25zdCBidG4gPSBlLnRhcmdldC5jbG9zZXN0KCJidXR0b25bZGF0YS1yYW5nZV0iKTsKICAgIGlmKCFidG4pIHJldHVybjsKICAgIHN0YXRlLmRldGFpbFJhbmdlID0gYnRuLmRhdGFz",
  "ZXQucmFuZ2U7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIjcmFuZ2VUYWJzIGJ1dHRvbiIpLmZvckVhY2goYj0+Yi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiLCBiPT09YnRuKSk7CiAgICBsb2FkQ2hhcnQocy50LCBzLnBjdD49MCk7CiAgfSk7CiAg",
  "d2lyZUV4cGxhaW5CdXR0b24ocy50KTsKCiAgbG9hZENoYXJ0KHMudCwgcG9zKTsKfQoKZnVuY3Rpb24gbWV0cmljQ2FyZChsYWJlbCwgdmFsdWUpewogIHJldHVybiBgPGRpdiBjbGFzcz0iZ2xhc3MgbWV0cmljLWNhcmQiPjxkaXYgY2xhc3M9Im1ldHJpYy1sYWJl",
  "bCI+JHtsYWJlbH08L2Rpdj48ZGl2IGNsYXNzPSJtZXRyaWMtdmFsdWUgdGFidWxhciI+JHt2YWx1ZX08L2Rpdj48L2Rpdj5gOwp9Cgphc3luYyBmdW5jdGlvbiBsb2FkQ2hhcnQodGlja2VyLCBwb3NpdGl2ZSl7CiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVs",
  "ZW1lbnRCeUlkKCJjaGFydFdyYXAiKTsKICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgicHJpY2VDaGFydCIpOwogIGlmKCF3cmFwIHx8ICFjYW52YXMpIHJldHVybjsKICBjYW52YXMuc3R5bGUub3BhY2l0eSA9ICIwLjI1IjsKICBsZXQg",
  "c2VyaWVzOwogIHRyeXsKICAgIHNlcmllcyA9IGF3YWl0IEFQSS5mZXRjaFN0b2NrSGlzdG9yeSh0aWNrZXIsIHN0YXRlLmRldGFpbFJhbmdlKTsKICB9Y2F0Y2goZSl7CiAgICB3cmFwLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJDaGFydCBkYXRhIHVuYXZh",
  "aWxhYmxlIiwgIlRoaXMgdGltZWZyYW1lIGNvdWxkbid0IGJlIGxvYWRlZC4gVHJ5IGEgZGlmZmVyZW50IHJhbmdlLiIpOwogICAgcmV0dXJuOwogIH0KICBjYW52YXMuc3R5bGUub3BhY2l0eSA9ICIxIjsKICBkcmF3Q2hhcnQoY2FudmFzLCBzZXJpZXMsIHBvc2l0",
  "aXZlLCB0aWNrZXIpOwogIGRyYXdWb2x1bWVDaGFydChzZXJpZXMsIHBvc2l0aXZlKTsKfQoKZnVuY3Rpb24gZHJhd1ZvbHVtZUNoYXJ0KHNlcmllcywgcG9zaXRpdmUpewogIGNvbnN0IGNhbnZhcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ2b2x1bWVDaGFy",
  "dCIpOwogIGlmKCFjYW52YXMpIHJldHVybjsKICBjb25zdCByZWN0ID0gY2FudmFzLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogIGNvbnN0IGRwciA9IHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvIHx8IDE7CiAgY2FudmFzLndpZHRoID0gcmVjdC53aWR0aCAqIGRw",
  "cjsKICBjYW52YXMuaGVpZ2h0ID0gcmVjdC5oZWlnaHQgKiBkcHI7CiAgY29uc3QgY3R4ID0gY2FudmFzLmdldENvbnRleHQoIjJkIik7CiAgY3R4LnNjYWxlKGRwcixkcHIpOwogIGNvbnN0IFcgPSByZWN0LndpZHRoLCBIID0gcmVjdC5oZWlnaHQ7CiAgY3R4LmNs",
  "ZWFyUmVjdCgwLDAsVyxIKTsKCiAgLy8gRGVyaXZlIGEgcGxhdXNpYmxlIHJlbGF0aXZlIHZvbHVtZSBwcm9maWxlIGZyb20gdGhlIHByaWNlIHNlcmllcycKICAvLyBwb2ludC10by1wb2ludCB2b2xhdGlsaXR5IChiaWdnZXIgbW92ZXMgdGVuZCB0byBjb2luY2lk",
  "ZSB3aXRoIGhpZ2hlcgogIC8vIHZvbHVtZSkg4oCUIGlsbHVzdHJhdGl2ZSBvbmx5OyB0aGUgYmFja2VuZCBoYXMgbm8gaGlzdG9yaWNhbCB2b2x1bWUgZmVlZC4KICBjb25zdCBkZWx0YXMgPSBzZXJpZXMubWFwKCh2LGkpPT4gaT09PTAgPyAwIDogTWF0aC5hYnMo",
  "di1zZXJpZXNbaS0xXSkpOwogIGNvbnN0IG1heEQgPSBNYXRoLm1heCguLi5kZWx0YXMsIDFlLTYpOwogIGNvbnN0IGJhclcgPSBXL3Nlcmllcy5sZW5ndGg7CiAgY29uc3QgY29sb3IgPSBwb3NpdGl2ZSA/ICIjMzNENkE2IiA6ICIjRkI2QjZCIjsKICBzZXJpZXMu",
  "Zm9yRWFjaCgodixpKT0+ewogICAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQoc3RhdGUuZGV0YWlsVGlja2VyKStpKjc7CiAgICBjb25zdCBoID0gTWF0aC5tYXgoMywgKGRlbHRhc1tpXS9tYXhEKSAqIEggKiAwLjg1ICogKDAuNTUgKyBzZWVkZWRSYW5kKHNlZWQp",
  "KjAuNikpOwogICAgY29uc3QgdXAgPSBpPT09MCA/IHRydWUgOiBzZXJpZXNbaV0gPj0gc2VyaWVzW2ktMV07CiAgICBjdHguZmlsbFN0eWxlID0gdXAgPyAicmdiYSg1MSwyMTQsMTY2LDAuNTUpIiA6ICJyZ2JhKDI1MSwxMDcsMTA3LDAuNTUpIjsKICAgIGN0eC5m",
  "aWxsUmVjdChpKmJhclcrYmFyVyowLjE1LCBILWgsIE1hdGgubWF4KDEsYmFyVyowLjcpLCBoKTsKICB9KTsKfQoKZnVuY3Rpb24gZHJhd0NoYXJ0KGNhbnZhcywgc2VyaWVzLCBwb3NpdGl2ZSwgdGlja2VyKXsKICBjb25zdCB3cmFwID0gY2FudmFzLnBhcmVudEVs",
  "ZW1lbnQ7CiAgY29uc3QgZHByID0gd2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMTsKICBjb25zdCByZWN0ID0gd3JhcC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICBjYW52YXMud2lkdGggPSByZWN0LndpZHRoICogZHByOwogIGNhbnZhcy5oZWlnaHQgPSBy",
  "ZWN0LmhlaWdodCAqIGRwcjsKICBjYW52YXMuc3R5bGUud2lkdGggPSByZWN0LndpZHRoKyJweCI7CiAgY2FudmFzLnN0eWxlLmhlaWdodCA9IHJlY3QuaGVpZ2h0KyJweCI7CiAgY29uc3QgY3R4ID0gY2FudmFzLmdldENvbnRleHQoIjJkIik7CiAgY3R4LnNjYWxl",
  "KGRwcixkcHIpOwoKICBjb25zdCBXID0gcmVjdC53aWR0aCwgSCA9IHJlY3QuaGVpZ2h0OwogIGNvbnN0IHBhZCA9IHt0b3A6MTYsIHJpZ2h0OjgsIGJvdHRvbToyNCwgbGVmdDo4fTsKICBjb25zdCBtaW4gPSBNYXRoLm1pbiguLi5zZXJpZXMpLCBtYXggPSBNYXRo",
  "Lm1heCguLi5zZXJpZXMpOwogIGNvbnN0IHJhbmdlViA9IChtYXgtbWluKSB8fCAxOwogIGNvbnN0IGlubmVyVyA9IFcgLSBwYWQubGVmdCAtIHBhZC5yaWdodDsKICBjb25zdCBpbm5lckggPSBIIC0gcGFkLnRvcCAtIHBhZC5ib3R0b207CiAgY29uc3Qgc3RlcCA9",
  "IGlubmVyVy8oc2VyaWVzLmxlbmd0aC0xKTsKCiAgZnVuY3Rpb24geHkoaSx2KXsKICAgIHJldHVybiBbcGFkLmxlZnQgKyBpKnN0ZXAsIHBhZC50b3AgKyBpbm5lckggLSAoKHYtbWluKS9yYW5nZVYpKmlubmVySF07CiAgfQogIGNvbnN0IHB0cyA9IHNlcmllcy5t",
  "YXAoKHYsaSk9Pnh5KGksdikpOwoKICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwoKICAvLyBncmlkbGluZXMKICBjdHguc3Ryb2tlU3R5bGUgPSAicmdiYSgxNTgsMTcxLDIxNCwwLjA4KSI7CiAgY3R4LmxpbmVXaWR0aCA9IDE7CiAgZm9yKGxldCBpPTA7aTw9Mztp",
  "KyspewogICAgY29uc3QgeSA9IHBhZC50b3AgKyAoaW5uZXJILzMpKmk7CiAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8ocGFkLmxlZnQseSk7IGN0eC5saW5lVG8oVy1wYWQucmlnaHQseSk7IGN0eC5zdHJva2UoKTsKICB9CgogIGNvbnN0IGNvbG9yID0g",
  "cG9zaXRpdmUgPyAiIzMzRDZBNiIgOiAiI0ZCNkI2QiI7CgogIC8vIHNtb290aCBwYXRoCiAgZnVuY3Rpb24gc21vb3RoUGF0aChwb2ludHMpewogICAgaWYocG9pbnRzLmxlbmd0aDwzKSByZXR1cm4gYE0ke3BvaW50c1swXVswXX0sJHtwb2ludHNbMF1bMV19IEwk",
  "e3BvaW50c1sxXVswXX0sJHtwb2ludHNbMV1bMV19YDsKICAgIGxldCBkID0gYE0ke3BvaW50c1swXVswXX0sJHtwb2ludHNbMF1bMV19YDsKICAgIGZvcihsZXQgaT0wO2k8cG9pbnRzLmxlbmd0aC0xO2krKyl7CiAgICAgIGNvbnN0IHAwID0gcG9pbnRzW2k9PT0w",
  "PzA6aS0xXTsKICAgICAgY29uc3QgcDEgPSBwb2ludHNbaV07CiAgICAgIGNvbnN0IHAyID0gcG9pbnRzW2krMV07CiAgICAgIGNvbnN0IHAzID0gcG9pbnRzW2krMjxwb2ludHMubGVuZ3RoP2krMjppKzFdOwogICAgICBjb25zdCBjcDF4ID0gcDFbMF0gKyAocDJb",
  "MF0tcDBbMF0pLzY7CiAgICAgIGNvbnN0IGNwMXkgPSBwMVsxXSArIChwMlsxXS1wMFsxXSkvNjsKICAgICAgY29uc3QgY3AyeCA9IHAyWzBdIC0gKHAzWzBdLXAxWzBdKS82OwogICAgICBjb25zdCBjcDJ5ID0gcDJbMV0gLSAocDNbMV0tcDFbMV0pLzY7CiAgICAg",
  "IGQgKz0gYCBDJHtjcDF4fSwke2NwMXl9ICR7Y3AyeH0sJHtjcDJ5fSAke3AyWzBdfSwke3AyWzFdfWA7CiAgICB9CiAgICByZXR1cm4gZDsKICB9CiAgY29uc3QgbGluZVBhdGggPSBuZXcgUGF0aDJEKHNtb290aFBhdGgocHRzKSk7CgogIC8vIGFyZWEgZmlsbAog",
  "IGNvbnN0IGdyYWQgPSBjdHguY3JlYXRlTGluZWFyR3JhZGllbnQoMCxwYWQudG9wLDAscGFkLnRvcCtpbm5lckgpOwogIGdyYWQuYWRkQ29sb3JTdG9wKDAsIGNvbG9yKyI1NSIpOwogIGdyYWQuYWRkQ29sb3JTdG9wKDEsIGNvbG9yKyIwMiIpOwogIGN0eC5zYXZl",
  "KCk7CiAgY29uc3QgYXJlYVBhdGggPSBuZXcgUGF0aDJEKHNtb290aFBhdGgocHRzKSk7CiAgYXJlYVBhdGgubGluZVRvKHB0c1twdHMubGVuZ3RoLTFdWzBdLCBwYWQudG9wK2lubmVySCk7CiAgYXJlYVBhdGgubGluZVRvKHB0c1swXVswXSwgcGFkLnRvcCtpbm5l",
  "ckgpOwogIGFyZWFQYXRoLmNsb3NlUGF0aCgpOwogIGN0eC5maWxsU3R5bGUgPSBncmFkOwogIGN0eC5maWxsKGFyZWFQYXRoKTsKICBjdHgucmVzdG9yZSgpOwoKICAvLyBsaW5lCiAgY3R4LnN0cm9rZVN0eWxlID0gY29sb3I7CiAgY3R4LmxpbmVXaWR0aCA9IDI7",
  "CiAgY3R4LmxpbmVKb2luID0gInJvdW5kIjsKICBjdHgubGluZUNhcCA9ICJyb3VuZCI7CiAgY3R4LnN0cm9rZShsaW5lUGF0aCk7CgogIC8vIGVudHJhbmNlIGFuaW1hdGlvbiB2aWEgY2xpcCByZXZlYWwKICBjYW52YXMuX2NoYXJ0TWV0YSA9IHtwdHMsIHNlcmll",
  "cywgVywgSCwgcGFkLCBjb2xvcn07CgogIC8vIGNyb3NzaGFpciBpbnRlcmFjdGl2aXR5CiAgY29uc3QgdG9vbHRpcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJjaGFydFRvb2x0aXAiKTsKICBjYW52YXMub25tb3VzZW1vdmUgPSAoZSk9PnsKICAgIGNvbnN0",
  "IHIgPSBjYW52YXMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICBjb25zdCBteCA9IGUuY2xpZW50WCAtIHIubGVmdDsKICAgIGxldCBpZHggPSBNYXRoLnJvdW5kKChteC1wYWQubGVmdCkvc3RlcCk7CiAgICBpZHggPSBNYXRoLm1heCgwLCBNYXRoLm1pbihz",
  "ZXJpZXMubGVuZ3RoLTEsIGlkeCkpOwogICAgY29uc3QgW3B4LHB5XSA9IHB0c1tpZHhdOwoKICAgIHJlZHJhd1dpdGhDcm9zc2hhaXIoY3R4LCBjYW52YXMuX2NoYXJ0TWV0YSwgcHgsIHB5KTsKCiAgICB0b29sdGlwLnN0eWxlLm9wYWNpdHkgPSAiMSI7CiAgICB0",
  "b29sdGlwLnN0eWxlLmxlZnQgPSBweCsicHgiOwogICAgdG9vbHRpcC5zdHlsZS50b3AgPSBweSsicHgiOwogICAgdG9vbHRpcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0idHQtcHJpY2UiPiR7Zm10SU5SKHNlcmllc1tpZHhdKX08L2Rpdj48ZGl2IGNsYXNzPSJ0",
  "dC1kYXRlIj5Qb2ludCAke2lkeCsxfSBvZiAke3Nlcmllcy5sZW5ndGh9PC9kaXY+YDsKICB9OwogIGNhbnZhcy5vbm1vdXNlbGVhdmUgPSAoKT0+ewogICAgdG9vbHRpcC5zdHlsZS5vcGFjaXR5ID0gIjAiOwogICAgY3R4LmNsZWFyUmVjdCgwLDAsVyxIKTsKICAg",
  "IHJlZHJhdyhjdHgsIGNhbnZhcy5fY2hhcnRNZXRhKTsKICB9OwoKICBmdW5jdGlvbiByZWRyYXcoY3R4LCBtZXRhKXsKICAgIGNvbnN0IHtwdHMsIFcsIEgsIHBhZCwgY29sb3J9ID0gbWV0YTsKICAgIGN0eC5jbGVhclJlY3QoMCwwLFcsSCk7CiAgICBjdHguc3Ry",
  "b2tlU3R5bGUgPSAicmdiYSgxNTgsMTcxLDIxNCwwLjA4KSI7CiAgICBjdHgubGluZVdpZHRoID0gMTsKICAgIGNvbnN0IGlubmVySDIgPSBILXBhZC50b3AtcGFkLmJvdHRvbTsKICAgIGZvcihsZXQgaT0wO2k8PTM7aSsrKXsKICAgICAgY29uc3QgeSA9IHBhZC50",
  "b3AgKyAoaW5uZXJIMi8zKSppOwogICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8ocGFkLmxlZnQseSk7IGN0eC5saW5lVG8oVy1wYWQucmlnaHQseSk7IGN0eC5zdHJva2UoKTsKICAgIH0KICAgIGNvbnN0IGdyYWQyID0gY3R4LmNyZWF0ZUxpbmVhckdy",
  "YWRpZW50KDAscGFkLnRvcCwwLHBhZC50b3AraW5uZXJIMik7CiAgICBncmFkMi5hZGRDb2xvclN0b3AoMCwgY29sb3IrIjU1Iik7IGdyYWQyLmFkZENvbG9yU3RvcCgxLCBjb2xvcisiMDIiKTsKICAgIGNvbnN0IGFyZWFQYXRoMiA9IG5ldyBQYXRoMkQoc21vb3Ro",
  "UGF0aChwdHMpKTsKICAgIGFyZWFQYXRoMi5saW5lVG8ocHRzW3B0cy5sZW5ndGgtMV1bMF0sIHBhZC50b3AraW5uZXJIMik7CiAgICBhcmVhUGF0aDIubGluZVRvKHB0c1swXVswXSwgcGFkLnRvcCtpbm5lckgyKTsKICAgIGFyZWFQYXRoMi5jbG9zZVBhdGgoKTsK",
  "ICAgIGN0eC5maWxsU3R5bGUgPSBncmFkMjsgY3R4LmZpbGwoYXJlYVBhdGgyKTsKICAgIGN0eC5zdHJva2VTdHlsZSA9IGNvbG9yOyBjdHgubGluZVdpZHRoID0gMjsgY3R4LmxpbmVKb2luPSJyb3VuZCI7IGN0eC5saW5lQ2FwPSJyb3VuZCI7CiAgICBjdHguc3Ry",
  "b2tlKG5ldyBQYXRoMkQoc21vb3RoUGF0aChwdHMpKSk7CiAgfQogIGZ1bmN0aW9uIHJlZHJhd1dpdGhDcm9zc2hhaXIoY3R4LCBtZXRhLCBweCwgcHkpewogICAgcmVkcmF3KGN0eCwgbWV0YSk7CiAgICBjb25zdCB7SCwgcGFkLCBjb2xvcn0gPSBtZXRhOwogICAg",
  "Y3R4LnNhdmUoKTsKICAgIGN0eC5zdHJva2VTdHlsZSA9ICJyZ2JhKDE1OCwxNzEsMjE0LDAuMzUpIjsKICAgIGN0eC5saW5lV2lkdGggPSAxOwogICAgY3R4LnNldExpbmVEYXNoKFszLDNdKTsKICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbyhweCwgcGFk",
  "LnRvcCk7IGN0eC5saW5lVG8ocHgsIEgtcGFkLmJvdHRvbSk7IGN0eC5zdHJva2UoKTsKICAgIGN0eC5zZXRMaW5lRGFzaChbXSk7CiAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmMocHgscHksNCwwLE1hdGguUEkqMik7CiAgICBjdHguZmlsbFN0eWxlID0gY29s",
  "b3I7IGN0eC5maWxsKCk7CiAgICBjdHguc3Ryb2tlU3R5bGUgPSAiIzA1MDYwQiI7IGN0eC5saW5lV2lkdGg9MjsgY3R4LnN0cm9rZSgpOwogICAgY3R4LnJlc3RvcmUoKTsKICB9Cn0KCndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJyZXNpemUiLCBkZWJvdW5jZSgo",
  "KT0+ewogIGNvbnN0IGNhbnZhcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJwcmljZUNoYXJ0Iik7CiAgaWYoY2FudmFzICYmIHN0YXRlLnZpZXc9PT0iZGV0YWlsIikgbG9hZENoYXJ0KHN0YXRlLmRldGFpbFRpY2tlciwgdHJ1ZSk7Cn0sIDIwMCkpOwoKLyog",
  "LS0tLS0tLS0tLS0tLS0tLSBTVEFURSBIRUxQRVJTIC0tLS0tLS0tLS0tLS0tLS0gKi8KZnVuY3Rpb24gZW1wdHlTdGF0ZUlubmVyKHRpdGxlLCBzdWIpewogIHJldHVybiBgCiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS1pY29uIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAy",
  "NCIgd2lkdGg9IjIyIiBoZWlnaHQ9IjIyIiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48Y2lyY2xlIGN4PSIxMSIgY3k9IjExIiByPSI3Ii8+PHBhdGggZD0iTTIxIDIxbC00LjMtNC4zIi8+PC9zdmc+PC9kaXY+CiAg",
  "ICA8ZGl2IGNsYXNzPSJzdGF0ZS10aXRsZSI+JHt0aXRsZX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRlLXN1YiI+JHtzdWJ9PC9kaXY+CiAgYDsKfQpmdW5jdGlvbiBlbXB0eVN0YXRlSFRNTCh0aXRsZSwgc3ViKXsKICByZXR1cm4gYDxkaXYgY2xhc3M9InN0",
  "YXRlLWJveCI+JHtlbXB0eVN0YXRlSW5uZXIodGl0bGUsIHN1Yil9PC9kaXY+YDsKfQpmdW5jdGlvbiBlcnJvclN0YXRlSFRNTCh0aXRsZSwgc3ViKXsKICByZXR1cm4gYDxkaXYgY2xhc3M9InN0YXRlLWJveCI+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS1pY29uIj48",
  "c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjIyIiBoZWlnaHQ9IjIyIiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMTIgOXY0TTEyIDE3aC4wMU0xMC4yOSAzLjg2TDEuODIgMThhMiAyIDAg",
  "MDAxLjcxIDNoMTYuOTRhMiAyIDAgMDAxLjcxLTNMMTMuNzEgMy44NmEyIDIgMCAwMC0zLjQyIDB6Ii8+PC9zdmc+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS10aXRsZSI+JHt0aXRsZX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRlLXN1YiI+JHtzdWJ9",
  "PC9kaXY+CiAgPC9kaXY+YDsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBCT09UCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT0gKi8KLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBBSSBBU1NJU1RBTlQg4oCUIGNoYXQgcGFuZWwgKyBwZXItc3RvY2sgZXhwbGFpbgogICA9PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmNvbnN0IGFpU3RhdGUgPSB7IG9wZW46IGZhbHNlLCBoaXN0b3J5OiBbXSwgY29uZmlndXJlZDogbnVsbCwgYnVzeTogZmFsc2UgfTsKCmZ1bmN0aW9uIGFpU2V0",
  "U3RhdHVzTGluZSh0ZXh0KXsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaVN0YXR1c0xpbmUiKTsKICBpZihlbCkgZWwudGV4dENvbnRlbnQgPSB0ZXh0Owp9Cgphc3luYyBmdW5jdGlvbiBjaGVja0FpU3RhdHVzKCl7CiAgdHJ5ewogICAg",
  "Y29uc3QgciA9IGF3YWl0IGZldGNoV2l0aFRpbWVvdXQoQ09ORklHLkFQSV9CQVNFICsgIi9haS9zdGF0dXMiLCBDT05GSUcuTElWRV9USU1FT1VUX01TKTsKICAgIGlmKCFyLm9rKSB0aHJvdyBuZXcgRXJyb3IoImJhZCBzdGF0dXMiKTsKICAgIGNvbnN0IGpzb24g",
  "PSBhd2FpdCByLmpzb24oKTsKICAgIGFpU3RhdGUuY29uZmlndXJlZCA9ICEhanNvbi5jb25maWd1cmVkOwogICAgYWlTZXRTdGF0dXNMaW5lKGFpU3RhdGUuY29uZmlndXJlZCA/ICJSZWFkeSIgOiAiTm90IGNvbmZpZ3VyZWQgb24gc2VydmVyIik7CiAgfWNhdGNo",
  "KGUpewogICAgYWlTdGF0ZS5jb25maWd1cmVkID0gZmFsc2U7CiAgICBhaVNldFN0YXR1c0xpbmUobGl2ZUJhY2tlbmRBdmFpbGFibGUgPyAiVW5hdmFpbGFibGUiIDogIkJhY2tlbmQgbm90IGNvbm5lY3RlZCIpOwogIH0KfQoKZnVuY3Rpb24gYnVpbGRBaUNvbnRl",
  "eHQoKXsKICAvLyBDb21wYWN0LCByZWxldmFudCBzbmFwc2hvdCBvZiB3aGF0J3MgY3VycmVudGx5IGxvYWRlZCDigJQga2VwdCBzbWFsbCBvbgogIC8vIHB1cnBvc2Ugc2luY2UgdGhpcyBnZXRzIHNlbnQgKGFuZCBiaWxsZWQpIG9uIGV2ZXJ5IHF1ZXN0aW9uLgog",
  "IGNvbnN0IGN0eCA9IHsgdmlldzogc3RhdGUudmlldywgd2F0Y2hsaXN0OiBbXSB9OwogIGlmKHN0YXRlLnZpZXcgPT09ICJkZXRhaWwiKSBjdHguY3VycmVudFN0b2NrID0geyB0aWNrZXI6IHN0YXRlLmRldGFpbFRpY2tlciB9OwogIGlmKHN0YXRlLndhdGNobGlz",
  "dC5sZW5ndGgpewogICAgY3R4LndhdGNobGlzdCA9IHN0YXRlLndhdGNobGlzdC5zbGljZSgwLCAxMCk7CiAgfQogIHJldHVybiBjdHg7Cn0KCmZ1bmN0aW9uIGFwcGVuZEFpTWVzc2FnZShyb2xlLCB0ZXh0LCBleHRyYUNsYXNzKXsKICBjb25zdCB3cmFwID0gZG9j",
  "dW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpTWVzc2FnZXMiKTsKICBpZighd3JhcCkgcmV0dXJuIG51bGw7CiAgY29uc3QgZGl2ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgiZGl2Iik7CiAgZGl2LmNsYXNzTmFtZSA9ICJhaS1tc2cgIiArIHJvbGUgKyAoZXh0cmFD",
  "bGFzcyA/ICIgIiArIGV4dHJhQ2xhc3MgOiAiIik7CiAgZGl2LnRleHRDb250ZW50ID0gdGV4dDsKICB3cmFwLmFwcGVuZENoaWxkKGRpdik7CiAgd3JhcC5zY3JvbGxUb3AgPSB3cmFwLnNjcm9sbEhlaWdodDsKICByZXR1cm4gZGl2Owp9Cgphc3luYyBmdW5jdGlv",
  "biBzZW5kQWlNZXNzYWdlKHF1ZXN0aW9uKXsKICBpZighcXVlc3Rpb24udHJpbSgpIHx8IGFpU3RhdGUuYnVzeSkgcmV0dXJuOwogIGFwcGVuZEFpTWVzc2FnZSgidXNlciIsIHF1ZXN0aW9uKTsKICBhaVN0YXRlLmJ1c3kgPSB0cnVlOwogIGRvY3VtZW50LmdldEVs",
  "ZW1lbnRCeUlkKCJhaVNlbmRCdG4iKS5kaXNhYmxlZCA9IHRydWU7CiAgY29uc3QgcGVuZGluZyA9IGFwcGVuZEFpTWVzc2FnZSgiYXNzaXN0YW50IiwgIlRoaW5raW5n4oCmIiwgInBlbmRpbmciKTsKCiAgdHJ5ewogICAgaWYoIWxpdmVCYWNrZW5kQXZhaWxhYmxl",
  "KSB0aHJvdyBuZXcgRXJyb3IoIkJhY2tlbmQgbm90IGNvbm5lY3RlZCDigJQgdGhlIEFJIGFzc2lzdGFudCBuZWVkcyB0aGUgbGl2ZSBiYWNrZW5kIHJ1bm5pbmcuIik7CiAgICBjb25zdCBjdHJsID0gbmV3IEFib3J0Q29udHJvbGxlcigpOwogICAgY29uc3QgaWQg",
  "PSBzZXRUaW1lb3V0KCgpPT5jdHJsLmFib3J0KCksIDIwMDAwKTsKICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKENPTkZJRy5BUElfQkFTRSArICIvY2hhdCIsIHsKICAgICAgbWV0aG9kOiAiUE9TVCIsCiAgICAgIGhlYWRlcnM6IHsiQ29udGVudC1UeXBlIjog",
  "ImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHF1ZXN0aW9uOiBxdWVzdGlvbi50cmltKCksCiAgICAgICAgY29udGV4dDogYnVpbGRBaUNvbnRleHQoKSwKICAgICAgICBoaXN0b3J5OiBhaVN0YXRlLmhpc3Rv",
  "cnkuc2xpY2UoLTYpLAogICAgICB9KSwKICAgICAgc2lnbmFsOiBjdHJsLnNpZ25hbCwKICAgIH0pLmZpbmFsbHkoKCk9PmNsZWFyVGltZW91dChpZCkpOwoKICAgIGNvbnN0IGpzb24gPSBhd2FpdCByZXMuanNvbigpOwogICAgaWYoIXJlcy5vayB8fCAhanNvbi5z",
  "dWNjZXNzKSB0aHJvdyBuZXcgRXJyb3IoKGpzb24uZXJyb3IgJiYganNvbi5lcnJvci5tZXNzYWdlKSB8fCAoIlJlcXVlc3QgZmFpbGVkICgiICsgcmVzLnN0YXR1cyArICIpIikpOwoKICAgIHBlbmRpbmcucmVtb3ZlKCk7CiAgICBhcHBlbmRBaU1lc3NhZ2UoImFz",
  "c2lzdGFudCIsIGpzb24uZGF0YS5hbnN3ZXIpOwogICAgYWlTdGF0ZS5oaXN0b3J5LnB1c2goe3JvbGU6InVzZXIiLCBjb250ZW50OiBxdWVzdGlvbi50cmltKCl9KTsKICAgIGFpU3RhdGUuaGlzdG9yeS5wdXNoKHtyb2xlOiJhc3Npc3RhbnQiLCBjb250ZW50OiBq",
  "c29uLmRhdGEuYW5zd2VyfSk7CiAgfWNhdGNoKGUpewogICAgcGVuZGluZy5yZW1vdmUoKTsKICAgIGFwcGVuZEFpTWVzc2FnZSgiYXNzaXN0YW50IiwgIkNvdWxkbid0IGdldCBhIHJlc3BvbnNlOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpLCAiZXJyb3IiKTsK",
  "ICB9ZmluYWxseXsKICAgIGFpU3RhdGUuYnVzeSA9IGZhbHNlOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpU2VuZEJ0biIpLmRpc2FibGVkID0gZmFsc2U7CiAgfQp9CgpmdW5jdGlvbiB3aXJlQWlQYW5lbCgpewogIGNvbnN0IGZhYiA9IGRvY3VtZW50",
  "LmdldEVsZW1lbnRCeUlkKCJhaUZhYiIpOwogIGNvbnN0IHBhbmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpUGFuZWwiKTsKICBjb25zdCBjbG9zZUJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaUNsb3NlQnRuIik7CiAgY29uc3QgaW5wdXQg",
  "PSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlJbnB1dCIpOwogIGNvbnN0IHNlbmRCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlTZW5kQnRuIik7CgogIHBhbmVsLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOwoKICBmYWIuYWRkRXZlbnRMaXN0ZW5l",
  "cigiY2xpY2siLCAoKT0+ewogICAgYWlTdGF0ZS5vcGVuID0gIWFpU3RhdGUub3BlbjsKICAgIHBhbmVsLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsICFhaVN0YXRlLm9wZW4pOwogICAgaWYoYWlTdGF0ZS5vcGVuKXsgY2hlY2tBaVN0YXR1cygpOyBpbnB1dC5m",
  "b2N1cygpOyB9CiAgfSk7CiAgY2xvc2VCdG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgYWlTdGF0ZS5vcGVuID0gZmFsc2U7CiAgICBwYW5lbC5jbGFzc0xpc3QuYWRkKCJoaWRkZW4iKTsKICB9KTsKICBjb25zdCBzZW5kID0gKCk9PnsKICAg",
  "IGNvbnN0IHEgPSBpbnB1dC52YWx1ZTsKICAgIGlucHV0LnZhbHVlID0gIiI7CiAgICBzZW5kQWlNZXNzYWdlKHEpOwogIH07CiAgc2VuZEJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIHNlbmQpOwogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoImtleWRvd24i",
  "LCAoZSk9PnsgaWYoZS5rZXkgPT09ICJFbnRlciIpIHNlbmQoKTsgfSk7Cn0KCi8vICJFeHBsYWluIHRoaXMgc3RvY2siIOKAlCBjYWxsZWQgZnJvbSByZW5kZXJEZXRhaWwgb25jZSBzdG9jayBkYXRhIGlzIGxvYWRlZC4KYXN5bmMgZnVuY3Rpb24gd2lyZUV4cGxh",
  "aW5CdXR0b24odGlja2VyKXsKICBjb25zdCBidG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZXhwbGFpbkJ0biIpOwogIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZXhwbGFpbkNhcmQiKTsKICBpZighYnRuKSByZXR1cm47CiAgYnRu",
  "LmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgYXN5bmMgKCk9PnsKICAgIGJ0bi5kaXNhYmxlZCA9IHRydWU7CiAgICBidG4udGV4dENvbnRlbnQgPSAiVGhpbmtpbmfigKYiOwogICAgY2FyZC5zdHlsZS5kaXNwbGF5ID0gImJsb2NrIjsKICAgIGNhcmQuaW5uZXJI",
  "VE1MID0gYDxkaXYgY2xhc3M9ImV4cGxhaW4taGVhZCI+PGRpdiBjbGFzcz0iYWktYXZhdGFyIj7inKY8L2Rpdj48ZGl2IHN0eWxlPSJmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7Ij5BSSBFeHBsYW5hdGlvbjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImV4",
  "cGxhaW4tdGV4dCI+JHtza2VsZXRvbkxpbmVzKDMpfTwvZGl2PmA7CiAgICB0cnl7CiAgICAgIGlmKCFsaXZlQmFja2VuZEF2YWlsYWJsZSkgdGhyb3cgbmV3IEVycm9yKCJCYWNrZW5kIG5vdCBjb25uZWN0ZWQuIik7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRj",
  "aFdpdGhUaW1lb3V0KGAke0NPTkZJRy5BUElfQkFTRX0vZXhwbGFpbi8ke2VuY29kZVVSSUNvbXBvbmVudCh0aWNrZXIpfWAsIDIwMDAwKTsKICAgICAgY29uc3QganNvbiA9IGF3YWl0IHIuanNvbigpOwogICAgICBpZighci5vayB8fCAhanNvbi5zdWNjZXNzKSB0",
  "aHJvdyBuZXcgRXJyb3IoKGpzb24uZXJyb3IgJiYganNvbi5lcnJvci5tZXNzYWdlKSB8fCAoIlJlcXVlc3QgZmFpbGVkICgiICsgci5zdGF0dXMgKyAiKSIpKTsKICAgICAgY2FyZC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iZXhwbGFpbi1oZWFkIj48ZGl2IGNs",
  "YXNzPSJhaS1hdmF0YXIiPuKcpjwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTNweDsiPkFJIEV4cGxhbmF0aW9uPC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0iZXhwbGFpbi10ZXh0Ij4ke2VzY2FwZUh0bWwoanNvbi5kYXRhLmV4cGxh",
  "bmF0aW9uKX08L2Rpdj5gOwogICAgfWNhdGNoKGUpewogICAgICBjYXJkLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJleHBsYWluLWhlYWQiPjxkaXYgY2xhc3M9ImFpLWF2YXRhciI+4pymPC9kaXY+PGRpdiBzdHlsZT0iZm9udC13ZWlnaHQ6NzAwO2ZvbnQtc2l6",
  "ZToxM3B4OyI+QUkgRXhwbGFuYXRpb248L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJleHBsYWluLXRleHQiIHN0eWxlPSJjb2xvcjp2YXIoLS1uZWctc29mdCk7Ij5Db3VsZG4ndCBnZW5lcmF0ZSBhbiBleHBsYW5hdGlvbjogJHtlc2NhcGVIdG1sKGUgJiYgZS5tZXNz",
  "YWdlIHx8IFN0cmluZyhlKSl9PC9kaXY+YDsKICAgIH1maW5hbGx5ewogICAgICBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAgICAgYnRuLnRleHRDb250ZW50ID0gIuKcpiBFeHBsYWluIHRoaXMgc3RvY2siOwogICAgfQogIH0pOwp9CgpzZXRBY3RpdmVOYXYoImRh",
  "c2hib2FyZCIpOwp3aXJlQWlQYW5lbCgpOwpjaGVja0xpdmVCYWNrZW5kKCkuZmluYWxseShyZW5kZXIpOwpzZXRJbnRlcnZhbChjaGVja0xpdmVCYWNrZW5kLCA0NTAwMCk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K"
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
