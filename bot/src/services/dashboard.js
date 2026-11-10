'use strict';

// Per-channel live dashboards: one pinned-style control embed in each of the
// four locked TGGLR Bot channels. Buttons let admins (and granted users) act
// without typing commands. Message ids are stored in bot_settings 'dashboards'.

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const api = require('./api');
const { COLORS, base, error, fmtDate, maskHwid, maskKey, success } = require('../utils/format');
const { computeExpiresAt, parseDuration } = require('../utils/duration');
const { isAllowed } = require('../utils/guards');

// Channel name each dashboard lives in (matches /notifications setup plan).
const DASH_CHANNELS = {
    license: 'license-logs',
    login: 'login-logs',
    security: 'security-alerts',
    server: 'server-logs'
};

const DASH_TITLES = {
    license: 'Licenses Dashboard',
    login: 'Logins Dashboard',
    security: 'Security Dashboard',
    server: 'Server Dashboard'
};

function refreshButton(kind) {
    return new ButtonBuilder()
        .setCustomId(`dash:refresh:${kind}`)
        .setLabel('Refresh')
        .setEmoji('\u{1F504}')
        .setStyle(ButtonStyle.Secondary);
}

function componentsFor(kind) {
    const row = new ActionRowBuilder().addComponents(refreshButton(kind));
    if (kind === 'license') {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('dash:create')
                .setLabel('Create License')
                .setEmoji('\u{1F7E2}')
                .setStyle(ButtonStyle.Success)
        );
    }
    if (kind === 'security') {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('dash:testalert')
                .setLabel('Test Alert')
                .setEmoji('\u26A0\uFE0F')
                .setStyle(ButtonStyle.Danger)
        );
    }
    return [row];
}

// ---------- embed builders ----------

async function buildLicenseEmbed(ctx) {
    const counts = {};
    for (const status of ['all', 'active', 'disabled', 'expired', 'lifetime']) {
        try {
            const result = await api.listLicenses(ctx.config, { limit: 1, status });
            counts[status] = result.total || 0;
        } catch {
            counts[status] = '?';
        }
    }
    let bansTotal = 0;
    try {
        const bans = await ctx.db.listBans({ limit: 1 });
        bansTotal = bans ? bans.total : 0;
    } catch { /* table unavailable */ }

    const embed = base(DASH_TITLES.license, COLORS.primary);
    embed.fields = [
        { name: 'Total', value: String(counts.all), inline: true },
        { name: 'Active', value: String(counts.active), inline: true },
        { name: 'Lifetime', value: String(counts.lifetime), inline: true },
        { name: 'Expired', value: String(counts.expired), inline: true },
        { name: 'Disabled', value: String(counts.disabled), inline: true },
        { name: 'HWID bans', value: String(bansTotal), inline: true }
    ];
    embed.description = [
        `\u{1F4C5} Updated: <t:${Math.floor(Date.now() / 1000)}:R>`,
        '',
        '**Quick actions:** \u{1F7E2} Create License (opens a form) \u2014 new keys go out with the normal public + owner-DM flow.',
        'Use slash commands `/license search`, `/license info`, `/license transfer` for everything else.'
    ].join('\n');
    embed.footer = { text: 'LicenseManagerTGG \u2014 auto-updating panel' };
    return embed;
}

async function buildLoginEmbed(ctx) {
    let rows = [];
    try {
        const { data } = await ctx.db.client
            .from('bot_events')
            .select('id, event_type, payload, created_at')
            .in('event_type', ['login_success', 'login_failure'])
            .order('id', { ascending: false })
            .limit(8);
        rows = data || [];
    } catch { /* table unavailable */ }

    const embed = base(DASH_TITLES.login, COLORS.primary);
    embed.description = `\u{1F4C5} Updated: <t:${Math.floor(Date.now() / 1000)}:R>`;
    embed.fields = [
        {
            name: 'Recent logins',
            value: rows.map((row) => {
                const payload = row.payload || {};
                const ok = row.event_type === 'login_success';
                return `${ok ? '\u2705' : '\u{274C}'} \`${maskKey(payload.license_key || 'unknown')}\` \u2014 ${payload.minecraft_username || 'unknown'}${ok ? '' : ` (${payload.code || 'rejected'})`} \u2014 ${fmtDate(row.created_at)}`;
            }).join('\n') || 'No logins recorded yet.'
        }
    ];
    embed.footer = { text: 'Full detail via /login list' };
    return embed;
}

