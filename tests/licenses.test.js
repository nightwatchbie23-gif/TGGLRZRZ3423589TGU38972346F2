'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLicensesHandler } = require('../api/licenses');
const { DatabaseError } = require('../lib/errors');
const { FakeLicenseRepository } = require('./helpers/fake-repository');
const { invokeHandler, withoutConsoleError } = require('./helpers/harness');

const NOW = new Date('2026-11-08T12:00:00.000Z');
const CONFIG = {
    adminToken: 'admin-secret',
    supabaseUrl: 'https://example.supabase.co',
    supabaseKey: 'service-role-secret'
};
const AUTH = { authorization: 'Bearer admin-secret' };

function makeLicense(overrides = {}) {
    return {
        license_key: 'KEY-1',
        is_active: true,
        hwid: null,
        expires_at: null,
        last_used_at: null,
        ...overrides
    };
}

function makeHandler(repository, overrides = {}) {
    return createLicensesHandler({
        repository,
        config: CONFIG,
        now: () => NOW,
        ...overrides
    });
}

test('management: rejects missing and invalid tokens with 401', async () => {
    const repository = new FakeLicenseRepository();

    const missing = await invokeHandler(makeHandler(repository), {
        method: 'GET',
        url: '/api/licenses'
    });
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.body.code, 'UNAUTHORIZED');
    assert.equal(missing.headers['www-authenticate'], 'Bearer');

    const invalid = await invokeHandler(makeHandler(repository), {
        method: 'GET',
        url: '/api/licenses',
        headers: { authorization: 'Bearer wrong-token' }
    });
    assert.equal(invalid.statusCode, 401);
});

