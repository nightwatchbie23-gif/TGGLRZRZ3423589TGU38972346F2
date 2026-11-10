'use strict';

// Player cards: one live embed per player inside a dedicated (locked)
// "logs-subs" channel. Card = Minecraft name + skin image, HWID, Discord
// owner, license used, versions, last login. Refreshes automatically every
// time the player verifies in the client (login event), plus a daily re-render.
// /players clean archives the history to a JSON file (sent by DM) and wipes.

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const api = require('./api');
const { COLORS, fmtDate } = require('../utils/format');

const SETTINGS_KEY = 'playerCards';
const CHANNEL_NAME = 'logs-subs';
const CATEGORY_NAME = 'TGGLR Bot';
const CARD_COLOR_ONLINE = 0x00a8ff;
const STALE_DAYS = 7;

class PlayerService {
    constructor(config, db) {
        this.config = config;
        this.db = db;
        this.monitors = null; // set by index.js: live "in game" session data
        this.refreshTimer = null;
    }

    liveSession(licenseKey) {
        if (!this.monitors || !this.monitors.lastSeen) {
            return null;
        }
        const lastSeen = this.monitors.lastSeen.get(licenseKey);
        if (!lastSeen) {
            return null;
        }
        const gapMs = (this.monitors.config.sessionGapMinutes || 10) * 60 * 1000;
        if (Date.now() - lastSeen > gapMs) {
            return null; // session expired
        }
        return lastSeen;
    }

    async state() {
        const state = await this.db.getSetting(SETTINGS_KEY, {});
        if (!state || typeof state !== 'object') {
            return { channelId: null, cards: {} };
        }
        if (!state.cards || typeof state.cards !== 'object') {
            state.cards = {};
        }
        return state;
    }

    async saveState(state) {
        await this.db.setSetting(SETTINGS_KEY, state);
    }

    // ---------- data collection ----------

    // Returns Map(license_key -> latest login event data)
    async latestLogins(limitPerQuery = 300) {
        const map = new Map();
        try {
            const { data } = await this.db.client
                .from('bot_events')
                .select('id, event_type, payload, created_at')
                .eq('event_type', 'login')
                .order('id', { ascending: false })
                .limit(limitPerQuery);
            for (const row of data || []) {
                const payload = row.payload || {};
                const key = payload.license_key;
                if (!key || map.has(key)) {
                    continue; // first hit per key = most recent
                }
                map.set(key, {
                    ...(payload.request || {}),
                    hwid: payload.hwid,
                    outcome: payload.outcome,
                    code: payload.code,
                    at: row.created_at
                });
            }
        } catch { /* bot_events table unavailable */ }
        return map;
    }

    async playbook() {
        // All licenses paired with their latest login event (if any).
        const licenses = [];
        let offset = 0;
        while (offset < 5000) {
            const result = await api.listLicenses(this.config, { limit: 200, offset, status: 'all' });
            const rows = result.licenses || [];
            licenses.push(...rows);
            if (rows.length < 200) {
                break;
            }
            offset += 200;
        }
        const logins = await this.latestLogins();
        return { licenses, logins };
    }

    // ---------- card rendering ----------

