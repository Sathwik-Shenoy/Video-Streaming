/**
 * Rate Limiter — in-memory sliding window rate limiter for Express + Socket.io.
 */

class RateLimiter {
  constructor({ windowMs = 5 * 60 * 1000, maxRequests = 120 } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.store = new Map();

    // Periodic cleanup to prevent memory leaks
    this._cleanup = setInterval(() => {
      const cutoff = Date.now() - this.windowMs;
      for (const [ip, timestamps] of this.store.entries()) {
        const filtered = timestamps.filter(ts => ts > cutoff);
        if (filtered.length === 0) this.store.delete(ip);
        else this.store.set(ip, filtered);
      }
    }, 60 * 1000);
    if (this._cleanup.unref) this._cleanup.unref();
  }

  /** Returns true if request is within limit */
  check(ip) {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = this.store.get(ip) || [];
    const filtered = timestamps.filter(ts => ts > windowStart);
    filtered.push(now);
    this.store.set(ip, filtered);
    return filtered.length <= this.maxRequests;
  }

  /** Express middleware */
  expressMiddleware() {
    return (req, res, next) => {
      const ip = req.ip || req.connection?.remoteAddress || 'unknown';
      if (!this.check(ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      }
      next();
    };
  }

  /** Socket.io middleware */
  socketMiddleware() {
    return (socket, next) => {
      const ip = socket.handshake.address || 'unknown';
      if (!this.check(ip)) {
        return next(new Error('Rate limit exceeded'));
      }
      next();
    };
  }

  destroy() {
    if (this._cleanup) clearInterval(this._cleanup);
  }
}

module.exports = { RateLimiter };
