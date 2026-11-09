'use strict';

const { ChannelType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { COLORS, base, error, info, success } = require('../utils/format');
const { TYPES } = require('../services/notifications');

const DATA = new SlashCommandBuilder()
    .setName('notifications')
    .setDescription('Notification settings')
    .addSubcommand((sc) => sc.setName('status').setDescription('Show notification settings'))
    .addSubcommand((sc) => sc
        .setName('enable')
        .setDescription('Enable notification types')
        .addStringOption((opt) => opt
            .setName('type')
            .setDescription('Type to enable (omit for all)')
            .addChoices(...TYPES.map((type) => ({ name: type, value: type })))
            .setRequired(false)))
    .addSubcommand((sc) => sc
        .setName('disable')
        .setDescription('Disable notification types (enforcement and logging are unaffected)')
        .addStringOption((opt) => opt
            .setName('type')
            .setDescription('Type to disable (omit for all)')
            .addChoices(...TYPES.map((type) => ({ name: type, value: type })))
            .setRequired(false)))
    .addSubcommand((sc) => sc
        .setName('toggle')
        .setDescription('Toggle a notification type')
        .addStringOption((opt) => opt
            .setName('type')
            .setDescription('Type to toggle')
            .addChoices(...TYPES.map((type) => ({ name: type, value: type })))
            .setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('channel')
        .setDescription('Set the channel for a notification type')
        .addStringOption((opt) => opt
            .setName('type')
            .setDescription('Type (omit for global)')
            .addChoices(...TYPES.map((type) => ({ name: type, value: type })), { name: 'global', value: 'global' })
            .setRequired(false))
        .addChannelOption((opt) => opt
            .setName('channel')
            .setDescription('Target channel (omit to clear)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)))
    .addSubcommand((sc) => sc.setName('test').setDescription('Send a test notification'));

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        switch (interaction.options.getSubcommand()) {
            case 'status': return subStatus(interaction, ctx);
            case 'enable': return setEnabled(interaction, ctx, true);
            case 'disable': return setEnabled(interaction, ctx, false);
            case 'toggle': return subToggle(interaction, ctx);
            case 'channel': return setChannel(interaction, ctx);
            case 'test': return subTest(interaction, ctx);
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /notifications status.')], flags: MessageFlags.Ephemeral });
        }
    }
};

async function subStatus(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const status = await ctx.notifications.status();
    const lines = Object.entries(status.types).map(([type, entry]) =>
        `\`${type}\` \u2014 ${entry.enabled ? 'on' : 'off'} \u2014 ${entry.target}`
    );
    const embed = base('Notification Settings', COLORS.primary);
    embed.description = [
        `Global channel: ${status.globalChannel}`,
        ...lines,
        '',
        'Disabling notifications never disables security enforcement or logging.'
    ].join('\n');
    return interaction.editReply({ embeds: [embed] });
}

async function setEnabled(interaction, ctx, enabled) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const type = interaction.options.getString('type');
    if (type) {
        await ctx.notifications.setType(type, enabled);
        return interaction.editReply({ embeds: [success('Updated', `\`${type}\` notifications are now ${enabled ? 'on' : 'off'}.`)] });
    }
    for (const entry of TYPES) {
        await ctx.notifications.setType(entry, enabled);
    }
    return interaction.editReply({ embeds: [success('Updated', `All notification types are now ${enabled ? 'on' : 'off'}.`)] });
}

async function subToggle(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const type = interaction.options.getString('type', true);
    const next = !ctx.notifications.isEnabled(type);
    await ctx.notifications.setType(type, next);
    return interaction.editReply({ embeds: [success('Updated', `\`${type}\` notifications are now ${next ? 'on' : 'off'}.`)] });
}

async function setChannel(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const type = interaction.options.getString('type') || 'global';
    const channel = interaction.options.getChannel('channel');
    if (channel) {
        await ctx.notifications.setChannel(type, channel.id);
        return interaction.editReply({ embeds: [success('Channel Set', `\`${type}\` notifications will be posted in <#${channel.id}>.`)] });
    }
    await ctx.notifications.setChannel(type, null);
    return interaction.editReply({ embeds: [info('Channel Cleared', `\`${type}\` notifications fall back to the global channel (if configured).`)] });
}

async function subTest(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const embed = base('Test Notification', COLORS.success);
    embed.description = 'If you can read this in the notification channel, delivery works.';
    const sent = await ctx.notifications.send('admin', embed);
    await ctx.notifications.notifyAdmins(embed).catch(() => {});
    return interaction.editReply({
        embeds: [sent
            ? success('Test Sent', 'The test notification was delivered.')
            : error('Test Not Delivered', 'No channel is configured. Use /notifications channel first.')]
    });
}
