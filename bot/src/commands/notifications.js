'use strict';

const { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { COLORS, base, error, info, success, maskKey, maskHwid } = require('../utils/format');

// Notification types used for slash command choices and settings.
const TYPES = [
    'login_success',
    'login_failure',
    'license_sharing',
    'hwid_ban',
    'server_error',
    'license_created',
    'license_added',
    'admin'
];

// ---------- command definition ----------
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
    .addSubcommand((sc) => sc.setName('test').setDescription('Send a test notification'))
    .addSubcommand((sc) => sc.setName('setup').setDescription('Create locked notification channels (License, Security, Login, Server)'));

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
            case 'setup': return subSetup(interaction, ctx);
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /notifications status.')], flags: MessageFlags.Ephemeral });
        }
    },
    loginEmbed,
    sharingAlertEmbed,
    serverErrorEmbed
};

// ---------- status / enable / disable / toggle / channel / test ----------

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

// ---------- /notifications setup ----------

const CATEGORY_NAME = 'TGGLR Bot';

// 4 locked channels:
//   license-channel  -> Create Key + View Licenses (license_created, license_added)
//   security-alerts  -> sharing ban (license_sharing, hwid_ban)
//   login-logs       -> login success/failure (login_success, login_failure)
//   server-logs      -> errors only (server_error)
const CHANNEL_PLAN = [
    { name: 'license-channel', types: ['license_created', 'license_added'] },
    { name: 'security-alerts', types: ['license_sharing', 'hwid_ban'] },
    { name: 'login-logs', types: ['login_success', 'login_failure'] },
    { name: 'server-logs', types: ['server_error'] }
];

const BOT_ALLOW = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory
];
const ADMIN_ALLOW = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory
];
const EVERYONE_DENY = [PermissionFlagsBits.ViewChannel];

async function subSetup(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    if (!guild) {
        return interaction.editReply({ embeds: [error('Wrong Context', 'This command only works in a server.')] });
    }
    if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.editReply({ embeds: [error('Missing Permission', 'I need the "Manage Channels" permission to create the log channels.')] });
    }

    try {
        let category = guild.channels.cache.find(
            (ch) => ch.type === ChannelType.GuildCategory && ch.name === CATEGORY_NAME
        );
        if (!category) {
            category = await guild.channels.create({
                name: CATEGORY_NAME,
                type: ChannelType.GuildCategory,
                permissionOverwrites: buildOverwrites(ctx, guild)
            });
        } else {
            await category.permissionOverwrites.set(buildOverwrites(ctx, guild));
        }

        const created = [];
        for (const entry of CHANNEL_PLAN) {
            let channel = guild.channels.cache.find(
                (ch) => ch.type === ChannelType.GuildText && ch.parentId === category.id && ch.name === entry.name
            );
            if (!channel) {
                channel = await guild.channels.create({
                    name: entry.name,
                    type: ChannelType.GuildText,
                    parent: category.id,
                    permissionOverwrites: buildOverwrites(ctx, guild)
                });
                created.push(entry.name);
            } else {
                await channel.permissionOverwrites.set(buildOverwrites(ctx, guild));
            }

            for (const type of entry.types) {
                await ctx.notifications.setChannel(type, channel.id);
            }
        }
        await ctx.notifications.setChannel('global', null);

        // Post/update the license dashboard with Create/View buttons.
        if (ctx.licenseDashboard) {
            const dashResult = await ctx.licenseDashboard.postOrUpdate(ctx);
            if (!dashResult.ok) {
                console.warn('[notifications] dashboard post failed:', dashResult.reason);
            }
        }

        const lines = CHANNEL_PLAN.map((entry) => {
            const routed = entry.types.map((t) => `\`${t}\``).join(', ');
            const channel = guild.channels.cache.find(
                (ch) => ch.parentId === category.id && ch.name === entry.name
            );
            return `${channel ? `<#${channel.id}>` : `\`#${entry.name}\``} \u2192 ${routed}`;
        });

        await ctx.db.audit('channels_setup', {
            actor: interaction.user.id,
            target: category.id,
            details: { created, via: 'discord' }
        });

        return interaction.editReply({
            embeds: [success('Notification Channels Ready', [
                `Category **${CATEGORY_NAME}** (locked: hidden from @everyone, admins + bot only)`,
                '',
                ...lines,
                '',
                created.length > 0
                    ? `Created ${created.length} new channel(s): \`${created.join('\`, \`')}\``
                    : 'All 4 channels already existed \u2014 permissions refreshed and routing rewired.',
                '',
                '\u2705 License channel = Create Key + View Licenses',
                '\u2705 Security alerts = BAN messages with HWID + User ID',
                '\u2705 Login logs = elegant format with Full Key + HWID + User ID + IGN + Discord mention',
                '\u2705 Server logs = errors only'
            ].join('\n'))]
        });
    } catch (error_) {
        return interaction.editReply({ embeds: [error('Setup Failed', error_.message)] });
    }
}

