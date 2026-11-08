'use strict';

const { HttpError } = require('./errors');
const { createLicenseRepository } = require('./license-repository');

let cachedClient = null;
let cachedSignature = null;
let cachedRepository = null;

function getSupabaseClient(config) {
    const signature = `${config.supabaseUrl}|${config.supabaseKey}`;

    if (!cachedClient || cachedSignature !== signature) {
        const { createClient } = require('@supabase/supabase-js');
        cachedClient = createClient(config.supabaseUrl, config.supabaseKey, {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false
            }
        });
        cachedSignature = signature;
        cachedRepository = null;
    }

    return cachedClient;
}

function getLicenseRepository(config) {
    if (!config || !config.supabaseUrl || !config.supabaseKey) {
        throw new HttpError(500, 'SERVER_CONFIG', 'Server configuration error');
    }

    const client = getSupabaseClient(config);
    if (!cachedRepository) {
        cachedRepository = createLicenseRepository(client);
    }

    return cachedRepository;
}

module.exports = { getLicenseRepository };
