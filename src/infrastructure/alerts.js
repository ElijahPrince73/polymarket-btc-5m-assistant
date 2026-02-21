/**
 * @file Simple alerting system for critical events.
 *
 * Tracks alert conditions and provides a way to query recent alerts.
 * Can be extended later to push to Slack, Discord, etc.
 */

/**
 * @typedef {Object} Alert
 * @property {string} type    - Alert type (e.g. 'circuit_breaker', 'daily_loss', 'api_error')
 * @property {string} message - Human-readable message
 * @property {string} level   - 'warning' | 'critical'
 * @property {string} timestamp
 * @property {Object} [data]  - Extra context
 */

export class AlertService {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxAlerts]          - Max alerts to keep in memory (default 200)
   * @param {number} [opts.dedupeWindowMs]     - Suppress duplicate alerts within this window (default 5 min)
   */
  constructor(opts = {}) {
    this.maxAlerts = opts.maxAlerts ?? 200;
    this.dedupeWindowMs = opts.dedupeWindowMs ?? 5 * 60_000;

    /** @type {Alert[]} */
    this._alerts = [];

    /** @type {Map<string, number>} type → last alert timestamp */
    this._lastAlertByType = new Map();
  }

  /**
   * Fire an alert.
   * @param {string} type
   * @param {string} message
   * @param {'warning'|'critical'} [level='warning']
   * @param {Object} [data]
   * @returns {boolean} true if alert was actually emitted (not deduped)
   */
  fire(type, message, level = 'warning', data) {
    const now = Date.now();
    const lastFired = this._lastAlertByType.get(type) ?? 0;

    // Deduplicate
    if (now - lastFired < this.dedupeWindowMs) {
      return false;
    }

    this._lastAlertByType.set(type, now);

    const alert = {
      type,
      message,
      level,
      timestamp: new Date(now).toISOString(),
      ...(data ? { data } : {}),
    };

    this._alerts.push(alert);

    // Prune old alerts
    if (this._alerts.length > this.maxAlerts) {
      this._alerts.splice(0, this._alerts.length - this.maxAlerts);
    }

    // Log to console
    const prefix = level === 'critical' ? '🚨' : '⚠️';
    console.warn(`${prefix} ALERT [${type}]: ${message}`);

    return true;
  }

  /**
   * Get recent alerts.
   * @param {number} [limit=50]
   * @returns {Alert[]}
   */
  getRecent(limit = 50) {
    return this._alerts.slice(-limit);
  }

  /**
   * Get alerts of a specific type.
   * @param {string} type
   * @param {number} [limit=20]
   * @returns {Alert[]}
   */
  getByType(type, limit = 20) {
    return this._alerts
      .filter((a) => a.type === type)
      .slice(-limit);
  }

  /**
   * Get a snapshot for the API.
   * @returns {{ total: number, recent: Alert[], criticalCount: number }}
   */
  getSnapshot() {
    const recent = this._alerts.slice(-50);
    return {
      total: this._alerts.length,
      recent,
      criticalCount: this._alerts.filter((a) => a.level === 'critical').length,
    };
  }

  /**
   * Clear all alerts.
   */
  clear() {
    this._alerts = [];
    this._lastAlertByType.clear();
  }
}
