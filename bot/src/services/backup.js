'use strict';

// Daily automatic license backups. Full JSON (including keys) is delivered
// either to a configured channel (admins-only channel recommended) or by DM
// to the first reachable admin. Also stored locally under bot/backups.

const fs = require('node:fs');
const path = require('node:path');
const { AttachmentBuilder } = require('discord.js');
const api = require('./api');

const SETTINGS_KEY = 'backup';
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

async function collectAllLicenses(ctx) {
    const all = [];
    let offset = 0;
    while (offset < 50000) {
        const result = await api.listLicenses(ctx.config, { limit: 200, offset, status: 'all' });
        const licenses = result.licenses || [];
        all.push(...licenses);
        if (licenses.length < 200) {
            break;
        }
        offset += 200;
    }
    return all;
}

async function buildBackupPayload(ctx) {
    const licenses = await collectAllLicenses(ctx);
    return {
        created_at: new Date().toISOString(),
        source: 'LicenseManagerTGG',
        count: licenses.length,
        licenses
    };
}

// Sends the backup: configured channel first, otherwise DM to admins.
// Never throws; returns delivery info.
async function deliverBackup(ctx, payload, { manual = false, channelOnly = false } = {}) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = new AttachmentBuilder(
        Buffer.from(JSON.stringify(payload, null, 2)),
        { name: `tgglr-licenses-${stamp}.json` }
    );
    const caption = `Package of licenses (${payload.count} keys) \u2014 ${manual ? 'manual backup' : 'automatic daily backup'}`;

    // Persist a local copy as well (same file manual /admin backup writes).
    try {
        const dir = path.join(__dirname, '..', '..', 'backups');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `licenses-${stamp}.json`), JSON.stringify(payload, null, 2));
    } catch (error) {
        console.warn('[backup] local copy failed:', error.message);
    }

    const settings = await ctx.db.getSetting(SETTINGS_KEY, {}) || {};

    if (settings.channelId) {
        try {
            const channel = await ctx.config.client.channels.fetch(settings.channelId);
            await channel.send({ content: caption, files: [file] });
            return { delivered: true, target: `channel <#${settings.channelId}>` };
        } catch (error) {
            console.warn('[backup] channel delivery failed:', error.message);
        }
    }
    if (channelOnly) {
        return { delivered: false, target: 'no channel configured (and channel-only requested)' };
    }
    for (const adminId of ctx.config.adminUserIds) {
        try {
            const user = await ctx.config.client.users.fetch(adminId);
            await user.send({ content: `${caption}\nKeep this file private \u2014 it contains all license keys.`, files: [file] });
            return { delivered: true, target: `DM <@${adminId}>` };
        } catch {
            // Try the next admin.
        }
    }
    return { delivered: false, target: 'nowhere (no channel, all DMs failed)' };
}

async function runBackup(ctx, options = {}) {
    const payload = await buildBackupPayload(ctx);
    const delivered = await deliverBackup(ctx, payload, options);
    try {
        await ctx.db.audit('backup_created', {
            actor: options.manual ? ctx.config.client.user.id : 'system',
            details: { count: payload.count, mode: options.manual ? 'manual' : 'automatic', ...delivered }
        });
    } catch { /* audit best-effort */ }
    return { count: payload.count, ...delivered };
}

async function isSameUtcDate(a, b) {
    return a.getUTCFullYear() === b.getUTCFullYear()
        && a.getUTCMonth() === b.getUTCMonth()
        && a.getUTCDate() === b.getUTCDate();
}

// Runs at most once per UTC day, at/after the configured hour (default 03:00).
// If the bot was off when the hour passed, the next 15-minute check catches up.
function startDailyBackup(ctx) {
    async function tick() {
        try {
            const settings = await ctx.db.getSetting(SETTINGS_KEY, {}) || {};
            if (settings.enabled === false) {
                return;
            }
            const now = new Date();
            const authorTime = settings.lastRun ? new Date(settings.lastRun) : null;
            if (authorTime && !Number.isNaN(authorTime.getTime()) && await isSameUtcDate(authorTime, now)) {
                return; // already backed up today
            }
            const hour = Number.isInteger(settings.hour) ? settings.hour : 3;
            if (now.getUTCHours() < hour) {
                return; // too early in the day (still catches up later)
            }
            const result = await runBackup(ctx, { manual: false });
            settings.lastRun = now.toISOString();
            await ctx.db.setSetting(SETTINGS_KEY, settings);
            console.log(`[backup] daily backup finished: ${result.count} licenses -> ${result.target}`);
        } catch (error) {
            console.warn('[backup] daily backup failed:', error.message);
        }
    }

    const timer = setInterval(tick, CHECK_INTERVAL_MS);
    if (timer.unref) {
        timer.unref();
    }
    setTimeout(tick, 25000); // first check shortly after startup
    console.log('[backup] daily backup scheduler started (checks every 15m)');
}

module.exports = {
    SETTINGS_KEY,
    startDailyBackup,
    runBackup,
    buildBackupPayload
};
