'use strict';

const { DatabaseError, HttpError } = require('./errors');
const { escapeLike } = require('./security');

const BASE_COLUMNS = ['license_key', 'is_active', 'hwid'];
const OPTIONAL_COLUMNS = {
    expiresAt: 'expires_at',
    lastUsedAt: 'last_used_at'
};

function isUndefinedColumnError(error) {
    if (!error) {
        return false;
    }

    if (error.code === '42703' || error.code === 'PGRST204') {
        return true;
    }

    const message = String(error.message || '').toLowerCase();
    if (!message.includes('column')) {
        return false;
    }

    return (
        message.includes('does not exist') ||
        message.includes('could not find') ||
        message.includes('schema cache')
    );
}

function databaseError(message, cause) {
    return new DatabaseError(message, { cause });
}

class LicenseRepository {
    constructor(client) {
        if (!client) {
            throw new TypeError('A Supabase client is required');
        }

        this.client = client;
        this.capabilities = null;
        this.capabilitiesPromise = null;
    }

    async getCapabilities() {
        if (this.capabilities) {
            return this.capabilities;
        }

        if (!this.capabilitiesPromise) {
            this.capabilitiesPromise = this.detectCapabilities().catch((error) => {
                this.capabilitiesPromise = null;
                throw error;
            });
        }

        this.capabilities = await this.capabilitiesPromise;
        return this.capabilities;
    }

    async detectCapabilities() {
        const combined = await this.client
            .from('licenses')
            .select(`${OPTIONAL_COLUMNS.expiresAt},${OPTIONAL_COLUMNS.lastUsedAt}`)
            .limit(1);

        if (!combined.error) {
            return { expiresAt: true, lastUsedAt: true };
        }

        if (!isUndefinedColumnError(combined.error)) {
            throw databaseError('Failed to inspect license schema', combined.error);
        }

        const capabilities = { expiresAt: false, lastUsedAt: false };

        for (const [key, column] of Object.entries(OPTIONAL_COLUMNS)) {
            const { error } = await this.client
                .from('licenses')
                .select(column)
                .limit(1);

            if (!error) {
                capabilities[key] = true;
            } else if (!isUndefinedColumnError(error)) {
                throw databaseError('Failed to inspect license schema', error);
            }
        }

        return capabilities;
    }

    selectColumns(capabilities) {
        const columns = [...BASE_COLUMNS];

        if (!capabilities || capabilities.expiresAt) {
            columns.push(OPTIONAL_COLUMNS.expiresAt);
        }
        if (!capabilities || capabilities.lastUsedAt) {
            columns.push(OPTIONAL_COLUMNS.lastUsedAt);
        }

        return columns.join(',');
    }

    selectLicense(licenseKey, capabilities) {
        return this.client
            .from('licenses')
            .select(this.selectColumns(capabilities))
            .eq('license_key', licenseKey)
            .maybeSingle();
    }

    async findByKey(licenseKey) {
        let response = await this.selectLicense(licenseKey, this.capabilities);

        if (response.error && isUndefinedColumnError(response.error)) {
            this.capabilities = null;
            this.capabilitiesPromise = null;

            const capabilities = await this.getCapabilities();
            response = await this.selectLicense(licenseKey, capabilities);
        }

        if (response.error) {
            throw databaseError('Failed to load license', response.error);
        }

        if (!this.capabilities) {
            this.capabilities = { expiresAt: true, lastUsedAt: true };
        }

        return response.data || null;
    }

    async bindHwid(licenseKey, hwid) {
        const { data, error } = await this.client
            .from('licenses')
            .update({ hwid })
            .eq('license_key', licenseKey)
            .eq('is_active', true)
            .is('hwid', null)
            .select('hwid')
            .maybeSingle();

        if (error) {
            throw databaseError('Failed to bind device', error);
        }

        return Boolean(data && data.hwid === hwid);
    }

    async touchLastUsed(licenseKey, timestamp) {
        const capabilities = this.capabilities || await this.getCapabilities();
        if (!capabilities.lastUsedAt) {
            return false;
        }

        const { error } = await this.client
            .from('licenses')
            .update({ last_used_at: timestamp })
            .eq('license_key', licenseKey);

        if (!error) {
            return true;
        }

        if (isUndefinedColumnError(error)) {
            this.capabilities = { ...capabilities, lastUsedAt: false };
            return false;
        }

        throw databaseError('Failed to update last used timestamp', error);
    }

    async list({ limit, offset, status, query, now }) {
        const capabilities = await this.getCapabilities();
        const columns = this.selectColumns(capabilities);

        if ((status === 'expired' || status === 'lifetime') && !capabilities.expiresAt) {
            throw new HttpError(
                400,
                'EXPIRATION_UNSUPPORTED',
                'License expiration requires the expires_at column. Apply the provided migration.'
            );
        }

        let request = this.client.from('licenses').select(columns, { count: 'exact' });

        if (status === 'active') {
            request = request.eq('is_active', true);
        } else if (status === 'disabled') {
            request = request.eq('is_active', false);
        } else if (status === 'expired') {
            request = request
                .not('expires_at', 'is', null)
                .lte('expires_at', now.toISOString());
        } else if (status === 'lifetime') {
            request = request.is('expires_at', null);
        }

        if (query) {
            request = request.ilike('license_key', `%${escapeLike(query)}%`);
        }

        request = request
            .order('license_key', { ascending: true })
            .range(offset, offset + limit - 1);

        const { data, error, count } = await request;
        if (error) {
            throw databaseError('Failed to list licenses', error);
        }

        const licenses = data || [];
        return {
            licenses,
            total: typeof count === 'number' ? count : licenses.length
        };
    }

    async create(fields) {
        const capabilities = await this.getCapabilities();
        const { data, error } = await this.client
            .from('licenses')
            .insert(fields)
            .select(this.selectColumns(capabilities))
            .single();

        if (error) {
            if (error.code === '23505') {
                throw new HttpError(409, 'LICENSE_EXISTS', 'License key already exists');
            }
            throw databaseError('Failed to create license', error);
        }

        return data;
    }

    async updateByKey(licenseKey, patch) {
        const capabilities = await this.getCapabilities();
        const { data, error } = await this.client
            .from('licenses')
            .update(patch)
            .eq('license_key', licenseKey)
            .select(this.selectColumns(capabilities))
            .maybeSingle();

        if (error) {
            throw databaseError('Failed to update license', error);
        }

        return data || null;
    }

    async deleteByKey(licenseKey) {
        const { data, error } = await this.client
            .from('licenses')
            .delete()
            .eq('license_key', licenseKey)
            .select('license_key')
            .maybeSingle();

        if (error) {
            throw databaseError('Failed to delete license', error);
        }

        return Boolean(data);
    }
}

function createLicenseRepository(client) {
    return new LicenseRepository(client);
}

module.exports = {
    LicenseRepository,
    createLicenseRepository,
    isUndefinedColumnError
};
