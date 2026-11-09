'use strict';

const { COLORS, fmtDate, maskHwid, maskKey } = require('../utils/format');

// Notification settings are stored in bot_settings:
//   channels.global   -> channel id used when no per-type channel is set
//   channels.<type>   -> channel id per notification type
//   types.<type>      -> boolean, default true (per-type enable/disable)
// Disabling notifications never affects logging or security enforcement.

const TYPES = [
    'login_success',
    'login_failure',
    'license_sharing',
    'hwid',
    'server',
    'license_expiry',
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

    loginEmbed({ outcome, license, metadata, code, firstSeen }) {
        const failure = outcome === 'failed';
        const embed = {
            color: failure ? COLORS.error : COLORS.success,
            title: failure ? 'Login Failed' : 'Login Successful',
            fields: [
                { name: 'Minecraft username', value: String(metadata.minecraft_username || 'unknown'), inline: true },
                { name: 'Minecraft UUID', value: String(metadata.mc_uuid || 'not provided'), inline: true },
                { name: 'Discord ID', value: license && license.discord_user_id ? `<@${license.discord_user_id}> (${license.discord_user_id})` : 'not linked', inline: true },
                { name: 'License key', value: maskKey(metadata.license_key), inline: true },
                { name: 'License type', value: license && license.expires_at ? 'Timed' : 'Lifetime', inline: true },
                { name: 'License status', value: failure ? `Rejected (${code})` : 'Active', inline: true },
                { name: 'HWID', value: maskHwid(metadata.hwid), inline: true },
                { name: 'TGGLR version', value: String(metadata.tgglr_version || 'not provided'), inline: true },
                { name: 'Minecraft version', value: String(metadata.mc_version || 'not provided'), inline: true },
                { name: 'Device', value: firstSeen ? 'First activation' : 'Returning device', inline: true }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'LicenseManagerTGG' }
        };
        return embed;
    }
}

module.exports = { NotificationService, TYPES };
