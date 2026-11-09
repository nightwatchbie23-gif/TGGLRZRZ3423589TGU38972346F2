'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

// Load bot/.env first, then the repository root .env as a fallback.
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

function read(name, { required = false, fallback = '' } = {}) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') {
        return value.trim();
    }
    if (required) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return fallback;
}

let cached = null;

function getConfig() {
    if (cached) {
        return cached;
    }

    cached = {
        discordToken: read('DISCORD_BOT_TOKEN', { required: true }),
        applicationId: read('DISCORD_APPLICATION_ID', { required: true }),
        guildId: read('DISCORD_GUILD_ID'),
        apiUrl: read('TGGLR_API_URL', { fallback: 'https://tgglr.vercel.app' }).replace(/\/+$/, ''),
        apiSecret: read('TGGLR_API_SECRET', { required: true }),
        supabaseUrl: read('SUPABASE_URL', { required: true }).replace(/\/+$/, ''),
        supabaseKey: read('SUPABASE_SERVICE_ROLE_KEY', { required: true }),
        adminUserIds: new Set(
            read('ADMIN_USER_IDS').split(',').map((id) => id.trim()).filter(Boolean)
        ),
        pollIntervalMs: Math.max(1000, Number(read('EVENT_POLL_INTERVAL_MS', { fallback: '3000' })) || 3000),
        sessionGapMinutes: Math.max(1, Number(read('SESSION_GAP_MINUTES', { fallback: '10' })) || 10)
    };

    return cached;
}

module.exports = { getConfig };
