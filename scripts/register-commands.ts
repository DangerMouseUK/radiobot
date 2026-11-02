/**
 * Registers the /radio guild command without starting the bot.
 *   node dist/scripts/register-commands.js [guildId ...]
 * With no guild IDs, uses DISCORD_DEV_GUILD_ID, or every guild the bot is in.
 */
import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/config/env.ts';
import { registerGuildCommands } from '../src/discord/register.ts';
import { createLogger } from '../src/observability/logger.ts';

const config = loadConfig();
const logger = createLogger(config.logLevel, [config.discordToken]);
let guildIds = process.argv.slice(2).filter((a) => /^\d{17,20}$/.test(a));
if (guildIds.length === 0 && config.devGuildId) guildIds = [config.devGuildId];
if (guildIds.length === 0) {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const guilds = (await rest.get(Routes.userGuilds())) as Array<{ id: string }>;
  guildIds = guilds.map((g) => g.id);
}
const n = await registerGuildCommands(
  config.discordToken,
  config.applicationId,
  guildIds,
  null,
  logger,
  true,
);
process.stdout.write(`Registered /radio in ${n} of ${guildIds.length} server(s).\n`);
