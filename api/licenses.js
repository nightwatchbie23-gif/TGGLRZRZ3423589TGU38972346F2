'use strict';

const { getConfig } = require('../lib/config');
const { authenticateAdmin } = require('../lib/auth');
const { getLicenseRepository } = require('../lib/supabase');
const {
    parseRequestBody,
    validateCreatePayload,
    validateUpdatePayload,
    validateListQuery,
    validateLicenseKey
} = require('../lib/validation');
const {
    createLicense,
    updateLicense,
    listLicenses,
    deleteLicense
} = require('../lib/license-service');
const { success, methodNotAllowed, handleError } = require('../lib/response');

const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE';

function getRequestQuery(req) {
    const query = {};

    if (typeof req.url === 'string' && req.url.includes('?')) {
        const url = new URL(req.url, 'http://localhost');
        for (const [key, value] of url.searchParams) {
            if (query[key] === undefined) {
                query[key] = value;
            }
        }
    }

    if (req.query && typeof req.query === 'object') {
        for (const [key, value] of Object.entries(req.query)) {
            if (query[key] === undefined) {
                query[key] = Array.isArray(value) ? value[0] : value;
            }
        }
    }

    return query;
}

function createLicensesHandler(options = {}) {
    const now = options.now || (() => new Date());

    return async function licensesHandler(req, res) {
        const method = String(req.method || '').toUpperCase();

        if (!ALLOWED_METHODS.includes(method)) {
            return methodNotAllowed(res, ALLOWED_METHODS);
        }

        try {
            const config = options.config || getConfig();
            authenticateAdmin(req, config);

            const repository = options.repository || getLicenseRepository(config);
            const currentTime = now();

            if (method === 'GET') {
                const filters = validateListQuery(getRequestQuery(req));
                const result = await listLicenses(repository, filters, { now: currentTime });
                return success(res, 200, 'Licenses retrieved', result);
            }

            if (method === 'POST') {
                const input = validateCreatePayload(parseRequestBody(req.body));
                const license = await createLicense(repository, input, { now: currentTime });
                return success(res, 201, 'License created', { license });
            }

            if (method === 'PATCH') {
                const input = validateUpdatePayload(parseRequestBody(req.body));
                const license = await updateLicense(repository, input, { now: currentTime });
                return success(res, 200, 'License updated', { license });
            }

            const query = getRequestQuery(req);
            let rawLicenseKey = query.license_key;

            if (rawLicenseKey === undefined && req.body !== undefined && req.body !== null && req.body !== '') {
                rawLicenseKey = parseRequestBody(req.body).license_key;
            }

            const licenseKey = validateLicenseKey(rawLicenseKey);
            await deleteLicense(repository, licenseKey);
            return success(res, 200, 'License deleted');
        } catch (error) {
            return handleError(res, error, 'licenses');
        }
    };
}

module.exports = createLicensesHandler();
module.exports.createLicensesHandler = createLicensesHandler;
