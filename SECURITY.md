# Security

## Reporting

If you find a vulnerability, please email security@3am.engineer rather than
opening a public issue. You should hear back within a few days.

## How credentials are handled

- **CLI / TUI**: uses the standard AWS SDK credential chain (`~/.aws`,
  environment, SSO). Nothing is sent anywhere except to AWS itself, and only
  read-only `Describe*` / `List*` / `Get*` calls are made.
- **Web UI**: pasted credentials are used for that one scan, held in memory
  for the duration of the request, and never persisted or logged. Rendered
  results (HTML/SVG only, no credentials) are cached in memory for 2 hours.

## Exposing the web UI

Every scan posts live AWS credentials in the request body, so an open listener
is a credential-harvesting endpoint. The server enforces this rather than
trusting you to remember it:

- It binds `127.0.0.1` by default.
- Binding anything else **refuses to start** without `ACCESS_CODE` set to at
  least 16 characters. `BLUEPRINT_ALLOW_INSECURE=1` overrides this for a port
  you know is unreachable from untrusted networks.
- `/api/*` rejects credential posts that arrive over plain HTTP from a
  non-loopback client. Terminate TLS in front and set `TRUST_PROXY` so the
  check and the rate limits see real client IPs.
- Diagram links are HMAC-signed. `/view/:id` without a valid `?t=` returns 404,
  so a leaked id alone exposes nothing. Set `VIEW_SECRET` to keep links working
  across restarts or across multiple instances.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ACCESS_CODE` | unset | Shared code required by `/api/*`. Mandatory for a non-loopback bind. |
| `VIEW_SECRET` | random per boot | HMAC key for diagram links. |
| `TRUST_PROXY` | unset | Passed to Express `trust proxy` (e.g. `1`, `loopback`). |
| `BLUEPRINT_ALLOW_INSECURE` | unset | Allow credentials over plain HTTP. |
| `SCAN_RATE_LIMIT` | `12` | Scans per IP per window. |
| `API_RATE_LIMIT` | `120` | Any `/api` request per IP per window. |
| `AUTH_FAIL_LIMIT` | `10` | Wrong access codes per IP per window. |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit window. |
| `SCAN_TIMEOUT_MS` | `300000` | Hard deadline for one scan. |

### Docker

```sh
docker run -p 8787:8787 \
  -e ACCESS_CODE="$(openssl rand -base64 24)" \
  -e VIEW_SECRET="$(openssl rand -hex 32)" \
  -e TRUST_PROXY=1 \
  3am-blueprint
```

The image runs as the unprivileged `node` user and exposes `/healthz`.

## Hardening in the browser

The credential page is served with a per-response nonce CSP: no
`unsafe-inline`, no `unsafe-eval`, `connect-src 'self'`, and
`frame-ancestors 'none'` so it cannot be framed for clickjacking. The rendered
diagram runs in a sandboxed iframe without `allow-same-origin`, and under
`connect-src 'none'` plus `img-src data:`, so even a hypothetical injection in
a resource name has no route off the page.

`scripts/smoke-browser.mjs` drives a real Chrome over CDP and fails on any CSP
violation or page error; CI runs it on every push.

## Hosting recommendations

For anything beyond personal use, prefer the cross-account role pattern over
pasted target-account keys: paste keys (or a profile) that can call
`sts:AssumeRole`, then pass `--role-arn` and `--external-id` (or the matching
fields in the web UI). The scan runs as that role; the pasted keys never need
read access to the diagrammed account.
