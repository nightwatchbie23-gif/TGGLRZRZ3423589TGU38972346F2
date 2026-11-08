'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createVerifyHandler } = require('../api/verify');
const { DatabaseError } = require('../lib/errors');
const { FakeLicenseRepository } = require('./helpers/fake-repository');
const { invokeHandler, withoutConsoleError } = require('./helpers/harness');

const NOW = new Date('2026-11-08T12:00:00.000Z');
const CONFIG = {
    adminToken: 'admin-secret',
    supabaseUrl: 'https://example.supabase.co',
    supabaseKey: 'service-role-secret'
};

function makeLicense(overrides = {}) {
    return {
        license_key: 'KEY-1',
        is_active: true,
        hwid: 'device-1',
        expires_at: null,
        last_used_at: null,
        ...overrides
    };
}

function makeHandler(repository, overrides = {}) {
    return createVerifyHandler({
        repository,
        config: CONFIG,
        now: () => NOW,
        ...overrides
    });
}

function credentials(overrides = {}) {
    return { license_key: 'KEY-1', hwid: 'device-1', ...overrides };
}

test('verify: rejects non-POST methods with 405 and Allow header', async () => {
    const repository = new FakeLicenseRepository();
    const res = await invokeHandler(makeHandler(repository), { method: 'GET' });

    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'POST');
    assert.deepEqual(res.body, {
        success: false,
        message: 'Method not allowed',
        code: 'METHOD_NOT_ALLOWED'
    });
});

test('verify: rejects invalid JSON bodies', async () => {
    const repository = new FakeLicenseRepository();
    const res = await invokeHandler(makeHandler(repository), { body: '{"license_key":' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_BODY');
});

test('verify: rejects array and empty bodies', async () => {
    const repository = new FakeLicenseRepository();

    const arrayResponse = await invokeHandler(makeHandler(repository), { body: [] });
    assert.equal(arrayResponse.statusCode, 400);
    assert.equal(arrayResponse.body.code, 'INVALID_BODY');

    const emptyResponse = await invokeHandler(makeHandler(repository), { body: undefined });
    assert.equal(emptyResponse.statusCode, 400);
    assert.equal(emptyResponse.body.code, 'INVALID_BODY');
});

test('verify: rejects missing, mistyped, or oversized credentials', async () => {
    const repository = new FakeLicenseRepository();

    for (const body of [
        { license_key: 'KEY-1' },
        { hwid: 'device-1' },
        { license_key: 123, hwid: 'device-1' },
        { license_key: 'KEY-1', hwid: false },
        { license_key: '   ', hwid: 'device-1' },
        { license_key: 'KEY-1', hwid: 'd'.repeat(257) },
        { license_key: `${'K'.repeat(256)}\n`, hwid: 'device-1' }
    ]) {
        const res = await invokeHandler(makeHandler(repository), { body });
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'INVALID_CREDENTIALS');
        assert.equal(res.body.message, 'Missing or invalid credentials');
    }
});

test('verify: accepts a JSON-encoded string body', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense()]
    });

    const res = await invokeHandler(makeHandler(repository), {
        body: JSON.stringify(credentials())
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'License verified successfully');
});

test('verify: rejects unknown license keys', async () => {
    const repository = new FakeLicenseRepository();
    const res = await invokeHandler(makeHandler(repository), { body: credentials() });

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.message, 'Invalid license key');
    assert.equal(res.body.code, 'LICENSE_NOT_FOUND');
});

test('verify: rejects disabled licenses', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ is_active: false })]
    });

    const res = await invokeHandler(makeHandler(repository), { body: credentials() });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message, 'License is disabled');
    assert.equal(res.body.code, 'LICENSE_DISABLED');
});

test('verify: rejects expired licenses', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ expires_at: '2026-11-08T11:59:59.000Z' })]
    });

    const res = await invokeHandler(makeHandler(repository), { body: credentials() });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message, 'License expired');
    assert.equal(res.body.code, 'LICENSE_EXPIRED');
    assert.equal(repository.touched.length, 0);
});

