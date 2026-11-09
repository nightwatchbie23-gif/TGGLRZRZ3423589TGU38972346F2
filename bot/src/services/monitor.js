'use strict';

// Background monitor:
// - polls bot_events (written by the backend /api/verify) and turns them into
//   login notifications, server activity and license-sharing detection
// - sweeps for session joins/leaves
// - hourly license-expiry watcher
// Notifications never affect license validation or enforcement: those happen
// server-side in the backend.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const api = require('./api');
const { COLORS, fmtDate, maskHwid, maskKey } = require('../utils/format');

class Monitor {
    constructor(client, config, db, notifications) {
        this.client = config.client;
        this.config = config;
        this.db = db;
        this.notifications = notifications;
        this.lastEventId = 0;
        this.lastSeen = new Map(); // licenseKey -> timestamp of last successful verify
        this.licenseState = new Map(); // licenseKey -> sharing detection state
        this.mismatchWindow = new Map(); // licenseKey -> timestamps of HWID mismatch failures
        this.pollTimer = null;
        this.sweepTimer = null;
        this.expiryTimer = null;
        this.clientVersion = null;
    }

    async start() {
        this.clientVersion = await this.db.getSetting('client_version');
        this.lastEventId = Number(await this.db.getSetting('last_event_id', 0)) || 0;
        this.restoreSeenState(await this.db.getSetting('last_seen', {}));

        this.pollTimer = setInterval(() => this.pollEvents().catch((error) => {
            console.error('[monitor] poll failed:', error.message);
        }), this.config.pollIntervalMs);
        this.sweepTimer = setInterval(() => this.sweepSessions(), 60_000);
        this.expiryTimer = setInterval(() => this.checkExpirations().catch((error) => {
            console.error('[monitor] expiry check failed:', error.message);
        }), 60 * 60 * 1000);
        setTimeout(() => this.checkExpirations().catch(() => {}), 30_000);

        console.log('[monitor] started');
    }

    stop() {
        clearInterval(this.pollTimer);
        clearInterval(this.sweepTimer);
        clearInterval(this.expiryTimer);
    }

    restoreSeenState(state) {
        if (!state || typeof state !== 'object') {
            return;
        }
        const cutoff = Date.now() - this.config.sessionGapMinutes * 60_000;
        for (const [key, value] of Object.entries(state)) {
            if (value >= cutoff) {
                this.lastSeen.set(key, value);
            }
        }
    }

    async persistSeenState() {
        const state = Object.fromEntries(this.lastSeen);
        await this.db.setSetting('last_seen', state);
    }

    async pollEvents() {
        const events = await this.db.fetchEvents(this.lastEventId, 50);
        for (const event of events) {
            this.lastEventId = event.id;
            try {
                await this.handleEvent(event);
            } catch (error) {
                console.error(`[monitor] event ${event.id} failed:`, error.message);
            }
        }
        if (events.length > 0) {
            await this.db.setSetting('last_event_id', this.lastEventId);
            await this.persistSeenState();
        }
        return events.length;
    }

    async handleEvent(event) {
        if (event.event_type !== 'login') {
            return;
        }
        const payload = event.payload || {};
        const request = payload.request || {};
        const licenseKey = payload.license_key;
        const outcome = payload.outcome;

        if (!licenseKey) {
            return;
        }

        // Server session tracking (successful verifications only).
        if (outcome === 'activated' || outcome === 'verified') {
            await this.trackSession(licenseKey);
        }

        // Sharing / abuse detection.
        if (outcome === 'failed' && payload.code === 'HWID_MISMATCH') {
            await this.trackMismatch(licenseKey);
        } else if (outcome === 'activated' || outcome === 'verified') {
            await this.trackSharing(licenseKey, payload.hwid, request.mc_uuid);
        }

        // Login notifications.
        const type = outcome === 'failed' ? 'login_failure' : 'login_success';
        if (!this.notifications.isEnabled(type)) {
            return;
        }

        const license = await api.findLicenseByKey(this.config, licenseKey);
        const firstSeen = outcome === 'activated';
        const embed = this.notifications.loginEmbed({
            outcome,
            license,
            metadata: {
                license_key: licenseKey,
                hwid: payload.hwid,
                ...request
            },
            code: payload.code,
            firstSeen
        });
        await this.notifications.send(type, embed);
    }

