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
- The server binds to `127.0.0.1` by default. If you expose it with
  `--host 0.0.0.0`, put TLS in front and set `ACCESS_CODE` to gate scans.

## Hosting recommendations

For anything beyond personal use, prefer the cross-account role pattern over
pasted keys: each user creates a read-only IAM role that trusts your service's
account with an external id, and the server calls `sts:AssumeRole` per scan.
