/**
 * Bot Detection & Rate Limiting Middleware
 *
 * Three-layer defence:
 *  1. IP-based rate limiting (sliding window)
 *  2. Behavior fingerprint validation (from frontend BehaviorAnalyzer)
 *  3. Audit logging of every connection attempt with suspicious-flag tracking
 *
 * Zero external dependencies — works in both local Express and Netlify Functions.
 */

import fs from 'fs'
import path from 'path'

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  // Rate limiting
  RATE_WINDOW_MS: 60 * 1000,         // 1-minute sliding window
  MAX_REQUESTS_PER_WINDOW: 10,        // per IP across all endpoints
  MAX_WALLET_CONNECTS_PER_WINDOW: 5,  // per IP for balance-check endpoints specifically
  BLOCK_DURATION_MS: 5 * 60 * 1000,  // 5-minute block after exceeding limits

  // Behavior validation
  MIN_BEHAVIOR_SCORE: 12,            // minimum score to pass (bots typically < 10)
  MIN_ELAPSED_SECONDS: 1.5,          // must spend at least 1.5s on page
  REQUIRE_MOUSE_OR_TOUCH: true,      // must have some pointer activity

  // Logging
  LOG_FILE: 'connection-audit.json',
  MAX_LOG_ENTRIES: 5000,             // rotate after this many entries
  SUSPICIOUS_THRESHOLD: 3,           // flag IP after N suspicious attempts
}

// ─── In-memory stores ────────────────────────────────────────────────────────

/** Map<ip, { timestamps: number[], walletTimestamps: number[], blockedUntil: number }> */
const rateLimitStore = new Map()

/** Map<ip, { suspiciousCount: number, lastSeen: number }> */
const suspicionStore = new Map()

// Periodic cleanup every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [ip, data] of rateLimitStore) {
    data.timestamps = data.timestamps.filter(t => now - t < CONFIG.RATE_WINDOW_MS)
    data.walletTimestamps = data.walletTimestamps.filter(t => now - t < CONFIG.RATE_WINDOW_MS)
    if (data.timestamps.length === 0 && now > data.blockedUntil) {
      rateLimitStore.delete(ip)
    }
  }
  for (const [ip, data] of suspicionStore) {
    if (now - data.lastSeen > 30 * 60 * 1000) { // 30 min expiry
      suspicionStore.delete(ip)
    }
  }
}, 5 * 60 * 1000)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    req.ip ||
    'unknown'
  )
}

function getRateLimitData(ip) {
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, {
      timestamps: [],
      walletTimestamps: [],
      blockedUntil: 0
    })
  }
  return rateLimitStore.get(ip)
}

function getSuspicionData(ip) {
  if (!suspicionStore.has(ip)) {
    suspicionStore.set(ip, { suspiciousCount: 0, lastSeen: Date.now() })
  }
  return suspicionStore.get(ip)
}

function incrementSuspicion(ip, reason) {
  const data = getSuspicionData(ip)
  data.suspiciousCount++
  data.lastSeen = Date.now()
  return data.suspiciousCount
}

// ─── Audit Logger ────────────────────────────────────────────────────────────

function writeAuditLog(entry) {
  try {
    const logPath = path.join(process.cwd(), CONFIG.LOG_FILE)
    let logs = []
    if (fs.existsSync(logPath)) {
      try {
        logs = JSON.parse(fs.readFileSync(logPath, 'utf8'))
        if (!Array.isArray(logs)) logs = []
      } catch { logs = [] }
    }

    logs.push(entry)

    // Rotate: keep only the latest entries
    if (logs.length > CONFIG.MAX_LOG_ENTRIES) {
      logs = logs.slice(-CONFIG.MAX_LOG_ENTRIES)
    }

    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2))
  } catch {
    // Serverless / read-only FS — log to stdout instead
    console.log(`[AUDIT] ${JSON.stringify(entry)}`)
  }
}

// ─── Behavior Validation ─────────────────────────────────────────────────────

