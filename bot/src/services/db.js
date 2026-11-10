'use strict';

// Direct Supabase access for bot-owned data: HWID bans, bot events, audit
// logs, sharing alerts and settings. Licenses themselves are always managed
// through the backend management API.

const { createClient } = require('@supabase/supabase-js');

const WARNED = new Set();

function warnOnce(table, message) {
    if (WARNED.has(table)) {
        return;
    }
    WARNED.add(table);
    console.warn(`[database] ${message} (${table})`);
}

class BotDatabase {
    constructor(config) {
        this.client = createClient(config.supabaseUrl, config.supabaseKey, {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false
            }
        });
    }

    async run(table, operation) {
        try {
            return await operation();
        } catch (error) {
            console.error(`[database] ${table} operation failed:`, error.message);
            return null;
        }
    }

    // ---------- settings ----------
    async getSetting(key, fallback = null) {
        const value = await this.run('bot_settings', async () => {
            const { data, error } = await this.client
                .from('bot_settings')
                .select('value')
                .eq('key', key)
                .maybeSingle();
            if (error) {
                throw error;
            }
            return data ? data.value : fallback;
        });
        return value ?? fallback;
    }

    async setSetting(key, value) {
        const result = await this.run('bot_settings', async () => {
            const { error } = await this.client
                .from('bot_settings')
                .upsert({ key, value, updated_at: new Date().toISOString() });
            if (error) {
                throw error;
            }
            return true;
        });
        return result ?? false;
    }

    // ---------- audit ----------
    async audit(eventType, { actor, target, reason, details } = {}) {
        return this.run('audit_logs', async () => {
            const { error } = await this.client.from('audit_logs').insert({
                event_type: eventType,
                actor: actor || null,
                target: target || null,
                reason: reason || null,
                details: details || null
            });
            if (error) {
                throw error;
            }
            return true;
        });
    }

    async listAudit({ limit = 10, offset = 0, target } = {}) {
        return this.run('audit_logs', async () => {
            let request = this.client
                .from('audit_logs')
                .select('id, event_type, actor, target, reason, details, created_at', { count: 'exact' });
            if (target) {
                request = request.eq('target', target);
            }
            const { data, error, count } = await request
                .order('id', { ascending: false })
                .range(offset, offset + limit - 1);
            if (error) {
                throw error;
            }
            return { rows: data || [], total: count || 0 };
        });
    }

    // ---------- HWID bans ----------
    async banHwid(hwid, { reason, bannedBy, licenseKey } = {}) {
        const result = await this.run('hwid_bans', async () => {
            // Deactivate previous rows for this HWID so history is preserved.
            await this.client.from('hwid_bans').update({ active: false }).eq('hwid', hwid);
            const { error } = await this.client.from('hwid_bans').insert({
                hwid,
                reason,
                banned_by: bannedBy || null,
                license_key: licenseKey || null,
                active: true
            });
            if (error) {
                throw error;
            }
            return true;
        });
        return result ?? false;
    }

    async unbanHwid(hwid) {
        const result = await this.run('hwid_bans', async () => {
            const { data, error } = await this.client
                .from('hwid_bans')
                .update({ active: false })
                .eq('hwid', hwid)
                .eq('active', true)
                .select('id');
            if (error) {
                throw error;
            }
            return Array.isArray(data) && data.length > 0;
        });
        return result ?? false;
    }

    async listBans({ limit = 10, offset = 0, hwid } = {}) {
        const result = await this.run('hwid_bans', async () => {
            let request = this.client
                .from('hwid_bans')
                .select('id, hwid, reason, banned_by, license_key, active, created_at', { count: 'exact' });
            if (hwid) {
                request = request.eq('hwid', hwid);
            }
            const { data, error, count } = await request
                .order('id', { ascending: false })
                .range(offset, offset + limit - 1);
            if (error) {
                throw error;
            }
            return { rows: data || [], total: count || 0 };
        });
        return result || { rows: [], total: 0 };
    }

    // ---------- bot events ----------
    async fetchEvents(afterId, limit = 50) {
        const events = await this.run('bot_events', async () => {
            const { data, error } = await this.client
                .from('bot_events')
                .select('id, event_type, payload, created_at')
                .gt('id', afterId)
                .order('id', { ascending: true })
                .limit(limit);
            if (error) {
                throw error;
            }
            return data || [];
        });
        return events || [];
    }

    // ---------- sharing alerts ----------
    async createAlert(licenseKey, alertKind, details) {
        return this.run('sharing_alerts', async () => {
            // Deduplicate: one open alert per license+kind.
            const { data: existing } = await this.client
                .from('sharing_alerts')
                .select('id')
                .eq('license_key', licenseKey)
                .eq('alert_kind', alertKind)
                .eq('status', 'open')
                .limit(1);
            if (existing && existing.length > 0) {
                return existing[0].id;
            }
            const { data, error } = await this.client
                .from('sharing_alerts')
                .insert({ license_key: licenseKey, alert_kind: alertKind, details })
                .select('id')
                .single();
            if (error) {
                throw error;
            }
            return data.id;
        });
    }

    async getAlert(id) {
        return this.run('sharing_alerts', async () => {
            const { data, error } = await this.client
                .from('sharing_alerts')
                .select('*')
                .eq('id', id)
                .maybeSingle();
            if (error) {
                throw error;
            }
            return data || null;
        });
    }

    async decideAlert(id, status, decidedBy) {
        return this.run('sharing_alerts', async () => {
            const now = new Date().toISOString();
            const { data, error } = await this.client
                .from('sharing_alerts')
                .update({ status, decided_by: decidedBy, decided_at: now })
                .eq('id', id)
                .eq('status', 'open')
                .select('*')
                .maybeSingle();
            if (error) {
                throw error;
            }
            return data || null;
        });
    }

    async listAlerts({ licenseKey, limit = 10, offset = 0 } = {}) {
        return this.run('sharing_alerts', async () => {
            let request = this.client
                .from('sharing_alerts')
                .select('*', { count: 'exact' });
            if (licenseKey) {
                request = request.eq('license_key', licenseKey);
            }
            const { data, error, count } = await request
                .order('id', { ascending: false })
                .range(offset, offset + limit - 1);
            if (error) {
                throw error;
            }
            return { rows: data || [], total: count || 0 };
        });
    }

    // ---------- license metadata (bot-managed association columns) ----------
    async updateLicenseMetadata(licenseKey, fields) {
        const result = await this.run('licenses', async () => {
            const patch = {};
            if (fields.discordUserId !== undefined) {
                patch.discord_user_id = fields.discordUserId;
            }
            if (fields.minecraftUsername !== undefined) {
                patch.minecraft_username = fields.minecraftUsername;
            }
            if (Object.keys(patch).length === 0) {
                return false;
            }
            const { error } = await this.client
                .from('licenses')
                .update(patch)
                .eq('license_key', licenseKey);
            if (error) {
                throw error;
            }
            return true;
        });
        return result ?? false;
    }

    async findLicenseMetadata(licenseKey) {
        return this.run('licenses', async () => {
            const { data, error } = await this.client
                .from('licenses')
                .select('license_key, discord_user_id, minecraft_username, mc_uuid')
                .eq('license_key', licenseKey)
                .maybeSingle();
            if (error) {
                throw error;
            }
            return data || null;
        });
    }
}

module.exports = { BotDatabase };