test('verify: treats an expiration equal to now as expired', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ expires_at: NOW.toISOString() })]
    });

    const res = await invokeHandler(makeHandler(repository), { body: credentials() });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'LICENSE_EXPIRED');
});

test('verify: rejects unparseable expiration values', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ expires_at: 'not-a-date' })]
    });

    const res = await invokeHandler(makeHandler(repository), { body: credentials() });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message, 'License is not valid');
    assert.equal(res.body.code, 'LICENSE_INVALID');
});

test('verify: accepts Lifetime licenses with a NULL expiration', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ expires_at: null })]
    });

    const res = await invokeHandler(makeHandler(repository), { body: credentials() });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'License verified successfully');
    assert.equal(repository.touched.length, 1);
    assert.equal(repository.touched[0].timestamp, NOW.toISOString());
});

test('verify: accepts licenses when the expires_at column does not exist', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [{ license_key: 'KEY-1', is_active: true, hwid: 'device-1' }],
        capabilities: { expiresAt: false, lastUsedAt: false }
    });

    const res = await invokeHandler(makeHandler(repository), { body: credentials() });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'License verified successfully');
    assert.equal(repository.touched.length, 0);
});

test('verify: binds an unbound license and reports activation', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ hwid: null })]
    });

    const res = await invokeHandler(makeHandler(repository), { body: credentials() });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'License activated successfully');
    assert.equal(repository.licenses.get('KEY-1').hwid, 'device-1');
    assert.equal(repository.touched.length, 1);
});

test('verify: rejects a different HWID without touching last_used_at', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ hwid: 'other-device' })]
    });

    const res = await invokeHandler(makeHandler(repository), {
        body: credentials({ hwid: 'device-1' })
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.message, 'HWID mismatch');
    assert.equal(res.body.code, 'HWID_MISMATCH');
    assert.equal(repository.touched.length, 0);
});

test('verify: treats a concurrent same-device binding as success', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ hwid: null })]
    });

    repository.bindHwid = async (licenseKey, hwid) => {
        repository.licenses.get(licenseKey).hwid = hwid;
        return false;
    };

    const res = await invokeHandler(makeHandler(repository), { body: credentials() });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'License activated successfully');
    assert.equal(repository.touched.length, 1);
});

test('verify: reports a conflict when another device wins the binding race', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ hwid: null })]
    });

    repository.bindHwid = async (licenseKey) => {
        repository.licenses.get(licenseKey).hwid = 'other-device';
        return false;
    };

    const res = await invokeHandler(makeHandler(repository), { body: credentials() });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message, 'License binding conflict. Retry verification.');
    assert.equal(res.body.code, 'HWID_CONFLICT');
});

test('verify: hides database error details', async () => {
    const repository = new FakeLicenseRepository();
    repository.failures.findByKey = new DatabaseError('connection refused to internal host');

    const res = await withoutConsoleError(() =>
        invokeHandler(makeHandler(repository), { body: credentials() })
    );

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Database error');
    assert.equal(res.body.code, 'DATABASE_ERROR');
    assert.ok(!JSON.stringify(res.body).includes('internal host'));
});

test('verify: succeeds even if updating last_used_at fails', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense()]
    });
    repository.failures.touchLastUsed = new DatabaseError('write failed');

    const res = await withoutConsoleError(() =>
        invokeHandler(makeHandler(repository), { body: credentials() })
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'License verified successfully');
});

test('verify: returns a configuration error when Supabase env is missing', async () => {
    const handler = createVerifyHandler({ config: {}, now: () => NOW });
    const res = await withoutConsoleError(() =>
        invokeHandler(handler, { body: credentials() })
    );

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Server configuration error');
    assert.equal(res.body.code, 'SERVER_CONFIG');
});
