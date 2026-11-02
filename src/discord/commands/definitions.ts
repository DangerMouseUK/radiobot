import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from 'discord.js';

const stationOpt = (o: import('discord.js').SlashCommandStringOption, desc = 'Station name or ID') =>
  o.setName('station').setDescription(desc).setRequired(true).setAutocomplete(true).setMaxLength(100);

/**
 * One top-level /radio command (PRD §6). Guild-only; visible to everyone, because every
 * subcommand is authorised server-side (admin subcommands deny non-admins).
 */
export function buildRadioCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const b = new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Play live internet radio in a voice channel')
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .addSubcommand((s) =>
      s
        .setName('browse')
        .setDescription('Browse stations and pick one to play')
        .addStringOption((o) =>
          o
            .setName('pack')
            .setDescription('Only show stations from this pack')
            .setAutocomplete(true)
            .setMaxLength(40),
        )
        .addStringOption((o) =>
          o
            .setName('category')
            .setDescription('Only show stations in this category')
            .setAutocomplete(true)
            .setMaxLength(70),
        )
        .addStringOption((o) =>
          o.setName('search').setDescription('Search by name, alias or genre').setMaxLength(60),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('play')
        .setDescription('Play a station in your voice channel')
        .addStringOption((o) => stationOpt(o))
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription(
              'Voice channel to play in (by default, listeners can only pick the one they are in)',
            )
            .addChannelTypes(ChannelType.GuildVoice),
        ),
    )
    .addSubcommand((s) =>
      s.setName('stop').setDescription('Stop playing (the bot stays in the channel for a short while)'),
    )
    .addSubcommand((s) =>
      s
        .setName('join')
        .setDescription('Join a voice channel and start the default station if one is set')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Voice channel to join')
            .addChannelTypes(ChannelType.GuildVoice),
        ),
    )
    .addSubcommand((s) =>
      s.setName('leave').setDescription('Leave the voice channel and stay out until someone plays a station'),
    )
    .addSubcommand((s) =>
      s.setName('now').setDescription('Show what is playing, where it comes from and its audio quality'),
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('List stations and whether they can play')
        .addStringOption((o) =>
          o
            .setName('scope')
            .setDescription('Which stations to list')
            .addChoices(
              { name: 'Station packs', value: 'packs' },
              { name: 'Custom (this server)', value: 'custom' },
              { name: 'Favourites', value: 'favourites' },
            ),
        )
        .addStringOption((o) =>
          o.setName('pack').setDescription('Only this station pack').setAutocomplete(true).setMaxLength(40),
        )
        .addIntegerOption((o) =>
          o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(50),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('inspect')
        .setDescription('Technical details of a station’s sources: codec, bitrate and evidence')
        .addStringOption((o) => stationOpt(o)),
    )
    .addSubcommand((s) =>
      s.setName('quality').setDescription('Audio quality of what is playing, from the station to Discord'),
    )
    .addSubcommand((s) =>
      s
        .setName('sources')
        .setDescription('A station’s sources, which one plays and which is the fallback')
        .addStringOption((o) => stationOpt(o)),
    )
    .addSubcommand((s) =>
      s.setName('status').setDescription('Show the bot’s connection and the station it is set to play'),
    )
    .addSubcommand((s) =>
      s.setName('stats').setDescription('Live stream and connection statistics, shown only to you (admins)'),
    )
    .addSubcommand((s) => s.setName('skip').setDescription('Skip to the next station in the queue'))
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add a custom station for this server (admins)')
        .addStringOption((o) =>
          o.setName('name').setDescription('Station name').setRequired(true).setMinLength(2).setMaxLength(60),
        )
        .addStringOption((o) =>
          o
            .setName('url')
            .setDescription('Public stream URL (Icecast, SHOUTcast, HLS, PLS or M3U)')
            .setRequired(true)
            .setMaxLength(2048),
        )
        .addStringOption((o) => o.setName('website').setDescription('Station website').setMaxLength(300))
        .addStringOption((o) =>
          o.setName('description').setDescription('Short description').setMaxLength(300),
        )
        .addStringOption((o) => o.setName('category').setDescription('Category or genre').setMaxLength(40))
        .addStringOption((o) =>
          o.setName('language').setDescription('Language the station broadcasts in').setMaxLength(20),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Edit a custom station (admins)')
        .addStringOption((o) => stationOpt(o, 'Custom station to edit'))
        .addStringOption((o) =>
          o.setName('name').setDescription('New station name').setMinLength(2).setMaxLength(60),
        )
        .addStringOption((o) => o.setName('url').setDescription('New stream URL').setMaxLength(2048))
        .addStringOption((o) => o.setName('website').setDescription('Station website').setMaxLength(300))
        .addStringOption((o) =>
          o.setName('description').setDescription('Short description').setMaxLength(300),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a custom station (admins). Stations from packs can’t be removed')
        .addStringOption((o) => stationOpt(o, 'Custom station to remove')),
    )
    .addSubcommand((s) =>
      s
        .setName('rescan')
        .setDescription('Check a station’s sources again now (admins)')
        .addStringOption((o) => stationOpt(o))
        .addBooleanOption((o) =>
          o
            .setName('compare')
            .setDescription('Also compare about 40 seconds of audio to try to verify unverified sources'),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('sync')
        .setDescription('Check station packs against their official station lists (admins)')
        .addStringOption((o) =>
          o.setName('pack').setDescription('Only check this pack').setAutocomplete(true).setMaxLength(40),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('config')
        .setDescription('Server settings: channels, roles, idle behaviour and quality (admins)')
        .addStringOption((o) =>
          o
            .setName('default_station')
            .setDescription('Station to play when the bot joins without one')
            .setAutocomplete(true)
            .setMaxLength(100),
        )
        .addIntegerOption((o) =>
          o
            .setName('manual_bitrate')
            .setDescription('Bitrate in kbps for the Manual quality mode')
            .setMinValue(32)
            .setMaxValue(510),
        ),
    )
    .addSubcommand((s) =>
      s.setName('export').setDescription('Download this server’s settings as a JSON file (admins)'),
    )
    .addSubcommand((s) =>
      s
        .setName('import')
        .setDescription('Load settings from an export file: preview the changes, then apply (admins)')
        .addAttachmentOption((o) =>
          o.setName('file').setDescription('A settings file made with /radio export').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription('Post a control panel that stays in a text channel (admins)')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Text channel for the panel')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) => s.setName('help').setDescription('How to use Radio Bot'))
    .addSubcommandGroup((g) =>
      g
        .setName('queue')
        .setDescription('Line up stations to play next')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Add a station to the queue (plays now if nothing is playing)')
            .addStringOption((o) => stationOpt(o)),
        )
        .addSubcommand((s) => s.setName('list').setDescription('Show the queue'))
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Remove a station from the queue')
            .addIntegerOption((o) =>
              o
                .setName('position')
                .setDescription('Position in the queue')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(25),
            ),
        )
        .addSubcommand((s) => s.setName('clear').setDescription('Empty the queue')),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('source')
        .setDescription('Choose which source a station plays from (admins)')
        .addSubcommand((s) =>
          s
            .setName('pin')
            .setDescription('Always use this source, falling back to another only while it is broken')
            .addStringOption((o) => stationOpt(o))
            .addStringOption((o) =>
              o
                .setName('source')
                .setDescription('Source (pick from the list)')
                .setRequired(true)
                .setAutocomplete(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('prefer')
            .setDescription('Use this source whenever it is verified and working')
            .addStringOption((o) => stationOpt(o))
            .addStringOption((o) =>
              o
                .setName('source')
                .setDescription('Source (pick from the list)')
                .setRequired(true)
                .setAutocomplete(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('auto')
            .setDescription('Let the bot choose the source again from its checks')
            .addStringOption((o) => stationOpt(o)),
        )
        .addSubcommand((s) =>
          s
            .setName('verify')
            .setDescription('Record whether a source plays the right station (applies to every server)')
            .addStringOption((o) => stationOpt(o))
            .addStringOption((o) =>
              o
                .setName('source')
                .setDescription('Source (pick from the list)')
                .setRequired(true)
                .setAutocomplete(true),
            )
            .addStringOption((o) =>
              o
                .setName('verdict')
                .setDescription('Your verdict after listening or checking the evidence')
                .setRequired(true)
                .addChoices(
                  { name: 'Correct station (verified)', value: 'verified' },
                  { name: 'Wrong station (mismatch)', value: 'mismatch' },
                  { name: 'Clear the verdict (go back to the automatic checks)', value: 'clear' },
                ),
            ),
        ),
    );
  return b.toJSON();
}