    async buildCard(ctx, license, login) {
        const db = ctx ? ctx.db : this.db;
        const meta = await db.findLicenseMetadata(license.license_key).catch(() => null);
        const mcName = (login && (login.minecraft_username || login.mc_username)) || (meta && meta.minecraft_username) || null;
        const mcUuid = (login && login.mc_uuid) || (meta && meta.mc_uuid) || null;
        const skinId = mcUuid || mcName;

        const active = license.is_active !== false && (!license.expires_at || new Date(license.expires_at).getTime() > Date.now());
        const lastLogin = login && login.at ? fmtDate(login.at) : null;
        const stale = login && login.at ? (Date.now() - new Date(login.at).getTime() > STALE_DAYS * 86400 * 1000) : true;

        const embed = {
            color: active ? CARD_COLOR_ONLINE : COLORS.error,
            title: `Player Card \u2014 ${mcName || license.license_key}`,
            timestamp: new Date().toISOString(),
            footer: { text: `PlayerBoard \u2022 LicenseManagerTGG \u2022 auto-updates on login` }
        };
        if (skinId) {
            embed.thumbnail = { url: `https://mc-heads.net/avatar/${skinId}/256` };
            embed.image = { url: `https://mc-heads.net/body/${skinId}/left/${active ? 'default' : 'drowned'}` };
        }

        const fields = [
            { name: 'Minecraft', value: `${mcName ? `\`${mcName}\`` : '\u2014'}${mcUuid ? `\n\`${mcUuid}\`` : ''}`, inline: true },
            { name: 'Discord owner', value: meta && meta.discord_user_id ? `<@${meta.discord_user_id}>\n\`${meta.discord_user_id}\`` : '\u2014', inline: true },
            { name: 'License used', value: `\`${license.license_key}\``, inline: true },
            {
                name: 'HWID (device)',
                value: (login && login.hwid) || license.hwid || '\u2014 unbound \u2014',
                inline: false
            },
            {
                name: 'Status',
                value: `${license.is_active === false ? '\u274C Disabled' : (license.expires_at && new Date(license.expires_at).getTime() <= Date.now() ? '\u26A0\uFE0F Expired' : '\u2705 Active')}`
                    + (license.expires_at ? ` \u2014 expires ${fmtDate(license.expires_at)}` : ' \u2014 lifetime'),
                inline: true
            },
            {
                name: 'Last login',
                value: lastLogin ? `${lastLogin}${stale ? '' : ' \u{1F7E9}'}` : 'never',
                inline: true
            },
            {
                // Live status from the session tracker (polls /api/verify).
                name: 'In game now',
                value: (() => {
                    const live = this.liveSession(license.license_key);
                    if (live) {
                        return `\u{1F7E2} Online \u2014 since <t:${Math.floor(live / 1000)}:R>`;
                    }
                    const lastSeen = this.monitors ? this.monitors.lastSeen.get(license.license_key) : null;
                    return lastSeen ? `\u26AA Offline \u2014 last active <t:${Math.floor(lastSeen / 1000)}:R>` : '\u26AA Offline \u2014 no session yet';
                })(),
                inline: false
            },
            {
                name: 'Client',
                value: `TGGLR ${(login && login.tgglr_version) || '?'} \u2022 MC ${(login && login.mc_version) || '?'} \u2022 ${login && login.outcome === 'activated' ? 'first activation' : 'returning session'}`,
                inline: false
            }
        ];
        if (login && login.outcome === 'failed') {
            fields.push({ name: 'Last problem', value: `\u26A0\uFE0F Rejected: ${login.code || 'unknown'}`, inline: false });
        }
        embed.fields = fields;
        return embed;
    }

    // Post or update one player's card message.
    async upsertCard(ctx, license, login) {
        const state = await this.state();
        if (!state.channelId) {
            return false;
        }
        try {
            const channel = await this.config.client.channels.fetch(state.channelId);
            const embed = await this.buildCard(ctx, license, login);
            const stored = state.cards[license.license_key];
            if (stored) {
                const message = await channel.messages.fetch(stored).catch(() => null);
                if (message) {
                    await message.edit({ embeds: [embed] });
                    return true;
                }
                // Message was deleted; fall through and repost.
            }
            const message = await channel.send({ embeds: [embed] });
            state.cards[license.license_key] = message.id;
            await this.saveState(state);
            return true;
        } catch (error) {
            console.warn('[players] card update failed:', error.message);
            return false;
        }
    }

    async upsertFromEvent(ctx, event) {
        const payload = event.payload || {};
        if (!payload.license_key) {
            return;
        }
        const successful = payload.outcome === 'activated' || payload.outcome === 'verified';
        if (!successful) {
            // Failed logins never spawn new cards (no board spam from
            // broken guests); they only update a card that already exists.
            const state = await this.state();
            if (!state.cards[payload.license_key]) {
                return;
            }
        }
        const license = await api.findLicenseByKey(this.config, payload.license_key).catch(() => null);
        if (!license) {
            return;
        }
        const login = {
            ...(payload.request || {}),
            hwid: payload.hwid,
            outcome: payload.outcome,
            code: payload.code,
            at: event.created_at
        };
        await this.upsertCard(ctx, license, login);
    }

    // Re-render every card (used by setup, refresh, and the daily tick).
    async renderAllCards(ctx) {
        const state = await this.state();
        if (!state.channelId) {
            return { ok: false, reason: 'channel not created yet (\u2014 run /players create)' };
        }
        let channel;
        try {
            channel = await this.config.client.channels.fetch(state.channelId);
        } catch (error) {
            return { ok: false, reason: `channel fetch failed: ${error.message}` };
        }

        const { licenses, logins } = await this.playbook();
        // Cards only for licenses that were actually used at least once.
        const used = licenses.filter((license) => logins.has(license.license_key) || license.hwid || license.last_used_at);
        let updated = 0;
        let failed = 0;
        for (const license of used) {
            const ok = await this.upsertCard(ctx, license, logins.get(license.license_key) || null);
            if (ok) {
                updated += 1;
            } else {
                failed += 1;
            }
        }
        // Remove stale card references for licenses that no longer exist.
        const liveKeys = new Set(licenses.map((license) => license.license_key));
        for (const key of Object.keys(state.cards)) {
            if (!liveKeys.has(key)) {
                try {
                    const message = await channel.messages.fetch(state.cards[key]);
                    await message.delete();
                } catch { /* already gone */ }
                delete state.cards[key];
            }
        }
        await this.saveState(state);
        return { ok: true, cards: used.length, updated, failed, players: state.cards ? Object.keys(state.cards).length : 0 };
    }

    // ---------- channel + lifecycle ----------

    overwrites() {
        const overwrites = [
            { id: 'everyone-deny', type: 'role', deny: [PermissionFlagsBits.ViewChannel] },
            { id: this.config.client.user.id, type: 'member', allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] }
        ];
        for (const adminId of this.config.adminUserIds) {
            overwrites.push({ id: adminId, type: 'member', allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        }
        for (const overwrite of overwrites) {
            if (overwrite.id === 'everyone-deny') {
                overwrite.id = this.config.client.guilds.cache.first()?.roles.everyone?.id;
            }
        }
        return overwrites.filter((overwrite) => overwrite.id);
    }

    async ensureChannel(guild) {
        const existing = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildText && ch.name === CHANNEL_NAME);
        if (existing) {
            const state = await this.state();
            state.channelId = existing.id;
            await this.saveState(state);
            return { channel: existing, created: false };
        }
        let category = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildCategory && ch.name === CATEGORY_NAME);
        if (!category) {
            category = await guild.channels.create({
                name: CATEGORY_NAME,
                type: ChannelType.GuildCategory,
                permissionOverwrites: this.overwrites()
            });
        }
        const channel = await guild.channels.create({
            name: CHANNEL_NAME,
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: this.overwrites()
        });
        const state = await this.state();
        state.channelId = channel.id;
        await this.saveState(state);
        return { channel, created: true };
    }

    async cleanBoard(ctx) {
        // Archive every login event + wipe the board + delete login events.
        const snapshot = { exported_at: new Date().toISOString(), players: {}, events: [] };
        try {
            const { data } = await this.db.client
                .from('bot_events')
                .select('id, event_type, payload, created_at')
                .eq('event_type', 'login')
                .order('id', { ascending: false })
                .limit(1000);
            snapshot.events = data || [];
        } catch { /* table unavailable */ }

        const { logins } = await this.playbook();
        snapshot.players = Object.fromEntries(logins);

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = {
            name: `tgglr-player-logs-${stamp}.json`,
            attachment: Buffer.from(JSON.stringify(snapshot, null, 2))
        };

        // Wipe card messages.
        const state = await this.state();
        let deletedCards = 0;
        if (state.channelId) {
            try {
                const channel = await this.config.client.channels.fetch(state.channelId);
                const messages = await channel.messages.fetch({ limit: 100 });
                const deletable = messages.filter((message) => state.cards[message.id] || message.author.id === this.config.client.user.id);
                for (const message of Array.from(deletable.values()).slice(0, 300)) {
                    await message.delete().then(() => { deletedCards += 1; }).catch(() => {});
                }
            } catch (error) {
                console.warn('[players] cleanup failed:', error.message);
            }
        }
        state.cards = {};
        await this.saveState(state);

        // Optionally purge login events from the database.
        let purgedEvents = 0;
        try {
            const { error: purgeError, count } = await this.db.client
                .from('bot_events')
                .delete()
                .eq('event_type', 'login');
            purgedEvents = purgeError ? 0 : (count || snapshot.events.length);
        } catch { /* table unavailable */ }

        try { await this.db.audit('player_logs_cleaned', { details: { deletedCards, purgedEvents } }); } catch { /* best effort */ }

        return { file, deletedCards, purgedEvents, events: snapshot.events.length };
    }

    startDailyRefresh(ctx) {
        this.refreshTimer = setInterval(async () => {
            try {
                const result = await this.renderAllCards(ctx);
                if (result.ok) {
                    console.log(`[players] daily board refresh: ${result.updated} card(s) updated`);
                }
            } catch (error) {
                console.warn('[players] daily refresh failed:', error.message);
            }
        }, 24 * 60 * 60 * 1000);
        if (this.refreshTimer.unref) {
            this.refreshTimer.unref();
        }
    }
}

module.exports = { PlayerService, CHANNEL_NAME };