function validateBehavior(fingerprint) {
  const issues = []

  if (!fingerprint || typeof fingerprint !== 'object') {
    return { valid: false, issues: ['Missing behavior fingerprint'] }
  }

  const { score, elapsed, mouse, clicks, touch, keys, scroll } = fingerprint

  // Score threshold
  if (typeof score !== 'number' || score < CONFIG.MIN_BEHAVIOR_SCORE) {
    issues.push(`Low behavior score: ${score ?? 'none'} (min ${CONFIG.MIN_BEHAVIOR_SCORE})`)
  }

  // Elapsed time
  if (typeof elapsed !== 'number' || elapsed < CONFIG.MIN_ELAPSED_SECONDS) {
    issues.push(`Too fast: ${elapsed ?? 0}s (min ${CONFIG.MIN_ELAPSED_SECONDS}s)`)
  }

  // Must have mouse OR touch activity
  if (CONFIG.REQUIRE_MOUSE_OR_TOUCH) {
    const hasPointer = (mouse?.moves > 0) || (touch?.count > 0) || (clicks?.count > 0)
    if (!hasPointer) {
      issues.push('No mouse/touch/click activity detected')
    }
  }

  // Suspiciously uniform mouse velocity (bot signature)
  if (mouse?.moves > 20 && mouse.velocityStd !== undefined && mouse.velocityStd < 0.05) {
    issues.push('Mouse velocity too uniform (synthetic events)')
  }

  // Impossibly high event rate
  if (elapsed > 0 && mouse?.moves > 0) {
    const movesPerSec = mouse.moves / elapsed
    if (movesPerSec > 200) {
      issues.push(`Impossible mouse rate: ${movesPerSec.toFixed(0)}/s`)
    }
  }

  // Timestamp freshness — fingerprint should be recent
  if (fingerprint.timestamp) {
    const age = Date.now() - fingerprint.timestamp
    if (age > 5 * 60 * 1000) { // older than 5 minutes
      issues.push('Stale behavior fingerprint')
    }
    if (age < 0) {
      issues.push('Future timestamp detected')
    }
  }

  return { valid: issues.length === 0, issues }
}

// ─── Middleware: Rate Limiter ────────────────────────────────────────────────

export function rateLimiter(isWalletEndpoint = false) {
  return (req, res, next) => {
    const ip = getClientIp(req)
    const now = Date.now()
    const data = getRateLimitData(ip)

    // Check if currently blocked
    if (now < data.blockedUntil) {
      const remaining = Math.ceil((data.blockedUntil - now) / 1000)

      writeAuditLog({
        timestamp: new Date().toISOString(),
        ip,
        endpoint: req.path,
        action: 'BLOCKED_RATE_LIMIT',
        message: `IP blocked for ${remaining}s more`,
        userAgent: req.headers['user-agent']
      })

      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.',
        retryAfter: remaining
      })
    }

    // Slide window: remove stale timestamps
    data.timestamps = data.timestamps.filter(t => now - t < CONFIG.RATE_WINDOW_MS)
    data.walletTimestamps = data.walletTimestamps.filter(t => now - t < CONFIG.RATE_WINDOW_MS)

    // Check general rate limit
    if (data.timestamps.length >= CONFIG.MAX_REQUESTS_PER_WINDOW) {
      data.blockedUntil = now + CONFIG.BLOCK_DURATION_MS
      incrementSuspicion(ip, 'rate_limit_exceeded')

      writeAuditLog({
        timestamp: new Date().toISOString(),
        ip,
        endpoint: req.path,
        action: 'RATE_LIMIT_TRIGGERED',
        message: `Exceeded ${CONFIG.MAX_REQUESTS_PER_WINDOW} requests/min`,
        requestCount: data.timestamps.length,
        userAgent: req.headers['user-agent']
      })

      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please wait before trying again.',
        retryAfter: Math.ceil(CONFIG.BLOCK_DURATION_MS / 1000)
      })
    }

    // Check wallet-specific rate limit
    if (isWalletEndpoint && data.walletTimestamps.length >= CONFIG.MAX_WALLET_CONNECTS_PER_WINDOW) {
      incrementSuspicion(ip, 'wallet_rate_limit')

      writeAuditLog({
        timestamp: new Date().toISOString(),
        ip,
        endpoint: req.path,
        action: 'WALLET_RATE_LIMIT',
        message: `Exceeded ${CONFIG.MAX_WALLET_CONNECTS_PER_WINDOW} wallet connects/min`,
        userAgent: req.headers['user-agent']
      })

      return res.status(429).json({
        success: false,
        error: 'Too many wallet connection attempts. Please slow down.',
        retryAfter: Math.ceil(CONFIG.RATE_WINDOW_MS / 1000)
      })
    }

    // Record this request
    data.timestamps.push(now)
    if (isWalletEndpoint) {
      data.walletTimestamps.push(now)
    }

    // Attach IP for downstream use
    req._clientIp = ip
    next()
  }
}