async function buildSecurityEmbed(ctx) {
    let alerts = { rows: [], total: 0 };
    let bans = 0;
    try {
        alerts = await ctx.db.listAlerts({ limit: 5 });
    } catch { /* table unavailable */ }
    try {
        const result = await ctx.db.listBans({ limit: 1 });
        bans = result ? result.total : 0;
    } catch { /* table unavailable */ }
    const open = (alerts.rows || []).filter((row) => row.status === 'open');

    const embed = base(DASH_TITLES.security, COLORS.danger ?? COLORS.error);
    embed.description = `\u{1F4C5} Updated: <t:${Math.floor(Date.now() / 1000)}:R>`;
    embed.fields = [
        {
            name: 'Open sharing alerts',
            value: open.map((row) =>
                `\u{1F6A8} #${row.id} \`${maskKey(row.license_key)}\` (${row.alert_kind}) \u2014 ${fmtDate(row.created_at)}`
            ).join('\n') || 'None open. \u2705'
        },
        {
            name: 'Recent alerts',
            value: (alerts.rows || []).map((row) =>
                `#${row.id} \`${maskKey(row.license_key)}\` \u2014 ${row.status} \u2014 ${fmtDate(row.created_at)}`
            ).join('\n') || 'No alerts recorded.'
        },
        { name: 'HWID bans (total)', value: String(bans), inline: true }
    ];
    embed.footer = { text: 'Decide alerts with the buttons on alert messages, or /license sharing' };
    return embed;
}

