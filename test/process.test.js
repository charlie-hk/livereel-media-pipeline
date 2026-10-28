import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisedProcess, run } from '../src/platform/process.js';
import { isWindows } from '../src/platform/paths.js';

const sleeper = isWindows
  ? { command: 'cmd', args: ['/c', 'timeout', '/t', '30', '/nobreak'] }
  : { command: 'sleep', args: ['30'] };

test('run collects output and reports success', async () => {
  const result = await run(process.execPath, ['-e', 'console.log("out"); console.error("err")']);
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /out/);
  assert.match(result.stderr, /err/);
});

test('run reports a non-zero exit as failure without throwing', async () => {
  const result = await run(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
});

test('run reports a missing binary rather than throwing', async () => {
  const result = await run('definitely-not-a-real-binary-xyz', []);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('run enforces its timeout', async () => {
  const started = Date.now();
  const result = await run(sleeper.command, sleeper.args, { timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000, 'should not wait for the process to finish');
});

test('a supervised process starts, reports output, and stops', async () => {
  const proc = new SupervisedProcess({
    name: 'echo-test',
    command: process.execPath,
    args: ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
    restart: { enabled: false },
  });

  const lines = [];
  proc.on('stdout', (line) => lines.push(line));
  proc.start();

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(proc.running);
  assert.deepEqual(lines, ['ready']);

  await proc.stop();
  assert.equal(proc.running, false);
});

test('a process that ignores a graceful stop is escalated to a signal', async () => {
  // Traps SIGINT and SIGTERM and keeps running, which is the behaviour the ladder exists for.
  const proc = new SupervisedProcess({
    name: 'stubborn',
    command: process.execPath,
    args: [
      '-e',
      'process.on("SIGINT",()=>{}); process.on("SIGTERM",()=>{}); console.log("up"); setInterval(()=>{},1000)',
    ],
    restart: { enabled: false },
  });

  proc.start();
  await new Promise((resolve) => setTimeout(resolve, 400));

  const result = await proc.stop();
  assert.equal(result.stoppedBy, 'SIGKILL', 'a process ignoring both signals must be killed');
  assert.equal(proc.running, false);
});

test('an exiting process is restarted with backoff', async () => {
  const proc = new SupervisedProcess({
    name: 'flaky',
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    restart: { enabled: true, maxRetries: 2, baseDelayMs: 50, maxDelayMs: 100, resetAfterMs: 60_000 },
  });

  const attempts = [];
  proc.on('restart', (info) => attempts.push(info.attempt));

  const gaveUp = new Promise((resolve) => proc.once('giveup', resolve));
  proc.start();

  const outcome = await Promise.race([
    gaveUp,
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);

  assert.ok(outcome, 'should stop retrying rather than loop forever');
  assert.deepEqual(attempts, [1, 2], 'retries should be bounded by maxRetries');
  assert.equal(proc.state, 'giveup');
});

test('stop() prevents any further restart', async () => {
  const proc = new SupervisedProcess({
    name: 'no-restart-after-stop',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    restart: { enabled: true, maxRetries: 5, baseDelayMs: 50 },
  });

  let restarts = 0;
  proc.on('restart', () => (restarts += 1));

  proc.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await proc.stop();
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(restarts, 0);
  assert.equal(proc.running, false);
});

test('progress lines split on carriage returns as well as newlines', async () => {
  // FFmpeg writes progress with \r. Splitting on \n alone buffers an entire run into one
  // line and starves the telemetry loop.
  const proc = new SupervisedProcess({
    name: 'cr-output',
    command: process.execPath,
    args: ['-e', 'process.stdout.write("a\\rb\\rc\\n")'],
    restart: { enabled: false },
  });

  const lines = [];
  proc.on('stdout', (line) => lines.push(line));
  proc.start();
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.deepEqual(lines, ['a', 'b', 'c']);
});
