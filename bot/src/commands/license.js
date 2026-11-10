'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const api = require('../services/api');
const { COLORS, base, error, fmtDate, maskKey, success, warn } = require('../utils/format');
const { computeExpiresAt, describe, parseDuration } = require('../utils/duration');
const { isAdmin, isAllowed, ADMIN_ONLY_COMMANDS } = require('../utils/guards');
const { licenseCreatedEmbed } = require('../services/notifications');

// ---------- command definition ----------
// Useful core commands: add, logs, info + access for granting users.
const DATA = new SlashCommandBuilder()
    .setName('license')
    .setDescription('License management')
    .addSubcommand((sc) => sc.setName('help').setDescription('Show license commands'))
    .addSubcommand((sc) => sc
        .setName('add')
        .setDescription('Create a license for a user (User ID + duration)')
        .addUserOption((opt) => opt.setName('owner').setDescription('Discord owner of the license').setRequired(true))
        .addStringOption((opt) => opt.setName('duration').setDescription('e.g. 7d, 2w, 3m, 1y, 1y2m3w5d, L').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('logs')
        .setDescription('Clean license log: User ID, MC name, remaining time, dates')
        .addStringOption((opt) => opt.setName('status').setDescription('Filter').addChoices(
            { name: 'All', value: 'all' },
            { name: 'Active', value: 'active' },
            { name: 'Expired', value: 'expired' },
            { name: 'Lifetime', value: 'lifetime' }
        ))
        .addIntegerOption((opt) => opt.setName('page').setDescription('Page number')))
    .addSubcommand((sc) => sc
        .setName('info')
        .setDescription('Full information for one license')
        .addStringOption((opt) => opt.setName('license_key').setDescription('License key').setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('access')
        .setDescription('Grant a user access to the bot')
        .addUserOption((opt) => opt.setName('user').setDescription('User to grant access').setRequired(true)));

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        if (interaction.options.getSubcommandGroup(false) === 'sharing') {
            return handleSharing(interaction, ctx);
        }
        switch (interaction.options.getSubcommand()) {
            case 'help': return subHelp(interaction);
            case 'add': return subAdd(interaction, ctx);
            case 'logs': return subLogs(interaction, ctx);
            case 'info': return subInfo(interaction, ctx);
            case 'access': return subAccess(interaction, ctx);
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /license help.')], flags: MessageFlags.Ephemeral });
        }
    }
};

// ---------- /license add ----------

