'use strict';

// Ties the bot's own Discord status to a watch list of users:
// - if ANY watched user is online/idle/dnd in a shared guild, the bot shows "online";
// - if NONE is, the bot goes invisible (appears offline).
// Commands still work while invisible; this only changes the visible status.

const WATCH_POLL_MS = 60000; // periodic refresh (guild member fetch)
const EVALUATE_DEBOUNCE_MS = 5000; // coalesce presenceUpdate bursts

function isPresent(presence) {
    if (!presence || !presence.status) return false;
    // A member that is not streaming/audio-connected counts via their text status.
    if (presence.status === 'offline') return false;
    // Some clients report online-type statuses on top of activities.
    if (presence.status === 'online' || presence.status === 'idle' || presence.status === 'dnd') return true;
    // Unknown platform 2 values (mobile web etc.) still indicate a session.
    return !['offline', 'invisible'].includes(presence.status);
}

async function evaluateOnce(ctx, client) {
    const ids = ctx.config.presenceIds;
    let anyOnline = false;

    for (const guild of client.guilds.cache.values()) {
        try {
            // Fetching members refreshes their cached presences (needs the
            // GuildPresences intent).
            const members = await guild.members.fetch({ user: ids });
            for (const id of ids) {
                const member = members.get(id);
                if (member && isPresent(member.presence)) {
                    anyOnline = true;
                }
            }
        } catch (error) {
            // Fall back to cached presences for this guild.
            for (const id of ids) {
                const member = guild.members.cache.get(id);
                if (member && isPresent(member.presence)) {
                    anyOnline = true;
                }
            }
            console.warn(`[presence] fetch failed in guild ${guild.id}: ${error.message}`);
        }
    }

    const wanted = anyOnline ? 'online' : 'invisible';
    client.user.setStatus(wanted).catch(() => {});
    return wanted;
}

// Starts the watcher. Returns nothing; never throws.
function startPresenceWatcher(ctx, client) {
    const ids = ctx.config.presenceIds || [];
    if (ids.length === 0) {
        return;
    }

    console.log(`[presence] watching ${ids.length} user(s); bot mirrors their online state`);

    let evaluating = false;
    let reRun = false;
    let lastWanted = null;

    async function run() {
        if (evaluating) {
            reRun = true;
            return;
        }
        evaluating = true;
        try {
            const wanted = await evaluateOnce(ctx, client);
            if (wanted !== lastWanted) {
                console.log(`[presence] bot status -> ${wanted}`);
                lastWanted = wanted;
            }
        } catch (error) {
            console.warn('[presence] evaluation failed:', error.message);
        } finally {
            evaluating = false;
            if (reRun) {
                reRun = false;
                setTimeout(run, EVALUATE_DEBOUNCE_MS);
            }
        }
    }

    // React immediately to gateway presence changes for watched users.
    client.on('presenceUpdate', (oldPresence, newPresence) => {
        if (!ids.includes(newPresence.userId)) {
            return;
        }
        setTimeout(run, EVALUATE_DEBOUNCE_MS);
    });

    // Periodic safety net (catches users whose presence events did not
    // arrive, e.g. going offline while bot was reconnecting).
    const timer = setInterval(run, WATCH_POLL_MS);
    timer.unref?.();

    // First evaluation after a short settle delay.
    setTimeout(run, 3000);
}

module.exports = { startPresenceWatcher };
