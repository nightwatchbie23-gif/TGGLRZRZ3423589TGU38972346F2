'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const api = require('../services/api');
const { COLORS, base, error, success } = require('../utils/format');

const DATA = new SlashCommandBuilder()
    .setName('system')
    .setDescription('System tools')
    .addSubcommand((sc) => sc.setName('health').setDescription('Check backend and database connectivity'))
    .addSubcommand((sc) => sc
        .setName('announcement')
        .setDescription('Post an announcement embed to the global channel')
        .addStringOption((opt) => opt.setName('message').setDescription('Announcement text').setRequired(true)))
    .addSubcommand((sc) => sc.setName('help').setDescription('Show system command help'));

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        switch (interaction.options.getSubcommand()) {
            case 'health': return subHealth(interaction, ctx);
            case 'announcement': return subAnnouncement(interaction, ctx);
            case 'help': {
                const embed = base('System Commands', COLORS.primary);
                embed.description = [
                    '`/system health` \u2013 backend API + Supabase connectivity check',
                    '`/system announcement` \u2013 post an announcement to the global channel'
                ].join('\n');
                return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /system help.')], flags: MessageFlags.Ephemeral });
        }
    }
};

async function subHealth(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const checks = [];

    const apiStart = Date.now();
    try {
        await api.listLicenses(ctx.config, { limit: 1 });
        checks.push({ name: 'Backend API', value: `online (${Date.now() - apiStart} ms)`, online: true });
    } catch (error_) {
        checks.push({ name: 'Backend API', value: `offline \u2014 ${error_.message}`, online: false });
    }

    const dbStart = Date.now();
    try {
        const { error: dbError } = await ctx.db.client.from('licenses').select('license_key').limit(1);
        if (dbError) {
            throw new Error(dbError.message);
        }
        checks.push({ name: 'Supabase', value: `online (${Date.now() - dbStart} ms)`, online: true });
    } catch (error_) {
        checks.push({ name: 'Supabase', value: `unavailable \u2014 ${error_.message}`, online: false });
    }

    const monitorActive = Boolean(ctx.monitors && ctx.monitors.pollTimer);
    checks.push({ name: 'Event monitor', value: monitorActive ? `running (poll ${ctx.config.pollIntervalMs} ms)` : 'stopped', online: monitorActive });

    const embed = base('System Health', checks.every((check) => check.online) ? COLORS.success : COLORS.error);
    embed.description = checks.map((check) => `${check.online ? '\u2705' : '\u274c'} **${check.name}** \u2014 ${check.value}`).join('\n');
    return interaction.editReply({ embeds: [embed] });
}

async function subAnnouncement(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = interaction.options.getString('message', true).slice(0, 1500);
    const channelId = ctx.notifications.channels.global;
    if (!channelId) {
        return interaction.editReply({ embeds: [error('No Channel', 'Set a global channel first: /notifications channel type:global channel:#channel.')] });
    }
    try {
        const channel = await ctx.config.client.channels.fetch(channelId);
        const embed = base('Announcement', COLORS.primary);
        embed.description = message;
        await channel.send({ embeds: [embed] });
        await ctx.db.audit('announcement_sent', { actor: interaction.user.id });
        return interaction.editReply({ embeds: [success('Announcement Sent', `Posted in <#${channelId}>.`)] });
    } catch (error_) {
        return interaction.editReply({ embeds: [error('Send Failed', error_.message)] });
    }
}
