import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  LabelBuilder,
  type MessageActionRowComponentBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { Station } from '../../catalogue/types.ts';
import type { GuildSettings, MemberControlMode } from '../../persistence/repositories/guilds.ts';
import { truncate } from '../../shared/text.ts';
import type { AppContext } from '../context.ts';
import { COLOR } from './format.ts';

/**
 * The server settings card (`/radio config`), in Discord's newer message layout: an overview of
 * every setting with a Change button beside each group, one page per group, a short setup for a
 * new server, and confirmations for the two changes that can't be undone (Reset, Remove panel).
 * Every page is one container that stays under Discord's limit of 40 components per message, and
 * every label is short enough for a phone (about 40 characters).
 */
export const SETTINGS_SCREENS = [
  'home',
  'access',
  'playing',
  'sound',
  'notices',
  'panel',
  'reset',
  'unpanel',
  'setup1',
  'setup2',
  'setup3',
  'setup4',
  'setup5',
] as const;
export type SettingsScreen = (typeof SETTINGS_SCREENS)[number];

const SCREENS: ReadonlySet<string> = new Set(SETTINGS_SCREENS);
export const isSettingsScreen = (s: string | undefined): s is SettingsScreen => SCREENS.has(s ?? '');

/** The setup steps that ask a question, in order; `setup5` is the summary at the end. */
const SETUP_STEPS = 4;

export interface SettingsCard {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  /** Role and channel names show as mentions, which must never ping anyone. */
  allowedMentions: { parse: [] };
}

/** Buttons and menus on the card last as long as an admin might reasonably keep it open. */
export const SETTINGS_TTL_MS = 30 * 60_000;

/** The default-station form's parts. */
export const STATION_PICK = 'pick';
export const STATION_NAME = 'name';
/** The default-station menu's "No default station" value (never a station ID: those have a colon). */
export const NO_DEFAULT_STATION = 'none';
/** The manual bitrate form's text box. */
export const BITRATE_INPUT = 'kbps';
/** The manual bitrate range, the same as Opus's and the export file's. */
export const MANUAL_KBPS_MIN = 32;
export const MANUAL_KBPS_MAX = 510;

const IDLE_TEXT: Record<GuildSettings['idleMode'], string> = {
  leave_when_empty: 'leave the channel',
  pause_when_empty: 'pause, and play again when someone joins',
  '24x7': 'keep playing (24/7)',
};

// The overview's words are short: on a phone the Change button beside each group leaves room for
// about 20 characters a line. Each group's own page says the same things in full.
const LISTENER_SHORT: Record<MemberControlMode, string> = {
  same_channel: 'bot’s channel',
  any: 'anywhere',
  none: 'off',
};

const IDLE_SHORT: Record<GuildSettings['idleMode'], string> = {
  leave_when_empty: 'leave',
  pause_when_empty: 'pause',
  '24x7': 'keep playing (24/7)',
};

const onOff = (on: boolean) => (on ? 'on' : 'off');

/** Up to three mentions, then "and 3 more", so a long list can't crowd the overview. */
function mentions(ids: readonly string[], kind: '#' | '@&', none: string): string {
  if (ids.length === 0) return none;
  const shown = ids
    .slice(0, 3)
    .map((x) => `<${kind}${x}>`)
    .join(', ');
  return ids.length > 3 ? `${shown} and ${ids.length - 3} more` : shown;
}

/** The quality in a few words, for the overview: "Maximum (up to 510 kbps)". */
function qualityShort(s: GuildSettings, maxKbps: number): string {
  if (s.qualityMode === 'maximum') return `Maximum (up to ${maxKbps} kbps)`;
  if (s.qualityMode === 'balanced') return 'Balanced (up to 128 kbps)';
  if (s.manualBitrateKbps === null) return 'Manual (not set yet)';
  return `Manual (${Math.min(s.manualBitrateKbps, maxKbps)} kbps)`;
}

/** "Maximum (follows each station’s bitrate, up to 510 kbps)": quality in words, with the cap applied. */
export function qualityText(s: GuildSettings, maxKbps: number): string {
  if (s.qualityMode === 'maximum') return `Maximum (follows each station’s bitrate, up to ${maxKbps} kbps)`;
  if (s.qualityMode === 'balanced') return 'Balanced (up to 128 kbps)';
  if (s.manualBitrateKbps === null) return 'Manual (no bitrate set yet, so it follows the station)';
  return s.manualBitrateKbps > maxKbps
    ? `Manual (${s.manualBitrateKbps} kbps, capped at ${maxKbps})`
    : `Manual (${s.manualBitrateKbps} kbps)`;
}

