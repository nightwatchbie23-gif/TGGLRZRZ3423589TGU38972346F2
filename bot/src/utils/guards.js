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

// ---------- access list ----------
// IDs granted via /access can use normal bot commands (license, hwid, login,
// server) but NOT admin-only commands (admin, system, notifications) and are
// never notified as admins. Cached briefly to avoid a DB hit per command.

const ACCESS_CACHE_TTL_MS = 60000;
let accessCache = { ids: new Set(), loadedAt: 0 };

function invalidateAccessCache() {
    accessCache = { ids: new Set(), loadedAt: 0 };
}

async function loadAllowedUsers(db) {
    if (Date.now() - accessCache.loadedAt < ACCESS_CACHE_TTL_MS) {
        return accessCache.ids;
    }
    const list = await db.getSetting('allowedUsers', []);
    accessCache = { ids: new Set(Array.isArray(list) ? list.map(String) : []), loadedAt: Date.now() };
    return accessCache.ids;
}

async function addAllowedUser(db, userId) {
    const ids = await loadAllowedUsers(db);
    if (!ids.has(userId)) {
        ids.add(userId);
        await db.setSetting('allowedUsers', [...ids]);
    }
    invalidateAccessCache();
    return ids;
}

async function removeAllowedUser(db, userId) {
    const ids = await loadAllowedUsers(db);
    if (ids.has(userId)) {
        ids.delete(userId);
        await db.setSetting('allowedUsers', [...ids]);
    }
    invalidateAccessCache();
    return ids;
}

// Commands granted users are NOT allowed to run (admins only).
const ADMIN_ONLY_COMMANDS = new Set(['admin', 'system', 'notifications']);

async function isAllowed(config, db, userId, commandName) {
    if (config.adminUserIds.has(userId)) {
        return true;
    }
    if (commandName && ADMIN_ONLY_COMMANDS.has(commandName)) {
        return false;
    }
    const ids = await loadAllowedUsers(db);
    return ids.has(userId);
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

module.exports = {
    isAdmin,
    isAllowed,
    addAllowedUser,
    removeAllowedUser,
    ADMIN_ONLY_COMMANDS,
    isMaintenance,
    isRateLimited,
    maintenanceMessage
};