async function buildServerEmbed(ctx) {
    const started = Date.now();
    let healthy = false;
    try {
        await api.listLicenses(ctx.config, { limit: 1 });
        healthy = true;
    } catch { /* unhealthy */ }
    const latency = Date.now() - started;

    const embed = base(DASH_TITLES.server, COLORS.primary);
    embed.description = `\u{1F4C5} Updated: <t:${Math.floor(Date.now() / 1000)}:R>`;
    embed.fields = [
        { name: 'Backend', value: `\`${ctx.config.apiUrl}\``, inline: true },
        { name: 'API health', value: healthy ? `\u2705 OK (${latency} ms)` : '\u{274C} Unreachable', inline: true },
        { name: 'Bot uptime', value: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`, inline: true },
        { name: 'Guild commands', value: String(ctx.commands.size), inline: true },
        { name: 'Node', value: process.version, inline: true }
    ];
    embed.footer = { text: 'Detailed status via /server status' };
    return embed;
}

const BUILDERS = {
    license: buildLicenseEmbed,
    login: buildLoginEmbed,
    security: buildSecurityEmbed,
    server: buildServerEmbed
};

async function buildDashboard(ctx, kind) {
    const builder = BUILDERS[kind];
    if (!builder) {
        return null;
    }
    try {
        return await builder(ctx);
    } catch (error_) {
        return error(`${DASH_TITLES[kind]} \u2014 error`, error_.message);
    }
}

// ---------- setup / refresh persistence ----------

async function getStoredDashboards(ctx) {
    const stored = await ctx.db.getSetting('dashboards', {});
    return stored && typeof stored === 'object' ? stored : {};
}

async function saveStoredDashboards(ctx, stored) {
    await ctx.db.setSetting('dashboards', stored);
}

async function upsertDashboardForChannel(ctx, channel, kind) {
    const stored = await getStoredDashboards(ctx);
    const entry = stored[kind];

    // Reuse the existing message if it still lives in this channel.
    if (entry && entry.messageId && entry.channelId === channel.id) {
        try {
            const message = await channel.messages.fetch(entry.messageId);
            const embed = await buildDashboard(ctx, kind);
            await message.edit({ embeds: [embed] });
            stored[kind] = { channelId: channel.id, messageId: message.id, title: DASH_TITLES[kind] };
            await saveStoredDashboards(ctx, stored);
            return { reused: true };
        } catch {
            // Message is gone; post a fresh one below.
        }
    }

    const embed = await buildDashboard(ctx, kind);
    const message = await channel.send({ embeds: [embed], components: componentsFor(kind) });
    stored[kind] = { channelId: channel.id, messageId: message.id, title: DASH_TITLES[kind] };
    await saveStoredDashboards(ctx, stored);
    return { reused: false };
}

// ---------- button + modal handling ----------

async function handleDashboardInteraction(ctx, interaction) {
    const customId = interaction.customId || '';

    if (interaction.isButton() && customId.startsWith('dash:refresh:')) {
        const kind = customId.slice('dash:refresh:'.length);
        if (!BUILDERS[kind]) {
            return interaction.deferUpdate();
        }
        if (!(await isAllowed(ctx.config, ctx.db, interaction.user.id, 'license'))) {
            return replyEphemeral(interaction, error('Not Authorized', 'You cannot use this dashboard.'));
        }
        await interaction.deferUpdate();
        try {
            const embed = await buildDashboard(ctx, kind);
            await interaction.editReply({ embeds: [embed] });
        } catch (error_) {
            await interaction.followUp({ embeds: [error('Refresh Failed', error_.message)] }).catch(() => {});
        }
        return;
    }

    if (interaction.isButton() && customId === 'dash:create') {
        if (!(await isAllowed(ctx.config, ctx.db, interaction.user.id, 'license'))) {
            return replyEphemeral(interaction, error('Not Authorized', 'You cannot create licenses.'));
        }
        const modal = new ModalBuilder()
            .setCustomId('dashCreateModal')
            .setTitle('Create TGGLR License')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('owner_id')
                        .setLabel('Owner Discord ID')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(17)
                        .setMaxLength(20)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('mc_username')
                        .setLabel('MC username (auto-detected \u2014 optional)')
                        .setStyle(TextInputStyle.Short)
                        .setMaxLength(32)
                        .setRequired(false)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('duration')
                        .setLabel('Duration (empty = lifetime)')
                        .setPlaceholder('e.g. 1m, 2y3w, 30d \u2014 compounds allowed')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                )
            );
        await interaction.showModal(modal);
        return;
    }

    if (interaction.isModalSubmit() && customId === 'dashCreateModal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const ownerIdRaw = interaction.fields.getTextInputValue('owner_id').trim();
            if (!/^\d{17,20}$/.test(ownerIdRaw)) {
                return interaction.editReply({ embeds: [error('Invalid Owner', `'${ownerIdRaw}' is not a valid Discord user ID.`)] });
            }
            const username = interaction.fields.getTextInputValue('mc_username').trim();
            const durationRaw = interaction.fields.getTextInputValue('duration').trim();

            let spec = null;
            if (durationRaw) {
                spec = parseDuration(durationRaw);
            }
            const expiresAt = computeExpiresAt(new Date(), spec);
            const license = await api.createLicense(
                ctx.config,
                expiresAt ? { expiresAt: expiresAt.toISOString() } : { duration: 'L' }
            );
            await ctx.db.updateLicenseMetadata(license.license_key, {
                discordUserId: ownerIdRaw,
                ...(username ? { minecraftUsername: username } : {})
            });
            await ctx.db.audit('license_created', {
                actor: interaction.user.id,
                target: license.license_key,
                details: { owner: ownerIdRaw, minecraft_username: username || 'auto-detect', duration: durationRaw || 'lifetime', via: 'dashboard' }
            });

            // Public confirmation in the dashboard channel, then owner DM.
            const publicEmbed = success('License Created', [
                `Key: \`${maskKey(license.license_key)}\``,
                `Owner: <@${ownerIdRaw}>`,
                `Minecraft username: ${username || 'auto-detected on first game launch'}`,
                expiresAt ? `Expires: ${fmtDate(expiresAt.toISOString())}` : 'Expires: never (Lifetime)',
                '',
                `The full key was sent to <@${ownerIdRaw}> by DM.`
            ].join('\n'));
            await interaction.channel.send({ embeds: [publicEmbed] }).catch(() => {});

            try {
                await interaction.client.users.fetch(ownerIdRaw).then((owner) => owner.send({
                    content: `**TGGLR license key**\n\`\`\`\n${license.license_key}\n\`\`\`\nMinecraft username: ${username || 'auto-detected on first launch'}\nKeep this key private \u2014 it binds to your device on first use.`
                }));
            } catch {
                return interaction.editReply({ embeds: [error('DM Failed', `License \`${maskKey(license.license_key)}\` created, but the owner has DMs closed. Use /license info to retrieve the key.`)] });
            }

            return interaction.editReply({
                embeds: [success('Created', `License \`${maskKey(license.license_key)}\` created and the full key was DM'd to <@${ownerIdRaw}>.`)]
            });
        } catch (error_) {
            return interaction.editReply({ embeds: [error('Creation Failed', error_.message)] });
        }
    }

    if (interaction.isButton() && customId === 'dash:testalert') {
        if (!(await isAllowed(ctx.config, ctx.db, interaction.user.id, 'license'))) {
            return replyEphemeral(interaction, error('Not Authorized', 'You cannot use this dashboard.'));
        }
        await interaction.deferUpdate();
        try {
            const embed = await buildDashboard(ctx, 'security');
            await interaction.editReply({ embeds: [embed] });
            const test = success('Security Dashboard', 'Security data refreshed above. Real alerts arrive automatically with action buttons.');
            await interaction.channel.send({ embeds: [test] });
        } catch (error_) {
            await interaction.followUp({ embeds: [error('Refresh Failed', error_.message)] }).catch(() => {});
        }
        return;
    }

    if (interaction.isButton() && customId.startsWith('dash:')) {
        await interaction.deferUpdate();
        return;
    }
}

function replyEphemeral(interaction, embed) {
    return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
}

module.exports = {
    DASH_CHANNELS,
    buildDashboard,
    componentsFor,
    handleDashboardInteraction,
    getStoredDashboards,
    saveStoredDashboards,
    upsertDashboardForChannel
};
