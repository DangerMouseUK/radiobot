import { createHash } from 'node:crypto';
import { REST, Routes } from 'discord.js';
import { type Logger, safeErr } from '../observability/logger.ts';
import type { MetaRepository } from '../persistence/repositories/guilds.ts';
import { buildRadioCommand } from './commands/definitions.ts';

export function commandsHash(): string {
  return createHash('sha256')
    .update(JSON.stringify([buildRadioCommand()]))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Registers /radio as a *guild* command (instant, guild-only by default — PRD FR-009).
 * Skips the REST call when the definition for that guild has not changed.
 */
export async function registerGuildCommands(
  token: string,
  applicationId: string,
  guildIds: string[],
  meta: MetaRepository | null,
  logger: Logger,
  force = false,
): Promise<number> {
  const rest = new REST({ version: '10' }).setToken(token);
  const body = [buildRadioCommand()];
  const hash = commandsHash();
  let updated = 0;
  for (const guildId of guildIds) {
    const key = `commands.hash.${guildId}`;
    if (!force && meta?.get(key) === hash) continue;
    try {
      await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
      meta?.set(key, hash);
      updated++;
    } catch (err) {
      logger.warn({ guildId, err: safeErr(err) }, 'command registration failed for guild');
    }
  }
  if (updated > 0) logger.info({ updated }, 'slash commands registered');
  return updated;
}
