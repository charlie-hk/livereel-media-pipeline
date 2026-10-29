import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapabilitiesPanel } from './CapabilitiesPanel';
import { StatusPanel } from './StatusPanel';
import { TelemetryChart } from './TelemetryChart';
import type { CapabilityReport, ProgressSample, ServiceStatus } from '../protocol/types';

const REPORT: CapabilityReport = {
  probedAt: '2026-10-29T10:00:00.000Z',
  fingerprint: { platform: 'linux', ffmpegVersion: '6.1.1', gpus: [], nvidiaDriver: null },
  renderNodes: [],
  encoders: [
    {
      name: 'h264_nvenc',
      kind: 'hardware',
      vendor: 'nvidia',
      usable: false,
      reason: 'Cannot load libcuda.so.1',
    },
    { name: 'libx264', kind: 'software', vendor: null, usable: true, probeMs: 71 },
  ],
  hwaccels: ['vaapi'],
};

const STATUS: ServiceStatus = {
  uptimeMs: 125_000,
  platform: 'linux',
  sessions: 1,
  pipelines: 0,
  encoders: ['libx264'],
  gstEncoder: 'x264enc',
  obs: { enabled: true, connected: false },
  store: { driver: 'file', configured: 'mongo', degraded: true },
  control: { commands: 12, errors: 0, eventsSent: 340, telemetryDropped: 0 },
};

describe('CapabilitiesPanel', () => {
  it('shows why a hardware encoder was rejected, not just that it was', () => {
    render(<CapabilitiesPanel report={REPORT} />);

    expect(screen.getByText('h264_nvenc')).toBeInTheDocument();
    expect(screen.getByText('Cannot load libcuda.so.1')).toBeInTheDocument();
    expect(screen.getByText('software only')).toBeInTheDocument();
  });

  it('says it is not connected rather than rendering an empty table', () => {
    render(<CapabilitiesPanel report={null} />);
    expect(screen.getByText('Not connected.')).toBeInTheDocument();
  });
});

describe('StatusPanel', () => {
  it('shows a degraded store alongside what was configured', () => {
    render(<StatusPanel status={STATUS} />);

    expect(screen.getByText('store degraded')).toBeInTheDocument();
    expect(screen.getByText('mongo')).toBeInTheDocument();
    expect(screen.getByText('x264enc')).toBeInTheDocument();
  });
});

describe('TelemetryChart', () => {
  const sample = (speed: number): ProgressSample => ({
    sessionId: 's-1',
    frame: 100,
    fps: 30,
    bitrateKbps: 2400,
    outTimeMs: 1000,
    totalSizeBytes: 1024,
    droppedFrames: 0,
    dupFrames: 0,
    speed,
    encoder: 'libx264',
    ended: false,
  });

  it('waits for data instead of drawing a line through one point', () => {
    render(<TelemetryChart samples={[sample(1)]} />);
    expect(screen.getByText('waiting for telemetry')).toBeInTheDocument();
  });

  it('labels the current speed for a screen reader', () => {
    render(<TelemetryChart samples={[sample(1.02), sample(0.88)]} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/0.88 times real time/);
  });
});