test('management: accepts the admin token through x-api-key', async () => {
    const repository = new FakeLicenseRepository({ licenses: [makeLicense()] });

    const res = await invokeHandler(makeHandler(repository), {
        method: 'GET',
        url: '/api/licenses',
        headers: { 'x-api-key': 'admin-secret' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.total, 1);
});

test('management: reports a configuration error when the admin token is missing', async () => {
    const repository = new FakeLicenseRepository();
    const handler = makeHandler(repository, { config: { ...CONFIG, adminToken: '' } });

    const res = await withoutConsoleError(() =>
        invokeHandler(handler, {
            method: 'GET',
            url: '/api/licenses',
            headers: AUTH
        })
    );

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Server configuration error');
    assert.equal(res.body.code, 'SERVER_CONFIG');
});

test('management: creates a Lifetime license with a generated key', async () => {
    const repository = new FakeLicenseRepository();

    const res = await invokeHandler(makeHandler(repository), {
        body: { duration: 'L' },
        headers: AUTH
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.message, 'License created');
    assert.match(res.body.data.license.license_key, /^TGGLR-[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$/);
    assert.equal(res.body.data.license.expires_at, null);
    assert.equal(res.body.data.license.is_active, true);
    assert.equal(repository.licenses.size, 1);
});

test('management: creates a license with a calendar-based duration', async () => {
    const repository = new FakeLicenseRepository();

    const res = await invokeHandler(makeHandler(repository), {
        body: { duration: '5m', license_key: 'CUSTOM-KEY' },
        headers: AUTH
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.license.license_key, 'CUSTOM-KEY');
    assert.equal(res.body.data.license.expires_at, '2027-04-08T12:00:00.000Z');
});

test('management: creates a license with an explicit expiration', async () => {
    const repository = new FakeLicenseRepository();

    const res = await invokeHandler(makeHandler(repository), {
        body: { expires_at: '2027-01-01T00:00:00Z', is_active: false },
        headers: AUTH
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.license.expires_at, '2027-01-01T00:00:00.000Z');
    assert.equal(res.body.data.license.is_active, false);
});

test('management: rejects duplicate license keys', async () => {
    const repository = new FakeLicenseRepository({ licenses: [makeLicense()] });

    const res = await invokeHandler(makeHandler(repository), {
        body: { duration: 'L', license_key: 'KEY-1' },
        headers: AUTH
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'LICENSE_EXISTS');
});

test('management: rejects invalid create payloads', async () => {
    const repository = new FakeLicenseRepository();

    const missing = await invokeHandler(makeHandler(repository), {
        body: {},
        headers: AUTH
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.body.code, 'DURATION_REQUIRED');

    const invalid = await invokeHandler(makeHandler(repository), {
        body: { duration: '5x' },
        headers: AUTH
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.code, 'INVALID_DURATION');
});

test('management: expires_at is not assumed for creation', async () => {
    const repository = new FakeLicenseRepository({
        capabilities: { expiresAt: false, lastUsedAt: false }
    });

    const finite = await invokeHandler(makeHandler(repository), {
        body: { duration: '5m' },
        headers: AUTH
    });
    assert.equal(finite.statusCode, 400);
    assert.equal(finite.body.code, 'EXPIRATION_UNSUPPORTED');

    const lifetime = await invokeHandler(makeHandler(repository), {
        body: { duration: 'L', license_key: 'LIFETIME-KEY' },
        headers: AUTH
    });
    assert.equal(lifetime.statusCode, 201);
    assert.ok(!('expires_at' in lifetime.body.data.license));
});

test('management: lists, filters and paginates licenses', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [
            makeLicense({ license_key: 'KEY-A', is_active: true }),
            makeLicense({ license_key: 'KEY-B', is_active: false }),
            makeLicense({ license_key: 'KEY-C', is_active: true, expires_at: '2026-01-01T00:00:00Z' })
        ]
    });

    const all = await invokeHandler(makeHandler(repository), {
        method: 'GET',
        url: '/api/licenses?limit=2&offset=1',
        headers: AUTH
    });
    assert.equal(all.statusCode, 200);
    assert.equal(all.body.data.total, 3);
    assert.deepEqual(all.body.data.licenses.map((license) => license.license_key), ['KEY-B', 'KEY-C']);

    const disabled = await invokeHandler(makeHandler(repository), {
        method: 'GET',
        url: '/api/licenses?status=disabled',
        headers: AUTH
    });
    assert.deepEqual(disabled.body.data.licenses.map((license) => license.license_key), ['KEY-B']);

    const expired = await invokeHandler(makeHandler(repository), {
        method: 'GET',
        url: '/api/licenses?status=expired',
        headers: AUTH
    });
    assert.deepEqual(expired.body.data.licenses.map((license) => license.license_key), ['KEY-C']);

    const searched = await invokeHandler(makeHandler(repository), {
        method: 'GET',
        url: '/api/licenses?q=key-b',
        headers: AUTH
    });
    assert.deepEqual(searched.body.data.licenses.map((license) => license.license_key), ['KEY-B']);
});

test('management: rejects an invalid list query', async () => {
    const repository = new FakeLicenseRepository();

    const res = await invokeHandler(makeHandler(repository), {
        method: 'GET',
        url: '/api/licenses?status=broken',
        headers: AUTH
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_QUERY');
});

test('management: expiration filters require the expires_at column', async () => {
    const repository = new FakeLicenseRepository({
        capabilities: { expiresAt: false, lastUsedAt: false }
    });

    const res = await invokeHandler(makeHandler(repository), {
        method: 'GET',
        url: '/api/licenses?status=expired',
        headers: AUTH
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'EXPIRATION_UNSUPPORTED');
});

test('management: disables, enables and resets the HWID', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ hwid: 'device-1' })]
    });
    const handler = makeHandler(repository);

    const disabled = await invokeHandler(handler, {
        method: 'PATCH',
        body: { license_key: 'KEY-1', action: 'disable' },
        headers: AUTH
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.body.data.license.is_active, false);

    const enabled = await invokeHandler(handler, {
        method: 'PATCH',
        body: { license_key: 'KEY-1', action: 'enable' },
        headers: AUTH
    });
    assert.equal(enabled.body.data.license.is_active, true);

    const reset = await invokeHandler(handler, {
        method: 'PATCH',
        body: { license_key: 'KEY-1', action: 'reset_hwid' },
        headers: AUTH
    });
    assert.equal(reset.body.data.license.hwid, null);
});

test('management: updates expiration and supports Lifetime', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ expires_at: '2027-01-01T00:00:00Z' })]
    });
    const handler = makeHandler(repository);

    const extended = await invokeHandler(handler, {
        method: 'PATCH',
        body: { license_key: 'KEY-1', action: 'update', duration: '10y' },
        headers: AUTH
    });
    assert.equal(extended.statusCode, 200);
    assert.equal(extended.body.data.license.expires_at, '2036-11-08T12:00:00.000Z');

    const lifetime = await invokeHandler(handler, {
        method: 'PATCH',
        body: { license_key: 'KEY-1', action: 'update', duration: 'L' },
        headers: AUTH
    });
    assert.equal(lifetime.body.data.license.expires_at, null);
});

