#!/usr/bin/env node
/**
 * Command-line entry point.
 *
 *   livereel serve      run the service
 *   livereel probe      report what this host can encode, and why not for the rest
 *   livereel selftest   run a short pipeline end to end and say what it proved
 */

import { loadConfig } from './config.js';
import { probeCapabilities, selectEncoder } from './media/capabilities.js';
import { selectGstEncoder } from './media/gstreamer.js';
import { FfmpegSession } from './media/ffmpeg.js';
import { setLevel, logger } from './log.js';
import { baseDirs, ensureDir } from './platform/paths.js';
import path from 'node:path';
import fs from 'node:fs';

const log = logger('cli');

const [, , command = 'serve', ...rest] = process.argv;
const flags = parseFlags(rest);

try {
  switch (command) {
    case 'serve':
      await serve();
      break;
    case 'probe':
      await probe();
      break;
    case 'selftest':
      await selftest();
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      console.error(`unknown command: ${command}\n`);
      usage();
      process.exit(2);
  }
} catch (err) {
  log.error('fatal', { error: err.message });
  if (process.env.LIVEREEL_LOG_LEVEL === 'debug') console.error(err.stack);
  process.exit(1);
}

async function serve() {
  // Imported here rather than at the top so `probe` and `selftest` stay usable before
  // `npm install` has run. Diagnosing a host is exactly what you want to do first on a
  // machine where the install is what failed.
  const { LivereelService } = await import('./service.js');

  const config = loadConfig(flags.config);
  setLevel(config.logLevel);

  log.info('starting livereel', {
    version: readVersion(),
    node: process.version,
    platform: process.platform,
    config: config.configFile ?? '(defaults)',
  });

  const service = await new LivereelService(config).start();

  // systemd sends SIGTERM on `systemctl stop` and on a unit restart. Handling it is what
  // turns "the service was killed" into "the service finished its recordings and exited",
  // and it is the half most ports forget, because on Windows the equivalent was never wired.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      log.warn('second signal, exiting immediately', { signal });
      process.exit(130);
    }
    shuttingDown = true;
    log.info('signal received', { signal });
    try {
      await service.stop();
      process.exit(0);
    } catch (err) {
      log.error('shutdown failed', { error: err.message });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: String(reason) });
  });
}

async function probe() {
  const config = loadConfig(flags.config);
  const report = await probeCapabilities({
    ffmpegPath: config.ffmpegPath,
    useCache: flags['no-cache'] ? false : config.encoder.probeCache,
  });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\nhost      ${report.fingerprint.platform}`);
  console.log(`ffmpeg    ${report.fingerprint.ffmpegVersion}`);
  if (report.fingerprint.gpus.length) {
    console.log(`gpu       ${report.fingerprint.gpus.join('; ')}`);
  } else {
    console.log('gpu       none reported by nvidia-smi');
  }
  if (report.renderNodes.length) console.log(`render    ${report.renderNodes.join(', ')}`);

  console.log('\nH.264 encoders');
  for (const encoder of report.encoders) {
    const mark = encoder.usable ? 'usable  ' : 'no      ';
    const detail = encoder.usable
      ? `${encoder.kind}${encoder.probeMs ? `, probed in ${encoder.probeMs}ms` : ''}`
      : encoder.reason;
    console.log(`  ${mark}${encoder.name.padEnd(14)}${detail}`);
  }

  const gst = await selectGstEncoder({ inspectPath: config.gstInspectPath });
  console.log(`\ngstreamer ${gst ? `${gst.element} (${gst.kind})` : 'not available'}`);

  const chosen = selectEncoder(report, config.encoder.prefer);
  console.log(`\nwould use ${chosen.name}${chosen.fellBack ? `  (fell back from ${chosen.requested})` : ''}\n`);
}

/**
 * Run a real pipeline for a few seconds and report what was proved.
 *
 * This exists so a claim about the host can be checked on the host, rather than inferred
 * from a config file or from what the encoder list advertises.
 */
async function selftest() {
  const config = loadConfig(flags.config);
  const seconds = Number(flags.seconds ?? 5);
  const outputDir = ensureDir(path.join(baseDirs().cache, 'selftest'));
  const outputFile = path.join(outputDir, `selftest-${Date.now()}.mp4`);

  const report = await probeCapabilities({ ffmpegPath: config.ffmpegPath, useCache: false });
  const encoder = selectEncoder(report, config.encoder.prefer);

  console.log(`encoder   ${encoder.name}${encoder.fellBack ? ` (fell back from ${encoder.requested})` : ''}`);

  const session = new FfmpegSession({
    id: 'selftest',
    source: { type: 'test', width: 1280, height: 720, fps: 30 },
    outputs: [{ type: 'file', path: outputFile, audio: false }],
    encoder,
    video: { width: 1280, height: 720, fps: 30, bitrate: '2M' },
    overlay: { ...config.overlay, directory: outputDir },
    ffmpegPath: config.ffmpegPath,
    restart: { enabled: false },
  });

  let samples = 0;
  let lastSpeed = null;
  session.on('progress', (sample) => {
    samples += 1;
    lastSpeed = sample.speed;
  });

  session.start();

  let overlayWrites = 0;
  const overlayTimer = setInterval(() => {
    if (session.setOverlayText(`selftest ${new Date().toISOString()}`)) overlayWrites += 1;
  }, 500);

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  clearInterval(overlayTimer);

  const stop = await session.stop();
  const size = fs.existsSync(outputFile) ? fs.statSync(outputFile).size : 0;

  console.log(`progress  ${samples} samples, last speed ${lastSpeed ?? 'n/a'}x`);
  console.log(`overlay   ${overlayWrites} updates applied while encoding`);
  console.log(`stop      ${stop.stoppedBy}`);
  console.log(`output    ${outputFile} (${(size / 1024 / 1024).toFixed(2)} MiB)`);

  const ok = samples > 0 && size > 0 && stop.stoppedBy !== 'SIGKILL';
  console.log(`\n${ok ? 'PASS' : 'FAIL'}\n`);
  process.exit(ok ? 0 : 1);
}

function usage() {
  console.log(`
livereel ${readVersion()}

  livereel serve [--config <file>]
  livereel probe [--json] [--no-cache]
  livereel selftest [--seconds <n>]

Environment:
  LIVEREEL_CONFIG          path to the config file
  LIVEREEL_CONTROL_TOKEN   shared secret for the control port
  LIVEREEL_MONGO_URI       MongoDB connection string
  LIVEREEL_LOG_LEVEL       debug | info | warn | error
`);
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function readVersion() {
  try {
    const file = new URL('../package.json', import.meta.url);
    return JSON.parse(fs.readFileSync(file, 'utf8')).version;
  } catch {
    return 'unknown';
  }
}
