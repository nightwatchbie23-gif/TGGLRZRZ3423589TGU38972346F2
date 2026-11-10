'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const {
    DASH_CHANNELS,
    upsertDashboardForChannel
} = require('../services/dashboard');
const { COLORS, base, error, success } = require('../utils/format');

// /dashboard setup  -> posts/updates a live control panel in each of the 4
// TGGLR Bot channels. /dashboard refresh -> rebuilds the data in all panels.

const DATA = new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Channel dashboards')
    .addSubcommand((sc) => sc.setName('setup').setDescription('Create/update a control panel in every TGGLR Bot channel'))
    .addSubcommand((sc) => sc.setName('refresh').setDescription('Rebuild the data in every dashboard panel'));

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        switch (interaction.options.getSubcommand()) {
            case 'setup': return subSetup(interaction, ctx);
            case 'refresh': return subRefresh(interaction, ctx);
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /dashboard setup.')], flags: MessageFlags.Ephemeral });
        }
    }
};

function findChannel(guild, name) {
    return guild.channels.cache.find((ch) =>
        ch.type === 0 && ch.name === name
    );
}

async function subSetup(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    if (!guild) {
        return interaction.editReply({ embeds: [error('Wrong Context', 'This command only works in a server.')] });
    }

    const results = [];
    const missing = [];
    for (const [kind, channelName] of Object.entries(DASH_CHANNELS)) {
        const channel = findChannel(guild, channelName);
        if (!channel) {
            missing.push(`#${channelName}`);
            continue;
        }
        try {
            const result = await upsertDashboardForChannel(ctx, channel, kind);
            results.push(`${result.reused ? '\u267B\uFE0F Updated existing panel' : '\u2705 New panel'} in <#${channel.id}> \u2014 \`${kind}\``);
        } catch (error_) {
            results.push(`\u274C Failed for <#${channel.id}> \u2014 ${error_.message}`);
        }
    }

    const description = [
        ...results,
        missing.length > 0 ? '' : null,
        missing.length > 0 ? `\u2139\uFE0F Channels not found: ${missing.join(', ')} \u2014 run \`/notifications setup\` first to create them.` : null
    ].filter((line) => line !== null).join('\n');

    const embed = success('Dashboards Ready', description);
    await ctx.db.audit('dashboard_setup', {
        actor: interaction.user.id,
        details: { kinds: Object.keys(DASH_CHANNELS) }
    });
    return interaction.editReply({ embeds: [embed] });
}

async function subRefresh(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const stored = await ctx.db.getSetting('dashboards', {});
    const lines = [];
    for (const [kind, entry] of Object.entries(stored && typeof stored === 'object' ? stored : {})) {
        if (!entry || !entry.channelId || !entry.messageId) {
            continue;
        }
        try {
            const channel = await guild.channels.fetch(entry.channelId);
            const message = await channel.messages.fetch(entry.messageId);
            const { buildDashboard } = require('../services/dashboard');
            const embed = await buildDashboard(ctx, kind);
            await message.edit({ embeds: [embed], components: require('../services/dashboard').componentsFor(kind) });
            lines.push(`\u2705 <#${entry.channelId}> \u2014 \`${kind}\``);
        } catch (error_) {
            lines.push(`\u274C \`${kind}\` \u2014 ${error_.message}`);
        }
    }
    const embed = base('Dashboards Refreshed', COLORS.primary);
    embed.description = lines.join('\n') || 'No dashboards stored yet \u2014 run `/dashboard setup`.';
    return interaction.editReply({ embeds: [embed] });
}
