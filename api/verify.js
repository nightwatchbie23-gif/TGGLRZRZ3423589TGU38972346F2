'use strict';

const { getConfig } = require('../lib/config');
const { getLicenseRepository } = require('../lib/supabase');
const { parseRequestBody, validateVerifyPayload } = require('../lib/validation');
const { verifyLicense } = require('../lib/license-service');
const { success, methodNotAllowed, handleError } = require('../lib/response');

function createVerifyHandler(options = {}) {
    const now = options.now || (() => new Date());

    return async function verifyHandler(req, res) {
        const method = String(req.method || '').toUpperCase();

        if (method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            const body = parseRequestBody(req.body);
            const credentials = validateVerifyPayload(body);

            const config = options.config || getConfig();
            const repository = options.repository || getLicenseRepository(config);

            const result = await verifyLicense(repository, credentials, { now: now() });
            const message = result.outcome === 'activated'
                ? 'License activated successfully'
                : 'License verified successfully';

            return success(res, 200, message);
        } catch (error) {
            return handleError(res, error, 'verify');
        }
    };
}

module.exports = createVerifyHandler();
module.exports.createVerifyHandler = createVerifyHandler;
