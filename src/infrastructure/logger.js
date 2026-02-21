/**
 * @file JSON structured logging utility.
 *
 * Provides a simple structured logger that outputs JSON lines.
 * Each log entry includes a timestamp, level, message, and optional data.
 */

/**
 * @typedef {'debug'|'info'|'warn'|'error'} LogLevel
 */

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.name]     - Logger name (e.g. 'LiveExecutor')
   * @param {LogLevel} [opts.level]  - Minimum log level (default 'info')
   */
  constructor(opts = {}) {
    this.name = opts.name ?? 'app';
    this.minLevel = LEVEL_ORDER[opts.level ?? 'info'] ?? 1;
  }

  /**
   * @param {LogLevel} level
   * @param {string} message
   * @param {Object} [data]
   */
  _log(level, message, data) {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const entry = {
      ts: new Date().toISOString(),
      level,
      logger: this.name,
      msg: message,
      ...(data ? { data } : {}),
    };

    const line = JSON.stringify(entry);

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(msg, data) { this._log('debug', msg, data); }
  info(msg, data) { this._log('info', msg, data); }
  warn(msg, data) { this._log('warn', msg, data); }
  error(msg, data) { this._log('error', msg, data); }

  /**
   * Create a child logger with a prefixed name.
   * @param {string} childName
   * @returns {Logger}
   */
  child(childName) {
    return new Logger({
      name: `${this.name}.${childName}`,
      level: Object.entries(LEVEL_ORDER).find(([, v]) => v === this.minLevel)?.[0] ?? 'info',
    });
  }
}

/**
 * Convenience: create a named logger.
 * @param {string} name
 * @param {LogLevel} [level]
 * @returns {Logger}
 */
export function createLogger(name, level) {
  return new Logger({ name, level });
}
