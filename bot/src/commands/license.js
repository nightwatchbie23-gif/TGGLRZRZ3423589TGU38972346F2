'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');
const api = require('../services/api');
const { COLORS, base, error, fmtDate, info, maskHwid, maskKey, success } = require('../utils/format');
const { computeExpiresAt, describe, parseDuration } = require('../utils/duration');
const { registerPendingAction } = require('../utils/pending');

const DATA = new SlashCommandBuilder()
    .setName('license')
    .setDescription('License management')
    .addSubcommand((sc) => sc.setName('help').setDescription('Show license command help'))
    .addSubcommand((sc) => sc
        .setName('create')
        .setDescription('Create a license and receive the key privately')
        .addUserOption((opt) => opt.setName('owner').setDescription('Discord owner of the license').setRequired(true))
        .addStringOption((opt) => opt.setName('username').setDescription('Minecraft username').setRequired(true))
        .addStringOption((opt) => opt.setName('duration').setDescription('e.g. 7d, 2w, 3m, 1y, 1y2m3w5d, L').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('list')
        .setDescription('List licenses (paginated)')
        .addStringOption((opt) => opt.setName('status').setDescription('Filter').addChoices(
            { name: 'All', value: 'all' },
            { name: 'Active', value: 'active' },
            { name: 'Disabled', value: 'disabled' },
            { name: 'Expired', value: 'expired' },
            { name: 'Lifetime', value: 'lifetime' }
        ))
        .addIntegerOption((opt) => opt.setName('page').setDescription('Page number')))
    .addSubcommand((sc) => sc
        .setName('info')
        .setDescription('Full administrative license information')
        .addStringOption((opt) => opt.setName('license_key').setDescription('License key').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('revoke')
        .setDescription('Disable (revoke) a license')
        .addStringOption((opt) => opt.setName('license_key').setDescription('License key').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason')))
    .addSubcommand((sc) => sc
        .setName('delete')
        .setDescription('Permanently delete a license')
        .addStringOption((opt) => opt.setName('license_key').setDescription('License key').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason')))
    .addSubcommand((sc) => sc
        .setName('enable')
        .setDescription('Enable a license')
        .addStringOption((opt) => opt.setName('license_key').setDescription('License key').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('disable')
        .setDescription('Disable a license')
        .addStringOption((opt) => opt.setName('license_key').setDescription('License key').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('clearhwid')
        .setDescription('Remove only the device binding (HWID)')
        .addStringOption((opt) => opt.setName('license_key').setDescription('License key').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('transfer')
        .setDescription('Transfer ownership to another Discord user')
        .addStringOption((opt) => opt.setName('license_key').setDescription('License key').setRequired(true))
        .addUserOption((opt) => opt.setName('new_owner').setDescription('New owner').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('history')
        .setDescription('Audit history for a license')
        .addStringOption((opt) => opt.setName('license_key').setDescription('License key').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('search')
        .setDescription('Search licenses by key fragment')
        .addStringOption((opt) => opt.setName('query').setDescription('Key fragment').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('expiring')
        .setDescription('Licenses expiring within N days (or already expired)')
        .addIntegerOption((opt) => opt.setName('days').setDescription('Days ahead (default 7)')))
    .addSubcommand((sc) => sc
        .setName('bulk-create')
        .setDescription('Generate multiple license keys')
        .addIntegerOption((opt) => opt.setName('count').setDescription('1-50').setRequired(true))
        .addStringOption((opt) => opt.setName('duration').setDescription('e.g. 30d, 3m, L').setRequired(true))
        .addUserOption((opt) => opt.setName('owner').setDescription('Discord owner for all keys'))
        .addStringOption((opt) => opt.setName('username').setDescription('Minecraft username for all keys')))
    .addSubcommandGroup((group) => group
        .setName('sharing')
        .setDescription('License sharing alerts')
        .addSubcommand((sc) => sc.setName('info').setDescription('Sharing detection settings and open alerts'))
        .addSubcommand((sc) => sc
            .setName('confirm')
            .setDescription('Confirm an alert and disable the license')
            .addIntegerOption((opt) => opt.setName('alert_id').setDescription('Alert ID').setRequired(true))
            .addStringOption((opt) => opt.setName('reason').setDescription('Reason')))
        .addSubcommand((sc) => sc
            .setName('dismiss')
            .setDescription('Dismiss an alert without action')
            .addIntegerOption((opt) => opt.setName('alert_id').setDescription('Alert ID').setRequired(true)))
        .addSubcommand((sc) => sc
            .setName('history')
            .setDescription('Alert history (all or per license)')
            .addStringOption((opt) => opt.setName('license_key').setDescription('Filter by license key')))
        .addSubcommand((sc) => sc
            .setName('ban')
            .setDescription('Ban devices (HWIDs) from a decided alert')
            .addIntegerOption((opt) => opt.setName('alert_id').setDescription('Alert ID').setRequired(true))
            .addStringOption((opt) => opt.setName('reason').setDescription('Ban reason').setRequired(true))));

// ---------- helpers ----------

function licenseLine(license) {
    const type = license.expires_at
        ? (new Date(license.expires_at).getTime() <= Date.now() ? 'expired' : `expires ${fmtDate(license.expires_at)}`)
        : 'lifetime';
    return `\`${maskKey(license.license_key)}\` \u2014 ${license.is_active ? 'enabled' : 'disabled'} \u2014 ${type}`;
}

async function confirmAction(interaction, actionId, handler) {
    registerPendingAction(`confirm:${actionId}`, handler);
    const embed = base('Confirmation Required', COLORS.warn);
    embed.description = 'This action cannot be undone. Are you sure?';
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm:${actionId}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('confirm:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

function invalidDuration(error_) {
    return error_ && error_.code === 'INVALID_DURATION';
}

// ---------- subcommands ----------

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        if (interaction.options.getSubcommandGroup(false) === 'sharing') {
            return handleSharing(interaction, ctx);
        }

        switch (interaction.options.getSubcommand()) {
            case 'help': return subHelp();
            case 'create': return subCreate(interaction, ctx);
            case 'list': return subList(interaction, ctx);
            case 'info': return subInfo(interaction, ctx);
            case 'enable': return subToggle(interaction, ctx, true);
            case 'disable': return subToggle(interaction, ctx, false);
            case 'revoke': return subRevoke(interaction, ctx);
            case 'delete': return subDelete(interaction, ctx);
            case 'clearhwid': return subClearHwid(interaction, ctx);
            case 'transfer': return subTransfer(interaction, ctx);
            case 'history': return subHistory(interaction, ctx);
            case 'search': return subSearch(interaction, ctx);
            case 'expiring': return subExpiring(interaction, ctx);
            case 'bulk-create': return subBulkCreate(interaction, ctx);
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /license help.')], flags: MessageFlags.Ephemeral });
        }
    }
};

function subHelp() {
    const embed = base('License Commands', COLORS.primary);
    embed.description = [
        '`/license create` \u2013 create a license (owner, Minecraft username, duration); key is sent privately to you',
        '`/license list` \u2013 paginated list with masked keys',
        '`/license info` \u2013 full information for one license',
        '`/license revoke` \u2013 disable (revoke) a license',
        '`/license delete` \u2013 permanently delete a license',
        '`/license enable` / `disable` \u2013 toggle a license',
        '`/license clearhwid` \u2013 remove only the device binding',
        '`/license transfer` \u2013 move ownership to another Discord user',
        '`/license history` \u2013 audit trail for a license',
        '`/license search` \u2013 find licenses by key fragment',
        '`/license expiring` \u2013 licenses expiring soon',
        '`/license bulk-create` \u2013 generate many keys at once',
        '`/license sharing` \u2013 sharing alerts (info / confirm / dismiss / history / ban)',
        '',
        'Durations: `7d`, `2w`, `3m`, `1y`, `1y2m3w5d`, `L` (lifetime).'
    ].join('\n');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function subCreate(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const owner = interaction.options.getUser('owner', true);
    const username = interaction.options.getString('username', true).trim();
    let spec;
    try {
        spec = parseDuration(interaction.options.getString('duration', true));
    } catch (error_) {
        return interaction.editReply({ embeds: [error('Invalid Duration', error_.message)] });
    }

    const expiresAt = computeExpiresAt(new Date(), spec);
    let license;
    try {
        license = await api.createLicense(
            ctx.config,
            expiresAt ? { expiresAt: expiresAt.toISOString() } : { duration: 'L' }
        );
    } catch (error_) {
        return interaction.editReply({ embeds: [error('Creation Failed', error_.message)] });
    }

    await ctx.db.updateLicenseMetadata(license.license_key, {
        discordUserId: owner.id,
        minecraftUsername: username
    });
    await ctx.db.audit('license_created', {
        actor: interaction.user.id,
        target: license.license_key,
        details: { owner: owner.id, minecraft_username: username, duration: describe(spec), via: 'discord' }
    });

    const embed = success('License Created', [
        `Key: \`${license.license_key}\``,
        `Owner: <@${owner.id}> (${owner.id})`,
        `Minecraft username: ${username}`,
        `Duration: ${describe(spec)}`,
        expiresAt ? `Expires: ${fmtDate(expiresAt.toISOString())}` : 'Expires: never (Lifetime)',
        '',
        'Share the key with the owner securely. It is never sent to them automatically.'
    ].join('\n'));
    await interaction.editReply({ embeds: [embed] });

    try {
        const dm = success('TGGLR License Key', `Key: \`${license.license_key}\`\nDuration: ${describe(spec)}`);
        await interaction.user.send({ embeds: [dm] });
    } catch {
        // DMs closed; the ephemeral reply above still contains the key.
    }
}

async function subList(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const pageSize = 10;
    const status = interaction.options.getString('status') || 'all';
    const pageOption = interaction.options.getInteger('page') || 1;

    let result = await api.listLicenses(ctx.config, { limit: pageSize, offset: (pageOption - 1) * pageSize, status });
    const total = result.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, pageOption), totalPages);
    if (page !== pageOption) {
        result = await api.listLicenses(ctx.config, { limit: pageSize, offset: (page - 1) * pageSize, status });
    }

    const embed = base(`Licenses \u2014 page ${page}/${totalPages}`, COLORS.primary);
    embed.description = (result.licenses || []).map(licenseLine).join('\n') || 'No licenses found.';
    embed.fields = [{ name: 'Total', value: String(total), inline: true }, { name: 'Filter', value: status, inline: true }];
    return interaction.editReply({ embeds: [embed] });
}

async function subInfo(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key = interaction.options.getString('license_key', true).trim();
    const license = await api.findLicenseByKey(ctx.config, key);
    if (!license) {
        return interaction.editReply({ embeds: [error('Not Found', 'No license matches that key.')] });
    }
    const metadata = await ctx.db.findLicenseMetadata(license.license_key);

    const embed = base('License Details', COLORS.primary);
    embed.fields = [
        { name: 'License key', value: `\`${license.license_key}\``, inline: false },
        { name: 'Status', value: license.is_active ? 'Enabled' : 'Disabled', inline: true },
        { name: 'Type', value: license.expires_at ? 'Timed' : 'Lifetime', inline: true },
        { name: 'Expires', value: license.expires_at ? fmtDate(license.expires_at) : 'never', inline: true },
        { name: 'HWID', value: maskHwid(license.hwid), inline: true },
        { name: 'Last used', value: fmtDate(license.last_used_at), inline: true },
        { name: 'Discord owner', value: metadata && metadata.discord_user_id ? `<@${metadata.discord_user_id}> (${metadata.discord_user_id})` : 'not linked', inline: true },
        { name: 'Minecraft username', value: metadata && metadata.minecraft_username ? metadata.minecraft_username : 'not set', inline: true },
        { name: 'Minecraft UUID', value: metadata && metadata.mc_uuid ? metadata.mc_uuid : 'not set', inline: true }
    ];
    return interaction.editReply({ embeds: [embed] });
}

async function subToggle(interaction, ctx, enable) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key = interaction.options.getString('license_key', true).trim();
    try {
        const license = await api.updateLicense(ctx.config, key, enable ? 'enable' : 'disable');
        await ctx.db.audit(enable ? 'license_enabled' : 'license_disabled', {
            actor: interaction.user.id,
            target: license.license_key
        });
        return interaction.editReply({
            embeds: [success(`License ${enable ? 'Enabled' : 'Disabled'}`, `\`${maskKey(license.license_key)}\` is now ${license.is_active ? 'enabled' : 'disabled'}.`)]
        });
    } catch (error_) {
        return interaction.editReply({ embeds: [error('Update Failed', error_.message)] });
    }
}

async function subRevoke(interaction, ctx) {
    const key = interaction.options.getString('license_key', true).trim();
    const reason = interaction.options.getString('reason') || '';
    await confirmAction(interaction, `revoke:${key}`, async (button) => {
        await button.deferUpdate();
        try {
            const license = await api.updateLicense(ctx.config, key, 'disable');
            await ctx.db.audit('license_revoked', {
                actor: interaction.user.id,
                target: license.license_key,
                reason: reason || null
            });
            await button.editReply({
                components: [],
                embeds: [success('License Revoked', `\`${maskKey(license.license_key)}\` has been disabled.` + (reason ? `\nReason: ${reason}` : ''))]
            });
        } catch (error_) {
            await button.editReply({ components: [], embeds: [error('Revoke Failed', error_.message)] });
        }
    });
}

async function subDelete(interaction, ctx) {
    const key = interaction.options.getString('license_key', true).trim();
    const reason = interaction.options.getString('reason') || '';
    await confirmAction(interaction, `delete:${key}`, async (button) => {
        await button.deferUpdate();
        try {
            await api.deleteLicense(ctx.config, key);
            await ctx.db.audit('license_deleted', {
                actor: interaction.user.id,
                target: key,
                reason: reason || 'deleted via Discord'
            });
            await button.editReply({
                components: [],
                embeds: [success('License Deleted', `\`${maskKey(key)}\` was permanently deleted.`)]
            });
        } catch (error_) {
            await button.editReply({ components: [], embeds: [error('Delete Failed', error_.message)] });
        }
    });
}

async function subClearHwid(interaction, ctx) {
    const key = interaction.options.getString('license_key', true).trim();
    await confirmAction(interaction, `clearhwid:${key}`, async (button) => {
        await button.deferUpdate();
        try {
            const license = await api.updateLicense(ctx.config, key, 'reset_hwid');
            await ctx.db.audit('license_hwid_cleared', {
                actor: interaction.user.id,
                target: license.license_key,
                reason: 'device binding cleared via Discord'
            });
            await button.editReply({
                components: [],
                embeds: [success('HWID Cleared', `Device binding for \`${maskKey(license.license_key)}\` was removed.\nOwner, Minecraft account, expiry and status were not changed.`)]
            });
        } catch (error_) {
            await button.editReply({ components: [], embeds: [error('Clear Failed', error_.message)] });
        }
    });
}

async function subTransfer(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key = interaction.options.getString('license_key', true).trim();
    const newOwner = interaction.options.getUser('new_owner', true);
    const license = await api.findLicenseByKey(ctx.config, key);
    if (!license) {
        return interaction.editReply({ embeds: [error('Not Found', 'No license matches that key.')] });
    }
    const metadata = await ctx.db.findLicenseMetadata(key);
    const previousOwner = metadata && metadata.discord_user_id ? metadata.discord_user_id : null;
    await ctx.db.updateLicenseMetadata(key, { discordUserId: newOwner.id });
    await ctx.db.audit('license_transferred', {
        actor: interaction.user.id,
        target: key,
        details: { previous_owner: previousOwner, new_owner: newOwner.id }
    });
    return interaction.editReply({
        embeds: [success('License Transferred', `\`${maskKey(key)}\` is now owned by <@${newOwner.id}> (${newOwner.id}).\nMinecraft account, HWID, expiry and status were not changed.`)]
    });
}

async function subHistory(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key = interaction.options.getString('license_key', true).trim();
    const result = await ctx.db.listAudit({ limit: 15, target: key });
    const rows = result ? result.rows : [];
    const embed = base(`License History \u2014 ${maskKey(key)}`, COLORS.primary);
    embed.description = rows.map((row) =>
        `\`${row.event_type}\` by \`${row.actor || 'system'}\` \u2014 ${fmtDate(row.created_at)}${row.reason ? `\n   reason: ${row.reason}` : ''}`
    ).join('\n') || 'No history recorded for this license.';
    return interaction.editReply({ embeds: [embed] });
}

async function subSearch(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const query = interaction.options.getString('query', true).trim();
    const result = await api.listLicenses(ctx.config, { limit: 15, q: query });
    const embed = base(`Search Results \u2014 "${query}"`, COLORS.primary);
    embed.description = (result.licenses || []).map(licenseLine).join('\n') || 'No matches.';
    return interaction.editReply({ embeds: [embed] });
}

async function subExpiring(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const days = Math.min(Math.max(1, interaction.options.getInteger('days') || 7), 365);
    const horizon = Date.now() + days * 24 * 60 * 60_000;
    const matches = [];
    let offset = 0;

    while (offset < 2000 && matches.length < 25) {
        const result = await api.listLicenses(ctx.config, { limit: 200, offset, status: 'all' });
        const licenses = result.licenses || [];
        for (const license of licenses) {
            if (!license.expires_at) {
                continue;
            }
            const expires = new Date(license.expires_at).getTime();
            if (!Number.isNaN(expires) && expires <= horizon) {
                matches.push(license);
            }
        }
        if (licenses.length < 200) {
            break;
        }
        offset += 200;
    }

    matches.sort((left, right) => new Date(left.expires_at) - new Date(right.expires_at));
    const embed = base(`Licenses Expiring Within ${days} Days`, COLORS.warn);
    embed.description = matches.slice(0, 25).map(licenseLine).join('\n') || 'Nothing expiring in that window.';
    return interaction.editReply({ embeds: [embed] });
}

async function subBulkCreate(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const count = Math.min(Math.max(1, interaction.options.getInteger('count', true)), 50);
    let spec;
    try {
        spec = parseDuration(interaction.options.getString('duration', true));
    } catch (error_) {
        return interaction.editReply({ embeds: [error('Invalid Duration', error_.message)] });
    }
    const owner = interaction.options.getUser('owner') || interaction.user;
    const username = interaction.options.getString('username');

    const created = [];
    const failures = [];

    for (let index = 0; index < count; index++) {
        try {
            const expiresAt = computeExpiresAt(new Date(), spec);
            const license = await api.createLicense(
                ctx.config,
                expiresAt ? { expiresAt: expiresAt.toISOString() } : { duration: 'L' }
            );
            await ctx.db.updateLicenseMetadata(license.license_key, {
                discordUserId: owner.id,
                ...(username ? { minecraftUsername: username } : {})
            });
            await ctx.db.audit('license_created', {
                actor: interaction.user.id,
                target: license.license_key,
                details: { bulk: true, owner: owner.id, minecraft_username: username || null, duration: describe(spec) }
            });
            created.push(license.license_key);
        } catch (error_) {
            failures.push(`#${index + 1}: ${error_.message}`);
        }
    }

    const embed = success('Bulk Create Finished', `Created ${created.length}/${count} licenses for <@${owner.id}>. Keys below are visible only to you.`);
    if (created.length > 0) {
        embed.fields = [{
            name: 'Keys',
            value: created.map((key) => `\`${key}\``).join('\n').slice(0, 1000)
        }];
    }
    if (failures.length > 0) {
        embed.fields.push({ name: 'Partial failures', value: failures.slice(0, 10).join('\n').slice(0, 1000) });
    }
    return interaction.editReply({ embeds: [embed] });
}

// ---------- /license sharing ----------

async function handleSharing(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();

    if (sub === 'info') {
        const open = await ctx.db.listAlerts({ limit: 10 });
        const rows = open ? open.rows.filter((row) => row.status === 'open') : [];
        const embed = base('License Sharing Settings', COLORS.primary);
        embed.description = [
            'Mode: **alert_review** (suspicious activity always requires manual review)',
            'Notifications: **both** (configured channel + admin DM)',
            'Logging: **always** (every alert and decision is recorded)',
            'Ban: **confirm** (no automatic bans \u2014 ever)',
            '',
            'A different HWID alone is not proof of sharing.'
        ].join('\n');
        embed.fields = [{
            name: `Open alerts (${rows.length})`,
            value: rows.map((row) => `#${row.id} \u2014 \`${maskKey(row.license_key)}\` \u2014 ${row.alert_kind}`).join('\n') || 'none'
        }];
        return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'confirm') {
        const alertId = interaction.options.getInteger('alert_id', true);
        const reason = interaction.options.getString('reason') || '';
        const alert = await ctx.db.getAlert(alertId);
        if (!alert) {
            return interaction.editReply({ embeds: [error('Not Found', 'No alert with that ID.')] });
        }
        if (reason) {
            await ctx.db.audit('sharing_confirmed', { actor: interaction.user.id, target: alert.license_key, reason });
        }
        const decided = await ctx.monitors.confirmAlert(alertId, interaction.user.id);
        if (!decided) {
            return interaction.editReply({ embeds: [info('Already Decided', `Alert #${alertId} is no longer open. Re-disable via /license disable if needed.`)] });
        }
        return interaction.editReply({
            embeds: [success('Alert Confirmed', `Alert #${alertId} confirmed. License \`${maskKey(alert.license_key)}\` has been **disabled** through the backend.`)]
        });
    }

    if (sub === 'dismiss') {
        const alertId = interaction.options.getInteger('alert_id', true);
        const alert = await ctx.db.getAlert(alertId);
        if (!alert) {
            return interaction.editReply({ embeds: [error('Not Found', 'No alert with that ID.')] });
        }
        const decided = await ctx.monitors.dismissAlert(alertId, interaction.user.id);
        if (!decided) {
            return interaction.editReply({ embeds: [info('Already Decided', `Alert #${alertId} is no longer open.`)] });
        }
        return interaction.editReply({
            embeds: [success('Alert Dismissed', `Alert #${alertId} recorded as dismissed. No action was taken.`)]
        });
    }

    if (sub === 'history') {
        const licenseKey = interaction.options.getString('license_key');
        const result = await ctx.db.listAlerts({ licenseKey: licenseKey || undefined, limit: 15 });
        const rows = result ? result.rows : [];
        const embed = base('Sharing Alerts History', COLORS.primary);
        embed.description = rows.map((row) =>
            `#${row.id} \u2014 \`${maskKey(row.license_key)}\` \u2014 ${row.alert_kind} \u2014 **${row.status}**${row.decided_by ? ` by <@${row.decided_by}>` : ''} \u2014 ${fmtDate(row.created_at)}`
        ).join('\n') || 'No alerts recorded.';
        return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'ban') {
        const alertId = interaction.options.getInteger('alert_id', true);
        const reason = interaction.options.getString('reason', true);
        const alert = await ctx.db.getAlert(alertId);
        if (!alert) {
            return interaction.editReply({ embeds: [error('Not Found', 'No alert with that ID.')] });
        }
        if (alert.status === 'open') {
            return interaction.editReply({
                embeds: [error('Alert Still Open', 'Confirm or dismiss the alert first (`/license sharing confirm`). Banning always requires explicit confirmation.')]
            });
        }
        const details = alert.details || {};
        const hwids = details.hwid ? [details.hwid] : [];
        if (hwids.length === 0) {
            return interaction.editReply({ embeds: [info('No Device Data', 'This alert has no distinct HWID to ban. Use /hwid ban with a specific HWID instead.')] });
        }
        const banned = [];
        for (const hwid of hwids) {
            const ok = await ctx.db.banHwid(hwid, { reason, bannedBy: interaction.user.id, licenseKey: alert.license_key });
            if (ok) {
                banned.push(maskHwid(hwid));
                await ctx.db.audit('hwid_banned', {
                    actor: interaction.user.id,
                    target: hwid,
                    reason,
                    details: { via: 'license sharing', license_key: alert.license_key }
                });
            }
        }
        return interaction.editReply({
            embeds: [success('Devices Banned', `Alert #${alertId}: banned ${banned.length} device(s):\n${banned.join('\n')}\nBanned devices can no longer verify licenses.`)]
        });
    }

    return interaction.editReply({ embeds: [error('Unknown subcommand', 'See /license sharing info.')] });
}
