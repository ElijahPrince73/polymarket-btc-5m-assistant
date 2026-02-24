import { execSync } from 'node:child_process';
try {
  const out = execSync('node --test test/domain/entryGate.test.js test/analyticsService.test.js 2>&1', { encoding: 'utf-8', timeout: 30000 });
  console.log(out);
} catch (e) {
  console.log('STDOUT:', e.stdout);
  console.log('STDERR:', e.stderr);
  console.log('EXIT CODE:', e.status);
}
