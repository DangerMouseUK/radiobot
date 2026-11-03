import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageActionRowComponentBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import {
  countryName,
  type LibraryIndex,
  type LibraryPack,
  languageName,
  searchLibrary,
} from '../../catalogue/pack-library.ts';
import type { StationPack } from '../../catalogue/packs.ts';
import { truncate } from '../../shared/text.ts';
import type { AppContext } from '../context.ts';
import { COLOR, DISCLAIMER } from './format.ts';
import type { View } from './views.ts';

const row = (...c: MessageActionRowComponentBuilder[]) =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...c);

/** Packs listed per message: a select menu holds at most 25 choices. */
const MAX_LISTED = 25;

function origin(p: StationPack): string {
  if (p.origin === 'installed') return 'installed from the library';
  if (p.origin === 'extra') return 'your own pack (EXTRA_PACKS_DIR)';
  return 'shipped with the bot';
}

function ownerText(owner: LibraryPack['owner'] | StationPack['meta']['owner']): string | null {
  if (!owner) return null;
  return owner.brand ? `${owner.brand} (${owner.name})` : owner.name;
}

/** `/radio packs installed`: every loaded pack, updates, skipped packs and notices. */
export function packsInstalledView(ctx: AppContext, guildId: string): View {
  const packs = ctx.packs.packs;
  const updates = ctx.packManager.updates;
  const lines = packs.map((p) => {
    const parts = [
      `**${p.meta.name}** (\`${p.meta.id}\`)`,
      p.meta.version ? `version ${p.meta.version}` : null,
      `${p.stations.length} stations`,
      origin(p),
      ctx.packs.isEnabled(p.meta.id) ? null : 'switched off (DISABLED_PACKS or ENABLED_PACKS)',
      updates.has(p.meta.id) ? `**update available: ${updates.get(p.meta.id)}**` : null,
    ];
    return parts.filter(Boolean).join(' · ');
  });
  const embed = new EmbedBuilder()
    .setTitle('Station packs')
    .setColor(COLOR.info)
    .setDescription(
      truncate(
        lines.join('\n') ||
          'No station packs are installed yet. Find some with `/radio packs library`, or with `radio-bot packs browse` on the server.',
        4000,
      ),
    );
  if (ctx.packs.skipped.length) {
    embed.addFields({
      name: 'Not loaded',
      value: truncate(ctx.packs.skipped.map((s) => `\`${s.dir}\`: ${s.reason}`).join('\n'), 1024),
    });
  }
  if (ctx.packManager.notices.length) {
    embed.addFields({ name: 'Notices', value: truncate(ctx.packManager.notices.join('\n'), 1024) });
  }
  embed.setFooter({ text: DISCLAIMER });
  const installed = packs.filter((p) => p.origin === 'installed').slice(0, MAX_LISTED);
  const components = installed.length
    ? [
        row(
          new StringSelectMenuBuilder()
            .setCustomId(ctx.ids.make(guildId, 'pksel', 'installed'))
            .setPlaceholder('Choose a pack to update or remove')
            .addOptions(
              installed.map((p) => ({
                label: truncate(p.meta.name, 100),
                value: p.meta.id,
                description: truncate(
                  `${p.meta.id} · ${updates.has(p.meta.id) ? 'update available' : `version ${p.meta.version ?? 'unknown'}`}`,
                  100,
                ),
              })),
            ),
        ),
      ]
    : [];
  return { embeds: [embed], components };
}

export interface LibraryFilter {
  words: string | null;
  country: string | null;
}

/** A country filter as typed: a code ("GB") or a name ("United Kingdom"), matched against the index. */
export function resolveCountry(index: LibraryIndex, typed: string | null): string | null {
  if (!typed) return null;
  const t = typed.trim().toLowerCase();
  const codes = new Set(index.packs.flatMap((p) => p.countries));
  for (const c of codes) if (c.toLowerCase() === t || countryName(c).toLowerCase() === t) return c;
  return typed.trim().toUpperCase().slice(0, 2);
}

