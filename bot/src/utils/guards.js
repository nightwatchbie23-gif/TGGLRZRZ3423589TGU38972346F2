'use strict';

// In-memory per-user rate limiting and shared interaction guards.

const RATE_LIMIT_ENTRIES = 10;
const RATE_LIMIT_WINDOW_MS = 10_000;

const buckets = new Map();

function isRateLimited(userId) {
    const now = Date.now();
    let timestamps = buckets.get(userId);
    if (!timestamps) {
        timestamps = [];
        buckets.set(userId, timestamps);
    }
    while (timestamps.length > 0 && now - timestamps[0] > RATE_LIMIT_WINDOW_MS) {
        timestamps.shift();
    }
    if (timestamps.length >= RATE_LIMIT_ENTRIES) {
        return true;
    }
    timestamps.push(now);
    return false;
}

function isAdmin(config, userId) {
    return config.adminUserIds.has(userId);
}

async function isMaintenance(db) {
    const state = await db.getSetting('maintenance', { enabled: false });
    return Boolean(state && state.enabled);
}

async function maintenanceMessage(db) {
    const state = await db.getSetting('maintenance', {});
    const parts = ['Bot is in maintenance mode. Administrative commands are paused.'];
    if (state && state.reason) {
        parts.push(`Reason: ${state.reason}`);
    }
    return parts.join('\n');
}

module.exports = { isAdmin, isMaintenance, isRateLimited, maintenanceMessage };
