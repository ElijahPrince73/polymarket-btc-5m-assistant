/**
 * @file Token-bucket rate limiter for CLOB API calls.
 *
 * Prevents exceeding API rate limits by throttling outbound requests.
 * Uses a simple token bucket algorithm: tokens replenish at a fixed rate,
 * and each request consumes one token.
 */

export class RateLimiter {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxTokens]     - Max tokens (burst capacity). Default 10.
   * @param {number} [opts.refillRate]    - Tokens added per second. Default 10.
   * @param {string} [opts.name]          - Name for logging. Default 'RateLimiter'.
   */
  constructor(opts = {}) {
    this.maxTokens = opts.maxTokens ?? 10;
    this.refillRate = opts.refillRate ?? 10;
    this.name = opts.name ?? 'RateLimiter';

    this._tokens = this.maxTokens;
    this._lastRefillMs = Date.now();

    // Stats
    this._totalRequests = 0;
    this._totalThrottled = 0;
  }

  /**
   * Refill tokens based on elapsed time.
   */
  _refill() {
    const now = Date.now();
    const elapsedSec = (now - this._lastRefillMs) / 1000;
    this._tokens = Math.min(this.maxTokens, this._tokens + elapsedSec * this.refillRate);
    this._lastRefillMs = now;
  }

  /**
   * Try to consume a token. Returns true if allowed, false if rate-limited.
   * @returns {boolean}
   */
  tryAcquire() {
    this._refill();
    this._totalRequests++;

    if (this._tokens >= 1) {
      this._tokens -= 1;
      return true;
    }

    this._totalThrottled++;
    return false;
  }

  /**
   * Wait until a token is available, then consume it.
   * @param {number} [maxWaitMs=5000] - Max time to wait before giving up
   * @returns {Promise<boolean>} true if acquired, false if timed out
   */
  async acquire(maxWaitMs = 5000) {
    const start = Date.now();

    while (true) {
      if (this.tryAcquire()) return true;

      const elapsed = Date.now() - start;
      if (elapsed >= maxWaitMs) return false;

      // Wait for estimated token availability
      const waitMs = Math.min(
        Math.ceil(1000 / this.refillRate),
        maxWaitMs - elapsed,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Get current stats.
   * @returns {{ tokens: number, maxTokens: number, refillRate: number, totalRequests: number, totalThrottled: number }}
   */
  getStats() {
    this._refill();
    return {
      name: this.name,
      tokens: Math.round(this._tokens * 100) / 100,
      maxTokens: this.maxTokens,
      refillRate: this.refillRate,
      totalRequests: this._totalRequests,
      totalThrottled: this._totalThrottled,
    };
  }
}

/**
 * Global CLOB API rate limiter singleton.
 * Shared across all components that call the Polymarket CLOB API.
 */
let _globalClobLimiter = null;

/**
 * Get or create the global CLOB rate limiter.
 * @param {Object} [opts] - Override defaults on first creation
 * @returns {RateLimiter}
 */
export function getClobRateLimiter(opts = {}) {
  if (!_globalClobLimiter) {
    _globalClobLimiter = new RateLimiter({
      maxTokens: opts.maxTokens ?? 10,
      refillRate: opts.refillRate ?? 10,
      name: 'CLOB',
    });
  }
  return _globalClobLimiter;
}
