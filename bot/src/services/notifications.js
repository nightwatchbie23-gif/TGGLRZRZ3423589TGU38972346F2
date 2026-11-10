'use strict';

const { COLORS, fmtDate, maskHwid, maskKey } = require('../utils/format');
const {
    loginEmbed: buildLoginEmbed,
    sharingAlertEmbed: buildSharingEmbed,
    serverErrorEmbed: buildServerEmbed
} = require('../commands/notifications');

// Notification settings are stored in bot_settings:
//   channels.global   -> channel id used when no per-type channel is set
//   channels.<type>   -> channel id per notification type
//   types.<type>      -> boolean, default true (per-type enable/disable)
// Disabling notifications never affects logging or security enforcement.

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

class NotificationService {
    constructor(db, config) {
        this.db = db;
        this.config = config;
    }

    async loadState() {
        this.channels = await this.db.getSetting('channels', {});
        this.types = await this.db.getSetting('types', {});
        if (!this.channels || typeof this.channels !== 'object') {
            this.channels = {};
        }
        if (!this.types || typeof this.types !== 'object') {
            this.types = {};
        }
    }

    isEnabled(type) {
        return this.types[type] !== false;
    }

    targetChannelId(type) {
        return this.channels[type] || this.channels.global || null;
    }

    async setChannel(type, channelId) {
        this.channels[type === 'global' ? 'global' : type] = channelId;
        await this.db.setSetting('channels', this.channels);
    }

    async setType(type, enabled) {
        this.types[type] = enabled;
        await this.db.setSetting('types', this.types);
    }

    async status() {
        const channelSummary = {};
        for (const type of TYPES) {
            if (this.channels[type]) {
                channelSummary[type] = {
                    enabled: this.isEnabled(type),
                    target: `<#${this.channels[type]}>`
                };
            } else if (this.channels.global) {
                channelSummary[type] = {
                    enabled: this.isEnabled(type),
                    target: `<#${this.channels.global}> (global)`
                };
            } else {
                channelSummary[type] = { enabled: this.isEnabled(type), target: 'not configured' };
            }
        }
        return {
            globalChannel: this.channels.global ? `<#${this.channels.global}>` : 'not configured',
            types: channelSummary
        };
    }

    async send(type, message) {
        if (!this.isEnabled(type)) {
            return false;
        }
        const channelId = this.targetChannelId(type);
        if (!channelId) {
            console.warn(`[notifications] no channel configured for ${type}; notification skipped (logging continues)`);
            return false;
        }
        try {
            const channel = await this.config.client.channels.fetch(channelId);
            const payload = typeof message === 'object' && message.embeds
                ? message
                : { embeds: [message] };
            await channel.send(payload);
            return true;
        } catch (error) {
            console.error(`[notifications] failed to send ${type}:`, error.message);
            return false;
        }
    }

    async notifyAdmins(embed) {
        for (const userId of this.config.adminUserIds) {
            try {
                const user = await this.config.client.users.fetch(userId);
                await user.send({ embeds: [embed] });
            } catch {
                // DMs may be closed; channel notification is the primary path.
            }
        }
    }

    // ---------- embed builders ----------

    loginEmbed({ outcome, license, metadata, code, firstSeen }) {
        return buildLoginEmbed({ outcome, license, metadata, code, firstSeen });
    }

    sharingAlertEmbed({ licenseKey, hwid, discordUserId, alertKind, reason }) {
        return buildSharingEmbed({ licenseKey, hwid, discordUserId, alertKind, reason });
    }

    serverErrorEmbed({ message, details }) {
        return buildServerEmbed({ message, details });
    }

    licenseCreatedEmbed({ licenseKey, ownerId, duration, expiresAt, createdAt }) {
        const discordMention = ownerId ? `<@${ownerId}>` : 'not bound';
        const type = expiresAt ? 'Timed' : 'Lifetime';
        const expires = expiresAt ? fmtDate(expiresAt) : 'never';
        return {
            color: COLORS.success,
            title: '\u2705 License Created',
            description: `License \`${maskKey(licenseKey)}\` was created and the full key was sent to the owner by DM.`,
            fields: [
                { name: 'Discord Owner', value: `${discordMention} (\`${ownerId || 'not bound'}\`)`, inline: true },
                { name: 'License Key', value: `\`${maskKey(licenseKey)}\``, inline: true },
                { name: 'Type', value: type, inline: true },
                { name: 'Duration', value: duration || 'lifetime', inline: true },
                { name: 'Expires', value: expires, inline: true },
                { name: 'Created', value: createdAt ? fmtDate(createdAt) : 'just now', inline: true },
                { name: 'Minecraft IGN', value: 'auto-detected on first launch', inline: true }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'LicenseManagerTGG \u2022 License Channel' }
        };
    }
}

module.exports = { NotificationService, TYPES };
