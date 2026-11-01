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
    .setDescription('Radio Bot — live internet radio in voice channels')
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .addSubcommand((s) =>
      s
        .setName('browse')
        .setDescription('Browse stations and pick one to play')
        .addStringOption((o) =>
          o
            .setName('pack')
            .setDescription('Station pack (group of stations)')
            .setAutocomplete(true)
            .setMaxLength(40),
        )
        .addStringOption((o) =>
          o.setName('category').setDescription('Filter by category').setAutocomplete(true).setMaxLength(70),
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
            .setDescription('Voice channel (DJs/admins)')
            .addChannelTypes(ChannelType.GuildVoice),
        ),
    )
    .addSubcommand((s) => s.setName('stop').setDescription('Stop the audio (stays in the channel briefly)'))
    .addSubcommand((s) =>
      s
        .setName('join')
        .setDescription('Join a voice channel and start the default station if one is set')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Voice channel').addChannelTypes(ChannelType.GuildVoice),
        ),
    )
    .addSubcommand((s) => s.setName('leave').setDescription('Disconnect and cancel auto-rejoin'))
    .addSubcommand((s) => s.setName('now').setDescription('What is playing, with source and output quality'))
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('List stations with their status')
        .addStringOption((o) =>
          o
            .setName('scope')
            .setDescription('Which list')
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
        .setDescription('Technical inspection of a station’s candidate sources')
        .addStringOption((o) => stationOpt(o)),
    )
    .addSubcommand((s) => s.setName('quality').setDescription('Current input/output audio quality report'))
    .addSubcommand((s) =>
      s
        .setName('sources')
        .setDescription('Verified/unverified sources, default choice and fallback')
        .addStringOption((o) => stationOpt(o)),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Connection and desired-station summary'))
    .addSubcommand((s) =>
      s.setName('stats').setDescription('Live stream and connection statistics, privately (Administrators)'),
    )
    .addSubcommand((s) => s.setName('skip').setDescription('Skip to the next station in the queue'))
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add a custom station for this server (admins)')
        .addStringOption((o) =>
          o.setName('name').setDescription('Display name').setRequired(true).setMinLength(2).setMaxLength(60),
        )
        .addStringOption((o) =>
          o
            .setName('url')
            .setDescription('Public stream URL (Icecast/SHOUTcast/HLS/PLS/M3U)')
            .setRequired(true)
            .setMaxLength(2048),
        )
        .addStringOption((o) => o.setName('website').setDescription('Station website').setMaxLength(300))
        .addStringOption((o) =>
          o.setName('description').setDescription('Short description').setMaxLength(300),
        )
        .addStringOption((o) => o.setName('category').setDescription('Category or genre').setMaxLength(40))
        .addStringOption((o) => o.setName('language').setDescription('Expected language').setMaxLength(20)),
    )
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Edit a custom station (admins)')
        .addStringOption((o) => stationOpt(o, 'Custom station'))
        .addStringOption((o) =>
          o.setName('name').setDescription('New display name').setMinLength(2).setMaxLength(60),
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
        .setDescription('Remove a custom station (admins; built-in stations cannot be removed)')
        .addStringOption((o) => stationOpt(o, 'Custom station')),
    )
    .addSubcommand((s) =>
      s
        .setName('rescan')
        .setDescription('Re-probe a station’s sources (admins, rate-limited)')
        .addStringOption((o) => stationOpt(o))
        .addBooleanOption((o) =>
          o
            .setName('compare')
            .setDescription('Also run a ~40 s audio comparison to verify unverified sources'),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('sync')
        .setDescription('Reconcile station packs with their official station lists (admins)')
        .addStringOption((o) =>
          o.setName('pack').setDescription('Only this pack').setAutocomplete(true).setMaxLength(40),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('config')
        .setDescription('Server settings: channels, roles, idle mode, quality (admins)')
        .addStringOption((o) =>
          o
            .setName('default_station')
            .setDescription('Default station')
            .setAutocomplete(true)
            .setMaxLength(100),
        )
        .addIntegerOption((o) =>
          o
            .setName('manual_bitrate')
            .setDescription('Opus target for manual quality mode (kbps)')
            .setMinValue(32)
            .setMaxValue(510),
        ),
    )
    .addSubcommand((s) =>
      s.setName('export').setDescription('Export this server’s settings as JSON (admins)'),
    )
    .addSubcommand((s) =>
      s
        .setName('import')
        .setDescription('Validate and preview a settings export, then apply (admins)')
        .addAttachmentOption((o) =>
          o.setName('file').setDescription('A Radio Bot export JSON file').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription('Post a persistent control panel (admins)')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Text channel')
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
            .setDescription('Remove one queued station')
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
        .setDescription('Source selection overrides (admins)')
        .addSubcommand((s) =>
          s
            .setName('pin')
            .setDescription('Always use one source for a station (with fallback warning)')
            .addStringOption((o) => stationOpt(o))
            .addStringOption((o) =>
              o.setName('source').setDescription('Source ID').setRequired(true).setAutocomplete(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('prefer')
            .setDescription('Prefer one source when it is eligible')
            .addStringOption((o) => stationOpt(o))
            .addStringOption((o) =>
              o.setName('source').setDescription('Source ID').setRequired(true).setAutocomplete(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('auto')
            .setDescription('Return to evidence-based automatic selection')
            .addStringOption((o) => stationOpt(o)),
        )
        .addSubcommand((s) =>
          s
            .setName('verify')
            .setDescription('Record an identity review verdict for a source (installation-wide)')
            .addStringOption((o) => stationOpt(o))
            .addStringOption((o) =>
              o.setName('source').setDescription('Source ID').setRequired(true).setAutocomplete(true),
            )
            .addStringOption((o) =>
              o
                .setName('verdict')
                .setDescription('Your verdict after listening/reviewing evidence')
                .setRequired(true)
                .addChoices(
                  { name: 'Correct station (verified)', value: 'verified' },
                  { name: 'Wrong station (mismatch)', value: 'mismatch' },
                  { name: 'Clear override (use automatic evidence)', value: 'clear' },
                ),
            ),
        ),
    );
  return b.toJSON();
}
