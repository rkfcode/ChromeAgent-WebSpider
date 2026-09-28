# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Use GitHub's [private vulnerability reporting](https://github.com/rezakazemifathi/webspider/security/advisories/new)
on this repository, or contact the maintainer directly through
[github.com/rezakazemifathi](https://github.com/rezakazemifathi).

Please include:

- a description of the issue and its impact,
- steps to reproduce,
- the affected version, and
- any suggested fix.

You can expect an acknowledgement, and credit in the release notes once a fix ships —
unless you would rather stay anonymous.

## Scope

In scope:

- privilege escalation between the extension's isolated world and the page,
- injection through the MAIN-world bridge (`main.js`),
- prototype pollution through the tool dispatch map,
- leaking the user's API key or conversation data,
- anything that lets a web page control the agent without the user asking.

Out of scope:

- the model returning a wrong or unhelpful answer,
- **CAPTCHA handling**. WebSpider detects a challenge, pauses and resumes automatically
  after the user solves it. It never solves or bypasses one — that is intentional, and a
  report asking it to bypass a challenge is not a vulnerability.

## Data handling

- The API key is stored in `chrome.storage.local` on the user's machine and is sent only
  to the endpoint the user configured.
- Page content is read locally. The only outbound bytes are the model request itself.
- There is no telemetry, no analytics and no auto-update ping.
