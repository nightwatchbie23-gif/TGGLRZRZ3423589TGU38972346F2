'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { COLORS, base, error, info, success } = require('../utils/format');
const { TYPES } = require('../services/notifications');

const DATA = new SlashCommandBuilder()
    .setName('login')
    .setDescription('Login monitoring notifications')
    .addSubcommand((sc) => sc.setName('help').setDescription('Show login command help'))
    .addSubcommand((sc) => sc.setName('enable').setDescription('Enable login notifications'))
    .addSubcommand((sc) => sc.setName('disable').setDescription('Disable login notifications (validation is unaffected)'))
    .addSubcommand((sc) => sc.setName('status').setDescription('Current login notification settings'))
    .addSubcommand((sc) => sc
        .setName('channel')
        .setDescription('Set the login notification channel')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Target channel (omit to clear)').setRequired(false)))
    .addSubcommand((sc) => sc
        .setName('stop')
        .setDescription('Stop login notifications and clear the channel'));

const LOGIN_TYPES = ['login_success', 'login_failure'];

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        switch (interaction.options.getSubcommand()) {
            case 'help': return subHelp(interaction);
            case 'enable': return setEnabled(interaction, ctx, true);
            case 'disable': return setEnabled(interaction, ctx, false);
            case 'channel': return setChannel(interaction, ctx);
            case 'stop': return subStop(interaction, ctx);
            case 'status': return subStatus(interaction, ctx);
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /login help.')], flags: MessageFlags.Ephemeral });
        }
    }
};

function subHelp(interaction) {
    const embed = base('Login Commands', COLORS.primary);
    embed.description = [
        '`/login enable` \u2013 enable login notifications',
        '`/login disable` \u2013 disable notifications only (monitoring/logging continue)',
        '`/login channel` \u2013 set or clear the notification channel',
        '`/login status` \u2013 show current settings',
        '`/login stop` \u2013 stop notifications and clear the channel',
        '',
        'Events originate from backend verification results. Stopping',
        'notifications never stops license validation or enforcement.'
    ].join('\n');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function setEnabled(interaction, ctx, enabled) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    for (const type of LOGIN_TYPES) {
        await ctx.notifications.setType(type, enabled);
    }
    return interaction.editReply({
        embeds: [enabled
            ? success('Login Notifications Enabled', 'Successful and failed logins will be posted to the configured channel.')
            : info('Login Notifications Disabled', 'Notifications are off. License validation and logging are unaffected.')]
    });
}

async function setChannel(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.options.getChannel('channel');
    if (channel) {
        await ctx.notifications.setChannel('login', channel.id);
        return interaction.editReply({ embeds: [success('Channel Set', `Login notifications will be posted in <#${channel.id}>.`)] });
    }
    await ctx.notifications.setChannel('login', null);
    return interaction.editReply({ embeds: [info('Channel Cleared', 'Login notifications fall back to the global channel (if configured).')] });
}

async function subStop(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await setEnabledTypes(ctx, false);
    await ctx.notifications.setChannel('login', null);
    return interaction.editReply({
        embeds: [info('Login Notifications Stopped', 'Notifications disabled and channel cleared. License validation and logging are unaffected.')]
    });
}

async function setEnabledTypes(ctx, enabled) {
    for (const type of LOGIN_TYPES) {
        await ctx.notifications.setType(type, enabled);
    }
}

async function subStatus(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const status = await ctx.notifications.status();
    const lines = LOGIN_TYPES.map((type) => {
        const entry = status.types[type];
        return `\`${type}\` \u2014 ${entry.enabled ? 'on' : 'off'} \u2014 ${entry.target}`;
    });
    const embed = base('Login Notification Status', COLORS.primary);
    embed.description = [
        `Global channel: ${status.globalChannel}`,
        ...lines,
        '',
        'Monitoring/logging: always active.'
    ].join('\n');
    return interaction.editReply({ embeds: [embed] });
}
