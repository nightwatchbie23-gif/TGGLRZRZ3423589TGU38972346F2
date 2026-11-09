'use strict';

const { getConfig } = require('../lib/config');
const { getLicenseRepository } = require('../lib/supabase');
const { parseRequestBody, validateVerifyPayload } = require('../lib/validation');
const { verifyLicense } = require('../lib/license-service');
const { checkHwidBan, emitEvent, updateClientMetadata } = require('../lib/observability');
const { HttpError } = require('../lib/errors');
const { success, methodNotAllowed, handleError } = require('../lib/response');

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_METADATA_LENGTH = 128;
const METADATA_FIELDS = [
    'minecraft_username',
    'mc_uuid',
    'mc_version',
    'tgglr_version'
];

// Optional, backward-compatible metadata sent by newer TGGLR clients.
// Existing clients keep working: every field is optional and validated leniently.
function extractMetadata(body) {
    const metadata = {};

    for (const field of METADATA_FIELDS) {
        const value = body[field];
        if (Array.isArray(value) || typeof value !== 'string') {
            continue;
        }
        const trimmed = value.trim();
        if (!trimmed || trimmed.length > MAX_METADATA_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
            continue;
        }
        metadata[field] = trimmed;
    }

    return metadata;
}

function createVerifyHandler(options = {}) {
    const now = options.now || (() => new Date());

    return async function verifyHandler(req, res) {
        const method = String(req.method || '').toUpperCase();

        if (method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        let credentials = null;
        let client = null;

        try {
            const body = parseRequestBody(req.body);
            credentials = validateVerifyPayload(body);
            const metadata = extractMetadata(body);

            const config = options.config || getConfig();
            const repository = options.repository || getLicenseRepository(config);
            client = repository.client || null;

            let ban = { banned: false, checked: false };
            if (client) {
                ban = await checkHwidBan(client, credentials.hwid);
            }
            if (ban.banned) {
                throw new HttpError(403, 'HWID_BANNED', 'This device is banned from using TGGLR');
            }

            const result = await verifyLicense(repository, credentials, { now: now() });
            const message = result.outcome === 'activated'
                ? 'License activated successfully'
                : 'License verified successfully';

            if (client) {
                await updateClientMetadata(client, credentials.licenseKey, metadata);
            }

            await emitEvent(client, 'login', {
                outcome: result.outcome,
                license_key: credentials.licenseKey,
                hwid: credentials.hwid,
                request: metadata
            });

            return success(res, 200, message);
        } catch (error) {
            if (credentials) {
                const code = error.code || 'INTERNAL_ERROR';
                if (code !== 'INVALID_BODY' && code !== 'INVALID_CREDENTIALS') {
                    await emitEvent(client, 'login', {
                        outcome: 'failed',
                        code,
                        license_key: credentials.licenseKey,
                        hwid: credentials.hwid
                    });
                }
            }
            return handleError(res, error, 'verify');
        }
    };
}

module.exports = createVerifyHandler();
module.exports.createVerifyHandler = createVerifyHandler;
