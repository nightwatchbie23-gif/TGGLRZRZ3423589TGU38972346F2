'use strict';

// Fire-and-forget helpers used by the API handlers. Every function here is
// failure-tolerant: observability must never break license verification or
// management responses. All helpers no-op safely when no Supabase client is
// available (e.g. tests inject fakes without one).

function hasClient(repository) {
    return Boolean(repository && repository.client);
}

function summarize(error) {
    if (!error) {
        return '';
    }
    return error.message || String(error);
}

async function emitEvent(client, eventType, payload) {
    if (!client) {
        return false;
    }
    try {
        const { error } = await client
            .from('bot_events')
            .insert({ event_type: eventType, payload });
        if (error) {
            console.error(`Failed to record ${eventType} event:`, summarize(error));
        }
        return !error;
    } catch (error) {
        console.error(`Failed to record ${eventType} event:`, summarize(error));
        return false;
    }
}

async function recordAudit(client, { eventType, actor, target, reason, details }) {
    if (!client) {
        return false;
    }
    try {
        const { error } = await client.from('audit_logs').insert({
            event_type: eventType,
            actor: actor || null,
            target: target || null,
            reason: reason || null,
            details: details || null
        });
        if (error) {
            console.error('Failed to record audit entry:', summarize(error));
        }
        return !error;
    } catch (error) {
        console.error('Failed to record audit entry:', summarize(error));
        return false;
    }
}

// First-seen wins: fields are only populated while they are NULL so the
// backend never overwrites bot-managed associations. Fails silently when the
// optional migration columns are absent.
async function updateClientMetadata(client, licenseKey, fields) {
    if (!client) {
        return;
    }

    for (const column of ['minecraft_username', 'mc_uuid']) {
        const value = fields[column];
        if (typeof value !== 'string' || !value) {
            continue;
        }
        try {
            const { error } = await client
                .from('licenses')
                .update({ [column]: value })
                .eq('license_key', licenseKey)
                .is(column, null);
            if (error && isMissingColumnError(error)) {
                console.warn('Optional license columns are missing; apply migrations/002_bot_support.sql');
                return;
            }
            if (error) {
                console.error(`Failed to update ${column}:`, summarize(error));
            }
        } catch (error) {
            console.error(`Failed to update ${column}:`, summarize(error));
        }
    }
}

function isMissingColumnError(error) {
    if (!error) {
        return false;
    }
    const message = String(error.message || '').toLowerCase();
    return (
        error.code === 'PGRST204' ||
        (message.includes('column') && message.includes('does not exist'))
    );
}

// HWID ban enforcement. Fails open (banned: false) only when the ban table is
// unavailable, so verification keeps working while the migration is not yet
// applied; every failure is logged.
async function checkHwidBan(client, hwid) {
    if (!client) {
        return { banned: false, checked: false };
    }

    try {
        const { data, error } = await client
            .from('hwid_bans')
            .select('id, reason')
            .eq('hwid', hwid)
            .eq('active', true)
            .limit(1);

        if (error && isMissingTableError(error)) {
            console.warn('hwid_bans table is missing; ban checks skipped. Apply migrations/002_bot_support.sql');
            return { banned: false, checked: false };
        }
        if (error) {
            console.error('Failed to check HWID bans:', summarize(error));
            return { banned: false, checked: false };
        }

        const ban = data && data.length > 0 ? data[0] : null;
        return { banned: Boolean(ban), reason: ban ? ban.reason : null, checked: true };
    } catch (error) {
        console.error('Failed to check HWID bans:', summarize(error));
        return { banned: false, checked: false };
    }
}

function isMissingTableError(error) {
    if (!error) {
        return false;
    }
    const message = String(error.message || '').toLowerCase();
    return (
        error.code === 'PGRST205' ||
        (message.includes('does not exist') && !message.includes('column'))
    );
}

module.exports = {
    checkHwidBan,
    emitEvent,
    hasClient,
    recordAudit,
    updateClientMetadata
};
