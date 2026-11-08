'use strict';

const { HttpError } = require('./errors');
const { parseDuration } = require('./license-utils');

const MAX_LICENSE_KEY_LENGTH = 256;
const MAX_HWID_LENGTH = 256;
const MAX_DURATION_LENGTH = 32;
const MAX_EXPIRES_AT_LENGTH = 64;
const MAX_QUERY_LENGTH = 100;
const MAX_LIMIT = 200;
const MAX_OFFSET = 1000000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const LIST_STATUSES = new Set(['all', 'active', 'disabled', 'expired', 'lifetime']);
const ACTIONS = new Set(['enable', 'disable', 'reset_hwid', 'update']);

function badRequest(code, message) {
    return new HttpError(400, code, message);
}

function parseRequestBody(raw) {
    let body = raw;

    if (Buffer.isBuffer(body)) {
        body = body.toString('utf8');
    }

    if (typeof body === 'string') {
        if (!body.trim()) {
            throw badRequest('INVALID_BODY', 'Invalid request body');
        }
        try {
            body = JSON.parse(body);
        } catch {
            throw badRequest('INVALID_BODY', 'Invalid request body');
        }
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw badRequest('INVALID_BODY', 'Invalid request body');
    }

    return body;
}

function validateVerifyPayload(body) {
    const isInvalid =
        typeof body.license_key !== 'string' ||
        typeof body.hwid !== 'string' ||
        !body.license_key.trim() ||
        !body.hwid.trim() ||
        body.license_key.trim().length > MAX_LICENSE_KEY_LENGTH ||
        body.hwid.trim().length > MAX_HWID_LENGTH ||
        CONTROL_CHARACTERS.test(body.license_key) ||
        CONTROL_CHARACTERS.test(body.hwid);

    if (isInvalid) {
        throw badRequest('INVALID_CREDENTIALS', 'Missing or invalid credentials');
    }

    return {
        licenseKey: body.license_key.trim(),
        hwid: body.hwid.trim()
    };
}

function validateLicenseKey(value) {
    if (typeof value !== 'string') {
        throw badRequest('INVALID_LICENSE_KEY', 'Invalid license key');
    }

    const licenseKey = value.trim();
    if (
        !licenseKey ||
        licenseKey.length > MAX_LICENSE_KEY_LENGTH ||
        CONTROL_CHARACTERS.test(licenseKey)
    ) {
        throw badRequest('INVALID_LICENSE_KEY', 'Invalid license key');
    }

    return licenseKey;
}

function validateDuration(value) {
    if (typeof value !== 'string' || value.trim().length > MAX_DURATION_LENGTH) {
        throw badRequest('INVALID_DURATION', 'Invalid duration. Use a positive number with d, w, m, y, or L for lifetime.');
    }
    return parseDuration(value);
}

function validateExpiresAt(value) {
    if (typeof value !== 'string' || value.length > MAX_EXPIRES_AT_LENGTH) {
        throw badRequest('INVALID_EXPIRATION', 'Invalid expires_at');
    }

    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        throw badRequest('INVALID_EXPIRATION', 'Invalid expires_at');
    }

    return new Date(timestamp).toISOString();
}

function validateBoolean(value, field) {
    if (typeof value !== 'boolean') {
        throw badRequest('VALIDATION_ERROR', `${field} must be a boolean`);
    }
    return value;
}

function validateCreatePayload(body) {
    const licenseKey = body.license_key === undefined
        ? null
        : validateLicenseKey(body.license_key);

    const hasDuration = body.duration !== undefined;
    const hasExpiresAt = body.expires_at !== undefined;

    if (!hasDuration && !hasExpiresAt) {
        throw badRequest('DURATION_REQUIRED', 'Either duration or expires_at is required');
    }
    if (hasDuration && hasExpiresAt) {
        throw badRequest('VALIDATION_ERROR', 'Provide either duration or expires_at, not both');
    }

    return {
        licenseKey,
        duration: hasDuration ? validateDuration(body.duration) : null,
        expiresAt: hasExpiresAt ? validateExpiresAt(body.expires_at) : null,
        isActive: body.is_active === undefined ? true : validateBoolean(body.is_active, 'is_active')
    };
}

function validateUpdatePayload(body) {
    const licenseKey = validateLicenseKey(body.license_key);

    if (typeof body.action !== 'string' || !body.action.trim()) {
        throw badRequest('INVALID_ACTION', 'Invalid action');
    }

    const action = body.action.trim().toLowerCase().replace(/-/g, '_');
    if (!ACTIONS.has(action)) {
        throw badRequest('INVALID_ACTION', 'Invalid action');
    }

    const isActive = body.is_active === undefined
        ? undefined
        : validateBoolean(body.is_active, 'is_active');
    const duration = body.duration === undefined ? undefined : validateDuration(body.duration);
    const expiresAt = body.expires_at === undefined ? undefined : validateExpiresAt(body.expires_at);

    if (action === 'update') {
        if (isActive === undefined && duration === undefined && expiresAt === undefined) {
            throw badRequest('NO_UPDATES', 'No update fields provided');
        }
        if (duration !== undefined && expiresAt !== undefined) {
            throw badRequest('VALIDATION_ERROR', 'Provide either duration or expires_at, not both');
        }
    }

    return { licenseKey, action, isActive, duration, expiresAt };
}

function parseInteger(value, field, defaultValue, min, max) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw badRequest('INVALID_QUERY', `Invalid ${field}`);
    }

    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
        throw badRequest('INVALID_QUERY', `Invalid ${field}`);
    }

    return number;
}

function validateListQuery(query) {
    const limit = parseInteger(query.limit, 'limit', 50, 1, MAX_LIMIT);
    const offset = parseInteger(query.offset, 'offset', 0, 0, MAX_OFFSET);

    const status = typeof query.status === 'string' && query.status.trim()
        ? query.status.trim().toLowerCase()
        : 'all';
    if (!LIST_STATUSES.has(status)) {
        throw badRequest('INVALID_QUERY', 'Invalid status filter');
    }

    let search = null;
    if (query.q !== undefined) {
        if (typeof query.q !== 'string' || query.q.length > MAX_QUERY_LENGTH) {
            throw badRequest('INVALID_QUERY', 'Invalid q');
        }
        search = query.q.trim() || null;
    }

    return { limit, offset, status, query: search };
}

module.exports = {
    parseRequestBody,
    validateVerifyPayload,
    validateLicenseKey,
    validateCreatePayload,
    validateUpdatePayload,
    validateListQuery
};
