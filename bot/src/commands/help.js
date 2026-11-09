'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { COLORS, base } = require('../utils/format');

const DATA = new SlashCommandBuilder()
    .setName('help')
    .setDescription('LicenseManagerTGG command overview');

module.exports = {
    data: DATA,
    async execute(interaction) {
        const embed = base('LicenseManagerTGG \u2014 Commands', COLORS.primary);
        embed.description = [
            '**License** \u2014 `/license help`',
            'Create, list, inspect, revoke, delete, enable/disable, clear HWID, transfer, history, search, expiring, bulk-create, sharing alerts.',
            '',
            '**Devices (HWID)** \u2014 `/hwid help`',
            'Ban, unban, lookup, list, info, history.',
            '',
            '**Login monitoring** \u2014 `/login help`',
            'Enable/disable notifications, channel, stop, status.',
            '',
            '**Server activity** \u2014 `/server help`',
            'Session join/leave notifications for verified TGGLR clients.',
            '',
            '**Notifications** \u2014 `/notifications status`',
            'Global and per-type settings, test delivery.',
            '',
            '**Admin / System** \u2014 `/admin`, `/system`',
            'Stats, logs, permissions, maintenance, backup, client version, health, announcements.'
        ].join('\n');
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
};
