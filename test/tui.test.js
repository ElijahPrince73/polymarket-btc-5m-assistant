import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtTimeLeft, getBtcSession, stripAnsi, narrativeFromSign,
  narrativeFromRsi, narrativeFromSlope, formatProbPct, formatSignedDelta
} from '../src/ui/tui.js';

test('fmtTimeLeft formats minutes and seconds', () => {
  assert.equal(fmtTimeLeft(3.5), '3m 30s');
  assert.equal(fmtTimeLeft(0), '0m 0s');
  assert.equal(fmtTimeLeft(1), '1m 0s');
});

test('fmtTimeLeft returns dash for null/undefined/NaN', () => {
  assert.equal(fmtTimeLeft(null), '-');
  assert.equal(fmtTimeLeft(undefined), '-');
  assert.equal(fmtTimeLeft(NaN), '-');
});

test('fmtTimeLeft clamps negative to zero', () => {
  assert.equal(fmtTimeLeft(-5), '0m 0s');
});

test('getBtcSession returns correct session for known UTC hours', () => {
  // 3 UTC = Asia session
  const asia = new Date('2025-01-15T03:00:00Z');
  assert.equal(getBtcSession(asia), 'Asia');

  // 10 UTC = Asia/Europe overlap
  const asiaEu = new Date('2025-01-15T07:30:00Z');
  assert.equal(getBtcSession(asiaEu), 'Asia/Europe overlap');

  // 15 UTC = Europe/US overlap
  const euUs = new Date('2025-01-15T15:00:00Z');
  assert.equal(getBtcSession(euUs), 'Europe/US overlap');

  // 20 UTC = US session
  const us = new Date('2025-01-15T20:00:00Z');
  assert.equal(getBtcSession(us), 'US');

  // 23 UTC = Off-hours
  const off = new Date('2025-01-15T23:00:00Z');
  assert.equal(getBtcSession(off), 'Off-hours');
});

test('stripAnsi removes ANSI escape codes', () => {
  assert.equal(stripAnsi('\x1b[31mred text\x1b[0m'), 'red text');
  assert.equal(stripAnsi('plain text'), 'plain text');
  assert.equal(stripAnsi('\x1b[32m\x1b[1mbold green\x1b[0m'), 'bold green');
});

test('narrativeFromSign returns correct narratives', () => {
  assert.equal(narrativeFromSign(5), 'LONG');
  assert.equal(narrativeFromSign(-3), 'SHORT');
  assert.equal(narrativeFromSign(0), 'NEUTRAL');
  assert.equal(narrativeFromSign(null), 'NEUTRAL');
  assert.equal(narrativeFromSign(undefined), 'NEUTRAL');
});

test('narrativeFromRsi returns correct narratives', () => {
  assert.equal(narrativeFromRsi(60), 'LONG');
  assert.equal(narrativeFromRsi(40), 'SHORT');
  assert.equal(narrativeFromRsi(50), 'NEUTRAL');
  assert.equal(narrativeFromRsi(null), 'NEUTRAL');
});

test('narrativeFromSlope returns correct narratives', () => {
  assert.equal(narrativeFromSlope(0.5), 'LONG');
  assert.equal(narrativeFromSlope(-0.3), 'SHORT');
  assert.equal(narrativeFromSlope(0), 'NEUTRAL');
  assert.equal(narrativeFromSlope(null), 'NEUTRAL');
});

test('formatProbPct formats probability as percentage', () => {
  assert.equal(formatProbPct(0.55), '55%');
  assert.equal(formatProbPct(0.123, 1), '12.3%');
  assert.equal(formatProbPct(null), '-');
  assert.equal(formatProbPct(undefined), '-');
});

test('formatSignedDelta formats delta with sign and percentage', () => {
  const result = stripAnsi(formatSignedDelta(5, 100));
  assert.ok(result.includes('+'));
  assert.ok(result.includes('5.00'));

  const negResult = stripAnsi(formatSignedDelta(-3, 100));
  assert.ok(negResult.includes('-'));
  assert.ok(negResult.includes('3.00'));

  // null/zero base returns dash
  const nullResult = stripAnsi(formatSignedDelta(null, null));
  assert.equal(nullResult, '-');
});
