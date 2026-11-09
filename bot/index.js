'use strict';

// LicenseManagerTGG - Discord license management bot for TGGLR.
// Runs as a separate persistent Node.js process; the Vercel backend remains
// the source of truth for licenses.

const { Client, GatewayIntentBits } = require('discord.js');

const { getConfig } = require('./src/config');
const { BotDatabase } = require('./src/services/db');
const api = require('./src/services/api');
const { NotificationService } = require('./src/services/notifications');
const { Monitor } = require('./src/services/monitor');
const { onReady } = require('./src/events/ready');
const { onInteractionCreate } = require('./src/events/interactionCreate');

const COMMANDS = [
    require('./src/commands/help'),
    require('./src/commands/license'),
    require('./src/commands/hwid'),
    require('./src/commands/login'),
    require('./src/commands/server'),
    require('./src/commands/notifications'),
    require('./src/commands/admin'),
    require('./src/commands/system')
];

async function main() {
    let config;
    try {
        config = getConfig();
    } catch (error) {
        console.error('Configuration error:', error.message);
        console.error('Copy bot/.env.example to bot/.env and fill in your values.');
        process.exit(1);
    }

    const client = new Client({
        intents: [GatewayIntentBits.Guilds]
    });

    const db = new BotDatabase(config);
    config.client = client;
    const notifications = new NotificationService(db, config);
    const monitors = new Monitor(client, config, db, notifications);
    await notifications.loadState();

    const commandMap = new Map(COMMANDS.map((command) => [command.data.name, command]));
    const ctx = { config, db, api, notifications, monitors, commands: commandMap };
    client.db = db;
    client.commands = commandMap;

    client.once('ready', () => onReady(ctx, client));
    client.on('interactionCreate', (interaction) => onInteractionCreate(ctx, interaction));

    process.on('SIGINT', () => shutdown(client, monitors));
    process.on('SIGTERM', () => shutdown(client, monitors));

    console.log(`LicenseManagerTGG starting (API: ${config.apiUrl}, admins: ${config.adminUserIds.size})`);
    await client.login(config.discordToken);
}

function shutdown(client, monitors) {
    console.log('Shutting down...');
    try {
        monitors.stop();
        client.destroy();
    } catch {
        // ignore
    }
    process.exit(0);
}

main().catch((error) => {
    console.error('Fatal startup error:', error.message);
    process.exit(1);
});
