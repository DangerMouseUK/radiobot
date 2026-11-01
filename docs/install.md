# Install Radio Bot (beginner's guide)

This guide takes you from nothing to a working radio bot in your Discord server, in about 15 minutes. You don't need to know how to program. You need to be able to copy and paste, and to type commands into a terminal window when this guide tells you to.

Radio Bot is **self-hosted**: it runs on a computer you control, using a Discord bot account you create. Nobody else runs it for you, and it only works while that computer is switched on.

> Radio Bot is unofficial and isn't affiliated with or endorsed by Radio FG / Maison FG or any broadcaster. Before running it for anyone other than yourself, read [rights-and-disclaimer.md](rights-and-disclaimer.md).

## Contents

- [What you need](#what-you-need)
- [1. Create your Discord bot](#1-create-your-discord-bot)
- [2. Install Radio Bot](#2-install-radio-bot)
- [3. Invite the bot to your server](#3-invite-the-bot-to-your-server)
- [4. Play some radio](#4-play-some-radio)
- [Looking after your bot](#looking-after-your-bot)
- [If something goes wrong](#if-something-goes-wrong)
- [Other ways to install](#other-ways-to-install)

## What you need

- **A computer that stays on.** The bot only plays while this computer is running. Any of these will do:
  - a Linux computer or home server (Ubuntu, Debian, Fedora and so on), on 64-bit Intel/AMD or ARM;
  - a Raspberry Pi 4 or 5 running the **64-bit** Raspberry Pi OS;
  - a small cloud server (a "VPS") from any provider. Radio Bot hasn't been benchmarked yet, but one CPU core and 1 GB of memory is a sensible starting point for a few servers;
  - a Mac or a Windows PC, which is fine for trying it out, but the bot stops whenever the computer sleeps.
- **An internet connection.** The bot only connects outwards, so you don't need to open ports on your router or buy a domain. Each server that is listening uses roughly 60–150 MB of upload per hour for typical stations, depending on the station's own quality (see [Using less bandwidth](#using-less-bandwidth) if that matters to you).
- **A Discord account,** and a Discord server where you're allowed to add bots (you own it, or you have the **Manage Server** permission).

The installer uses **Docker**, a free tool that runs Radio Bot in its own sealed box with everything it needs (Node.js and FFmpeg) included. On Linux the installer can set Docker up for you. On a Mac or Windows PC you install Docker Desktop first, as described in [step 2](#2-install-radio-bot).

## 1. Create your Discord bot

You create the bot's account yourself, in Discord's Developer Portal. This gives you two values the installer will ask for: an **Application ID** and a **bot token**.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and log in with your Discord account.
2. Click **New Application** (top right). Type a name, such as `Radio Bot`, tick the box to accept Discord's terms, and click **Create**. Please don't name it after a radio station in a way that suggests it's official.
3. You're now on the **General Information** page. Find **Application ID** and click **Copy**. Paste it somewhere safe for a moment, such as a text file. It's a long number, like `123456789012345678`.
4. Click **Bot** in the menu on the left.
   - Click **Reset Token**, then **Yes, do it!** (Discord may ask for your password or a 2FA code). Click **Copy** and paste the token next to your Application ID.
   - **Treat the token like a password.** Anyone who has it controls your bot. Never post it in a chat, a screenshot or a GitHub issue. If it ever leaks, come back here and click **Reset Token** again.
   - Further down, under **Privileged Gateway Intents**, leave all three switches (**Presence**, **Server Members** and **Message Content**) **off**. Radio Bot doesn't need them.
5. Optional: to stop other people adding your bot to their servers, first go to **Installation** and set **Install Link** to **None**, then go back to **Bot** and switch **Public Bot** off. (Discord refuses to switch Public Bot off while an install link is set.)

That's all the setup Discord needs. You'll get the link that adds the bot to your server at the end of step 2.

## 2. Install Radio Bot

Pick the section for your computer, then follow [Run the installer](#run-the-installer).

### On Linux (including Raspberry Pi and cloud servers)

Open a terminal. On a cloud server, that means connecting with SSH as your provider describes. Make sure `git` and `curl` are installed. On Ubuntu, Debian or Raspberry Pi OS:

```bash
sudo apt update && sudo apt install -y git curl
```

You don't need to install Docker yourself: if it's missing, the installer offers to install it using Docker's official script.

### On a Mac

1. Install [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) and open it. Wait until it says Docker is running.
2. Open the **Terminal** app (in Applications → Utilities).
3. If the installer later asks you to install "command line developer tools" for `git`, click **Install**, wait for it to finish, and run the installer again.

### On Windows

Radio Bot runs inside Windows' built-in Linux environment, WSL.

1. Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/). Keep the **Use WSL 2** option selected. Restart if asked, then open Docker Desktop and wait until it says Docker is running.
2. Open **PowerShell** and run this. It installs Ubuntu inside Windows, and may ask you to restart:

   ```powershell
   wsl --install -d Ubuntu
   ```

   When Ubuntu first opens, choose a username and password. These are only for Ubuntu.
3. In Docker Desktop, open **Settings → Resources → WSL integration**, switch on **Ubuntu**, and click **Apply & restart**.
4. Open **Ubuntu** from the Start menu. Everything from here on is typed in that Ubuntu window. Install `git` and `curl`:

   ```bash
   sudo apt update && sudo apt install -y git curl
   ```

### Run the installer

Copy this line into your terminal and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/DangerMouseUK/radiobot/main/install.sh | bash
```

If you'd rather read the installer before running it, download Radio Bot and start the installer from your copy instead. This does exactly the same thing:

```bash
git clone https://github.com/DangerMouseUK/radiobot.git ~/radio-bot
bash ~/radio-bot/scripts/radio-bot.sh install
```

The installer:

1. downloads the newest release of Radio Bot into a `radio-bot` folder in your home folder;
2. checks for Docker, and on Linux offers to install it if it's missing;
3. asks for your **Application ID** and then your **bot token**. Paste each one and press Enter. While you paste the token, nothing appears on screen; that's normal, and keeps it private;
4. downloads (or, if none is published for this version, builds) the Radio Bot image. Building takes a few minutes the first time, longer on a Raspberry Pi;
5. starts the bot, waits until it has connected to Discord, and adds a `radio-bot` command you can use later.

When it finishes, you'll see **Radio Bot is online** and an invite link.

> **"permission denied" talking to Docker on Linux?** The installer handles this by using `sudo`, which means it may ask for your password. To stop that, add yourself to the `docker` group with `sudo usermod -aG docker $USER`, then log out and back in.

If the installer asks for your computer password, that is `sudo`: it may need it to set up Docker on Linux, or to add the `radio-bot` command to `/usr/local/bin` (common on a Mac). Type the password you sign in with; nothing appears on screen while you type.

## 3. Invite the bot to your server

Open the invite link the installer printed. If you've lost it, run `radio-bot invite` to print it again. It looks like this, with your own Application ID in it:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=3197952
```

Choose your server, click **Continue**, and then **Authorise**. Leave all the listed permissions ticked. The bot asks only for what it needs:

| Permission | Why |
|---|---|
| View Channels | See the voice channel and the channels it posts in |
| Send Messages | Only for the optional control panel and problem notices |
| Embed Links | Show the panel and notices as tidy cards |
| Attach Files | `/radio export` sends a settings file |
| Connect | Join a voice channel |
| Speak | Play the radio |

Never give the bot **Administrator**; it doesn't need it. If your voice channels have custom permissions, make sure the bot's role can **View Channel**, **Connect** and **Speak** in the channel you want it to play in.

## 4. Play some radio

In your Discord server:

1. Join a voice channel.
2. Type `/radio play` and start typing a station name, such as `FG DJ RADIO`. Pick it from the list that appears and press Enter. Or type `/radio browse` to pick from the full list.
3. The bot joins your channel and starts playing. The first time each station plays, the bot checks its streams first, which can take a few seconds.

Useful next steps:

- `/radio help` lists every command.
- **Server owners and administrators:** `/radio config` chooses which channels the bot can be used in, which roles count as DJs, what happens when everyone leaves the channel, and the audio quality. `/radio panel` posts a control panel whose buttons work for everyone allowed to control playback (DJs and admins, plus listeners if you allow it).
- The [README's command list](../README.md#commands) explains every command and who can use it.
- While it plays, the bot's status in the member list says what it's playing, such as "Listening to FG DJ RADIO · Artist - Title". To show only the station, or nothing, run `radio-bot config` and set `PRESENCE_MODE=station` or `PRESENCE_MODE=off`.

## Looking after your bot

Run these in a terminal on the computer where you installed Radio Bot. On Windows, use the Ubuntu window.

| Command | What it does |
|---|---|
| `radio-bot status` | Shows the version, whether the bot is running and connected, and whether an update is available |
| `radio-bot logs` | Shows what the bot is doing right now. Press **Ctrl+C** to stop watching (the bot keeps running) |
| `radio-bot stop` · `radio-bot start` · `radio-bot restart` | Stop, start or restart the bot. A restart also applies any changes to the settings file |
| `radio-bot config` | Opens the settings file in a text editor (usually **nano**: save with **Ctrl+O** then **Enter**, and close with **Ctrl+X**). When you close it, it offers to restart the bot to apply your changes |
| `radio-bot invite` | Prints the link that adds the bot to a server |
| `radio-bot backup` | Saves a copy of the bot's database (settings, favourites, custom stations) into the `backups` folder in `~/radio-bot` |
| `radio-bot restore <file>` | Puts a backup back, replacing the current data. The file can be named from the folder you're in, or from `~/radio-bot` (for example `backups/radio-bot-manual-….sqlite`) |
| `radio-bot update` | Updates to the newest release. It backs up the database first |
| `radio-bot uninstall` | Removes Radio Bot and the `~/radio-bot` folder. While the bot is running it offers to save a copy of its data first; backups already in `~/radio-bot/backups` are moved to a `radio-bot-backup-…` folder in your home folder. It asks separately before deleting the bot's data |
| `radio-bot help` | Lists these commands |

**The bot starts by itself** when the computer starts (as long as Docker does; on a Mac or Windows PC, set Docker Desktop to start when you sign in). If it crashes, Docker restarts it.

**Updating.** Run `radio-bot update` now and then; `radio-bot status` tells you when there's something new. Read [CHANGELOG.md](../CHANGELOG.md) to see what changed. If an update ever goes wrong, `radio-bot update v1.0.0` (with the version you were on) takes you back, but only if the newer version didn't change the database. If it did, the bot refuses to start on the older version rather than risk your data; restore the backup the update made, using `radio-bot restore`.

**Backups.** The update command backs up automatically, but run `radio-bot backup` before making big changes, and copy the `~/radio-bot/backups` folder somewhere else now and then. Backups hold your server's settings and IDs, never your bot token.

**Changing settings.** Most settings are per-server and live in Discord (`/radio config`). A few apply to the whole installation and live in the settings file that `radio-bot config` opens. Each one is explained in the file itself, and in the [README's configuration table](../README.md#configuration). If you change the settings file by hand, run `radio-bot restart` afterwards.

**Your own tweaks to the Docker setup** belong in a file called `compose.override.yaml` in the `~/radio-bot` folder, never in `compose.yaml` itself. Updates refuse to run over edited files, so that they never silently undo your changes.

### Using less bandwidth

By default the bot sends each station at the station's own quality: a 128 kbps station goes out at 128 kbps (about 58 MB of upload per hour for each server that is listening), and a 320 kbps one at 320 kbps (about 144 MB). It never goes above 510 kbps (about 230 MB an hour), which only a very high-quality station, or one whose quality the bot couldn't work out, would reach. On a metered connection or a slow upload, run `radio-bot config`, set `MAX_OPUS_BITRATE_KBPS=192` (or `128`), save, and let it restart. You can also cap a single server at 128 kbps with `/radio config` → **Playback** → quality **balanced**; that only saves anything on stations above 128 kbps.

## If something goes wrong

Start with `radio-bot status`, then `radio-bot logs`. The log is technical, but the newest lines usually say what's wrong.

| What you see | What to do |
|---|---|
| The installer says **"An invalid token was provided"**, or the bot keeps restarting | The token was copied wrongly or has been reset. Get a fresh one ([step 1](#1-create-your-discord-bot), **Reset Token**), then run `radio-bot config`, replace the `DISCORD_TOKEN=` line, save and close |
| **`DISCORD_APPLICATION_ID: must be a Discord snowflake ID`** | Copy the Application ID again from the **General Information** page. It's only digits |
| `/radio` doesn't appear in Discord | Check `radio-bot status` says healthy. Then re-invite the bot with the link from `radio-bot invite` (you don't need to remove it first), and restart Discord |
| The bot joins but you hear nothing | Check that the bot isn't server-muted, and that its role can **Speak** in that channel. Try another station with `/radio play` |
| **"No verified, working source is available"** | That station's streams aren't working right now. Try another station, or ask an admin to run `/radio rescan` on it later |
| **"Docker is installed but not running"** | Start Docker Desktop (Mac or Windows), or run `sudo systemctl start docker` (Linux), then try again |
| **"Files … were edited"** when updating | Something changed a file in `~/radio-bot`. Move your changes into `compose.override.yaml`, then run the `git … checkout` command the message shows, and update again |
| `radio-bot: command not found` | Open a new terminal window. If it still isn't found, use `bash ~/radio-bot/scripts/radio-bot.sh` instead of `radio-bot` |

The full troubleshooting guide is [troubleshooting.md](troubleshooting.md). If you're still stuck, open an issue on GitHub. Include what you did, what you expected, and the last 50 lines of `radio-bot logs`, but **never your token or the settings file**.

## Other ways to install

The installer is the easiest route, and it uses the same Docker setup that experienced users run by hand. If you know what you're doing and want more control:

| Guide | For |
|---|---|
| [install-docker.md](install-docker.md) | Running Docker Compose yourself: every setting, the data volume, logs, health checks, upgrades, backups and restores in detail |
| [install-linux.md](install-linux.md) | Running directly on Linux as a systemd service, without Docker |
| [install-container-platforms.md](install-container-platforms.md) | Hosted container platforms that run an always-on worker with a persistent volume |