/** What autostart still needs, in words, or null when it has everything. */
function autostartNeeds(s: GuildSettings, station: Station | null): string | null {
  const missing = [
    station ? null : 'a default station',
    s.preferredVoiceChannelId ? null : 'a preferred voice channel',
  ].filter((m): m is string => m !== null);
  return missing.length ? missing.join(' and ') : null;
}

const text = (content: string) => new TextDisplayBuilder().setContent(content);
const separator = (divider = true) =>
  new SeparatorBuilder().setDivider(divider).setSpacing(SeparatorSpacingSize.Small);
const row = (...c: MessageActionRowComponentBuilder[]) =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...c);

/**
 * Builds one screen of the settings card. Reads at most the default station, by ID: no lists of
 * stations, so the card costs the same on any catalogue.
 */
export function settingsCard(
  ctx: AppContext,
  guildId: string,
  s: GuildSettings,
  screen: SettingsScreen,
  note = '',
): SettingsCard {
  const id = (arg: string) => ctx.ids.make(guildId, 'cfg', arg, SETTINGS_TTL_MS);
  const button = (arg: string, label: string, style = ButtonStyle.Secondary, disabled = false) =>
    new ButtonBuilder().setCustomId(id(arg)).setLabel(label).setStyle(style).setDisabled(disabled);
  const go = (to: SettingsScreen, label: string, style = ButtonStyle.Secondary) =>
    button(`go:${to}`, label, style);
  // A switch shows its state: green when on (the only green on the card), grey when off. Off and
  // missing what it needs, it can't be turned on, and its text says why.
  const toggle = (field: string, on: boolean, blocked = false) =>
    button(
      `${field}:${screen}`,
      on ? 'On' : 'Off',
      on ? ButtonStyle.Success : ButtonStyle.Secondary,
      !on && blocked,
    );
  const section = (content: string, accessory: ButtonBuilder) =>
    new SectionBuilder().addTextDisplayComponents(text(content)).setButtonAccessory(accessory);

  const defaults = ctx.guilds.defaults;
  const max = ctx.config.maxOpusBitrateKbps;
  const station = s.defaultStationId ? ctx.stations.getStation(s.defaultStationId) : null;
  const stationName = station
    ? station.displayName
    : s.defaultStationId
      ? 'a station that is no longer available'
      : 'none';
  const needs = autostartNeeds(s, station);
  const voice = s.preferredVoiceChannelId ? `<#${s.preferredVoiceChannelId}>` : 'none';
  const opt = (value: string, label: string, description: string, current: string, dflt: string) => ({
    value,
    label,
    description: value === dflt ? `${description} (default)` : description,
    default: value === current,
  });

  const c = new ContainerBuilder().setAccentColor(COLOR.info);
  if (note) c.addTextDisplayComponents(text(note));

  const voiceSelect = (arg: string) =>
    new ChannelSelectMenuBuilder()
      .setCustomId(id(arg))
      .setPlaceholder('No preferred voice channel')
      .setChannelTypes(ChannelType.GuildVoice)
      .setMinValues(0)
      .setMaxValues(1)
      .setDefaultChannels(s.preferredVoiceChannelId ? [s.preferredVoiceChannelId] : []);
  const idleSelect = (arg: string) =>
    new StringSelectMenuBuilder()
      .setCustomId(id(arg))
      .setPlaceholder('When everyone leaves')
      .addOptions(
        opt('leave_when_empty', 'Leave', 'Leave when everyone has gone', s.idleMode, defaults.idleMode),
        opt('pause_when_empty', 'Pause', 'Play again when someone joins', s.idleMode, defaults.idleMode),
        opt('24x7', 'Keep playing (24/7)', 'Stay and keep playing', s.idleMode, defaults.idleMode),
      );
  const noticeSelect = (arg: string) =>
    new ChannelSelectMenuBuilder()
      .setCustomId(id(arg))
      .setPlaceholder('Notices off')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(0)
      .setMaxValues(1)
      .setDefaultChannels(s.notificationChannelId ? [s.notificationChannelId] : []);

  switch (screen) {
    case 'home': {
      const setupDue = !s.preferredVoiceChannelId || !station;
      c.addTextDisplayComponents(
        text(
          [
            '## Radio Bot settings',
            'Changes save straight away and apply to the whole server.',
            ...(setupDue
              ? [
                  `**Getting started:** ${s.preferredVoiceChannelId ? '✅' : '⬜'} Voice channel · ${station ? '✅' : '⬜'} Default station`,
                  '-# **Set up** goes through the main settings in four short steps.',
                ]
              : []),
          ].join('\n'),
        ),
      );
      const playing = [
        '**Playing**',
        `Default station: ${stationName}`,
        `Voice channel: ${voice}${s.voiceLock && s.preferredVoiceChannelId ? ' (locked)' : ''}`,
        `Autostart: ${onOff(s.autostart)}`,
        `Resume on restart: ${onOff(s.resumeOnRestart)}`,
      ];
      if (s.autostart && needs) playing.push(`⚠️ Autostart needs ${needs} first.`);
      if (s.voiceLock && !s.preferredVoiceChannelId)
        playing.push('⚠️ Channel lock needs a preferred voice channel first.');
      const groups: Array<[string, SettingsScreen]> = [
        [
          [
            '**Who can use it**',
            `Commands: ${mentions(s.allowedTextChannelIds, '#', 'every channel')}`,
            `Plays in: ${mentions(s.allowedVoiceChannelIds, '#', 'every voice channel')}`,
            `DJ roles: ${mentions(s.djRoleIds, '@&', 'none')}`,
            `Listener control: ${LISTENER_SHORT[s.memberControlMode]}`,
          ].join('\n'),
          'access',
        ],
        [playing.join('\n'), 'playing'],
        [
          [
            '**Sound and empty channel**',
            `Quality: ${qualityShort(s, max)}`,
            `When empty: ${IDLE_SHORT[s.idleMode]}`,
          ].join('\n'),
          'sound',
        ],
        [
          [
            '**Notices**',
            `Problem notices: ${s.notificationChannelId ? `<#${s.notificationChannelId}>` : 'off'}`,
            `Channel status: ${onOff(s.voiceChannelStatus)}`,
          ].join('\n'),
          'notices',
        ],
        [
          `**Control panel**\n${s.panelChannelId ? `Posted in <#${s.panelChannelId}>` : 'Not posted'}`,
          'panel',
        ],
      ];
      for (const [content, to] of groups)
        c.addSeparatorComponents(separator()).addSectionComponents(section(content, go(to, 'Change')));
      c.addSeparatorComponents(separator()).addActionRowComponents(
        row(
          go('setup1', 'Set up', setupDue ? ButtonStyle.Primary : ButtonStyle.Secondary),
          go('reset', 'Reset…', ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(ctx.ids.make(guildId, 'close', '', SETTINGS_TTL_MS))
            .setLabel('Close')
            .setStyle(ButtonStyle.Secondary),
        ),
      );
      break;
    }
    case 'access': {
      c.addTextDisplayComponents(
        text(
          '## Who can use it\n-# Admins (the server owner and members with Administrator) can always use everything.',
        ),
      )
        .addSeparatorComponents(separator())
        .addTextDisplayComponents(
          text('**Commands work in**\nWhere people can use `/radio`. Choose none for every channel.'),
        )
        .addActionRowComponents(
          row(
            new ChannelSelectMenuBuilder()
              .setCustomId(id('text:access'))
              .setPlaceholder('Every channel')
              .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice)
              .setMinValues(0)
              .setMaxValues(25)
              .setDefaultChannels(s.allowedTextChannelIds.slice(0, 25)),
          ),
        )
        .addTextDisplayComponents(
          text('**Radio plays in**\nThe voice channels it may join. Choose none for every voice channel.'),
        )
        .addActionRowComponents(
          row(
            new ChannelSelectMenuBuilder()
              .setCustomId(id('voice:access'))
              .setPlaceholder('Every voice channel')
              .setChannelTypes(ChannelType.GuildVoice)
              .setMinValues(0)
              .setMaxValues(25)
              .setDefaultChannels(s.allowedVoiceChannelIds.slice(0, 25)),
          ),
        )
        .addTextDisplayComponents(
          text(
            '**DJ roles**\nMembers with these roles can always control the radio, but not change settings.',
          ),
        )
        .addActionRowComponents(
          row(
            new RoleSelectMenuBuilder()
              .setCustomId(id('djs:access'))
              .setPlaceholder('No DJ roles')
              .setMinValues(0)
              .setMaxValues(25)
              .setDefaultRoles(s.djRoleIds.slice(0, 25)),
          ),
        )
        .addTextDisplayComponents(text('**Listeners**\nWho else can play, stop and skip.'))
        .addActionRowComponents(
          row(
            new StringSelectMenuBuilder()
              .setCustomId(id('member:access'))
              .setPlaceholder('Who else can control the radio')
              .addOptions(
                opt(
                  'same_channel',
                  'Listeners in the bot’s channel',
                  'Plus DJs and admins',
                  s.memberControlMode,
                  'same_channel',
                ),
                opt(
                  'none',
                  'Only DJs and admins',
                  'Listeners can only listen',
                  s.memberControlMode,
                  'same_channel',
                ),
                opt(
                  'any',
                  'Anyone',
                  'Even from outside the voice channel',
                  s.memberControlMode,
                  'same_channel',
                ),
              ),
          ),
        )
        .addSeparatorComponents(separator())
        .addActionRowComponents(row(go('home', 'Back')));
      break;
    }
    case 'playing': {
      c.addTextDisplayComponents(text('## Playing'))
        .addSeparatorComponents(separator())
        .addSectionComponents(
          section(
            `**Default station**\n${stationName}\n-# What \`/radio join\` plays, and what autostart plays.`,
            button('station:playing', 'Change'),
          ),
        )
        .addTextDisplayComponents(
          text(
            '**Preferred voice channel**\nWhere the radio plays when the person asking isn’t in a voice channel, and where autostart plays.',
          ),
        )
        .addActionRowComponents(row(voiceSelect('pvoice:playing')))
        .addSeparatorComponents(separator())
        .addSectionComponents(
          section(
            [
              '**Autostart**',
              'Play the default station in the preferred voice channel when the bot starts.',
              needs
                ? `-# ${s.autostart ? '⚠️ It does nothing yet: it needs' : 'Needs'} ${needs} first.`
                : null,
            ]
              .filter(Boolean)
              .join('\n'),
            toggle('autostart', s.autostart, needs !== null),
          ),
          section(
            [
              '**Channel lock**',
              'Only ever play in the preferred voice channel.',
              s.preferredVoiceChannelId
                ? null
                : `-# ${s.voiceLock ? '⚠️ It does nothing yet: it needs' : 'Needs'} a preferred voice channel first.`,
            ]
              .filter(Boolean)
              .join('\n'),
            toggle('lock', s.voiceLock, !s.preferredVoiceChannelId),
          ),
          section(
            '**Resume after a restart**\nCarry on playing what was playing when the bot restarts.',
            toggle('resume', s.resumeOnRestart),
          ),
        )
        .addSeparatorComponents(separator())
        .addActionRowComponents(row(go('home', 'Back')));
      break;
    }
    case 'sound': {
      c.addTextDisplayComponents(text('## Sound and empty channel'))
        .addSeparatorComponents(separator())
        .addTextDisplayComponents(
          text(
            `**Quality**\n${qualityText(s, max)}\n-# A higher bitrate can’t add detail the station’s stream doesn’t contain.`,
          ),
        )
        .addActionRowComponents(
          row(
            new StringSelectMenuBuilder()
              .setCustomId(id('quality:sound'))
              .setPlaceholder('Audio quality')
              .addOptions(
                opt(
                  'maximum',
                  'Maximum',
                  'Follow the station’s bitrate',
                  s.qualityMode,
                  defaults.qualityMode,
                ),
                opt('balanced', 'Balanced', 'Up to 128 kbps', s.qualityMode, defaults.qualityMode),
                opt('manual', 'Manual', 'A bitrate you choose', s.qualityMode, defaults.qualityMode),
              ),
          ),
        );
      if (s.qualityMode === 'manual')
        c.addSectionComponents(
          section(
            `**Manual bitrate**\n${s.manualBitrateKbps !== null ? `${s.manualBitrateKbps} kbps` : 'Not set yet, so Manual follows the station.'}`,
            button('bitrate:sound', s.manualBitrateKbps !== null ? 'Change' : 'Set'),
          ),
        );
      c.addSeparatorComponents(separator())
        .addTextDisplayComponents(
          text(`**When everyone leaves the voice channel**\nNow: ${IDLE_TEXT[s.idleMode]}.`),
        )
        .addActionRowComponents(row(idleSelect('idle:sound')))
        .addSeparatorComponents(separator())
        .addActionRowComponents(row(go('home', 'Back')));
      break;
    }
    case 'notices': {
      c.addTextDisplayComponents(text('## Notices'))
        .addSeparatorComponents(separator())
        .addTextDisplayComponents(
          text(
            '**Problem notices**\nWhere the bot reports a station failing, switching source or recovering, and leaving the channel. Choose none to turn them off.',
          ),
        )
        .addActionRowComponents(row(noticeSelect('notify:notices')))
        .addSeparatorComponents(separator())
        .addSectionComponents(
          section(
            '**Voice channel status**\nShows what is playing under the voice channel’s name.\n-# Needs the bot’s optional Set Voice Channel Status permission; without it, nothing shows.',
            toggle('vstatus', s.voiceChannelStatus),
          ),
        )
        .addSeparatorComponents(separator())
        .addActionRowComponents(row(go('home', 'Back')));
      break;
    }
    case 'panel': {
      c.addTextDisplayComponents(
        text(
          [
            '## Control panel',
            'A message with the radio’s buttons that stays in a text channel and updates by itself. Each button checks the access of whoever presses it.',
            `**Now:** ${s.panelChannelId ? `posted in <#${s.panelChannelId}>` : 'not posted'}`,
          ].join('\n'),
        ),
      )
        .addActionRowComponents(
          row(
            new ChannelSelectMenuBuilder()
              .setCustomId(id('panel:panel'))
              .setPlaceholder(s.panelChannelId ? 'Move it to…' : 'Post it in…')
              .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setMinValues(1)
              .setMaxValues(1),
          ),
        )
        .addSeparatorComponents(separator())
        .addActionRowComponents(
          row(
            go('home', 'Back'),
            ...(s.panelChannelId ? [go('unpanel', 'Remove…', ButtonStyle.Danger)] : []),
          ),
        );
      break;
    }
    case 'unpanel': {
      c.addTextDisplayComponents(
        text(
          s.panelChannelId
            ? `## Remove the control panel?\nThe panel message in <#${s.panelChannelId}> is deleted for everyone. You can post a new one at any time.`
            : '## Remove the control panel?\nThere is no control panel to remove.',
        ),
      ).addActionRowComponents(
        row(
          ...(s.panelChannelId ? [button('unpanel:panel', 'Remove it', ButtonStyle.Danger)] : []),
          go('panel', 'Cancel'),
        ),
      );
      break;
    }
    case 'reset': {
      const d = { ...s, ...ctx.guilds.defaultSettings() };
      c.addTextDisplayComponents(
        text(
          [
            '## Reset all settings?',
            'Every setting on this card goes back to its default:',
            '- Who can use it: every channel, no DJ roles, listeners control it from the bot’s voice channel',
            `- Playing: no default station or preferred voice channel; autostart and channel lock off; resume after a restart ${onOff(d.resumeOnRestart)}`,
            `- Sound: ${qualityText(d, max)}; when everyone leaves: ${IDLE_TEXT[d.idleMode]}`,
            '- Notices: problem notices off, voice channel status on',
            'Favourites, source choices, custom stations and the control panel stay as they are.',
            '-# This can’t be undone. To keep a copy of the settings first, use `/radio export`.',
          ].join('\n'),
        ),
      ).addActionRowComponents(
        row(button('reset:home', 'Reset everything', ButtonStyle.Danger), go('home', 'Cancel')),
      );
      break;
    }
    case 'setup1':
    case 'setup2':
    case 'setup3':
    case 'setup4': {
      const step = Number(screen.slice(5));
      const next = `setup${step + 1}` as SettingsScreen;
      const back: SettingsScreen = step === 1 ? 'home' : (`setup${step - 1}` as SettingsScreen);
      c.addTextDisplayComponents(
        text(`## Set up Radio Bot\n-# Step ${step} of ${SETUP_STEPS}`),
      ).addSeparatorComponents(separator());
      // Next is the recommended step once the question has an answer; until then it is Skip.
      const onward = (answered: boolean) =>
        go(next, answered ? 'Next' : 'Skip', answered ? ButtonStyle.Primary : ButtonStyle.Secondary);
      if (screen === 'setup1') {
        c.addTextDisplayComponents(
          text(
            '**Which voice channel should the radio use?**\nIt plays there when the person asking isn’t in a voice channel, and autostart plays there.',
          ),
        )
          .addActionRowComponents(row(voiceSelect('pvoice:setup1')))
          .addActionRowComponents(row(go(back, 'Back'), onward(Boolean(s.preferredVoiceChannelId))));
      } else if (screen === 'setup2') {
        c.addTextDisplayComponents(
          text(
            `**What should it play by default?**\nNow: ${stationName}\n-# \`/radio join\` plays it, and so does autostart.`,
          ),
        ).addActionRowComponents(
          row(
            go(back, 'Back'),
            button(
              'station:setup2',
              station ? 'Change station' : 'Choose a station',
              station ? ButtonStyle.Secondary : ButtonStyle.Primary,
            ),
            onward(Boolean(station)),
          ),
        );
      } else if (screen === 'setup3') {
        c.addTextDisplayComponents(text('**What should happen when everyone leaves the voice channel?**'))
          .addActionRowComponents(row(idleSelect('idle:setup3')))
          .addActionRowComponents(row(go(back, 'Back'), onward(true)));
      } else {
        c.addTextDisplayComponents(
          text(
            '**Where should the bot report problems?**\nIt posts there when a station fails, switches source or recovers, and when it leaves. Choose none to turn notices off.',
          ),
        )
          .addActionRowComponents(row(noticeSelect('notify:setup4')))
          .addActionRowComponents(row(go(back, 'Back'), onward(Boolean(s.notificationChannelId))));
      }
      break;
    }
    case 'setup5': {
      c.addTextDisplayComponents(
        text(
          [
            '## Set up Radio Bot',
            '-# Finished',
            `Preferred voice channel: ${voice}`,
            `Default station: ${stationName}`,
            `When everyone leaves: ${IDLE_TEXT[s.idleMode]}`,
            `Problem notices: ${s.notificationChannelId ? `<#${s.notificationChannelId}>` : 'off'}`,
          ].join('\n'),
        ),
      );
      // Autostart is offered only once it can work: with a station and a channel to play it in.
      if (!needs)
        c.addSeparatorComponents(separator()).addSectionComponents(
          section(
            '**Start playing by itself?**\nAutostart plays the default station in the preferred voice channel whenever the bot starts.',
            toggle('autostart', s.autostart),
          ),
        );
      c.addSeparatorComponents(separator()).addActionRowComponents(
        row(go('setup4', 'Back'), go('home', 'Done', ButtonStyle.Primary)),
      );
      break;
    }
  }
  return { components: [c], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/**
 * The default-station form: a menu of likely choices (the current default, what is playing and
 * the favourites first) and a box for any other name. `choices` is at most 24 stations.
 */
export function stationModal(
  ctx: AppContext,
  guildId: string,
  back: SettingsScreen,
  choices: readonly Station[],
  current: string | null,
  marks: (s: Station) => string,
): ModalBuilder {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(STATION_PICK)
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1)
    .setPlaceholder('Pick a station')
    .addOptions(
      {
        value: NO_DEFAULT_STATION,
        label: 'No default station',
        description: 'Clear it',
        default: current === null,
      },
      ...choices.slice(0, 24).map((st) => {
        const why = marks(st);
        return {
          value: st.id,
          label: truncate(st.displayName, 100),
          ...(why ? { description: truncate(why, 100) } : {}),
          default: st.id === current,
        };
      }),
    );
  const name = new TextInputBuilder()
    .setCustomId(STATION_NAME)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100)
    .setPlaceholder('For example: jazz');
  return new ModalBuilder()
    .setCustomId(ctx.ids.make(guildId, 'cfgm', `station:${back}`, SETTINGS_TTL_MS))
    .setTitle('Default station')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Pick a station')
        .setDescription('The current default, what is playing and favourites come first.')
        .setStringSelectMenuComponent(menu),
      new LabelBuilder()
        .setLabel('Or type a name')
        .setDescription('Part of a station’s name or an alias. Used instead of the menu.')
        .setTextInputComponent(name),
    );
}

/** The manual bitrate form: one number, checked when it is sent. */
export function bitrateModal(
  ctx: AppContext,
  guildId: string,
  back: SettingsScreen,
  current: number | null,
): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(BITRATE_INPUT)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(3)
    .setPlaceholder('For example: 192');
  if (current !== null) input.setValue(String(current));
  return new ModalBuilder()
    .setCustomId(ctx.ids.make(guildId, 'cfgm', `bitrate:${back}`, SETTINGS_TTL_MS))
    .setTitle('Manual bitrate')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Bitrate in kbps')
        .setDescription(
          `A whole number from ${MANUAL_KBPS_MIN} to ${MANUAL_KBPS_MAX}. The bot plays at most ${ctx.config.maxOpusBitrateKbps} kbps.`,
        )
        .setTextInputComponent(input),
    );
}
