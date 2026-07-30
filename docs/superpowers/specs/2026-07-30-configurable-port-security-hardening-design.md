# Configurable Port and Security Hardening Design

## Goal

Make the router port easy to override for unattended launches, close confirmed
browser-to-local-service attack paths, harden the embedded console, and improve
Linux x64 CPU compatibility without changing existing configuration files or
normal SDK behavior.

## Scope

This change covers the standalone router in `apps/router` and its release
build. It does not redesign routing policy, add a general environment-variable
configuration system, change the Koishi plugin API, or add a container image.

## Startup Configuration

The existing `config.json` `listen.port` value remains supported. Two
non-persistent startup overrides are added:

- `AIHUB_AUTO_PORT=<port>`
- `--port <port>` and `--port=<port>`

The effective port precedence is:

1. `--port`
2. `AIHUB_AUTO_PORT`
3. `config.json` `listen.port`
4. default `8787`

An override must be a base-10 integer from 1 through 65535. Missing values,
unknown arguments, repeated `--port` arguments, whitespace, fractional values,
and out-of-range values fail startup before opening a listener. The error names
the invalid source and accepted range. `--help` prints the supported invocation
without loading credentials or starting the server.

The override changes only the in-memory effective configuration. It must not
rewrite `config.json`, so one-off launches and container settings do not create
unexpected persistent state.

## Browser Request Boundary

The router is a local credential-bearing service. A browser request guard runs
before UI, control, health, or proxy routing:

- When the configured listener is loopback, the request URL hostname must also
  be `127.0.0.1`, `[::1]`, or `localhost`. This rejects DNS rebinding requests
  whose `Host` resolves to loopback but names an attacker-controlled domain.
- If an `Origin` header is present, it must exactly equal the request URL
  origin. `Origin: null` and cross-origin values are rejected.
- `Sec-Fetch-Site: cross-site` is rejected even when an intermediary strips or
  rewrites `Origin`.
- Requests without browser provenance headers remain accepted. OpenAI SDKs,
  command-line clients, health checks, and reverse proxies therefore keep
  working.
- Non-loopback listeners retain the existing mandatory `proxyToken` and
  `uiPassword` checks. The browser guard is defense in depth and does not
  replace those credentials.

Rejected requests receive a small JSON response and are not forwarded
upstream. Host failures use HTTP 421 and browser-origin failures use HTTP 403.
No permissive CORS headers are added.

## Console Hardening

Each UI response gets a cryptographically random CSP nonce. The server applies
a response-header policy equivalent to:

```text
default-src 'none';
script-src 'nonce-<random>';
style-src 'nonce-<random>';
connect-src 'self';
base-uri 'none';
form-action 'none';
frame-ancestors 'none';
object-src 'none'
```

The nonce is inserted only into the static embedded `<style>` and `<script>`
elements. The response also sends `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
Control responses and errors use `Cache-Control: no-store`.

The console password is held only in the current page's JavaScript memory. It
is never written to `localStorage`, `sessionStorage`, or another
browser-persistent store. Reloading a protected console requires entering the
password again.

Existing dynamic HTML rendering remains escaped through the current `esc()`
helper. No new HTML injection sink or remote script is introduced. Replacing
the entire single-file console renderer is outside this focused change.

## Dependency Finding

An OSV scan of all 174 exact packages in `bun.lock` found one advisory:
`GHSA-5v7r-6r5c-r473` / `CVE-2026-31808` in `file-type@16.5.4`, a moderate
denial-of-service issue in malformed ASF parsing.

The affected package is present only through the Koishi development/test
dependency chain and is not imported into or bundled with the standalone
router. The patched `file-type` release is a breaking major upgrade and the
current Koishi dependency range does not accept it. This change records the
finding and its non-runtime exposure rather than forcing an unverified
transitive override. The implementation must re-run the exact-version OSV scan
and report any changed result.

## Linux Compatibility

The Linux x64 release target changes from `bun-linux-x64` to
`bun-linux-x64-baseline`, while retaining the artifact name
`aihub-auto-linux-x64.zip`. This removes the modern x86-64/AVX2 assumption for
older processors without creating two confusing x64 downloads.

Compatibility validation runs the compiled binary on the supplied x86_64
Docker host in these userlands:

- Debian 10 (`debian:buster-slim`)
- CentOS 7 (`centos:7`) when its registry image remains retrievable
- Alpine 3.18 (`alpine:3.18`) as an explicit negative or positive compatibility
  probe, depending on the Bun executable's libc requirements

Each probe runs `aihub-auto --help` and a short loopback startup/health-check
smoke test with a temporary configuration directory and a non-default port.
Docker shares the host kernel, so these checks establish old userland/libc
compatibility only. They do not claim compatibility with kernels older than
the Ubuntu 24.04 host's kernel. Any unsupported image is documented in the
security report and PR instead of being hidden with compatibility shims.

## Tests

Unit tests cover argument forms, precedence, help output, and every invalid
port class. Integration tests cover:

- loopback Host acceptance and attacker-domain rejection;
- same-origin browser, cross-origin browser, `Origin: null`, and no-Origin SDK
  requests;
- `Sec-Fetch-Site: cross-site`;
- prevention of control and `/v1` forwarding after rejection;
- CSP nonce agreement between header and HTML;
- `no-store`, `nosniff`, frame restriction, and referrer policy;
- absence of browser-persistent console password storage;
- unchanged `uiPassword`, `proxyToken`, health, and proxy behavior.

The full acceptance sequence is `bun test`, TypeScript checking, release build,
local smoke tests, and the remote Docker compatibility matrix.

## Deliverables

- Focused implementation and tests.
- Updated root and router documentation with port precedence and Linux
  compatibility notes.
- `security_best_practices_report.md` with evidence, severity, fixes, residual
  risk, and exact code locations.
- A reviewable branch pushed to GitHub and a pull request against
  `WSXYT/aihub-auto:main`.

