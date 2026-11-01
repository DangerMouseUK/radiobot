# Permissions, governance and abuse controls

Radio Bot asks Discord for as little access as it can. It then checks every action itself, on the server side, whatever Discord's client-side command visibility says. The code is in `src/discord/permissions/authorize.ts`, `src/discord/context.ts`, `src/discord/voice-access.ts` and `src/discord/components/custom-id.ts`.

## Discord access the bot needs

### Gateway intents

| Intent | Used for |
|---|---|
| `Guilds` | Servers, channels, roles, and interaction delivery context |
| `GuildVoiceStates` | Which voice channel a user or the bot is in, listener counts for the idle modes, moves and disconnects |

There are **no privileged intents**: no Message Content, no Server Members, no Presence. The bot does not read messages or chat history, and does not receive voice audio (it joins self-deafened). The member's roles come from the interaction payload itself, and voice channels from the voice-state cache. Any bot may set its own "Listening to" status (`PRESENCE_MODE`); that needs no intent or permission.

### OAuth2 scopes

`bot` and `applications.commands`.

### Bot permissions (integer `281474979908608`)

| Permission | Bit value | Why it is needed |
|---|---:|---|
| View Channels | 1024 | See the target voice channel, the panel channel and the notice channel |
| Send Messages | 2048 | **Only** for the optional control panel (`/radio panel`) and the optional notification channel. Slash-command replies don't need it |
| Embed Links | 16384 | Embeds in the control panel and notices |
| Attach Files | 32768 | `/radio export` returns a JSON file |
| Connect | 1048576 | Join the voice channel |
| Speak | 2097152 | Transmit audio |
| Set Voice Channel Status | 281474976710656 | **Optional.** Shows the station and the song or show title as the status of the bot's voice channel, cleared when playback stops or the bot leaves. Admins can switch it off in `/radio config` → Notifications. Without the permission the bot simply doesn't set a status |

1024 + 2048 + 16384 + 32768 + 1048576 + 2097152 + 281474976710656 = **281474979908608**.

Servers that invited the bot with the earlier integer `3197952` keep working; to get the channel status there, re-invite the bot with the current link or give its role **Set Voice Channel Status** in the voice channel.

Not required: Administrator, Manage Server, Manage Channels, Manage Roles, Manage Messages, Read Message History, Mention Everyone, Use Voice Activity, Priority Speaker, Move Members.

Each time it joins a channel, the bot checks View Channel, Connect and Speak on that **specific** channel, and checks that the channel is a standard voice channel (stage channels are refused) and joinable (not full). Before posting the panel it checks View Channel and Send Messages in the panel channel. Notices are skipped silently if Send Messages is missing.

### Command registration

There is one `/radio` command, registered as a **guild** command, limited to the guild context (not DMs) and the guild-install type. It is visible to every member: the admin subcommands are listed too, and they refuse anyone who isn't an admin. If you want to hide some subcommands from roles in the client, you can use Discord's **Server Settings → Integrations → Radio Bot** command permissions. This is cosmetic, and the bot's own checks still apply.

## Access levels

`accessLevel()` puts each user at one level per server:

| Level | Who |
|---|---|
| **admin** | The server owner, or anyone with Discord's **Administrator** permission (`isAdministrator` in `authorize.ts`). **Manage Server alone does not count**, and there is no configurable admin-role setting. To delegate bot administration, give the role Administrator. To delegate playback control only, use DJ roles. |
| **dj** | Anyone with a role configured as a *DJ role* |
| **member** | Everyone else |

Separately, the bot **operator** is either a Discord user listed in `OPERATOR_USER_IDS` or the application's owner (or team members). Operators are the only ones who can record identity verdicts for the sources of any station pack, because those verdicts affect every server on the installation. Being an operator does not make you a server admin.

## Capabilities

Each command and component needs one capability:

