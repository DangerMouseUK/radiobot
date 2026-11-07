import {
  type APIApplicationCommandOption,
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  InteractionContextType,
} from 'discord.js';
import { describe, expect, it } from 'vitest';
import { OPUS_ENCODER_MAX_KBPS, OPUS_MIN_KBPS } from '../../src/audio/encoder.ts';
import { buildRadioCommand } from '../../src/discord/commands/definitions.ts';
import { commandsHash } from '../../src/discord/register.ts';
import { MANUAL_KBPS_MAX, MANUAL_KBPS_MIN } from '../../src/discord/ui/settings-view.ts';
import { parseListArg } from '../../src/discord/ui/views.ts';
import { MAX_QUEUE_LENGTH } from '../../src/persistence/repositories/guilds.ts';
import { MAX_URL_LENGTH } from '../../src/streams/url-policy.ts';

/** Discord application-command limits (developer docs, "Application Commands"). */
const NAME = /^[-_\p{L}\p{N}]{1,32}$/u;
const MAX_OPTIONS = 25;
const MAX_DESCRIPTION = 100;
const MAX_CHOICES = 25;
const MAX_COMBINED_CHARS = 4000;

const cmd = buildRadioCommand();
const top = (cmd.options ?? []) as APIApplicationCommandOption[];

type AnyOption = APIApplicationCommandOption & {
  options?: AnyOption[];
  choices?: Array<{ name: string; value: string | number }>;
  required?: boolean;
  autocomplete?: boolean;
  min_value?: number;
  max_value?: number;
  max_length?: number;
};

function allOptions(list: AnyOption[], path = ''): Array<{ path: string; o: AnyOption }> {
  return list.flatMap((o) => [
    { path: `${path}${o.name}`, o },
    ...allOptions(o.options ?? [], `${path}${o.name} `),
  ]);
}

const flat = allOptions(top as AnyOption[]);
const find = (path: string): AnyOption => {
  const hit = flat.find((x) => x.path === path);
  if (!hit) throw new Error(`no option ${path}`);
  return hit.o;
};
const isSub = (o: AnyOption) =>
  o.type === ApplicationCommandOptionType.Subcommand ||
  o.type === ApplicationCommandOptionType.SubcommandGroup;

