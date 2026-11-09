'use strict';

// Thin REST client for the existing TGGLR backend management API.
// The backend remains the source of truth for all license data.

async function request(config, method, path, { query, body } = {}) {
    const url = new URL(`${config.apiUrl}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
        if (value !== undefined && value !== null) {
            url.searchParams.set(key, String(value));
        }
    }

    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${config.apiSecret}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok || !payload || payload.success !== true) {
        const code = payload && payload.code ? payload.code : 'REQUEST_FAILED';
        const message = payload && payload.message ? payload.message : `HTTP ${response.status}`;
        const error = new Error(message);
        error.code = code;
        error.status = response.status;
        throw error;
    }

    return payload;
}

function listLicenses(config, { limit = 50, offset = 0, status = 'all', q } = {}) {
    return request(config, 'GET', '/api/licenses', { query: { limit, offset, status, q } })
        .then((payload) => payload.data);
}

function createLicense(config, { expiresAt, duration }) {
    const body = expiresAt ? { expires_at: expiresAt } : { duration };
    return request(config, 'POST', '/api/licenses', { body })
        .then((payload) => payload.data.license);
}

function updateLicense(config, licenseKey, action, extra = {}) {
    return request(config, 'PATCH', '/api/licenses', {
        body: { license_key: licenseKey, action, ...extra }
    }).then((payload) => payload.data.license);
}

function deleteLicense(config, licenseKey) {
    return request(config, 'DELETE', '/api/licenses', { query: { license_key: licenseKey } });
}

async function findLicenseByKey(config, licenseKey) {
    // Exact key match first (list search is anchored on substring matches).
    let result = await listLicenses(config, { limit: 1, q: licenseKey });
    const found = (result.licenses || []).find((license) => license.license_key === licenseKey);
    if (found || !result.total) {
        return found || null;
    }
    return null;
}

module.exports = {
    createLicense,
    deleteLicense,
    findLicenseByKey,
    listLicenses,
    request,
    updateLicense
};
