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
        .addStringOption((opt) => opt.setName('hwid').setDescription('Full HWID').setRequired(false))
        .addUserOption((opt) => opt.setName('user').setDescription('Discord user to ban their associated HWID').setRequired(false))
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason (required if no user provided)').setRequired(true))
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
        .addStringOption((opt) => opt.setName('hwid').setDescription('Full HWID').setRequired(true));
    .addSubcommand((sc) => sc
        .setName('logs')
        .setDescription('Show license key, HWID and User ID for a HWID')
        .addStringOption((opt) => opt.setName('hwid').setDescription('Full HWID').setRequired(false)));

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
            case 'logs': return subLogs(interaction, ctx);
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
        '`/hwid logs` \u2013 show license key, HWID and User ID',
        '',
        'HWID bans are enforced by the backend at verification time and are',
        'independent of license enable/disable state.'
    ].join('\n');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function subBan(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const hwidOption = interaction.options.getString('hwid', false);
    const userOption = interaction.options.getUser('user', false);
    const reason = interaction.options.getString('reason', false) || 'No reason provided';

    let hwid = hwidOption;
    // If user is provided, resolve their HWID from their licenses.
    if (userOption && !hwidOption) {
        const discordId = userOption.id;
        try {
            // List licenses owned by this Discord user.
            const result = await api.listLicenses(ctx.config, { limit: 200, status: 'all', q: `discord_user_id:${discordId}` });
            const licenses = result.licenses || [];
            if (licenses.length === 0) {
                return interaction.editReply({ embeds: [info('No Licenses', `User <@${discordId}> has no associated TGGLR licenses.`).flags(MessageFlags.Ephemeral)] });
            }
            // Use the first license's HWID.
            hwid = licenses[0].hwid;
            if (!hwid) {
                return interaction.editReply({ embeds: [info('No HWID', `User <@${discordId}> has licenses but none have a bound HWID.`).flags(MessageFlags.Ephemeral)] });
            }
        } catch (error) {
            console.error('[hwid ban] Failed to resolve user licenses:', error.message);
            return interaction.editReply({ embeds: [error('Failed', 'Could not resolve the user\'s licenses. Please try providing the HWID directly.')] });
        }
    }

    // If still no HWID, error.
    if (!hwid) {
        return interaction.editReply({ embeds: [error('Missing HWID', 'Please provide a HWID or a Discord user with a bound license.')] });
    }

    const reasonFinal = reason || 'No reason provided';
    const ok = await ctx.db.banHwid(hwid, { reason: reasonFinal, bannedBy: interaction.user.id });
    if (!ok) {
        return interaction.editReply({ embeds: [error('Ban Failed', 'Could not write the ban. Check that migrations/002_bot_support.sql was applied.')] });
    }
    await ctx.db.audit('hwid_banned', {
        actor: interaction.user.id,
        target: hwid,
        reason: reasonFinal,
        details: { via: 'discord /hwid ban' }
    });
    await ctx.monitors.notifyAction('hwid', `HWID banned by <@${interaction.user.id}> — reason: ${reasonFinal}`);
    return interaction.editReply({
        embeds: [success('Device Banned', `HWID \`${maskHwid(hwid)}\` is now banned.\nReason: ${reasonFinal}\nThe device can no longer verify licenses.`)]
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

async function subLogs(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const hwidOption = interaction.options.getString('hwid', false);
    
    let hwid = hwidOption;
    if (!hwid) {
        return interaction.editReply({ embeds: [error('Missing HWID', 'Please provide a HWID to view logs.')] });
    }
    
    // Get ban info and associated license.
    const { rows: bans, license } = await lookupRows(ctx, hwid);
    const activeBan = bans.find((row) => row.active);
    
    // Get license metadata for user ID.
    let userIdDisplay = 'not bound';
    let licenseKeyDisplay = 'not found';
    if (license) {
        licenseKeyDisplay = license.license_key || 'not found';
        const meta = await ctx.db.findLicenseMetadata(license.license_key).catch(() => null);
        if (meta && meta.discord_user_id) {
            userIdDisplay = `<@${meta.discord_user_id}> (\`${meta.discord_user_id}\`)`;
        }
    }
    
    const embed = base(`HWID Logs \u2014 \`${maskHwid(hwid)}\``, activeBan ? COLORS.error : COLORS.success);
    embed.fields = [
        { name: 'License Key', value: `\`${licenseKeyDisplay}\``, inline: false },
        { name: 'HWID', value: `\`${maskHwid(hwid)}\``, inline: true },
        { name: 'Discord User ID', value: userIdDisplay, inline: true },
        { name: 'Ban status', value: activeBan ? `BANNED \u2014 ${activeBan.reason}` : 'Not banned', inline: false }
    ];
    return interaction.editReply({ embeds: [embed] });
}

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
            case 'logs': return subLogs(interaction, ctx);
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /hwid help.')], flags: MessageFlags.Ephemeral });
        }
    }
};