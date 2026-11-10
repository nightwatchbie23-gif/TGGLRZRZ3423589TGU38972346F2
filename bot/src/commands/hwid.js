'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const api = require('../services/api');
const { COLORS, base, error, fmtDate, info, maskHwid, success } = require('../utils/format');

const DATA = new SlashCommandBuilder()
    .setName('hwid')
    .setDescription('Device (HWID) ban management')
    .addSubcommand((sc) => sc.setName('help').setDescription('Show HWID command help'))
    .addSubcommand((sc) => sc
        .setName('ban')
        .setDescription('Ban a device from using TGGLR')
        .addStringOption((opt) => opt.setName('hwid').setDescription('Full HWID').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason (required)').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('unban')
        .setDescription('Lift a device ban')
        .addStringOption((opt) => opt.setName('hwid').setDescription('Full HWID').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('lookup')
        .setDescription('Show ban status and linked license for a HWID')
        .addStringOption((opt) => opt.setName('hwid').setDescription('Full HWID').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('list')
        .setDescription('List device bans')
        .addIntegerOption((opt) => opt.setName('page').setDescription('Page number')))
    .addSubcommand((sc) => sc
        .setName('info')
        .setDescription('Detailed ban information for a HWID')
        .addStringOption((opt) => opt.setName('hwid').setDescription('Full HWID').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('history')
        .setDescription('Ban/unban history for a HWID')
        .addStringOption((opt) => opt.setName('hwid').setDescription('Full HWID').setRequired(true)));

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        switch (interaction.options.getSubcommand()) {
            case 'help': return subHelp(interaction);
            case 'ban': return subBan(interaction, ctx);
            case 'unban': return subUnban(interaction, ctx);
            case 'lookup': return subLookup(interaction, ctx);
            case 'list': return subList(interaction, ctx);
            case 'info': return subInfo(interaction, ctx);
            case 'history': return subHistory(interaction, ctx);
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /hwid help.')], flags: MessageFlags.Ephemeral });
        }
    }
};

function subHelp(interaction) {
    const embed = base('HWID Commands', COLORS.primary);
    embed.description = [
        '`/hwid ban` \u2013 ban a device (reason required)',
        '`/hwid unban` \u2013 lift a device ban',
        '`/hwid lookup` \u2013 ban status and linked license',
        '`/hwid list` \u2013 device bans (paginated)',
        '`/hwid info` \u2013 detailed ban information',
        '`/hwid history` \u2013 ban/unban history',
        '',
        'HWID bans are enforced by the backend at verification time and are',
        'independent of license enable/disable state.'
    ].join('\n');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function subBan(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const hwid = interaction.options.getString('hwid', true).trim();
    const reason = interaction.options.getString('reason', true).trim();

    const ok = await ctx.db.banHwid(hwid, { reason, bannedBy: interaction.user.id });
    if (!ok) {
        return interaction.editReply({ embeds: [error('Ban Failed', 'Could not write the ban. Check that migrations/002_bot_support.sql was applied.')] });
    }
    await ctx.db.audit('hwid_banned', {
        actor: interaction.user.id,
        target: hwid,
        reason,
        details: { via: 'discord /hwid ban' }
    });
    await ctx.monitors.notifyAction('hwid', `HWID banned by <@${interaction.user.id}> \u2014 reason: ${reason}`);
    return interaction.editReply({
        embeds: [success('Device Banned', `HWID \`${maskHwid(hwid)}\` is now banned.\nReason: ${reason}\nThe device can no longer verify licenses.`)]
    });
}

async function subUnban(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const hwid = interaction.options.getString('hwid', true).trim();
    const ok = await ctx.db.unbanHwid(hwid);
    if (!ok) {
        return interaction.editReply({ embeds: [info('No Active Ban', `No active ban was found for \`${maskHwid(hwid)}\`.`)] });
    }
    await ctx.db.audit('hwid_unbanned', {
        actor: interaction.user.id,
        target: hwid,
        details: { via: 'discord /hwid unban' }
    });
    await ctx.monitors.notifyAction('hwid', `HWID unbanned by <@${interaction.user.id}>`);
    return interaction.editReply({
        embeds: [success('Device Unbanned', `HWID \`${maskHwid(hwid)}\` can verify licenses again.`)]
    });
}

async function lookupRows(ctx, hwid) {
    const bans = await ctx.db.listBans({ hwid, limit: 5 });
    const rows = bans ? bans.rows : [];
    // Find licenses bound to this device through the backend.
    const license = await findLicenseByHwid(ctx, hwid);
    return { rows, license };
}

async function findLicenseByHwid(ctx, hwid) {
    let offset = 0;
    while (offset < 2000) {
        const result = await ctx.api.listLicenses(ctx.config, { limit: 200, offset, status: 'all' });
        const licenses = result.licenses || [];
        const match = licenses.find((license) => license.hwid === hwid);
        if (match) {
            return match;
        }
        if (licenses.length < 200) {
            break;
        }
        offset += 200;
    }
    return null;
}

async function subLookup(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const hwid = interaction.options.getString('hwid', true).trim();
    const { rows, license } = await lookupRows(ctx, hwid);
    const activeBan = rows.find((row) => row.active);

    const embed = base(`HWID \u2014 \`${maskHwid(hwid)}\``, activeBan ? COLORS.error : COLORS.success);
    embed.fields = [
        { name: 'Ban status', value: activeBan ? `BANNED \u2014 ${activeBan.reason}` : 'Not banned', inline: false },
        {
            name: 'Linked license',
            value: license ? `\`${license.license_key}\` (${license.is_active ? 'enabled' : 'disabled'})` : 'none found',
            inline: false
        }
    ];
    return interaction.editReply({ embeds: [embed] });
}

async function subList(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const pageSize = 10;
    const page = Math.max(1, interaction.options.getInteger('page') || 1);
    const result = await ctx.db.listBans({ limit: pageSize, offset: (page - 1) * pageSize });
    const rows = result ? result.rows : [];
    const total = result ? result.total : 0;

    const embed = base(`Device Bans \u2014 page ${page}`, COLORS.primary);
    embed.description = rows.map((row) =>
        `\`${maskHwid(row.hwid)}\` \u2014 ${row.active ? '**banned**' : 'lifted'} \u2014 ${row.reason} \u2014 ${fmtDate(row.created_at)}`
    ).join('\n') || 'No device bans recorded.';
    embed.fields = [{ name: 'Total records', value: String(total), inline: true }];
    return interaction.editReply({ embeds: [embed] });
}

async function subInfo(interaction, ctx) {
    return subLookup(interaction, ctx);
}

async function subHistory(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const hwid = interaction.options.getString('hwid', true).trim();
    const result = await ctx.db.listAudit({ limit: 15, target: hwid });
    const rows = (result && result.rows) || [];
    const embed = base(`HWID History \u2014 \`${maskHwid(hwid)}\``, COLORS.primary);
    embed.description = rows.map((row) =>
        `\`${row.event_type}\` by \`${row.actor || 'system'}\` \u2014 ${fmtDate(row.created_at)}${row.reason ? `\n   reason: ${row.reason}` : ''}`
    ).join('\n') || 'No history recorded for this device.';
    return interaction.editReply({ embeds: [embed] });
}