describe('/radio command definition (Discord limits)', () => {
  it('is a single guild-only command with exactly 25 top-level subcommands/groups', () => {
    expect(cmd.name).toBe('radio');
    expect(cmd.contexts).toEqual([InteractionContextType.Guild]);
    expect(cmd.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
    expect(top).toHaveLength(MAX_OPTIONS);
    expect(top.every((o) => isSub(o as AnyOption))).toBe(true);
    expect(new Set(top.map((o) => o.name)).size).toBe(top.length);
  });

  it('keeps every name lower-case, valid and unique among its siblings', () => {
    expect(cmd.name).toMatch(NAME);
    for (const { path, o } of flat) {
      expect(o.name, path).toMatch(NAME);
      expect(o.name, path).toBe(o.name.toLowerCase());
      const siblings = o.options ?? [];
      expect(new Set(siblings.map((s) => s.name)).size, path).toBe(siblings.length);
    }
  });

  it('keeps every description between 1 and 100 characters', () => {
    expect(cmd.description.length).toBeGreaterThan(0);
    expect(cmd.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    for (const { path, o } of flat) {
      expect(o.description.length, path).toBeGreaterThan(0);
      expect(o.description.length, path).toBeLessThanOrEqual(MAX_DESCRIPTION);
    }
  });

  it('nests correctly: groups hold only subcommands, subcommands hold only values, ≤25 each', () => {
    for (const { path, o } of flat) {
      const children = o.options ?? [];
      expect(children.length, path).toBeLessThanOrEqual(MAX_OPTIONS);
      if (o.type === ApplicationCommandOptionType.SubcommandGroup) {
        expect(children.length, path).toBeGreaterThan(0);
        expect(
          children.every((c) => c.type === ApplicationCommandOptionType.Subcommand),
          path,
        ).toBe(true);
      } else if (o.type === ApplicationCommandOptionType.Subcommand) {
        expect(children.some(isSub), path).toBe(false);
      }
    }
  });

  it('lists required options before optional ones', () => {
    for (const { path, o } of flat.filter((x) => x.o.type === ApplicationCommandOptionType.Subcommand)) {
      const req = (o.options ?? []).map((c) => Boolean(c.required));
      const firstOptional = req.indexOf(false);
      if (firstOptional >= 0) expect(req.slice(firstOptional).includes(true), path).toBe(false);
    }
  });

  it('never combines autocomplete with fixed choices and keeps choices within limits', () => {
    for (const { path, o } of flat) {
      if (!o.choices) continue;
      expect(o.autocomplete ?? false, path).toBe(false);
      expect(o.choices.length, path).toBeLessThanOrEqual(MAX_CHOICES);
      for (const c of o.choices) {
        expect(c.name.length, path).toBeGreaterThan(0);
        expect(c.name.length, path).toBeLessThanOrEqual(100);
        expect(String(c.value).length, path).toBeLessThanOrEqual(100);
      }
    }
  });

  it('stays under the combined name/description/value size limit', () => {
    let total = cmd.name.length + cmd.description.length;
    for (const { o } of flat) {
      total += o.name.length + o.description.length;
      for (const c of o.choices ?? []) total += c.name.length + String(c.value).length;
    }
    expect(total).toBeLessThanOrEqual(MAX_COMBINED_CHARS);
  });
});

describe('/radio option ranges agree with the code that consumes them', () => {
  it('the settings card’s manual bitrate spans the Opus encoder range', () => {
    expect(MANUAL_KBPS_MIN).toBe(OPUS_MIN_KBPS);
    expect(MANUAL_KBPS_MAX).toBe(OPUS_ENCODER_MAX_KBPS);
  });

  it('config has no options, so the picker shows it as one plain command', () => {
    // Every setting is on its card; options made people think the command needed them.
    expect(find('config').options ?? []).toEqual([]);
  });

  it('queue remove positions cover the whole queue', () => {
    const o = find('queue remove position');
    expect(o.required).toBe(true);
    expect(o.min_value).toBe(1);
    expect(o.max_value).toBe(MAX_QUEUE_LENGTH);
  });

  it('custom station URLs may be as long as the URL policy allows', () => {
    expect(find('add url').max_length).toBe(MAX_URL_LENGTH);
    expect(find('edit url').max_length).toBe(MAX_URL_LENGTH);
  });

  it('list scope choices are exactly the scopes the list view understands', () => {
    const values = (find('list scope').choices ?? []).map((c) => String(c.value));
    expect(values).toEqual(['all', 'packs', 'custom', 'favourites']);
    for (const v of values) expect(parseListArg(`${v}_:p0`).scope).toBe(v);
  });

  it('/radio edit can change everything /radio add sets, apart from the station itself', () => {
    const optionNames = (sub: string) =>
      flat.filter((x) => x.path.startsWith(`${sub} `)).map((x) => x.o.name);
    expect(optionNames('edit').filter((n) => n !== 'station')).toEqual(optionNames('add'));
  });

  it('every station-taking subcommand uses an autocompleted, required station option', () => {
    const stationOpts = flat.filter((x) => x.o.name === 'station');
    expect(stationOpts.length).toBeGreaterThanOrEqual(10);
    for (const { path, o } of stationOpts) {
      expect(o.type, path).toBe(ApplicationCommandOptionType.String);
      expect(o.required, path).toBe(true);
      expect(o.autocomplete, path).toBe(true);
      expect(o.max_length, path).toBe(100);
    }
  });

  it('identity review verdicts are verified, mismatch or clear', () => {
    expect((find('source verify verdict').choices ?? []).map((c) => c.value)).toEqual([
      'verified',
      'mismatch',
      'clear',
    ]);
  });
});

describe('command registration hash', () => {
  it('is a stable 16-hex-digit fingerprint of the definition', () => {
    expect(commandsHash()).toMatch(/^[0-9a-f]{16}$/);
    expect(commandsHash()).toBe(commandsHash());
  });
});
