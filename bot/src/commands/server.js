'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { COLORS, base, error, info, success } = require('../utils/format');

const DATA = new SlashCommandBuilder()
    .setName('server')
    .setDescription('TGGLR server error logs')
    .addSubcommand((sc) => sc.setName('help').setDescription('Show server command help'))
    .addSubcommand((sc) => sc.setName('enable').setDescription('Enable server error notifications'))
    .addSubcommand((sc) => sc.setName('disable').setDescription('Disable server error notifications'))
    .addSubcommand((sc) => sc.setName('status').setDescription('Current server error notification settings'))
    .addSubcommand((sc) => sc
        .setName('channel')
        .setDescription('Set the error notification channel')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Target channel (omit to clear)').setRequired(false)))
    .addSubcommand((sc) => sc
        .setName('stop')
        .setDescription('Stop error notifications and clear the channel'));

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
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /server help.')], flags: MessageFlags.Ephemeral });
        }
    }
};

function subHelp(interaction) {
    const embed = base('Server Commands', COLORS.primary);
    embed.description = [
        '`/server enable` - enable server error notifications',
        '`/server disable` - disable server error notifications',
        '`/server channel` - set or clear the error notification channel',
        '`/server status` - show current settings',
        '`/server stop` - stop notifications and clear the channel',
        '',
        'Server logs only send when there is a problem or error.'
    ].join('\n');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function setEnabled(interaction, ctx, enabled) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await ctx.notifications.setType('server_error', enabled);
    return interaction.editReply({
        embeds: [enabled
            ? success('Server Error Notifications Enabled', 'Server errors will be posted to the configured channel.')
            : info('Server Error Notifications Disabled', 'Server error notifications are off.')]
    });
}

async function setChannel(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.options.getChannel('channel');
    if (channel) {
        await ctx.notifications.setChannel('server_error', channel.id);
        return interaction.editReply({ embeds: [success('Channel Set', `Server errors will be posted in <#${channel.id}>.`)] });
    }
    await ctx.notifications.setChannel('server_error', null);
    return interaction.editReply({ embeds: [info('Channel Cleared', 'Server errors fall back to the global channel (if configured).')] });
}

async function subStop(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await ctx.notifications.setType('server_error', false);
    await ctx.notifications.setChannel('server_error', null);
    return interaction.editReply({
        embeds: [info('Server Error Notifications Stopped', 'Notifications disabled and channel cleared.')]
    });
}

async function subStatus(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const status = await ctx.notifications.status();
    const entry = status.types.server_error;
    const embed = base('Server Error Notification Status', COLORS.primary);
    embed.description = [
        `Global channel: ${status.globalChannel}`,
        `\`server_error\` - ${entry.enabled ? 'on' : 'off'} - ${entry.target}`,
        '',
        'Server logs only send when there is a problem or error.'
    ].join('\n');
    return interaction.editReply({ embeds: [embed] });
}