- **read**: browse, list (including `scope:favourites`), now, quality, sources, inspect, status, help, `queue list`, and the browse, list, refresh, sources and inspect buttons.
- **control**: play (including choosing a station in browse or from an ambiguity picker), stop, join, leave, skip, `queue add`, `queue remove` and `queue clear`, the next, previous and skip buttons, and the favourite button.
- **admin**: stats (including its Refresh button; its Close button only deletes the clicker's own private reply), add, edit, remove, rescan (including the re-probe button), sync, config (including every settings control), export, import (including Apply and Cancel), panel, and `source pin`, `prefer`, `auto` and `verify`.

### Capability matrix

| Capability | member | dj | admin |
|---|:---:|:---:|:---:|
| Browse, list, now-playing, quality, sources, inspect, status, help | Yes | Yes | Yes |
| Play or switch, stop, leave, join, next and previous, favourite, skip, queue add, remove and clear | Depends on the listener control mode (below) | Yes | Yes |
| Add, edit or remove a custom station | No | No | Yes |
| Rescan or compare sources, sync station packs, pin, prefer or auto source | No | No | Yes |
| Configure channels, DJ roles, idle mode, quality, autostart and notifications; post the panel | No | No | Yes |
| Import or export configuration; `/radio stats` (private live statistics) | No | No | Yes |
| Record an identity verdict (`source verify`) for a **custom** station of this server | No | No | Yes |
| Record an identity verdict for a source in a **station pack** | No | No | Operator only |

### Listener control mode

The *Who can play/stop* setting in `/radio config` → Playback decides what members (not DJs or admins) may do with **control** actions:

| Mode | Members can control playback… |
|---|---|
| `same_channel` (default) | …only while they are in a voice channel; only when the bot is idle or in **their** channel; and only to play in the channel they are in. |
| `none` | Never. Only DJs and admins. |
| `any` | Always, from an allowed command channel. |

### Channel restrictions

- **Command channels** (`/radio config` → Access): when the list is not empty, commands and component clicks from **members and DJs** are refused outside those channels, with an ephemeral message naming the allowed channels. The text chat inside an *approved voice channel* also counts as an allowed command channel. **Admins bypass the command-channel restriction**, so an admin can never lock themselves out.
- **Approved voice channels:** when the list is not empty, the bot only joins those channels. This applies to everyone, admins included, because it is enforced when connecting. If someone moves the bot into a channel that isn't approved, it leaves and posts a notice to the notification channel, if one is set.
- **Preferred voice channel and lock:** with *Lock to preferred channel* on, playback always goes to the preferred channel. An explicit `channel` option for any other channel is refused by both `/radio play` and `/radio join`; without one, they go to the preferred channel. If someone moves the bot away from the preferred channel, it leaves in the same way.

An empty list means "no restriction".

### Voice channel choice

For play and join, the target is chosen in this order: the locked preferred channel, then the explicit `channel` option, then the channel the bot is already in, then the requester's voice channel, then the preferred channel. The capability check runs against that target. The connection step then re-checks the allowlist and the bot's own permissions on that channel.

## Server-side checks for buttons and menus

The PRD requires that "a button posted in a public channel must not become an unrestricted bypass". Here is how that is met:

1. **Every component interaction is re-authorised** with the clicking user's current roles, channel and voice state, exactly as the matching slash command would be. A Stop button in a public panel still needs the *control* capability. A settings menu still needs *admin*.
2. **Signed component IDs.** Every custom ID has the form `rb1:<action>:<arg>:<expiry>:<signature>`. The signature is an HMAC-SHA256, truncated to 16 base64url characters, over the guild ID and the body. It uses a per-installation secret that is generated once and stored in the database (`app_meta.components.secret`). The check uses a constant-time comparison. A forged ID, or an ID copied from another server, fails the check with "This control is not valid here.". **The signature is not authorisation.** It only proves that this installation issued the ID for this server. Step 1 is still applied.
3. **Expiry.** Now-playing buttons, browse pages and ambiguity pickers expire after 15 minutes, settings pages and the `/radio stats` panel after 30 minutes, and import previews after 10 minutes. Expired controls answer "These controls have expired. Run the command again.". Control-panel buttons have no expiry so that the panel keeps working across restarts, and they are still re-authorised on every click.
4. **Server-held state.** Browse sessions and import previews are referenced by a random token that maps to server-side state. An import can only be applied by an admin of the same server before its preview expires, and only once.
5. **Superseding.** A new play or switch increments the session's generation counter, so an older request that is still pending cannot overwrite a newer one. Its reply says "Superseded".

## Rate limits

These are in-memory token buckets (`RateLimits` in `src/discord/context.ts`). Each holds the stated number of uses and refills continuously over the window. When one is exhausted, the reply says "Slow down — … is rate-limited. Try again in N s." (reason code `RATE_LIMITED`).

| Limit | Key | Allowance |
|---|---|---|
| Play or switch | per user | 6 per 30 s |
| Play or switch | per server | 12 per 30 s |
| Re-probe (`/radio rescan`, re-probe button) | per server | 3 per 10 min |
| Add custom station | per server | 5 per hour |
| Catalogue sync | per server | 2 per hour |
| Catalogue sync | whole installation | 1 per 10 min |
| Button and menu clicks | per user | 20 per 20 s |

Other installation-wide bounds:

- `MAX_ACTIVE_GUILD_STREAMS` (default 3): servers streaming at once. Exceeding it is refused with `STREAM_LIMIT`;
- `MAX_CONCURRENT_PROBES` (default 2), plus a limit of one probe per stream host at a time;
- `MAX_CUSTOM_STATIONS_PER_GUILD` (default 25). Exceeding it is refused with `CUSTOM_STATION_LIMIT`.

The scheduled catalogue sync runs at most once per `CATALOG_SYNC_INTERVAL_HOURS` (at least 6 h) for each pack that declares an official list.

## Custom station safety (SSRF)

Only admins can add custom stations, and the URL check applies to admins too. Every URL, redirect and reconnect is checked:

- the scheme is `http(s)` only, and plain HTTP can be refused with `ALLOW_INSECURE_HTTP_STREAMS=false`;
- credentials in the URL are rejected;
- internal service ports and privileged ports other than 80 and 443 are rejected;
- internal host names and suffixes are rejected;
- private, loopback, link-local, CGNAT, multicast, documentation and reserved IPv4 and IPv6 ranges are rejected, including IPv4-mapped, NAT64 and 6to4 forms.

DNS is resolved by the bot, and the hop is rejected if any answer is blocked. The socket is pinned to the checked address. FFmpeg is never given a URL. See [architecture.md](architecture.md#the-source-validation-boundary) and [SECURITY.md](../SECURITY.md).

## What is logged about users

Logs contain guild IDs, and the user ID of whoever records an identity override. Playback intents store the last requester's user ID, queue entries store the user ID of whoever queued them, and source preferences and custom stations store the admin who set or added them. Logs contain no message content. See [rights-and-disclaimer.md](rights-and-disclaimer.md#privacy-policy-for-a-self-hosted-instance).
