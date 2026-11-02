# Permissions, governance and abuse controls

## In short

- **The bot asks Discord for very little.** It can see channels, post messages, attach a file, join a voice channel and speak. It cannot read your messages and never hears anyone's voice.
- **There are three kinds of people:**
  - **Admins** are the server owner and anyone with Discord's **Administrator** permission. Nobody else. Manage Server does not count.
  - **DJs** have a role that an admin has made a *DJ role*. They can always control playback.
  - **Listeners** are everyone else. By default they can control the radio only from inside a voice channel, and only the one the bot is in (or any channel while the bot is idle).
- **Everyone can look.** Browsing stations, seeing what is playing and checking audio quality are open to all, in any channel where radio commands are allowed.
- **Only admins change settings,** add custom stations, import or export settings and see `/radio stats`.
- **Buttons are checked every time they are clicked,** exactly like the command they belong to. A Stop button in a public channel still needs the right to control the radio.
- **Admins can limit where the bot works:** which text channels accept radio commands, and which voice channels it may join.
- **There are rate limits,** so nobody can flood the bot with station changes or stream checks.

The rest of this page gives the exact rules. The code is in `src/discord/permissions/authorize.ts`, `src/discord/context.ts`, `src/discord/voice-access.ts` and `src/discord/components/custom-id.ts`.

## Discord access the bot needs

### Gateway intents

An *intent* is a category of events Discord sends to a bot. Radio Bot uses two:

| Intent | Used for |
|---|---|
| `Guilds` | Servers, channels, roles, and the context of each command or click |
| `GuildVoiceStates` | Which voice channel a user or the bot is in: listener counts for the idle modes, and noticing when the bot is moved or disconnected |

There are **no privileged intents**: no Message Content, no Server Members, no Presence. The bot does not read messages or chat history. It joins voice channels self-deafened, so it never receives anyone's voice. A member's roles come with each command or click, and voice channels come from Discord's voice-state updates. The bot's own "Listening to" status (`PRESENCE_MODE`) needs no intent or permission.

### OAuth2 scopes

The invite link asks for two *scopes*: `bot`, which adds the bot to the server, and `applications.commands`, which adds its `/radio` command.

### Bot permissions (integer `281474979908608`)

| Permission | Bit value | Why it is needed |
|---|---:|---|
| View Channels | 1024 | See the target voice channel, the panel channel and the notice channel |
| Send Messages | 2048 | **Only** for the optional control panel (`/radio panel`) and the optional notice channel. Replies to slash commands don't need it |
| Embed Links | 16384 | Embeds in the control panel and notices |
| Attach Files | 32768 | `/radio export` replies with a JSON file |
| Connect | 1048576 | Join the voice channel |
| Speak | 2097152 | Play audio |
| Set Voice Channel Status | 281474976710656 | **Optional.** Shows the station and the song or show title as the status of the bot's voice channel. The status is cleared when playback stops or the bot leaves. Admins can switch it off in `/radio config` → Notifications. Without the permission the bot simply doesn't set a status |

1024 + 2048 + 16384 + 32768 + 1048576 + 2097152 + 281474976710656 = **281474979908608**.

Servers that invited the bot with the earlier integer `3197952` keep working. To get the voice channel status there, invite the bot again with the current link, or give its role **Set Voice Channel Status** in the voice channel.

Not needed: Administrator, Manage Server, Manage Channels, Manage Roles, Manage Messages, Read Message History, Mention Everyone, Use Voice Activity, Priority Speaker, Move Members.

Each time it joins a channel, the bot checks that it has View Channel, Connect and Speak in that **particular** channel, so a channel's own permission settings count. It also checks that the channel is a standard voice channel (stage channels are refused) and that it isn't full. Before posting the control panel it checks View Channel and Send Messages in the panel channel. If Send Messages is missing in the notice channel, notices are quietly skipped.

### Command registration

There is one command, `/radio`, registered separately in each server. It works only in servers, not in direct messages. Every member sees the whole command, including the admin subcommands, which refuse anyone who isn't an admin. To hide some subcommands from some roles, use Discord's **Server Settings → Integrations → Radio Bot**. That only changes what people see; the bot's own checks still apply.

## Access levels

Each person has one level in each server (worked out by `accessLevel()`):

| Level | Who |
|---|---|
| **admin** | The server owner, or anyone with Discord's **Administrator** permission. **Manage Server alone does not count**, and there is no admin-role setting. To let someone run the bot, give their role Administrator. To let them control playback only, make it a DJ role. |
| **dj** | Anyone with a role that an admin has set as a *DJ role* in `/radio config` → Access |
| **member** | Everyone else (called *listeners* on this page) |

Separately, the bot **operator** is the person running the bot: a Discord user listed in `OPERATOR_USER_IDS`, or the owner of the bot's Discord application (or a member of its team). Only operators can record identity verdicts (whether a source really carries its station) for the sources of station packs, because those verdicts affect every server the bot is in. They must also be an admin of the server where they run the command. Being an operator does not make you an admin of a server.

