# livereel control panel

A React control panel for the service in this repository. It connects to the WebSocket
control channel, shows what the host can encode, starts and stops sessions, charts telemetry
as it arrives, edits the burned-in overlay mid-recording, and drives OBS.

**Live demo:** https://charlie-hk.github.io/livereel-media-pipeline/

React 18, Vite 5, TypeScript in strict mode, Tailwind. No state library and no chart library:
the state is one connection and a bounded window of samples, and the chart is one series with
one threshold.

## Running it

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

Open it and either point it at a running service or press **Run the demo**.

To drive a real service, start it first and connect to its control port:

```bash
node src/cli.js serve
# then in the panel: ws://127.0.0.1:8787
```

If `control.token` is set in the service config, put the same token in the token field. A
browser cannot set an `Authorization` header on a WebSocket handshake, so it is sent as a
query parameter, which is the second path `#verifyClient` in `src/control/server.js` accepts.

## The demo

The panel ships with an in-process stand-in that speaks the same protocol: the same request
ids, the same reply and event frames, the same error codes. Nothing in the components knows
which one it is talking to.

That is the point of `src/protocol/transport.ts`. The demo is not a second screen full of
fixed values; it exercises the real client, the real correlation of replies to requests and
the real event routing. Its capability report is a copy of an actual probe on a GPU-less
Ubuntu host, which is why asking for `h264_nvenc` there falls back to `libx264` and reports
`Cannot load libcuda.so.1` as the reason.

## Tests

```bash
npm test
```

19 tests. The ones worth knowing about:

- replies are matched to requests by id, proved by answering two in-flight commands in
  reverse order
- a dropped connection rejects everything in flight instead of leaving buttons spinning
- a request that is never answered times out rather than hanging
- the stand-in falls back from hardware to software and reports the real reason
- telemetry streams only while a session is running, and stops when it is stopped
- the capabilities panel shows *why* an encoder was rejected, not just that it was

## Layout

```
src/protocol/    types, the client, and the transport interface
src/mock/        the stand-in service behind the demo
src/hooks/       one hook holding the connection and derived state
src/components/  panels, all presentational
```

## Building

```bash
npm run build                 # type check, then build into ../docs for GitHub Pages
VITE_BASE=/ npm run build     # for serving from a domain root instead
```

`npm run build` type checks first, so a build cannot succeed on code that does not compile.