async function subAdd(interaction, ctx) {
    if (!isAdmin(ctx.config, interaction.user.id)) {
        return interaction.reply({ embeds: [error('Not Authorized', 'Admins only.')], flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const owner = interaction.options.getUser('owner', true);
    let spec;
    try {
        spec = parseDuration(interaction.options.getString('duration', true));
    } catch (error_) {
        return interaction.editReply({ embeds: [error('Invalid Duration', error_.message)] });
    }
    const expiresAt = computeExpiresAt(new Date(), spec);
    let license;
    try {
        license = await api.createLicense(ctx.config, expiresAt ? { expiresAt: expiresAt.toISOString() } : { duration: 'L' });
    } catch (error_) {
        return interaction.editReply({ embeds: [error('Creation Failed', error_.message)] });
    }
    // No manual MC username — auto-detected from the game on first launch.
    await ctx.db.updateLicenseMetadata(license.license_key, { discordUserId: owner.id });
    await ctx.db.audit('license_created', {
        actor: interaction.user.id,
        target: license.license_key,
        details: { owner: owner.id, duration: describe(spec), via: 'discord' }
    });

    // Public confirmation in the license channel (full key stays private — DM only).
    const licenseChannelId = ctx.notifications.targetChannelId('license_created');
    if (licenseChannelId) {
        try {
            const channel = await ctx.config.client.channels.fetch(licenseChannelId);
            await channel.send({ embeds: [licenseCreatedEmbed({
                licenseKey: license.license_key,
                ownerId: owner.id,
                duration: describe(spec),
                expiresAt: expiresAt ? expiresAt.toISOString() : null,
                createdAt: new Date().toISOString()
            })] });
        } catch {
            // channel fetch failed; ephemeral reply still informs the admin.
        }
    }

    return interaction.editReply({
        embeds: [success('License Created', [
            `Key: \`${maskKey(license.license_key)}\` (full key sent to <@${owner.id}> by DM)`,
            `Owner: <@${owner.id}> (\`${owner.id}\`)`,
            `Duration: ${describe(spec)}${expiresAt ? ` \u2014 expires ${fmtDate(expiresAt.toISOString())}` : ' \u2014 lifetime'}`,
            '',
            'Minecraft username will be auto-detected when the owner runs the client.'
        ].join('\n'))]
    }).then(() => {
        // Fire-and-forget: notify owner by DM with full key.
        owner.send({
            embeds: [success('TGGLR License Key', [
                `Key: \`${license.license_key}\``,
                `Duration: ${describe(spec)}${expiresAt ? ` \u2014 expires ${fmtDate(expiresAt.toISOString())}` : ' \u2014 lifetime'}`,
                '',
                'Run the game client to auto-detect your Minecraft username.',
                'Keep this key private \u2014 it binds to your device on first use.'
            ].join('\n'))]
        }).catch(() => {});
    });
}

// ---------- /license logs ----------

async function subLogs(interaction, ctx) {
    if (!isAdmin(ctx.config, interaction.user.id)) {
        return interaction.reply({ embeds: [error('Not Authorized', 'Admins only.')], flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const pageSize = 10;
    const status = interaction.options.getString('status') || 'all';
    const page = Math.max(1, interaction.options.getInteger('page') || 1);

    let result = await api.listLicenses(ctx.config, { limit: pageSize, offset: (page - 1) * pageSize, status });
    const total = result.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    if (safePage !== page) {
        result = await api.listLicenses(ctx.config, { limit: pageSize, offset: (safePage - 1) * pageSize, status });
    }

    const embed = base(`License Logs \u2014 page ${safePage}/${totalPages}`, COLORS.primary);
    const metas = {};
    try {
        for (const license of result.licenses || []) {
            const m = await ctx.db.findLicenseMetadata(license.license_key).catch(() => null);
            if (m) metas[license.license_key] = m;
        }
    } catch { /* table unavailable \u2014 continue without metadata */ }

    embed.description = (result.licenses || []).map((license) => licenseLine(license, metas[license.license_key])).join('\n\n') || 'No licenses.';
    embed.fields = [
        { name: 'Total', value: String(total), inline: true },
        { name: 'Filter', value: status, inline: true },
        { name: 'Note', value: 'MC name auto-detected from the game \u2014 blank until first launch.', inline: false }
    ];
    return interaction.editReply({ embeds: [embed] });
}

// ---------- /license info ----------

async function subInfo(interaction, ctx) {
    if (!isAdmin(ctx.config, interaction.user.id)) {
        return interaction.reply({ embeds: [error('Not Authorized', 'Admins only.')], flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key = interaction.options.getString('license_key', true).trim();
    const license = await api.findLicenseByKey(ctx.config, key);
    if (!license) {
        return interaction.editReply({ embeds: [error('Not Found', 'No license matches that key.')] });
    }
    const metadata = await ctx.db.findLicenseMetadata(license.license_key).catch(() => null);
    const expires = license.expires_at ? new Date(license.expires_at).getTime() : 0;
    const now = Date.now();
    const expired = expires > 0 && expires <= now;
    const type = expired ? 'Session Expired' : (license.expires_at ? 'Timed' : 'Lifetime');
    const remaining = expired ? 'Session Expired' : (license.expires_at ? `${Math.max(0, Math.floor((expires - now) / 86400000))} days left` : '—');
    const embed = base('License Details', COLORS.primary);
    embed.fields = [
        { name: 'License key', value: `\`${license.license_key}\``, inline: false },
        { name: 'Status', value: license.is_active ? 'Enabled' : 'Disabled', inline: true },
        { name: 'Type', value: type, inline: true },
        { name: 'Expires', value: license.expires_at ? fmtDate(license.expires_at) : 'never', inline: true },
        { name: 'Remaining', value: remaining, inline: true },
        { name: 'HWID', value: license.hwid ? `\`${license.hwid.slice(0, 12)}\u2026\`` : 'unbound', inline: true },
        { name: 'Created', value: license.created_at ? fmtDate(license.created_at) : 'unknown', inline: true },
        { name: 'Discord owner', value: metadata && metadata.discord_user_id ? `<@${metadata.discord_user_id}> (\`${metadata.discord_user_id}\`)` : 'not bound', inline: true },
        { name: 'Minecraft username', value: metadata && metadata.minecraft_username ? `\`${metadata.minecraft_username}\`` : 'auto-detect on launch', inline: true },
        { name: 'Minecraft UUID', value: metadata && metadata.mc_uuid ? `\`${metadata.mc_uuid}\`` : 'not set', inline: true },
        { name: 'Last used', value: license.last_used_at ? fmtDate(license.last_used_at) : 'never', inline: true }
    ];
    return interaction.editReply({ embeds: [embed] });
}

// ---------- /license access ----------

async function subAccess(interaction, ctx) {
    if (!isAdmin(ctx.config, interaction.user.id)) {
        return interaction.reply({ embeds: [error('Not Authorized', 'Admins only.')], flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser('user', true);
    await ctx.db.audit('access_granted', { actor: interaction.user.id, target: user.id, details: { via: 'license access' } });
    return interaction.editReply({ embeds: [success('Access Granted', `<@${user.id}> (\`${user.id}\`) can now use /license, /register and /help. Takes effect immediately.`) ] });
}

// ---------- helpers ----------

function licenseLine(license, meta) {
    const expires = license.expires_at ? new Date(license.expires_at).getTime() : 0;
    const now = Date.now();
    const expired = expires > 0 && expires <= now;

    const owner = meta && meta.discord_user_id
        ? `<@${meta.discord_user_id}>` : 'not bound';
    const mc = meta && meta.minecraft_username
        ? `\`${meta.minecraft_username}\``
        : 'auto-detect';

    const statusLine = expired
        ? '❌ Expired'
        : license.expires_at
            ? `⏳ ${Math.max(0, Math.floor((expires - now) / 86400000))} days left`
            : '♾️ Lifetime';

    const dateLine = license.expires_at
        ? `expires ${fmtDate(license.expires_at)}`
        : 'never';

    return [
        `🔑 \`${maskKey(license.license_key)}\``,
        `   👤 ${owner}`,
        `   🎮 MC: ${mc}`,
        `   ${statusLine} — ${dateLine}`
    ].join('\n');
}

function subHelp(interaction) {
    const embed = base('License Commands', COLORS.primary);
    embed.description = [
        '`/license add owner:@user duration:1m` \u2014 create a license (User ID + duration)',
        '`/license logs` \u2014 clean log: User ID, MC name, remaining time, dates',
        '`/license info key:...` \u2014 full details for one license',
        '`/license access user:@them` \u2014 grant a user access to the bot',
        '',
        'Minecraft username is auto-detected from the game client \u2014 nothing to type.',
        'Durations: `7d`, `2w`, `3m`, `1y`, `1y2m3w5d`, `L` (lifetime).'
    ].join('\n');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function handleSharing() { /* removed \u2014 not part of the useful core */ }