## Capabilities

Each command, button and menu needs one of three kinds of access (*capabilities*): **read** to look, **control** to change what is playing, and **admin** for settings, custom stations and the other admin tools.

- **read**: `/radio browse`, `list` (including `scope:favourites`), `now`, `quality`, `sources`, `inspect`, `status`, `help` and `queue list`. Also the buttons that browse, page through lists, refresh the now-playing card and open Sources or Inspect, including the Favourites filter in a browse list.
- **control**: `/radio play`, `stop`, `join`, `leave`, `skip`, `queue add`, `queue remove` and `queue clear`. Also choosing a station from a browse list or a "which station did you mean?" menu, the Previous station, Next station, Stop, Leave and Skip buttons, and the **Favourite** and **Unfavourite** buttons. The source menu under `/radio sources` needs *control* too: it switches the source of the station that is playing, until the station changes. When an admin has pinned the station to one source, only admins can use that menu.
- **admin**: `/radio stats` (and its Refresh button), `add`, `edit`, `remove`, `rescan` (and the **Check sources again** button), `sync`, `config` (and every settings control), `export`, `import` (and its Apply and Cancel buttons), `panel`, and `source pin`, `prefer`, `auto` and `verify`. Also the **Use this source first** and **Choose automatically** buttons under `/radio sources`. The Close button of `/radio stats` needs only *read*: it deletes the clicker's own private reply.

### Capability matrix

| Action | Listener | DJ | Admin |
|---|:---:|:---:|:---:|
| Browse, list, now playing, quality, sources, inspect, status, help, queue list | Yes | Yes | Yes |
| Play or switch, stop, join, leave, next and previous, favourite and unfavourite, skip, queue add, remove and clear, choose another source | Depends on the listener control mode (below) | Yes | Yes |
| Add, edit or remove a custom station | No | No | Yes |
| Check or compare sources again, sync station packs, pin, prefer or auto source | No | No | Yes |
| Change channels, DJ roles, idle mode, quality, autostart, notices and the voice channel status; post the panel | No | No | Yes |
| Import or export settings; `/radio stats` (private live statistics) | No | No | Yes |
| Record an identity verdict (`source verify`) for a **custom** station of this server | No | No | Yes |
| Record an identity verdict for a source in a **station pack** | No | No | Operator only |

### Listener control mode

The **Who else can control the radio** menu in `/radio config` → Playback decides what listeners (not DJs or admins) may do with *control* actions:

| Mode | Shown as | Listeners can control playback… |
|---|---|---|
| `same_channel` (default) | Listeners in the bot's voice channel, plus DJs and admins | …only while they are in a voice channel, only when the bot is idle or in **their** channel, and only to play in the channel they are in. |
| `none` | Only DJs and admins | Never. |
| `any` | Anyone who can use radio commands | Always, from an allowed command channel, and in any voice channel the bot may use. |

### Channel restrictions

All three settings are in `/radio config`. An empty list means "no restriction".

- **Command channels** (Access): when the list isn't empty, commands and clicks from **listeners and DJs** are refused outside those channels, with a private message naming the allowed channels. The text chat inside an *approved voice channel* also counts as an allowed command channel. **Admins are never restricted by this list**, so an admin can't lock themselves out.
- **Approved voice channels** (Access): when the list isn't empty, the bot joins only those channels. This applies to everyone, admins included, because it is checked when the bot connects. If someone moves the bot into a channel that isn't approved, it leaves and posts a notice in the notice channel, if one is set.
- **Preferred voice channel and lock** (Playback): with **Lock to preferred channel** on, playback always goes to the preferred channel. `/radio play` and `/radio join` refuse a `channel` option that names any other channel, and without one they go to the preferred channel. If someone moves the bot away from the preferred channel, it leaves in the same way.

### Voice channel choice

For play and join, the bot picks the voice channel in this order:

1. the preferred channel, when the lock is on;
2. the channel named in the `channel` option;
3. the channel the bot is already in;
4. the channel the person asking is in;
5. the preferred channel.

The capability check runs against that channel. So DJs and admins can name any channel. Listeners can name any channel only in the `any` mode, and only the one they are in with `same_channel`. When the bot connects, it checks the approved voice channels and its own permissions on that channel again.

## Server-side checks for buttons and menus

A button posted in a public channel must not let anyone get round the rules above. This is how the bot makes sure:

