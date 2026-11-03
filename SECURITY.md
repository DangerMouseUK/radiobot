# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes |
| earlier | No |

Security fixes are released as patch versions of the latest minor release. Please upgrade to the newest 1.0.x before reporting, if you can.

## Reporting a vulnerability

**Please don't report security issues in public issues, discussions or pull requests.**

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (private vulnerability reporting / security advisories). Include:

- the affected version or commit;
- a description of the issue and its impact;
- steps to reproduce, or a proof of concept (please use your own test server and test bot);
- any suggested fix.

What to expect:

- **Acknowledgement:** the maintainers aim to acknowledge reports within 7 days. This is a volunteer project, so there is no formal service level.
- **Coordination:** we'll agree a fix and a disclosure date with you and credit you in the advisory, unless you'd rather not be credited.
- **Testing limits:** please don't test against other people's instances or real broadcasters' servers in ways that could cause harm. Never include real Discord tokens in reports.

Broadcasters and rights holders asking for a station or source to be removed can use the same private channel. See [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md#takedown-procedure).

## Scope

In scope: vulnerabilities in this repository's code, default configuration, Dockerfile and Compose file. That especially includes:

- **SSRF and network-policy bypasses.** Any way to make the bot, or FFmpeg, connect to a loopback, private, link-local, CGNAT, multicast, reserved or cloud-metadata address, or to an internal host name, through:
  - a custom station URL, PLS/M3U entries, HLS master or media playlists and segment URIs, or `EXT-X-MAP` URIs;
  - redirects, DNS rebinding, IPv6, IPv4-mapped, NAT64 or 6to4 forms, or unusual URL syntax.

  The policy is in `src/streams/url-policy.ts`, and enforcement is in `src/streams/safe-fetch.ts`.
- **FFmpeg argument or protocol injection.** Any way for user input to reach FFmpeg arguments, or to make FFmpeg open anything other than its stdin pipe.
- **Authorisation bypass.** Running admin or control actions without the required role, channel or voice-channel conditions, through slash commands, buttons, select menus or forms. This includes forged, replayed-across-servers or expired button, menu and form IDs, and import previews applied by someone who isn't an admin of that server, or after they expired or were replaced.
- **Secret leakage.** The Discord token, stream credentials or tokenised URLs appearing in logs, Discord replies, `/radio stats`, exports, backups produced by the bot, or the diagnostics endpoint.
- **Resource exhaustion.** Inputs that get around the documented bounds: playlist and segment size caps, probe budgets, the import file limit (a Discord attachment of at most 256 KB), concurrency limits, rate limits, the clean-up of finished FFmpeg processes. Examples are unbounded memory, zombie FFmpeg processes, or a crafted stream that hangs a session forever.
- **Container hardening regressions:** running as root, a writable root filesystem, or published ports in the default Compose file.

Out of scope:

- availability, content or behaviour of third-party radio streams and broadcaster websites;
- Discord platform issues, and the behaviour of `discord.js`, `@discordjs/voice` or FFmpeg that isn't caused by how Radio Bot uses them (please report those upstream; we do want to know if we need to pin or patch);
- attacks that need control of the host, the Docker daemon, the `.env` file or the operator's Discord application;
- the optional diagnostics endpoint being reachable by processes inside the same container, which is by design (it binds to `127.0.0.1`);
- rate limits being per-process and resetting on restart;
- `ALLOW_INSECURE_HTTP_STREAMS=true`, the default, which allows plain-HTTP stream URLs (custom stations, pack sources and redirects) by design. Set it to `false` to require HTTPS everywhere.

## Hardening notes for operators

- **Keep the token secret.** Keep `.env` mode `600`, never commit it, and reset the token in the Developer Portal if it leaks.
- **Use the shipped Compose file.** It publishes no ports, runs as the non-root `node` user with a read-only root filesystem and all capabilities dropped, and sets `no-new-privileges`.
- **Limit outgoing traffic with firewall rules (egress rules) as an extra layer of protection.** The bot needs outbound access to Discord (HTTPS, WebSocket and voice UDP) and to the stream hosts you use.
- **Custom stations are always admin-only** (server owner or Administrator permission). Set `MAX_CUSTOM_STATIONS_PER_GUILD=0` to switch them off entirely.
- **Keep the image up to date.** Releases pin dependency versions, including the DAVE and voice libraries.
