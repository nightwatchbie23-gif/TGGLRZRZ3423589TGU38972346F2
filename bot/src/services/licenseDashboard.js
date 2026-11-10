'use strict';

// License Dashboard — persistent message in #license-channel with buttons.
// Buttons: Create License (modal) + View Licenses (logs table).
// Message id stored in bot_settings 'licenseDashboard' so it survives restarts.

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags
} = require('discord.js');
const api = require('../services/api');
const { COLORS, base, error, fmtDate, maskKey, success } = require('../utils/format');
const { computeExpiresAt, describe, parseDuration } = require('../utils/duration');

const DASHBOARD_SETTING = 'licenseDashboard';
const LICENSE_CHANNEL_TYPE = 'license_created';

class LicenseDashboard {
    constructor(config, db, notifications) {
        this.config = config;
        this.db = db;
        this.notifications = notifications;
    }

    async state() {
        const s = await this.db.getSetting(DASHBOARD_SETTING, {});
        return s && typeof s === 'object' ? s : {};
    }

    async saveState(s) {
        await this.db.setSetting(DASHBOARD_SETTING, s);
    }

    buildEmbed() {
        const embed = base('TGGLR License Dashboard', COLORS.primary);
        embed.description = [
            'Manage your TGGLR licenses:',
            '',
            '✅ **Create License** — owner ID, MC username, duration.',
            '📋 **View Licenses** — owners, MC names, expiry, time left.',
            '',
            'MC username auto-detected from the game client.'
        ].join('\n');
        embed.footer = { text: 'LicenseManagerTGG • License Dashboard' };
        return embed;
    }