/** `/radio packs library`: what the official library offers, filtered, with an install menu. */
export function packsLibraryView(
  ctx: AppContext,
  guildId: string,
  index: LibraryIndex,
  f: LibraryFilter,
): View {
  const country = resolveCountry(index, f.country);
  const found = searchLibrary(index, { words: f.words, country });
  const filters = [f.words ? `“${f.words}”` : null, country ? countryName(country) : null].filter(Boolean);
  const lines = found.slice(0, MAX_LISTED).map((p) => {
    const where = p.countries.map(countryName).join(', ');
    const owner = ownerText(p.owner);
    const loaded = ctx.packs.get(p.id);
    const state = loaded ? (ctx.packManager.updates.has(p.id) ? ' · update available' : ' · installed') : '';
    return `**${p.name}** (\`${p.id}\`) · ${p.stations} stations${where ? ` · ${where}` : ''}${owner ? ` · ${owner}` : ''}${state}`;
  });
  const embed = new EmbedBuilder()
    .setTitle(`Pack library${filters.length ? `: ${filters.join(', ')}` : ''}`)
    .setColor(COLOR.info)
    .setDescription(
      truncate(
        lines.length ? lines.join('\n') : 'No packs match that. Try fewer words, or leave out the country.',
        4000,
      ),
    )
    .setFooter({
      text: truncate(
        `${found.length > MAX_LISTED ? `Showing ${MAX_LISTED} of ${found.length}: narrow it down with search or country. ` : ''}${DISCLAIMER}`,
        2048,
      ),
    });
  const components = found.length
    ? [
        row(
          new StringSelectMenuBuilder()
            .setCustomId(ctx.ids.make(guildId, 'pksel', 'library'))
            .setPlaceholder('Choose a pack to see it and install it')
            .addOptions(
              found.slice(0, MAX_LISTED).map((p) => ({
                label: truncate(p.name, 100),
                value: p.id,
                description: truncate(`${p.id} · ${p.stations} stations`, 100),
              })),
            ),
        ),
      ]
    : [];
  return { embeds: [embed], components };
}

/**
 * One pack: what the library says about it and what is installed, with Install, Update or Remove.
 * `entry` is null when the library couldn't be reached or doesn't list it.
 */
export function packCardView(
  ctx: AppContext,
  guildId: string,
  id: string,
  entry: LibraryPack | null,
  note: string | null = null,
): View {
  const loaded = ctx.packs.get(id);
  const name = entry?.name ?? loaded?.meta.name ?? id;
  const embed = new EmbedBuilder().setTitle(`${name} (${id})`).setColor(COLOR.info);
  const description = entry?.description || loaded?.meta.description;
  if (description) embed.setDescription(truncate(description, 1000));
  const owner = ownerText(entry?.owner ?? loaded?.meta.owner ?? null);
  const countries = entry?.countries ?? loaded?.meta.countries ?? [];
  const languages = entry?.languages ?? loaded?.meta.languages ?? [];
  const facts = [
    owner ? `Company: ${owner}` : null,
    `Stations: ${entry?.stations ?? loaded?.stations.length ?? 0}`,
    countries.length ? `Countries: ${countries.map(countryName).join(', ')}` : null,
    languages.length ? `Languages: ${languages.map(languageName).join(', ')}` : null,
    entry ? `Streams last checked: ${entry.lastChecked ?? 'not recorded'}` : null,
    entry
      ? `Library version: ${entry.version}`
      : 'The pack library doesn’t list this pack (or couldn’t be reached).',
    loaded ? `Installed version: ${loaded.meta.version ?? 'unknown'} · ${origin(loaded)}` : 'Not installed.',
  ].filter(Boolean);
  embed.addFields({ name: 'About', value: truncate(facts.join('\n'), 1024) });
  if (note) embed.addFields({ name: 'Result', value: truncate(note, 1024) });
  embed.setFooter({ text: DISCLAIMER });

  const buttons: ButtonBuilder[] = [];
  const installable = entry?.status === 'available' && (!loaded || loaded.origin === 'installed');
  if (installable && (!loaded || ctx.packManager.updates.has(id))) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, 'pkinst', id))
        .setLabel(loaded ? `Update to ${entry.version}` : 'Install')
        .setStyle(ButtonStyle.Success),
    );
  }
  if (loaded?.origin === 'installed') {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, 'pkrm', id))
        .setLabel('Remove')
        .setStyle(ButtonStyle.Danger),
    );
  }
  return { embeds: [embed], components: buttons.length ? [row(...buttons)] : [] };
}

/** Asks before removing a pack. */
export function packRemoveConfirmView(ctx: AppContext, guildId: string, id: string): View {
  const name = ctx.packs.get(id)?.meta.name ?? id;
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`Remove ${name}?`)
        .setColor(COLOR.warn)
        .setDescription(
          'Its stations disappear from every server this bot is in, and anything playing one of them stops. Favourites and queues are kept, so they come back if the pack is installed again.',
        ),
    ],
    components: [
      row(
        new ButtonBuilder()
          .setCustomId(ctx.ids.make(guildId, 'pkrmok', id))
          .setLabel('Remove it')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(ctx.ids.make(guildId, 'close'))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}
