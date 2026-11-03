# Install Radio Bot (beginner's guide)

This guide takes you from nothing to a radio bot playing in your Discord server. It takes about 15 minutes, plus download time. You don't need to know how to program. You need to be able to copy and paste, and to type a few commands when the guide shows you them.

Radio Bot is **self-hosted**. That means it runs on a computer you look after, using a Discord bot account you create. Nobody else runs it for you, and it only plays while that computer is switched on.

> Radio Bot is unofficial and isn't affiliated with or endorsed by any broadcaster. Before running it for anyone other than yourself, read [rights-and-disclaimer.md](rights-and-disclaimer.md).

## Contents

- [What you need](#what-you-need)
- [Words used in this guide](#words-used-in-this-guide)
- [1. Create your Discord bot](#1-create-your-discord-bot)
- [2. Install Radio Bot](#2-install-radio-bot)
- [3. Invite the bot to your server](#3-invite-the-bot-to-your-server)
- [4. Play some radio](#4-play-some-radio)
- [Looking after your bot](#looking-after-your-bot)
- [If something goes wrong](#if-something-goes-wrong)
- [Other ways to install](#other-ways-to-install)

## What you need

- **A computer that stays on.** The bot only plays while this computer is running. Any of these will do:
  - a Linux computer or home server (Ubuntu, Debian, Fedora and so on) with a 64-bit Intel, AMD or ARM processor;
  - a Raspberry Pi 4 or 5 running the **64-bit** version of Raspberry Pi OS;
  - a small rented server in the cloud (often called a "VPS"). One processor core and 1 GB of memory is plenty for a few Discord servers: one playing station uses about 8% of a core and about 200 MB of memory (see the [README's requirements](../README.md#requirements)). Other regular jobs on the same small machine, such as statistics collectors or backups, can cause brief audio hiccups;
  - a Mac or a Windows PC. These are fine for trying it out, but the bot stops whenever the computer sleeps.
- **About 3 GB of free disk space.** Radio Bot comes as a download of about 1 GB, and an update briefly needs room for two copies.
- **An internet connection.** The bot only connects outwards, so you don't need to change your router's settings, open ports or buy a website address. Each Discord server that is listening uses roughly 60 to 150 MB of upload per hour for typical stations, depending on the station's own quality. See [Using less bandwidth](#using-less-bandwidth) if that matters to you.
- **A Discord account,** and a Discord server where you're allowed to add bots. That means you own the server, or you have the **Manage Server** permission in it.

## Words used in this guide

- **Terminal:** a window where you type commands instead of clicking. Each command in this guide is in a grey box. Copy it, paste it into the terminal, and press **Enter**. To paste in a terminal, press **Ctrl+Shift+V** on Linux, **Cmd+V** on a Mac, or **Ctrl+V** (or right-click) in the Ubuntu window on Windows.
- **Docker:** a free tool that runs Radio Bot in its own sealed box, with everything it needs already inside. The installer uses it, so you don't have to install anything else for Radio Bot.
- **Image:** Docker's word for the ready-made download of Radio Bot (about 1 GB). Each version of Radio Bot has its own image.
- **Bot token:** a long secret code that lets the bot log in to Discord as your bot. Treat it like a password.
- **Application ID:** a long number that identifies your bot to Discord. It isn't secret.
- **kbps:** kilobits per second, how much sound data a station sends each second. More usually means better sound, and more data used.
- **sudo:** a word in front of a command that runs it with administrator rights. When a command uses it, the terminal may ask for your computer password. Nothing appears on screen while you type the password; that is normal. Type it and press **Enter**.

## 1. Create your Discord bot

You create the bot's account yourself, on Discord's website for developers. At the end of this step you'll have the two values the installer asks for: the **Application ID** and the **bot token**.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and log in with your Discord account.
2. Click **New Application** (top right).
3. Type a name, such as `Radio Bot`. Don't name it after a radio station in a way that suggests it's the station's official bot.
4. Tick the box to accept Discord's terms, and click **Create**.
5. You're now on the **General Information** page. Find **Application ID** and click **Copy** under it. Paste it somewhere safe for a moment, such as a new note or text file. It's a long number, like `123456789012345678`.
6. Click **Bot** in the menu on the left.
7. Click **Reset Token**, then **Yes, do it!**. Discord may ask for your password or a two-factor code first.
8. Click **Copy** next to the new token, and paste it next to your Application ID. Discord shows the token only once. If you lose it, click **Reset Token** again to get a new one.
9. Further down the same page, under **Privileged Gateway Intents**, leave all three switches (**Presence Intent**, **Server Members Intent** and **Message Content Intent**) **off**. Radio Bot doesn't need them.
10. Optional: to stop other people adding your bot to their servers, click **Installation** in the left menu and set **Install Link** to **None**. Then go back to **Bot** and switch **Public Bot** off. Discord won't let you switch Public Bot off while an install link is set, which is why the order matters.

> **Keep the token secret.** Anyone who has it controls your bot. Never post it in a chat, a screenshot or a GitHub issue. If it ever leaks, come back to the **Bot** page and click **Reset Token**; the old token stops working at once.

That's all the setup Discord needs. You'll get the link that adds the bot to your server at the end of step 2.

## 2. Install Radio Bot

First follow the section for your computer: [Linux](#on-linux-including-raspberry-pi-and-cloud-servers), [Mac](#on-a-mac) or [Windows](#on-windows). Then follow [Run the installer](#run-the-installer).

### On Linux (including Raspberry Pi and cloud servers)

1. Open a terminal.
   - On a desktop, look for **Terminal** in your applications menu. On Ubuntu, **Ctrl+Alt+T** opens one.
   - On a cloud server, log in to it over SSH, as your provider's instructions describe. For example, from a Mac or Linux computer you might type `ssh yourname@your-server-address`.
2. Check that your system is 64-bit:

   ```bash
   uname -m
   ```

   You should see `x86_64` or `aarch64`. If you see something else, such as `armv7l` on a Raspberry Pi, install the 64-bit version of the operating system first.
3. Install `git` and `curl`, the two tools the installer uses to download Radio Bot. On Ubuntu, Debian or Raspberry Pi OS:

   ```bash
   sudo apt update && sudo apt install -y git curl
   ```

   On Fedora, use `sudo dnf install -y git curl` instead.

You don't need to install Docker yourself. If it's missing, the installer offers to install it for you, using Docker's official install script.

### On a Mac

1. Download and install [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/).
2. Open Docker Desktop from your Applications folder, accept its terms, and wait until it says Docker is running.
3. Open the **Terminal** app. It's in **Applications → Utilities**.
4. If your Mac later asks you to install the "command line developer tools" (it needs them for `git`), click **Install**. Wait for it to finish, then run the installer again.

### On Windows

If you don't have a Linux machine to hand, Radio Bot can run inside WSL, the Linux environment built into Windows.

1. Download and install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/). When its installer offers to use **WSL 2**, keep that option selected. Restart the PC if asked.
2. Open Docker Desktop, accept its terms, and wait until it says Docker is running.
3. Right-click the **Start** button and choose **Terminal (Admin)** (on older Windows, **Windows PowerShell (Admin)**). Click **Yes** when Windows asks for permission.
4. Type this and press **Enter**. It installs Ubuntu, a version of Linux, inside Windows, and may ask you to restart:

   ```powershell
   wsl --install -d Ubuntu
   ```

5. When Ubuntu first opens, it asks you to choose a username and password. These are only for Ubuntu, and you'll need the password whenever a command uses `sudo`.
6. In Docker Desktop, open **Settings → Resources → WSL integration**, switch on **Ubuntu**, and click **Apply & restart**.
7. Open **Ubuntu** from the Start menu. Type everything from here on in that Ubuntu window. Install `git` and `curl`:

   ```bash
   sudo apt update && sudo apt install -y git curl
   ```

### Run the installer

1. Copy this line into your terminal and press **Enter**:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/DangerMouseUK/radiobot/main/install.sh | bash
   ```

   You should see `Downloading Radio Bot into` followed by a `radio-bot` folder in your home folder.

   If you'd rather read the installer before running it, use these two commands instead. They do exactly the same thing:

   ```bash
   git clone https://github.com/DangerMouseUK/radiobot.git ~/radio-bot
   bash ~/radio-bot/scripts/radio-bot.sh install
   ```

2. **Only on Linux, if Docker isn't installed yet,** the installer asks `Install Docker now with Docker's official script (get.docker.com)?`. Type `y` and press **Enter**, then type your computer password if asked. If you just press **Enter**, the answer is no, and the installer stops and tells you where to get Docker.
3. When it asks for the **Application ID**, paste the number you copied in step 1 and press **Enter**.
4. When it asks for the **bot token**, paste the token and press **Enter**. Nothing appears on screen while you paste it; that's normal, and keeps it private. If either value doesn't look right, the installer says so and asks again.
5. The installer now downloads Radio Bot (about 1 GB). It may look as if nothing is happening for a few minutes; let it work. If there's no ready-made download for your version, it says `building it on this machine instead`. Building takes a few minutes the first time, and longer on a Raspberry Pi.
6. It starts the bot, adds the `radio-bot` command you'll use later, and waits up to 90 seconds for the bot to connect to Discord. You should see `✔ Radio Bot is online.`
7. **Add some stations.** Radio Bot comes with no stations. They come in **station packs**: lists of one radio company's stations, kept in Radio Bot's official pack library online. On a first install, the installer shows `==> Add some stations` and asks `See the station packs you can add now? [Y/n]`.
   - Press **Enter** (the answer is yes). It lists the packs you can add. Each line starts with the pack's name in lower case, such as `mypack`, followed by its full name, how many stations it has, its country and the company it belongs to.
   - When it asks `Packs to add, separated by spaces (press Enter to skip):`, type the names of the packs you want, for example `mypack otherpack`, and press **Enter**. You should see `Installed …` for each one.
   - If you'd rather choose later, just press **Enter**. You can add packs at any time; see [Adding and removing stations](#adding-and-removing-stations).
   - If you see `Couldn't reach the pack library just now`, the computer couldn't reach GitHub, where the library is kept. Carry on, and add packs later.

When it has finished, you should see:

```text
==> Last step: invite the bot to your Discord server
```

followed by an invite link. Keep the terminal open for the next step.

**If you don't see "Radio Bot is online":**

- `Radio Bot stopped while starting. The lines above say why.` usually means the token or the Application ID is wrong. Run `radio-bot config` and correct them (see [If something goes wrong](#if-something-goes-wrong)).
- `Radio Bot still isn't ready after 90 seconds` usually means the computer can't reach Discord. Check its internet connection, then run `radio-bot status`.
- **"permission denied" when talking to Docker, on Linux:** the installer gets round this by using `sudo`, so it may ask for your password. To stop that, add yourself to the `docker` group with `sudo usermod -aG docker $USER`, then log out and back in.
- **It asks for your computer password:** that's `sudo`. It may need it to set up Docker on Linux, or to add the `radio-bot` command to the `/usr/local/bin` folder (common on a Mac). Type the password you sign in with and press **Enter**.

It is safe to run the installer again at any time. If Radio Bot is already installed, it checks that installation, keeps your settings and starts the bot. It only offers station packs again if none are installed.

## 3. Invite the bot to your server

1. Open the invite link the installer printed. If you've lost it, run `radio-bot invite` to print it again. It looks like this, with your own Application ID in it:

   ```text
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=281474979908608
   ```

2. Choose your server from the list and click **Continue**.
3. Leave all the listed permissions ticked and click **Authorize**. Discord may ask you to prove you're human.

You should see a message that the bot was added, and the bot appears in your server's member list.

The bot asks only for what it needs:

| Permission | Why |
|---|---|
| View Channels | See the voice channel and the channels it posts in |
| Send Messages | Only for the optional control panel and problem notices |
| Embed Links | Show the control panel as a tidy card |
| Attach Files | `/radio export` sends a settings file |
| Connect | Join a voice channel |
| Speak | Play the radio |
| Set Voice Channel Status | Optional: show the station and song under the voice channel's name |

Never give the bot **Administrator**; it doesn't need it. If your voice channels have their own permission settings, make sure the bot's role can **View Channel**, **Connect** and **Speak** in the channel you want it to play in.

## 4. Play some radio

In your Discord server:

1. Join a voice channel.
2. In any text channel, type `/radio play`. Start typing the name of a station, pick it from the list that appears, and press **Enter**. Or type `/radio browse` to pick from the full list.
3. The bot joins your voice channel and starts playing. It posts a card showing what's playing, with buttons to control it. The first time a station plays, the bot checks its streams first, which can take a few seconds.

**If the list of stations is empty** and the bot says `No stations yet`, no station packs are installed. Add some as described in [Adding and removing stations](#adding-and-removing-stations).

**If `/radio` doesn't appear** when you type it, or the bot doesn't play, see [If something goes wrong](#if-something-goes-wrong).

Useful next steps:

- `/radio help` lists the commands.
- **Server owners and administrators** can run `/radio config` to choose which channels the bot can be used in, which roles count as DJs (DJs can always control the radio), what happens when everyone leaves the channel, and the audio quality. `/radio panel` posts a control panel whose buttons work for everyone allowed to control playback.
- Press **Favourite** under a playing station to add it to this server's favourites. Favourites come first when you type `/radio play`, and **Unfavourite** removes one.
- The [README's command list](../README.md#commands) explains every command and who can use it.
- While it plays, the bot's status in the member list says what it's playing, such as "Listening to My Station · Artist - Title". To show only the station, or nothing, change `PRESENCE_MODE` to `station` or `off` (see [Changing settings](#changing-settings)).
- The voice channel shows it too, under the channel's name, for example "📻 My Station · Artist - Title". This uses the **Set Voice Channel Status** permission. To turn it off for your server, use `/radio config` → **Notifications**.

## Looking after your bot

Type these commands in a terminal on the computer where you installed Radio Bot. On Windows, use the Ubuntu window.

| Command | What it does |
|---|---|
| `radio-bot status` | Shows the version, whether the bot is running and healthy, and whether an update is available. It also tells you if an update didn't finish |
| `radio-bot logs` | Shows the bot's last 200 log lines, then keeps showing new ones as they happen. Press **Ctrl+C** to stop watching; the bot keeps running |
| `radio-bot stop` · `radio-bot start` · `radio-bot restart` | Stops, starts or restarts the bot. A restart also applies any changes to the settings file |
| `radio-bot packs` | Lists the station packs you have installed, and says when one has an update. See [Adding and removing stations](#adding-and-removing-stations) |
| `radio-bot packs browse` · `radio-bot packs add <pack>` · `radio-bot packs update` · `radio-bot packs remove <pack>` | Shows the packs you can add, adds one, updates the ones you have, or removes one |
| `radio-bot config` | Opens the settings file in a text editor. See [Changing settings](#changing-settings) |
| `radio-bot invite` | Prints the link that adds the bot to a server |
| `radio-bot backup` | Saves a copy of the bot's database (its settings, favourites and custom stations), and copies it, with the backups the bot made earlier, into the `backups` folder in `~/radio-bot`. See [Backups](#backups) |
| `radio-bot restore <file>` | Puts a backup back, replacing the bot's current data. See [Putting a backup back](#putting-a-backup-back) |
| `radio-bot update` | Updates Radio Bot to the newest version. See [Updating](#updating) |
| `radio-bot uninstall` | Removes Radio Bot from this computer. See [Removing Radio Bot](#removing-radio-bot) |
| `radio-bot install` | Sets up or repairs this installation. It is safe to run again |
| `radio-bot version` | Prints the installed version |
| `radio-bot help` | Lists these commands |

`~/radio-bot` means the `radio-bot` folder in your home folder. It holds Radio Bot itself, the settings file (`.env`), and the `backups` and `logs` folders.

**The bot starts by itself** when the computer starts, as long as Docker does. On a Mac or Windows PC, turn on **Start Docker Desktop when you sign in to your computer** in Docker Desktop's settings. If the bot crashes, Docker restarts it.

**`radio-bot status`** prints something like this:

```text
Version:  v1.2.1
Folder:   /home/you/radio-bot
State:    running
Health:   healthy: ok
```

`State` is `running` when the bot is running. `Health` says `healthy: ok` once the bot is connected to Discord, its database works and FFmpeg (the audio tool inside it) is ready. If `State` is `restarting` or `exited`, or `Health` says `unhealthy`, run `radio-bot logs` to see why. An `Update:` line appears when there's a new version, or when an update didn't finish.

### Changing settings

Most settings are made per Discord server, in Discord, with `/radio config`. A few apply to the whole installation and live in the settings file.

1. Run `radio-bot config`. The settings file opens in a text editor, usually **nano**. Each setting has a short explanation above it, and the [README's configuration table](../README.md#configuration) explains them all.
2. Change the value after the `=` sign. For example, change `PRESENCE_MODE=track` to `PRESENCE_MODE=station`.
3. In **nano**, save with **Ctrl+O** and then **Enter**, and close with **Ctrl+X**.
4. When it asks `Restart Radio Bot to apply the changes?`, press **Enter** (the answer is yes).

You should see `Radio Bot is online.` again. If you changed the settings file some other way, run `radio-bot restart` afterwards.

**Your own changes to the Docker setup** belong in a file called `compose.override.yaml` in the `~/radio-bot` folder, never in `compose.yaml` itself. An update refuses to run over files you've edited, so it never quietly undoes your changes.

### Adding and removing stations

Stations come in **station packs**. Each pack lists one radio company's stations. The packs are kept in Radio Bot's official pack library, where every pack is checked before it is added. Adding, updating or removing a pack doesn't interrupt anything that is playing, and you don't need to restart the bot.

**To add a pack:**

1. See what there is:

   ```bash
   radio-bot packs browse
   ```

   Each line starts with the pack's short name, such as `mypack`, then its full name, how many stations it has, its country and the company it belongs to. To narrow the list, add a word, a country or a language, for example `radio-bot packs browse jazz`, `radio-bot packs browse --country GB` or `radio-bot packs browse --language fr`. Packs you already have say `(installed)`.
2. Add one or more packs by their short names:

   ```bash
   radio-bot packs add mypack
   ```

   You should see `Installed …` with the number of stations, then `Radio Bot is loading the change now. Nothing that is playing is interrupted.` The new stations appear in `/radio play` and `/radio browse` shortly afterwards.

   Some packs are grouped into **collections**, listed at the end of `radio-bot packs browse`. To add a whole collection, type `radio-bot packs add --collection` followed by its name.

**To see what you have:** run `radio-bot packs`. It lists your packs with their versions and the number of stations, and says `update available` next to any pack that has a newer version.

**To update your packs:** run `radio-bot packs update`. Packs never update by themselves, so that nothing changes without you knowing.

**To remove a pack:** run `radio-bot packs remove mypack`. Its stations disappear from every Discord server the bot is in, and anything playing one of them stops. Your favourites and queues are kept, so they come back if you add the pack again. A pack you removed stays removed.

If the bot isn't running when you change packs, it says `The change takes effect when it starts`.

**From Discord:** the owner of the bot's Discord application (you, if you made it in [step 1](#1-create-your-discord-bot)) can do the same in any server where they are an admin. `/radio packs library` shows the packs you can add, with a menu to pick one and an **Install** button. `/radio packs installed` shows the packs you have, with **Update** and **Remove** buttons. Other admins can look, but can't change anything, because packs are shared by every server the bot is in. To let someone else change packs too, add their Discord user ID to `OPERATOR_USER_IDS` in the settings file (see [Changing settings](#changing-settings)).

**Once a day** the bot checks the library. If a pack you have has been taken out of the library (for example because the radio company asked), the bot removes it and says so in `/radio packs installed`.

### Updating

Run `radio-bot update` now and then. `radio-bot status` tells you when there's something new, and [CHANGELOG.md](../CHANGELOG.md) says what changed.

`radio-bot update` does this:

1. If the bot is playing in any server, it tells you, and asks `Update now?`. Press **Enter** to go ahead, or type `n` to cancel. Playback stops during the update, and afterwards only starts again by itself in servers where **Resume after restart** is on in `/radio config`. The station keeps playing while the new version downloads, and on a small server the download can cause small cuts in the audio, so a quiet moment is the best time to update.
2. If the bot is running, it backs up the database and copies the backup into the `backups` folder in `~/radio-bot`.
3. It switches to the new version and downloads it.
4. It keeps the last 500 lines of the old version's log in the `logs` folder in `~/radio-bot`. The newest 5 of these files are kept.
5. It restarts the bot and waits until it's online. Some updates also change how the database is laid out; the bot does this by itself when it starts, after making another backup.
6. Once the new version is running, it deletes the old version's download to free disk space.

You should see `Updated v… → v…` at the end.

If an update stops halfway, for example because your internet connection dropped, run `radio-bot update` again and it finishes the job. Until then, `radio-bot status` says `the last update to … didn't finish`.

**Updating from version 1.1.0 or earlier:** those versions came with a station pack built in. Newer versions come with none, so the first time the new version starts, it downloads that pack again from the pack library, before it plays anything. Your favourites, queues and settings keep working. Run `radio-bot packs` afterwards to check that it's there. If the computer couldn't reach GitHub at that moment, the bot tries again later by itself, or you can add the pack yourself with `radio-bot packs add`.

### Going back to an earlier version

If an update goes wrong, you can go back to the version you had before:

1. Run `radio-bot update` followed by that version, for example:

   ```bash
   radio-bot update v1.0.4
   ```

2. If you see `Radio Bot is online.`, you're done.
3. If you see `Radio Bot stopped while starting`, and the lines above it mention `Database has migrations newer than this build`, the newer version had already changed the database, and the older version refuses to open it rather than risk your data. Put back a backup from before the update, as described in [Putting a backup back](#putting-a-backup-back). Choose the newest file whose name starts with `radio-bot-pre-`: the newer version made it just before it changed the database. If there isn't one, choose the newest `radio-bot-manual-…` file from before you updated.

### Backups

`radio-bot update` makes a backup by itself, but run `radio-bot backup` before making big changes. You should see `Backups copied to` followed by the `backups` folder.

Copy the `~/radio-bot/backups` folder to another computer or a USB stick now and then: a backup on the same disk doesn't help if the disk fails. Backups hold your servers' settings and Discord IDs, but never your bot token.

If the bot isn't running (for example, because it can't start), `radio-bot backup` can't make a new backup. It says so, and still copies the backups the bot made earlier into the `backups` folder.

### Putting a backup back

1. Run `radio-bot backup`. This makes sure every backup the bot has is in the `backups` folder, even if the bot can't start.
2. List the backups, newest first:

   ```bash
   ls -t ~/radio-bot/backups
   ```

   Each name contains the date and time it was made, for example `radio-bot-manual-2026-11-02T10-30-00-000Z.sqlite`.
3. Run `radio-bot restore backups/` followed by the file's name, for example:

   ```bash
   radio-bot restore backups/radio-bot-manual-2026-11-02T10-30-00-000Z.sqlite
   ```

4. It asks `Restore …?`. Type `y` and press **Enter**.

You should see `Restored.` If the bot was running, it first makes a backup of the current data, just in case. It refuses a file that isn't a backup before it changes anything, and if copying the backup in goes wrong, it starts the bot again on the data it had.

### Removing Radio Bot

Run `radio-bot uninstall`. It asks before each step:

1. `Continue?`: type `y` to go ahead.
2. If the bot is running, `Save a copy of the bot's data to your home folder first?`: press **Enter** for yes. The copy goes into a `radio-bot-backup-…` folder in your home folder. Backups already in `~/radio-bot/backups` are moved there too.
3. `Delete the bot's data …? This cannot be undone.`: type `y` to delete it, or press **Enter** to keep it. If you keep it, installing Radio Bot again picks it up.

It then removes the bot, the `radio-bot` command and the `~/radio-bot` folder. To remove the bot from Discord too, kick it from your servers, or delete the application in the Developer Portal.

### Using less bandwidth

By default the bot sends each station at the station's own quality. A 128 kbps station goes out at 128 kbps, about 58 MB of upload per hour for each Discord server that is listening. A 320 kbps station goes out at 320 kbps, about 144 MB an hour. It never goes above 510 kbps (about 230 MB an hour), and only a very high-quality station, or one whose quality the bot couldn't work out, would reach that.

On a metered connection or a slow upload:

1. Run `radio-bot config`.
2. Change the `MAX_OPUS_BITRATE_KBPS=510` line to `MAX_OPUS_BITRATE_KBPS=192` (or `128`).
3. Save, close, and let it restart.

You can also limit a single Discord server to 128 kbps: in `/radio config`, open **Playback** and choose **Balanced** in the **Audio quality** menu. That only saves anything on stations above 128 kbps.

## If something goes wrong

Start with `radio-bot status`, then `radio-bot logs`. The log is technical, but the newest lines usually say what's wrong.

| What you see | What to do |
|---|---|
| **"An invalid token was provided"** in the log, or the bot keeps restarting | The token was copied wrongly or has been reset. Get a fresh one ([step 1](#1-create-your-discord-bot), **Reset Token**). Run `radio-bot config`, replace everything after `DISCORD_TOKEN=` with the new token, then save and close |
| **`DISCORD_APPLICATION_ID: must be a Discord ID (17 to 20 digits)`** | The Application ID is wrong. Copy it again from the **General Information** page; it's only digits. Run `radio-bot config` and put it after `DISCORD_APPLICATION_ID=` |
| **"Docker is installed but not running"** | Start Docker Desktop (Mac or Windows), or run `sudo systemctl start docker` (Linux), then try again |
| **"Docker Compose … is too old"** | Update Docker (on a Mac or Windows PC, update Docker Desktop), then try again |
| `radio-bot: command not found` | Open a new terminal window. If it still isn't found, type `bash ~/radio-bot/scripts/radio-bot.sh` instead of `radio-bot` |
| `/radio` doesn't appear in Discord | Check that `radio-bot status` says `healthy`. Then open the link from `radio-bot invite` again and add the bot to the same server (you don't need to remove it first). Then restart Discord |
| The bot joins but you hear nothing | Check that the bot isn't server-muted, and that its role can **Speak** in that channel. Try another station with `/radio play` |
| **"No verified, working source is available"** | That station's streams aren't working right now. Try another station, or ask an admin to run `/radio rescan` on it later |
| **"No stations yet"** in Discord, or `/radio play` suggests nothing | No station packs are installed. Run `radio-bot packs browse`, then `radio-bot packs add` with the pack's name (see [Adding and removing stations](#adding-and-removing-stations)) |
| **"Couldn't reach the pack library"** | The computer couldn't reach GitHub, where the pack library is kept. Check its internet connection and try again later |
| **"…only the bot owner can install, update or remove them"** in Discord | Packs are shared by every server the bot is in, so only the bot's owner can change them. Use `radio-bot packs` on the computer instead, or add your Discord user ID to `OPERATOR_USER_IDS` with `radio-bot config` |
| **"Files … were edited"** when updating | A file in `~/radio-bot` was changed. Move your changes into `compose.override.yaml`, run the `git … checkout` command the message shows (it undoes the edits), and update again |
| **"Couldn't reach GitHub to check for updates"** | Check the computer's internet connection, then try again |
| `radio-bot status` says **"the last update … didn't finish"** | Run `radio-bot update` again to finish it |
| **"… isn't a Radio Bot backup"** when restoring | The file you named isn't a backup. Pick a `.sqlite` file from the `backups` folder (see [Putting a backup back](#putting-a-backup-back)) |

The full troubleshooting guide is [troubleshooting.md](troubleshooting.md). If you're still stuck, open an issue on GitHub. Say what you did and what you expected, and include the last lines of `radio-bot logs`. **Never include your token or the settings file.**

## Other ways to install

The installer is the easiest route, and it uses the same Docker setup that experienced users run by hand. If you're comfortable with a terminal and want more control:

| Guide | For |
|---|---|
| [install-docker.md](install-docker.md) | Running Docker Compose yourself: every setting, the data volume, logs, health checks, upgrades, backups and restores in detail |
| [install-linux.md](install-linux.md) | Running directly on Linux as a systemd service, without Docker |
| [install-container-platforms.md](install-container-platforms.md) | Hosted container platforms that run an always-on worker with a persistent volume |