    buildButtons() {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('licdash:create')
                .setLabel('Create License')
                .setEmoji('\u2705')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('licdash:view')
                .setLabel('View Licenses')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary)
        );
    }

    async postOrUpdate(ctx) {
        const channelId = this.notifications.targetChannelId(LICENSE_CHANNEL_TYPE);
        if (!channelId) {
            return { ok: false, reason: 'License channel not configured — run /notifications setup first' };
        }
        try {
            const channel = await this.config.client.channels.fetch(channelId);
            const state = await this.state();
            const embed = this.buildEmbed();
            const buttons = this.buildButtons();

            if (state.messageId) {
                try {
                    const message = await channel.messages.fetch(state.messageId);
                    await message.edit({ embeds: [embed], components: [buttons] });
                    return { ok: true, reused: true };
                } catch {
                    // message deleted — repost below.
                }
            }

            const message = await channel.send({ embeds: [embed], components: [buttons] });
            await this.saveState({ messageId: message.id, channelId });
            return { ok: true, reused: false };
        } catch (error) {
            return { ok: false, reason: error.message };
        }
    }

    async handleInteraction(interaction, ctx) {
        const customId = interaction.customId || '';

        if (customId === 'licdash:create') {
            if (!(await this.isAllowed(interaction.user.id))) {
                return interaction.reply({ embeds: [error('Not Authorized', 'Creation is restricted to admins or granted users.')], flags: MessageFlags.Ephemeral });
            }
            const modal = new ModalBuilder()
                .setCustomId('licdashCreateModal')
                .setTitle('Create TGGLR License')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('owner_id')
                            .setLabel('Owner Discord ID')
                            .setPlaceholder('e.g. 1370478516034076813')
                            .setStyle(TextInputStyle.Short)
                            .setMinLength(17)
                            .setMaxLength(20)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('mc_username')
                            .setLabel('Minecraft Username (optional - auto-detected)')
                            .setPlaceholder('Leave blank to detect from game')
                            .setStyle(TextInputStyle.Short)
                            .setMaxLength(32)
                            .setRequired(false)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('duration')
                            .setLabel('Duration (empty = lifetime)')
                            .setPlaceholder('e.g. 7d, 2w, 3m, 1y, 1y2m3w5d, L')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                    )
                );
            return interaction.showModal(modal);
        }

        if (customId === 'licdash:view') {
            if (!(await this.isAllowed(interaction.user.id))) {
                return interaction.reply({ embeds: [error('Not Authorized', 'Viewing is restricted to admins or granted users.')], flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const result = await api.listLicenses(ctx.config, { limit: 15, status: 'all' });
                const licenses = result.licenses || [];
                const metas = {};
                for (const license of licenses) {
                    try {
                        const m = await this.db.findLicenseMetadata(license.license_key).catch(() => null);
                        if (m) metas[license.license_key] = m;
                    } catch { /* skip */ }
                }
                const lines = licenses.map((license) => {
                    const meta = metas[license.license_key] || {};
                    const expires = license.expires_at ? new Date(license.expires_at).getTime() : 0;
                    const now = Date.now();
                    const expired = expires > 0 && expires <= now;

                    const owner = meta.discord_user_id
                        ? `<@${meta.discord_user_id}>` : 'not bound';
                    const ownerId = meta.discord_user_id
                        ? `(\`${meta.discord_user_id}\`)` : '';
                    const mc = meta.minecraft_username
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
                        `   👤 ${owner} ${ownerId}`,
                        `   🎮 MC: ${mc}`,
                        `   ${statusLine} — ${dateLine}`
                    ].join('\n');
                });
                const embed = base('Current Licenses', COLORS.primary);
                embed.description = lines.join('\n\n') || 'No licenses.';
                embed.fields = [{ name: 'Total', value: String(result.total || 0), inline: true }];
                return interaction.editReply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            } catch (error_) {
                return interaction.editReply({ embeds: [error('View Failed', error_.message)], flags: MessageFlags.Ephemeral });
            }
        }

        if (customId === 'licdashCreateModal') {
            // handled separately in interactionCreate
            return;
        }
    }

    async handleModalSubmit(interaction, ctx) {
        if (interaction.customId !== 'licdashCreateModal') {
            return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const ownerIdRaw = interaction.fields.getTextInputValue('owner_id').trim();
            if (!/^\d{17,20}$/.test(ownerIdRaw)) {
                return interaction.editReply({ embeds: [error('Invalid Owner', `'${ownerIdRaw}' is not a valid Discord user ID.`) ] });
            }
            const mcUsername = interaction.fields.getTextInputValue('mc_username').trim();
            const durationRaw = interaction.fields.getTextInputValue('duration').trim();
            let spec = null;
            if (durationRaw) {
                spec = parseDuration(durationRaw);
            }
            const expiresAt = computeExpiresAt(new Date(), spec);
            const license = await api.createLicense(ctx.config, expiresAt ? { expiresAt: expiresAt.toISOString() } : { duration: 'L' });
            await this.db.updateLicenseMetadata(license.license_key, {
                discordUserId: ownerIdRaw,
                ...(mcUsername ? { minecraftUsername: mcUsername } : {})
            });
            await this.db.audit('license_created', { actor: interaction.user.id, target: license.license_key, details: { owner: ownerIdRaw, duration: durationRaw || 'lifetime', via: 'dashboard_button' } });

            const channelId = this.notifications.targetChannelId(LICENSE_CHANNEL_TYPE);
            if (channelId) {
                try {
                    const channel = await this.config.client.channels.fetch(channelId);
                    await channel.send({ embeds: [success('License Created from Dashboard', [
                        `Key: \`${maskKey(license.license_key)}\``,
                        `Owner: <@${ownerIdRaw}> (\`${ownerIdRaw}\`)`,
                        mcUsername ? `Minecraft Username: \`${mcUsername}\`` : 'Minecraft Username: auto-detect on launch',
                        `Duration: ${describe(spec)}${expiresAt ? ` — expires ${fmtDate(expiresAt.toISOString())}` : ' — lifetime'}`,
                        '',
                        'Full key sent to owner by DM.'
                    ].join('\n'))] });
                } catch { /* channel fetch failed */ }
            }

            try {
                const owner = await this.config.client.users.fetch(ownerIdRaw);
                await owner.send({ embeds: [success('TGGLR License Key', [
                    `Key: \`${license.license_key}\``,
                    mcUsername ? `Minecraft Username: \`${mcUsername}\`` : 'Minecraft Username: auto-detected on first launch',
                    `Duration: ${describe(spec)}${expiresAt ? ` — expires ${fmtDate(expiresAt.toISOString())}` : ' — lifetime'}`,
                    '',
                    'Keep this key private — it binds to your device on first use.'
                ].join('\n'))] });
            } catch {
                return interaction.editReply({ embeds: [error('DM Failed', `License \`${maskKey(license.license_key)}\` created but owner has DMs closed. Use /license info to get the key.`) ] });
            }

            return interaction.editReply({ embeds: [success('Created', `License \`${maskKey(license.license_key)}\` created and full key DM'd to owner <@${ownerIdRaw}>.`) ] });
        } catch (error_) {
            return interaction.editReply({ embeds: [error('Creation Failed', error_.message)] });
        }
    }

    async isAllowed(userId) {
        const { isAllowed } = require('../utils/guards');
        return isAllowed(this.config, this.db, userId, 'license');
    }
}

module.exports = { LicenseDashboard, DASHBOARD_SETTING };