    // ---------- sharing detection (alert_review, never auto-bans) ----------
    getState(licenseKey) {
        let state = this.licenseState.get(licenseKey);
        if (!state) {
            state = { hwids: new Map(), uuids: new Map() };
            this.licenseState.set(licenseKey, state);
        }
        return state;
    }

    async raiseAlert(licenseKey, kind, details) {
        const alertId = await this.db.createAlert(licenseKey, kind, details);
        if (!alertId) {
            return;
        }
        await this.notifyAlert(alertId, licenseKey, kind, details);
        await this.db.audit('sharing_alert', {
            actor: 'monitor',
            target: licenseKey,
            details: { alert_kind: kind, alert_id: alertId, ...details }
        });
    }

    async notifyAlert(alertId, licenseKey, kind, details) {
        const embed = {
            color: COLORS.warn,
            title: 'License Sharing Alert',
            description: `Suspicious activity detected. Review required \u2014 no action taken automatically.`,
            fields: [
                { name: 'Alert ID', value: String(alertId), inline: true },
                { name: 'License', value: maskKey(licenseKey), inline: true },
                { name: 'Kind', value: kind, inline: true },
                { name: 'Details', value: JSON.stringify(maskDetails(details), null, 2).slice(0, 1000), inline: false }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'Confirm or dismiss with /license sharing' }
        };
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`sharing:confirm:${alertId}`)
                .setLabel('Confirm (disable license)')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`sharing:dismiss:${alertId}`)
                .setLabel('Dismiss')
                .setStyle(ButtonStyle.Secondary)
        );

        await this.notifications.send('license_sharing', { embeds: [embed], components: [row] });
        await this.notifications.notifyAdmins(embed);
    }

    async trackSharing(licenseKey, hwid, mcUuid) {
        if (!hwid && !mcUuid) {
            return;
        }
        const state = this.getState(licenseKey);
        const now = Date.now();

        // Different Minecraft UUIDs on the same license.
        if (mcUuid) {
            const knownAt = state.uuids.get(mcUuid);
            if (knownAt === undefined) {
                const distinctCount = state.uuids.size;
                state.uuids.set(mcUuid, now);
                if (distinctCount >= 1) {
                    await this.raiseAlert(licenseKey, 'mc_uuid_change', {
                        mc_uuid: mcUuid,
                        known_uuid_count: distinctCount + 1
                    });
                }
            }
        }

        // Suspicious concurrent sessions: distinct HWIDs within the window from
        // a different device, after a binding already existed.
        if (hwid) {
            const knownAt = state.hwids.get(hwid);
            let isConcurrent = false;
            if (knownAt === undefined && state.hwids.size >= 1) {
                for (const seenAt of state.hwids.values()) {
                    if (now - seenAt < 30 * 60_000) {
                        isConcurrent = true;
                        break;
                    }
                }
            }
            state.hwids.set(hwid, now);
            if (isConcurrent) {
                await this.raiseAlert(licenseKey, 'concurrent_sessions', {
                    hwid,
                    distinct_hwids: state.hwids.size
                });
            }
        }
    }

    async trackMismatch(licenseKey) {
        const now = Date.now();
        const window = this.mismatchWindow.get(licenseKey) || [];
        const recent = window.filter((time) => now - time < 24 * 60 * 60_000);
        recent.push(now);
        this.mismatchWindow.set(licenseKey, recent);
        if (recent.length >= 3 && recent.length === window.length + 0 + 1) {
            await this.raiseAlert(licenseKey, 'device_churn', {
                mismatches_24h: recent.length
            });
        }
    }

    // ---------- server activity (own client sessions only) ----------
    async trackSession(licenseKey) {
        const now = Date.now();
        const previous = this.lastSeen.get(licenseKey);
        this.lastSeen.set(licenseKey, now);
        const gapMinutes = this.config.sessionGapMinutes;

        if (!previous || now - previous > gapMinutes * 60_000) {
            if (this.notifications.isEnabled('server')) {
                const license = await api.findLicenseByKey(this.config, licenseKey).catch(() => null);
                const embed = {
                    color: COLORS.success,
                    title: 'Client Session Started',
                    fields: [
                        { name: 'License', value: maskKey(licenseKey), inline: true },
                        { name: 'Minecraft username', value: license && license.minecraft_username ? license.minecraft_username : 'unknown', inline: true },
                        { name: 'Discord ID', value: license && license.discord_user_id ? `<@${license.discord_user_id}>` : 'not linked', inline: true }
                    ],
                    timestamp: new Date().toISOString(),
                    footer: { text: 'LicenseManagerTGG' }
                };
                await this.notifications.send('server', embed);
            }
        }
    }

    async sweepSessions() {
        if (!this.notifications.isEnabled('server')) {
            return;
        }
        const cutoff = Date.now() - this.config.sessionGapMinutes * 60_000;
        let changed = false;
        for (const [licenseKey, seenAt] of this.lastSeen.entries()) {
            if (seenAt < cutoff && seenAt >= cutoff - this.config.pollIntervalMs * 2 - 60_000) {
                this.lastSeen.delete(licenseKey);
                changed = true;
                const embed = {
                    color: COLORS.neutral,
                    title: 'Client Session Ended',
                    fields: [{ name: 'License', value: maskKey(licenseKey), inline: true }],
                    timestamp: new Date().toISOString(),
                    footer: { text: 'LicenseManagerTGG' }
                };
                await this.notifications.send('server', embed).catch(() => {});
            }
        }
        if (changed) {
            await this.persistSeenState().catch(() => {});
        }
    }

    // ---------- expiry watcher ----------
    async checkExpirations() {
        if (!this.notifications.isEnabled('license_expiry')) {
            return;
        }
        const sent = (await this.db.getSetting('expiry_sent', {})) || {};
        const now = Date.now();
        const horizon = now + 7 * 24 * 60 * 60_000;
        let changed = false;

        let offset = 0;
        while (offset < 2000) {
            const result = await api.listLicenses(this.config, { limit: 200, offset, status: 'all' });
            const licenses = result.licenses || [];
            for (const license of licenses) {
                if (!license.expires_at) {
                    continue;
                }
                const expires = new Date(license.expires_at).getTime();
                if (Number.isNaN(expires) || expires > horizon || sent[license.license_key]) {
                    continue;
                }
                sent[license.license_key] = true;
                changed = true;
                const expired = expires <= now;
                const embed = {
                    color: expired ? COLORS.error : COLORS.warn,
                    title: expired ? 'License Expired' : 'License Expiring Soon',
                    fields: [
                        { name: 'License', value: maskKey(license.license_key), inline: true },
                        { name: 'Status', value: license.is_active ? 'Enabled' : 'Disabled', inline: true },
                        { name: 'Expires', value: fmtDate(license.expires_at), inline: true }
                    ],
                    timestamp: new Date().toISOString(),
                    footer: { text: 'LicenseManagerTGG' }
                };
                await this.notifications.send('license_expiry', embed);
            }
            if (licenses.length < 200) {
                break;
            }
            offset += 200;
        }

        if (changed) {
            await this.db.setSetting('expiry_sent', sent);
        }
    }

    // Generic action notification (admin actions, HWID changes and bans).
    async notifyAction(type, description) {
        const embed = {
            color: COLORS.warn,
            title: 'Administrative Action',
            description,
            timestamp: new Date().toISOString(),
            footer: { text: 'LicenseManagerTGG' }
        };
        await this.notifications.send(type, embed);
        await this.notifications.notifyAdmins(embed);
    }

    // ---------- sharing alerts (called from commands & buttons) ----------
    async confirmAlert(alertId, actor) {
        const alert = await this.db.decideAlert(alertId, 'confirmed', actor);
        if (!alert) {
            return null;
        }
        await api.updateLicense(this.config, alert.license_key, 'disable');
        await this.db.audit('sharing_confirmed', {
            actor,
            target: alert.license_key,
            reason: `alert #${alertId} confirmed; license disabled`
        });
        return alert;
    }

    async dismissAlert(alertId, actor) {
        const alert = await this.db.decideAlert(alertId, 'dismissed', actor);
        if (!alert) {
            return null;
        }
        await this.db.audit('sharing_dismissed', {
            actor,
            target: alert.license_key,
            reason: `alert #${alertId} dismissed`
        });
        return alert;
    }
}

function maskDetails(details) {
    const masked = { ...details };
    if (masked.hwid) {
        masked.hwid = maskHwid(masked.hwid);
    }
    if (masked.mc_uuid) {
        masked.mc_uuid = `${String(masked.mc_uuid).slice(0, 8)}\u2026`;
    }
    return masked;
}

module.exports = { Monitor };
