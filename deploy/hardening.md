# Hardening notes

What the systemd unit restricts, what it deliberately does not, and the firewall rules that
go with it. Each relaxation below is there because a media pipeline genuinely needs it, not
because it was easier to leave open.

## Where the unit stops short, and why

| Directive | Setting | Reason |
|---|---|---|
| `PrivateDevices` | `false` | v4l2 capture needs `/dev/video*` and VAAPI needs `/dev/dri/renderD*`. A host that only transcodes files or pulls from the network should set it `true` and drop the `DeviceAllow` lines with it. |
| `MemoryDenyWriteExecute` | `false` | Some hardware encoder stacks allocate executable pages. NVENC's driver shim is the one that trips it in practice; with it `true`, the encoder fails at init with an error that does not mention systemd at all. |
| `ProtectSystem` | `strict` + `ReadWritePaths` | The whole filesystem is read-only except the state and log directories. Recordings go under `/var/lib/livereel`, so nothing else needs to be writable. |
| `KillMode` | `mixed` | The service signals its own children so FFmpeg can finish writing. `control-group`, the default, would signal everything at once and truncate the output. |

`SystemCallFilter=@system-service` with `~@privileged @resources` is the useful middle ground:
it leaves the syscalls an encoder makes and removes the ones a compromised service would want.
Check what a tightening actually costs before keeping it:

```bash
systemd-analyze security livereel.service
```

## Firewall

The control port is loopback-only by default, in which case it needs no rule at all. Expose it
only with a token set, and only to the hosts that need it.

```bash
# Default deny inbound, allow outbound (RTMP/SRT egress keeps working).
ufw default deny incoming
ufw default allow outgoing

# SSH first, or the next command locks you out.
ufw limit 22/tcp comment 'ssh, rate limited'

# Control port, only from the operator subnet. The service refuses to bind off-loopback
# without control.token set, so this rule and that token go together.
ufw allow from 10.0.0.0/24 to any port 8787 proto tcp comment 'livereel control'

# Only if this host also receives a stream.
# ufw allow 1935/tcp comment 'rtmp ingest'
# ufw allow 9000/udp comment 'srt ingest'

ufw enable
ufw status verbose
```

MongoDB on the same host needs no rule: `mongodb://127.0.0.1:27017` never leaves loopback. If
it is remote, restrict it at the database host rather than opening 27017 here.

## Operational checks

```bash
# What this host can actually encode, as the service user rather than as root.
sudo -u livereel node /opt/livereel/src/cli.js probe

# A real pipeline, end to end, reporting what it proved.
sudo -u livereel node /opt/livereel/src/cli.js selftest --seconds 5

# Logs, parsed.
journalctl -u livereel -f -o cat | jq -c '{ts, level, scope, msg}'

# Did a session fall back off hardware encoding, and why?
journalctl -u livereel -o cat | jq -c 'select(.msg | test("falling back"))'
```

## The permission failures that look like something else

A capture device the service user cannot open reports as an unsupported encoder or a missing
device, never as a permission problem. Two checks separate them:

```bash
# Is the service user in the groups that own the devices?
id livereel            # expect: video, render

# Can it open them at all?
sudo -u livereel ffmpeg -f v4l2 -i /dev/video0 -frames:v 1 -f null - 2>&1 | tail -5
```

If the second works and the service still cannot capture, the restriction is coming from the
unit: comment out `DeviceAllow`/`PrivateDevices` and retry to confirm before changing anything
else.
