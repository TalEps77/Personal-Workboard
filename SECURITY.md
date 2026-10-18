# Security policy

## Supported versions

Only the current `main` branch is supported. Fixes are made on `main` and are not backported. Self-hosters who use the update pipeline in [docs/deploy.md](docs/deploy.md) receive them automatically.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability** (GitHub private vulnerability reporting).

Please include:

- what the problem is and which component it affects (for example pairing, scoping between people, the MCP endpoint, the deploy script);
- steps to reproduce, or a proof of concept, and the commit you tested;
- the impact as you see it (what an attacker gains, and what they need first);
- your deployment shape if it matters (reverse proxy, single or multiple people);
- whether you want to be credited.

Do not include real personal data, tokens or `.env` files in a report.

## What to expect

- Acknowledgement within 7 days.
- An initial assessment (accepted, needs more information, or not a vulnerability) within 14 days.
- For accepted reports, a fix on `main` as soon as it is ready, with a coordinated disclosure date agreed with you, usually within 90 days of the report.
- Credit in the release notes if you wish.

This is a volunteer-maintained project, so these are targets rather than guarantees.

## Scope

In scope: the server (`server/`), the web app (`public/`), the container and compose configuration, and the deploy scripts (`deploy/`). The threat model and known limits are described in [docs/security.md](docs/security.md); a report that only restates a documented limit (for example "data is stored as plain files") is not a vulnerability.

Out of scope: vulnerabilities in your reverse proxy, Docker, the host, or in a messaging agent you connect to Workboard.