function buildOverwrites(ctx, guild) {
    const overwrites = [
        { id: guild.roles.everyone.id, deny: EVERYONE_DENY },
        { id: guild.members.me.id, allow: BOT_ALLOW }
    ];
    for (const adminId of ctx.config.adminUserIds) {
        overwrites.push({ id: adminId, allow: ADMIN_ALLOW });
    }
    return overwrites;
}

// ---------- embed builders (used by NotificationService) ----------

function loginEmbed({ outcome, license, metadata, code, firstSeen }) {
    const failure = outcome === 'failed';
    const discordUserId = metadata && metadata.discord_user_id ? metadata.discord_user_id : null;
    const discordMention = discordUserId ? `<@${discordUserId}>` : 'not bound';
    const ign = metadata && metadata.minecraft_username ? metadata.minecraft_username : 'auto-detect';
    const mcUuid = metadata && metadata.mc_uuid ? metadata.mc_uuid : 'not set';
    const hwid = metadata && metadata.hwid ? maskHwid(metadata.hwid) : 'unbound';
    const fullKey = metadata && metadata.license_key ? metadata.license_key : (license && license.license_key || 'unknown');
    const licenseType = license && license.expires_at ? 'Timed' : 'Lifetime';
    const expires = license && license.expires_at ? fmtDate(license.expires_at) : 'never';

    const embed = {
        color: failure ? COLORS.error : COLORS.success,
        title: failure ? '\u274C Login Failed' : '\u2705 Login Successful',
        description: failure
            ? `\`${fullKey}\` \u2192 rejected (\`${code || 'unknown'}\`)`
            : `\`${fullKey}\` \u2192 activated on device`,
        fields: [
            { name: 'IGN (Minecraft)', value: `\`${ign}\``, inline: true },
            { name: 'Discord User', value: `${discordMention} (\`${discordUserId || 'not bound'}\`)`, inline: true },
            { name: 'License Key', value: `\`${fullKey}\``, inline: true },
            { name: 'HWID (Device)', value: `\`${hwid}\``, inline: true },
            { name: 'License Type', value: licenseType, inline: true },
            { name: 'Expires', value: expires, inline: true },
            { name: 'Minecraft UUID', value: `\`${mcUuid}\``, inline: true },
            { name: 'Device', value: firstSeen ? 'First activation' : 'Returning device', inline: true }
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'LicenseManagerTGG \u2022 Login Logs' }
    };
    return embed;
}

function sharingAlertEmbed({ licenseKey, hwid, discordUserId, alertKind, reason, detectedAt }) {
    const discordMention = discordUserId ? `<@${discordUserId}>` : 'not bound';
    const detected = detectedAt ? new Date(detectedAt).toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' }) : 'just now';
    return {
        color: COLORS.error,
        title: '\u26A0\uFE0F License Sharing Detected \u2014 BAN',
        description: `License \`${maskKey(licenseKey)}\` was shared across devices and has been **banned**.`,
        fields: [
            { name: 'License Key', value: `\`${licenseKey}\``, inline: true },
            { name: 'Shared by (Discord)', value: `${discordMention} (\`${discordUserId || 'not bound'}\`)`, inline: true },
            { name: 'HWID (Banned Device)', value: `\`${maskHwid(hwid)}\``, inline: true },
            { name: 'Alert Type', value: alertKind || 'license_sharing', inline: true },
            { name: 'Detected At', value: detected, inline: true },
            { name: 'Reason', value: reason || 'HWID mismatch across multiple devices', inline: false },
            { name: 'Action', value: '\u274C License disabled + HWID banned', inline: false }
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'LicenseManagerTGG \u2022 Security Alert' }
    };
}

function serverErrorEmbed({ message, details }) {
    return {
        color: COLORS.error,
        title: '\u26A0\uFE0F Server Error',
        description: message || 'An error occurred',
        fields: details ? [{ name: 'Details', value: `\`${details}\``, inline: false }] : [],
        timestamp: new Date().toISOString(),
        footer: { text: 'LicenseManagerTGG \u2022 Server Logs' }
    };
}
