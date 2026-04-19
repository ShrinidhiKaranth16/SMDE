import { Request, Response, NextFunction } from 'express';

interface BucketEntry {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, BucketEntry>();

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX || '10', 10);

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0];

  return ip?.trim() || req.socket.remoteAddress || 'unknown';
}

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === 'test') {
      next();
      return;
  }
  const ip = getClientIp(req);
  const now = Date.now();

  let entry = buckets.get(ip);

  if (!entry) {
    entry = { tokens: MAX_REQUESTS, lastRefill: now };
    buckets.set(ip, entry);
  }

  // Refill tokens proportionally based on time elapsed
  const elapsed = now - entry.lastRefill;
  const refill = Math.floor((elapsed / WINDOW_MS) * MAX_REQUESTS);
  if (refill > 0) {
    entry.tokens = Math.min(MAX_REQUESTS, entry.tokens + refill);
    entry.lastRefill = now;
  }

  if (entry.tokens < 1) {
    const retryAfterMs = WINDOW_MS - elapsed;
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    res.setHeader('Retry-After', retryAfterSec.toString());
    res.setHeader('X-RateLimit-Limit', MAX_REQUESTS.toString());
    res.setHeader('X-RateLimit-Remaining', '0');
    res.status(429).json({
      error: 'RATE_LIMITED',
      message: `Too many requests. Limit is ${MAX_REQUESTS} per ${WINDOW_MS / 1000}s window.`,
      retryAfterMs,
    });
    return;
  }

  entry.tokens -= 1;
  res.setHeader('X-RateLimit-Limit', MAX_REQUESTS.toString());
  res.setHeader('X-RateLimit-Remaining', entry.tokens.toString());
  next();
}

// Cleanup stale entries periodically to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [ip, entry] of buckets.entries()) {
    if (entry.lastRefill < cutoff) buckets.delete(ip);
  }
}, WINDOW_MS);