1. **Every click is authorised again,** using the clicking user's current roles, channel and voice channel, exactly as the matching slash command would be. A Stop button in a public panel still needs *control*. A settings menu still needs *admin*.
2. **Signed button IDs.** Every button and menu carries a hidden ID of the form `rb2:<action>:<argument>:<expiry>:<signature>`.
   - The signature is an HMAC-SHA256 (a keyed checksum), cut to 16 characters. It covers the server ID and the rest of the ID, and uses a secret that each installation generates once and stores in its database. It is checked in constant time, so the time a check takes gives nothing away.
   - A forged ID, or an ID copied from another server, fails the check with "This button or menu is not valid here.".
   - **The signature is not permission.** It only proves that this installation made the ID for this server. Step 1 still applies.
   - Every ID fits Discord's 100-character limit by design: the action name is at most 7 characters (all are listed in `COMPONENT_ACTIONS`), the argument at most 65 (the longest possible station ID) and the expiry 5. Making an ID with anything longer is refused.
   - IDs in the older `rb1` format (Radio Bot 1.0.5 and earlier) are still checked, then treated as expired. The control panel is redrawn when the bot starts, so its own buttons are replaced automatically.
3. **Expiry.** The expiry is stored in whole minutes, rounded up.
   - Now-playing buttons, sources views and "which station?" menus expire after 15 minutes.
   - A browse list stays open for 15 minutes after it was last used.
   - Settings pages and the `/radio stats` panel expire after 30 minutes.
   - Import previews expire after 10 minutes.
   - Expired controls answer "These buttons have expired. Run the command again." (an expired browse list says to run `/radio browse` again).
   - Control-panel buttons never expire, so the panel keeps working across restarts. They are still authorised on every click.
4. **State kept by the bot.** Browse lists and import previews are referred to by a random token. The list or preview itself stays inside the bot. An import can be applied only by an admin of the same server, only before its preview expires, and only once. Each server has at most one import preview: a new `/radio import` replaces the previous one, whose buttons then say it has expired.
5. **Newer requests win.** Each play or switch request gets a number. An older request that is still running can't overwrite a newer one; its reply says "Request replaced: A newer station request took over from this one."

## Rate limits

These limits are kept in memory (`RateLimits` in `src/discord/context.ts`), so restarting the bot resets them. Each one lets you use the whole allowance at once; it then refills gradually over the stated time. When a limit runs out, the reply says "Too many … in a short time. Try again in N s." (reason code `RATE_LIMITED`).

| Limit | Counted per | Allowance |
|---|---|---|
| Station changes: `/radio play`, `/radio join`, Next, Previous, Skip, choosing from a list, `queue add` when nothing is playing, and the source menu | user | 6 per 30 s |
| Station changes (as above) | server | 12 per 30 s |
| Stream checks: `/radio rescan`, the **Check sources again** button, `/radio edit` with a new URL | server | 3 per 10 min |
| Adding custom stations, with `/radio add` or by an import | server | 5 per hour |
| Catalogue sync (`/radio sync`) | server | 2 per hour |
| Catalogue sync (`/radio sync`) | whole installation | 1 per 10 min |
| Button and menu clicks | user | 20 per 20 s |
| Settings import (`/radio import`) | server | 5 per 10 min |

Other limits that apply to the whole installation:

- `MAX_ACTIVE_GUILD_STREAMS` (default 3): servers streaming at once. Going over it is refused with `STREAM_LIMIT`.
- `MAX_CONCURRENT_PROBES` (default 2): stream checks at once, and never more than one at a time per stream host.
- `MAX_CUSTOM_STATIONS_PER_GUILD` (default 25): custom stations per server. Going over it is refused with `CUSTOM_STATION_LIMIT`.
- The queue holds at most 25 stations per server.
- An import file must be a Discord attachment of at most 256 KB.

The scheduled catalogue sync runs once every `CATALOG_SYNC_INTERVAL_HOURS` (24 by default, at least 6) for each pack that declares an official list, plus a random delay of up to 15 minutes.

## Custom station safety (SSRF)

*SSRF* (server-side request forgery) is a trick where someone gets a server to connect to a private address on its own network. Only admins can add custom stations, and the same checks apply to admins. Every URL, redirect and reconnect is checked:

- only `http://` and `https://` URLs, of at most 2048 characters; plain HTTP can be refused with `ALLOW_INSECURE_HTTP_STREAMS=false`;
- no user name or password in the URL;
- no ports of common internal services, and no ports below 1024 other than 80 and 443;
- no internal host names (such as `localhost`, `metadata` or names ending in `.local`, `.internal` or `.lan`), and no host names without a dot;
- no private, loopback, link-local, CGNAT, multicast, documentation or reserved IPv4 and IPv6 addresses, including their IPv4-mapped, NAT64 and 6to4 forms.

The bot looks up the host name itself and rejects the connection if any of the addresses it gets back is blocked. It then connects only to the address it checked. FFmpeg is never given a URL. See [architecture.md](architecture.md#the-source-validation-boundary) and [SECURITY.md](../SECURITY.md).

## What is logged about users

- Logs contain server IDs. They also contain a user ID in two cases: when someone records an identity verdict with `/radio source verify`, and when someone switches a playing station to another source with the source menu.
- The database keeps the user ID of the last person who started playback, of whoever queued each station, and of the admin who set each source preference or added each custom station.
- Logs contain no message content.

See [rights-and-disclaimer.md](rights-and-disclaimer.md#privacy-policy-for-a-self-hosted-instance).
