'use strict';

const { HttpError } = require('../../lib/errors');

class FakeLicenseRepository {
    constructor({ licenses = [], capabilities = { expiresAt: true, lastUsedAt: true } } = {}) {
        this.licenses = new Map();
        for (const license of licenses) {
            this.licenses.set(license.license_key, { ...license });
        }

        this.capabilities = { ...capabilities };
        this.failures = {};
        this.touched = [];
        this.bindCalls = [];
    }

    maybeFail(method) {
        if (this.failures[method]) {
            throw this.failures[method];
        }
    }

    async getCapabilities() {
        this.maybeFail('getCapabilities');
        return { ...this.capabilities };
    }

    async findByKey(licenseKey) {
        this.maybeFail('findByKey');
        const license = this.licenses.get(licenseKey);
        return license ? { ...license } : null;
    }

    async bindHwid(licenseKey, hwid) {
        this.maybeFail('bindHwid');
        this.bindCalls.push({ licenseKey, hwid });

        const license = this.licenses.get(licenseKey);
        if (!license || license.hwid != null || license.is_active !== true) {
            return false;
        }

        license.hwid = hwid;
        return true;
    }

    async touchLastUsed(licenseKey, timestamp) {
        this.maybeFail('touchLastUsed');
        if (!this.capabilities.lastUsedAt) {
            return false;
        }

        this.touched.push({ licenseKey, timestamp });
        const license = this.licenses.get(licenseKey);
        if (license) {
            license.last_used_at = timestamp;
        }
        return true;
    }

    async list({ limit, offset, status, query, now }) {
        this.maybeFail('list');

        if ((status === 'expired' || status === 'lifetime') && !this.capabilities.expiresAt) {
            throw new HttpError(
                400,
                'EXPIRATION_UNSUPPORTED',
                'License expiration requires the expires_at column. Apply the provided migration.'
            );
        }

        let rows = Array.from(this.licenses.values());

        if (status === 'active') {
            rows = rows.filter((license) => license.is_active === true);
        } else if (status === 'disabled') {
            rows = rows.filter((license) => license.is_active !== true);
        } else if (status === 'expired') {
            rows = rows.filter((license) =>
                license.expires_at != null && new Date(license.expires_at).getTime() <= now.getTime()
            );
        } else if (status === 'lifetime') {
            rows = rows.filter((license) => license.expires_at == null);
        }

        if (query) {
            const needle = query.toLowerCase();
            rows = rows.filter((license) => license.license_key.toLowerCase().includes(needle));
        }

        rows.sort((left, right) => left.license_key.localeCompare(right.license_key));
        const total = rows.length;
        const page = rows.slice(offset, offset + limit).map((license) => ({ ...license }));

        return { licenses: page, total };
    }

    async create(fields) {
        this.maybeFail('create');

        if (this.licenses.has(fields.license_key)) {
            throw new HttpError(409, 'LICENSE_EXISTS', 'License key already exists');
        }

        const license = { ...fields };
        this.licenses.set(license.license_key, license);
        return { ...license };
    }

    async updateByKey(licenseKey, patch) {
        this.maybeFail('updateByKey');
        const license = this.licenses.get(licenseKey);
        if (!license) {
            return null;
        }

        Object.assign(license, patch);
        return { ...license };
    }

    async deleteByKey(licenseKey) {
        this.maybeFail('deleteByKey');
        return this.licenses.delete(licenseKey);
    }
}

module.exports = { FakeLicenseRepository };
