'use strict';

const { HttpError } = require('./errors');
const { addDuration, evaluateExpiration } = require('./license-utils');
const { generateLicenseKey } = require('./security');

function expirationUnsupported() {
    return new HttpError(
        400,
        'EXPIRATION_UNSUPPORTED',
        'License expiration requires the expires_at column. Apply the provided migration.'
    );
}

function assertActive(license) {
    if (license.is_active !== true) {
        throw new HttpError(403, 'LICENSE_DISABLED', 'License is disabled');
    }
}

function assertNotExpired(license, now) {
    const expiration = evaluateExpiration(license.expires_at, now);

    if (expiration.invalid) {
        throw new HttpError(403, 'LICENSE_INVALID', 'License is not valid');
    }
    if (expiration.expired) {
        throw new HttpError(403, 'LICENSE_EXPIRED', 'License expired');
    }
}

async function touchLastUsed(repository, licenseKey, now) {
    try {
        await repository.touchLastUsed(licenseKey, now.toISOString());
    } catch (error) {
        // last_used_at is informational; a failure must not break verification.
        console.error('Failed to update last_used_at:', error.message);
    }
}

async function verifyLicense(repository, { licenseKey, hwid }, { now = new Date() } = {}) {
    const license = await repository.findByKey(licenseKey);

    if (!license) {
        throw new HttpError(404, 'LICENSE_NOT_FOUND', 'Invalid license key');
    }

    assertActive(license);
    assertNotExpired(license, now);

    if (!license.hwid) {
        const bound = await repository.bindHwid(licenseKey, hwid);

        if (bound) {
            await touchLastUsed(repository, licenseKey, now);
            return { outcome: 'activated' };
        }

        // Another request won the atomic binding; re-read to decide whether it
        // bound this same device or a different one.
        const current = await repository.findByKey(licenseKey);

        if (!current) {
            throw new HttpError(404, 'LICENSE_NOT_FOUND', 'Invalid license key');
        }

        assertActive(current);
        assertNotExpired(current, now);

        if (current.hwid === hwid) {
            await touchLastUsed(repository, licenseKey, now);
            return { outcome: 'activated' };
        }

        throw new HttpError(409, 'HWID_CONFLICT', 'License binding conflict. Retry verification.');
    }

    if (license.hwid !== hwid) {
        throw new HttpError(401, 'HWID_MISMATCH', 'HWID mismatch');
    }

    await touchLastUsed(repository, licenseKey, now);
    return { outcome: 'verified' };
}

async function createLicense(repository, input, { now = new Date() } = {}) {
    const capabilities = await repository.getCapabilities();
    const fields = {
        license_key: input.licenseKey || generateLicenseKey(),
        is_active: input.isActive
    };

    if (input.duration) {
        if (input.duration.lifetime) {
            if (capabilities.expiresAt) {
                fields.expires_at = null;
            }
        } else {
            if (!capabilities.expiresAt) {
                throw expirationUnsupported();
            }
            fields.expires_at = addDuration(now, input.duration).toISOString();
        }
    } else if (input.expiresAt) {
        if (!capabilities.expiresAt) {
            throw expirationUnsupported();
        }
        fields.expires_at = input.expiresAt;
    }

    return repository.create(fields);
}

async function updateLicense(repository, input, { now = new Date() } = {}) {
    const capabilities = await repository.getCapabilities();
    let patch;

    switch (input.action) {
        case 'enable':
            patch = { is_active: true };
            break;
        case 'disable':
            patch = { is_active: false };
            break;
        case 'reset_hwid':
            patch = { hwid: null };
            break;
        case 'update':
            patch = {};
            let lifetimeNoop = false;
            if (input.isActive !== undefined) {
                patch.is_active = input.isActive;
            }
            if (input.duration !== undefined) {
                if (input.duration.lifetime) {
                    if (capabilities.expiresAt) {
                        patch.expires_at = null;
                    } else {
                        // Without the column every license is already Lifetime.
                        lifetimeNoop = true;
                    }
                } else {
                    if (!capabilities.expiresAt) {
                        throw expirationUnsupported();
                    }
                    patch.expires_at = addDuration(now, input.duration).toISOString();
                }
            } else if (input.expiresAt !== undefined) {
                if (!capabilities.expiresAt) {
                    throw expirationUnsupported();
                }
                patch.expires_at = input.expiresAt;
            }
            if (Object.keys(patch).length === 0) {
                if (lifetimeNoop) {
                    const current = await repository.findByKey(input.licenseKey);
                    if (!current) {
                        throw new HttpError(404, 'LICENSE_NOT_FOUND', 'License not found');
                    }
                    return current;
                }
                throw new HttpError(400, 'NO_UPDATES', 'No update fields provided');
            }
            break;
        default:
            throw new HttpError(400, 'INVALID_ACTION', 'Invalid action');
    }

    const license = await repository.updateByKey(input.licenseKey, patch);
    if (!license) {
        throw new HttpError(404, 'LICENSE_NOT_FOUND', 'License not found');
    }

    return license;
}

async function listLicenses(repository, options, { now = new Date() } = {}) {
    return repository.list({ ...options, now });
}

async function deleteLicense(repository, licenseKey) {
    const deleted = await repository.deleteByKey(licenseKey);

    if (!deleted) {
        throw new HttpError(404, 'LICENSE_NOT_FOUND', 'License not found');
    }

    return true;
}

module.exports = {
    verifyLicense,
    createLicense,
    updateLicense,
    listLicenses,
    deleteLicense
};
