'use strict';

const { ActivityType, MessageFlags } = require('discord.js');
const { REST, Routes } = require('discord.js');

// Registers slash commands (guild-scoped for instant availability when
// DISCORD_GUILD_ID is set, otherwise global) and starts the background monitor.
async function onReady(ctx, client) {
    if (ctx.readyStarted) {
        return;
    }
    ctx.readyStarted = true;
    console.log(`Logged in as ${client.user.tag}`);

    const rest = new REST().setToken(ctx.config.discordToken);
    const body = Array.from(ctx.commands.values()).map((command) => command.data.toJSON());
    try {
        if (ctx.config.guildId) {
            await rest.put(Routes.applicationGuildCommands(ctx.config.applicationId, ctx.config.guildId), { body });
            await rest.put(Routes.applicationCommands(ctx.config.applicationId), { body: [] });
            console.log(`Registered ${body.length} guild commands (globals cleared)`);
        } else {
            await rest.put(Routes.applicationCommands(ctx.config.applicationId), { body });
            console.log(`Registered ${body.length} global commands`);
        }
    } catch (error) {
        console.error('Command registration failed:', error);
    }

    const { ActivityType } = require('discord.js');
    const { startPresenceWatcher } = require('../services/presence');
    if (ctx.config.presenceIds.length > 0 && ctx.config.presenceEnabled) {
        // Presence watcher owns the bot status from now on.
        startPresenceWatcher(ctx, client);
    } else {
        client.user.setPresence({
            activities: [{ name: 'TGGLR licenses', type: ActivityType.Watching }],
            status: 'online'
        });
    }

    // Startup database check: warn if the bot migration has not been applied.
    for (const table of ['bot_events', 'audit_logs', 'hwid_bans', 'sharing_alerts', 'bot_settings']) {
        try {
            const { error } = await client.db.client.from(table).select('*').limit(1);
            if (error) {
                console.warn(`[startup] table "${table}" unavailable: ${error.message}`);
            }
        } catch (error) {
            console.warn(`[startup] table "${table}" check failed:`, error.message);
        }
    }

    // Daily automatic license backup.
    const { startDailyBackup } = require('../services/backup');
    startDailyBackup(ctx);

    await ctx.monitors.start();
}

module.exports = { onReady };
