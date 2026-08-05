# Security Policy

Report security issues to the maintainers privately. Do not open public issues for vulnerabilities.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Practices

- API tokens must never be logged
- Join tokens are short-lived
- Webhook payloads are signed when secret configured
- Treat agent-supplied brief content as untrusted
