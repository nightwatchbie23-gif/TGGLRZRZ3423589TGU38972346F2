'use strict';

function readFirst(env, names) {
    for (const name of names) {
        const value = env[name];
        if (typeof value === 'string' && value.trim() !== '') {
            return value.trim();
        }
    }
    return '';
}

function getConfig(env = process.env) {
    return {
        supabaseUrl: readFirst(env, ['SUPABASE_URL']).replace(/\/+$/, ''),
        supabaseKey: readFirst(env, ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_KEY']),
        adminToken: readFirst(env, ['LICENSE_ADMIN_TOKEN', 'ADMIN_API_KEY'])
    };
}

module.exports = { getConfig };