// ─── Middleware: Behavior Validator ──────────────────────────────────────────

export function behaviorValidator(req, res, next) {
  const ip = req._clientIp || getClientIp(req)
  const fingerprint = req.body?._behavior
  const walletAddress = req.body?.address || req.body?.wallet || 'unknown'

  const validation = validateBehavior(fingerprint)

  const logEntry = {
    timestamp: new Date().toISOString(),
    ip,
    endpoint: req.path,
    wallet: walletAddress,
    behaviorScore: fingerprint?.score ?? null,
    elapsed: fingerprint?.elapsed ?? null,
    mouseMovements: fingerprint?.mouse?.moves ?? 0,
    clicks: fingerprint?.clicks?.count ?? 0,
    scrolls: fingerprint?.scroll?.count ?? 0,
    keyPresses: fingerprint?.keys?.count ?? 0,
    touchEvents: fingerprint?.touch?.count ?? 0,
    userAgent: req.headers['user-agent'],
    valid: validation.valid,
    issues: validation.issues
  }

  if (!validation.valid) {
    const suspicionCount = incrementSuspicion(ip, validation.issues.join('; '))

    logEntry.action = 'SUSPICIOUS_BEHAVIOR'
    logEntry.suspicionCount = suspicionCount
    logEntry.flagged = suspicionCount >= CONFIG.SUSPICIOUS_THRESHOLD

    writeAuditLog(logEntry)

    // After multiple suspicious attempts, hard-block
    if (suspicionCount >= CONFIG.SUSPICIOUS_THRESHOLD) {
      const data = getRateLimitData(ip)
      data.blockedUntil = Date.now() + CONFIG.BLOCK_DURATION_MS

      console.warn(`[BOT DETECTION] IP ${ip} blocked — ${suspicionCount} suspicious attempts`)

      return res.status(403).json({
        success: false,
        error: 'Connection blocked due to suspicious activity.'
      })
    }

    // Soft rejection — tell the client to retry after interacting with the page
    return res.status(403).json({
      success: false,
      error: 'Human verification failed. Please interact with the page and try again.',
      issues: validation.issues
    })
  }

  // Passed — log as clean
  logEntry.action = 'VERIFIED_HUMAN'
  writeAuditLog(logEntry)

  // Strip _behavior from body so downstream handlers don't see it
  if (req.body?._behavior) {
    delete req.body._behavior
  }

  next()
}

// ─── Middleware: Connection Audit Logger (for non-protected endpoints) ───────

export function auditLogger(req, res, next) {
  const ip = req._clientIp || getClientIp(req)

  writeAuditLog({
    timestamp: new Date().toISOString(),
    ip,
    method: req.method,
    endpoint: req.path,
    action: 'REQUEST',
    userAgent: req.headers['user-agent']
  })

  next()
}

// ─── Express setup helper ────────────────────────────────────────────────────

/**
 * Apply bot protection to an Express app.
 *
 * Usage:
 *   import { applyBotProtection } from './middleware/botDetection.js'
 *   applyBotProtection(app)
 */
export function applyBotProtection(app) {
  // Global: audit log every request
  app.use(auditLogger)

  // Global: general rate limiter on all POST endpoints
  app.use((req, res, next) => {
    if (req.method === 'POST') {
      return rateLimiter(false)(req, res, next)
    }
    next()
  })

  console.log('[BOT PROTECTION] Middleware active — rate limiting + behavior analysis enabled')
}

/**
 * Create a middleware chain for wallet-sensitive endpoints.
 * Applies stricter wallet-specific rate limiting AND behavior validation.
 */
export function walletProtection() {
  return [rateLimiter(true), behaviorValidator]
}