test('management: a Lifetime update is a no-op without the expires_at column', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [{ license_key: 'KEY-1', is_active: true, hwid: null }],
        capabilities: { expiresAt: false, lastUsedAt: false }
    });

    const res = await invokeHandler(makeHandler(repository), {
        method: 'PATCH',
        body: { license_key: 'KEY-1', action: 'update', duration: 'L' },
        headers: AUTH
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.license.license_key, 'KEY-1');
});

test('management: rejects unknown licenses and invalid updates', async () => {
    const repository = new FakeLicenseRepository({ licenses: [makeLicense()] });
    const handler = makeHandler(repository);

    const unknown = await invokeHandler(handler, {
        method: 'PATCH',
        body: { license_key: 'MISSING', action: 'disable' },
        headers: AUTH
    });
    assert.equal(unknown.statusCode, 404);

    const noFields = await invokeHandler(handler, {
        method: 'PATCH',
        body: { license_key: 'KEY-1', action: 'update' },
        headers: AUTH
    });
    assert.equal(noFields.statusCode, 400);
    assert.equal(noFields.body.code, 'NO_UPDATES');

    const invalidAction = await invokeHandler(handler, {
        method: 'PATCH',
        body: { license_key: 'KEY-1', action: 'explode' },
        headers: AUTH
    });
    assert.equal(invalidAction.statusCode, 400);
    assert.equal(invalidAction.body.code, 'INVALID_ACTION');
});

test('management: deletes licenses by query or body', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [makeLicense({ license_key: 'KEY-1' }), makeLicense({ license_key: 'KEY-2' })]
    });
    const handler = makeHandler(repository);

    const fromQuery = await invokeHandler(handler, {
        method: 'DELETE',
        url: '/api/licenses?license_key=KEY-1',
        headers: AUTH
    });
    assert.equal(fromQuery.statusCode, 200);
    assert.equal(fromQuery.body.message, 'License deleted');
    assert.equal(repository.licenses.has('KEY-1'), false);

    const fromBody = await invokeHandler(handler, {
        method: 'DELETE',
        url: '/api/licenses',
        body: { license_key: 'KEY-2' },
        headers: AUTH
    });
    assert.equal(fromBody.statusCode, 200);
    assert.equal(repository.licenses.size, 0);
});

test('management: rejects deleting without a key or an unknown key', async () => {
    const repository = new FakeLicenseRepository();
    const handler = makeHandler(repository);

    const noKey = await invokeHandler(handler, {
        method: 'DELETE',
        url: '/api/licenses',
        headers: AUTH
    });
    assert.equal(noKey.statusCode, 400);
    assert.equal(noKey.body.code, 'INVALID_LICENSE_KEY');

    const unknown = await invokeHandler(handler, {
        method: 'DELETE',
        url: '/api/licenses?license_key=MISSING',
        headers: AUTH
    });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.body.code, 'LICENSE_NOT_FOUND');
});

test('management: rejects unsupported methods', async () => {
    const repository = new FakeLicenseRepository();

    const res = await invokeHandler(makeHandler(repository), {
        method: 'PUT',
        url: '/api/licenses',
        headers: AUTH
    });

    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'GET, POST, PATCH, DELETE');
});

test('management: hides database details and never exposes the service-role key', async () => {
    const repository = new FakeLicenseRepository();
    repository.failures.create = new DatabaseError('permission denied for secret table');

    const res = await withoutConsoleError(() =>
        invokeHandler(makeHandler(repository), {
            body: { duration: 'L' },
            headers: AUTH
        })
    );

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Database error');

    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('secret table'));
    assert.ok(!serialized.includes(CONFIG.supabaseKey));
    assert.ok(!serialized.includes(CONFIG.adminToken));
});
