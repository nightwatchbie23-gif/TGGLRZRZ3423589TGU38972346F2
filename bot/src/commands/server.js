'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { COLORS, base, error, info, success } = require('../utils/format');

const DATA = new SlashCommandBuilder()
    .setName('server')
    .setDescription('TGGLR client session activity')
    .addSubcommand((sc) => sc.setName('help').setDescription('Show server command help'))
    .addSubcommand((sc) => sc.setName('enable').setDescription('Enable session join/leave notifications'))
    .addSubcommand((sc) => sc.setName('disable').setDescription('Disable session notifications'))
    .addSubcommand((sc) => sc.setName('status').setDescription('Current session notification settings'))
    .addSubcommand((sc) => sc
        .setName('channel')
        .setDescription('Set the session notification channel')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Target channel (omit to clear)').setRequired(false)))
    .addSubcommand((sc) => sc
        .setName('stop')
        .setDescription('Stop session notifications and clear the channel'));

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        switch (interaction.options.getSubcommand()) {
            case 'help': return subHelp();
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

function subHelp() {
    const embed = base('Server Commands', COLORS.primary);
    embed.description = [
        '`/server enable` \u2013 enable session join/leave notifications',
        '`/server disable` \u2013 disable session notifications',
        '`/server channel` \u2013 set or clear the notification channel',
        '`/server status` \u2013 show current settings',
        '`/server stop` \u2013 stop notifications and clear the channel',
        '',
        'Tracks only verified TGGLR client sessions (join/leave derived from',
        "successful license verifications). Other players' data, DMs and chat",
        'content are never collected.'
    ].join('\n');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function setEnabled(interaction, ctx, enabled) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await ctx.notifications.setType('server', enabled);
    return interaction.editReply({
        embeds: [enabled
            ? success('Session Notifications Enabled', 'Client session join/leave events will be posted to the configured channel.')
            : info('Session Notifications Disabled', 'Session notifications are off. Monitoring logs continue server-side.')]
    });
}

async function setChannel(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.options.getChannel('channel');
    if (channel) {
        await ctx.notifications.setChannel('server', channel.id);
        return interaction.editReply({ embeds: [success('Channel Set', `Session notifications will be posted in <#${channel.id}>.`)] });
    }
    await ctx.notifications.setChannel('server', null);
    return interaction.editReply({ embeds: [info('Channel Cleared', 'Session notifications fall back to the global channel (if configured).')] });
}

async function subStop(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await ctx.notifications.setType('server', false);
    await ctx.notifications.setChannel('server', null);
    return interaction.editReply({
        embeds: [info('Session Notifications Stopped', 'Notifications disabled and channel cleared.')]
    });
}

async function subStatus(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const status = await ctx.notifications.status();
    const entry = status.types.server;
    const embed = base('Session Notification Status', COLORS.primary);
    embed.description = [
        `Global channel: ${status.globalChannel}`,
        `\`server\` \u2014 ${entry.enabled ? 'on' : 'off'} \u2014 ${entry.target}`,
        `Session gap (join/leave threshold): ${ctx.config.sessionGapMinutes} minutes`
    ].join('\n');
    return interaction.editReply({ embeds: [embed] });
}
