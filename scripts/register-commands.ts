/**
 * Registers the /radio guild command without starting the bot.
 *   node dist/scripts/register-commands.js [guildId ...]
 * With no guild IDs, uses DISCORD_DEV_GUILD_ID, or every guild the bot is in. Exits 0 when every
 * server was registered, 1 when any failed (the log says why), and 2 for an argument that isn't a
 * server ID.
 */
import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/config/env.ts';
import { registerGuildCommands } from '../src/discord/register.ts';
import { createLogger } from '../src/observability/logger.ts';

/** Discord returns at most this many servers per request for the bot's server list. */
const GUILD_PAGE = 200;

const args = process.argv.slice(2);
const notIds = args.filter((a) => !/^\d{17,20}$/.test(a));
if (notIds.length) {
  process.stderr.write(
    `Not a server ID: ${notIds.join(', ')}. Give server IDs only (17 to 20 digits), or none for every server.\n`,
  );
  process.exit(2);
}
const config = loadConfig();
const logger = createLogger(config.logLevel, [config.discordToken]);
let guildIds = [...new Set(args)];
if (guildIds.length === 0 && config.devGuildId) guildIds = [config.devGuildId];
if (guildIds.length === 0) {
  // The list comes a page at a time, in ID order: ask for the next page after the last ID seen.
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  let after: string | null = null;
  for (;;) {
    const query = new URLSearchParams({ limit: String(GUILD_PAGE) });
    if (after) query.set('after', after);
    const page = (await rest.get(Routes.userGuilds(), { query })) as Array<{ id: string }>;
    guildIds.push(...page.map((g) => g.id));
    const last = page[page.length - 1]?.id ?? null;
    if (page.length < GUILD_PAGE || !last || last === after) break;
    after = last;
  }
  guildIds = [...new Set(guildIds)];
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
if (n < guildIds.length) process.exit(1);
