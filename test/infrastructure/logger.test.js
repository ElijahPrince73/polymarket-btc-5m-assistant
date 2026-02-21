import test from 'node:test';
import assert from 'node:assert/strict';

import { Logger, createLogger } from '../../src/infrastructure/logger.js';

test('Logger: creates with defaults', () => {
  const log = new Logger();
  assert.equal(log.name, 'app');
});

test('Logger: creates with custom name', () => {
  const log = new Logger({ name: 'TestService' });
  assert.equal(log.name, 'TestService');
});

test('Logger: child creates prefixed logger', () => {
  const parent = new Logger({ name: 'Parent' });
  const child = parent.child('Child');
  assert.equal(child.name, 'Parent.Child');
});

test('createLogger: convenience function', () => {
  const log = createLogger('MyModule');
  assert.equal(log.name, 'MyModule');
});

// Note: we don't test actual console output — just that methods don't throw
test('Logger: info/warn/error/debug do not throw', () => {
  const log = new Logger({ name: 'test', level: 'debug' });
  log.debug('debug message');
  log.info('info message');
  log.warn('warn message', { key: 'value' });
  log.error('error message', { err: 'test' });
});
