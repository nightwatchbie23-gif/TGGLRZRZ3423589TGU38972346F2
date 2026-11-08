'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    LicenseRepository,
    isUndefinedColumnError
} = require('../lib/license-repository');
const { DatabaseError, HttpError } = require('../lib/errors');
const { createFakeSupabase } = require('./helpers/fake-supabase');

const NOW = new Date('2026-11-08T12:00:00.000Z');
const UNDEFINED_COLUMN = {
    code: '42703',
    message: 'column licenses.expires_at does not exist'
};

test('repository: detects both optional columns with one probe', async () => {
    const client = createFakeSupabase();
    client.queue({ data: [{ expires_at: null, last_used_at: null }], error: null });

    const repository = new LicenseRepository(client);
    const capabilities = await repository.getCapabilities();

    assert.deepEqual(capabilities, { expiresAt: true, lastUsedAt: true });
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].select, 'expires_at,last_used_at');
    assert.equal(client.calls[0].limit, 1);
});

test('repository: falls back when expires_at is missing and caches the result', async () => {
    const client = createFakeSupabase();
    client.queue(
        { data: null, error: UNDEFINED_COLUMN },
        { data: null, error: UNDEFINED_COLUMN },
        { data: null, error: UNDEFINED_COLUMN },
        { data: [], error: null },
        {
            data: { license_key: 'KEY-1', is_active: true, hwid: null, last_used_at: null },
            error: null
        }
    );

    const repository = new LicenseRepository(client);
    const license = await repository.findByKey('KEY-1');

    assert.equal(license.license_key, 'KEY-1');
    assert.deepEqual(repository.capabilities, { expiresAt: false, lastUsedAt: true });
    assert.equal(client.calls[1].select, 'expires_at,last_used_at');
    assert.equal(client.calls[2].select, 'expires_at');
    assert.equal(client.calls[3].select, 'last_used_at');
    assert.equal(client.calls[4].select, 'license_key,is_active,hwid,last_used_at');

    client.queue({ data: null, error: null });
    await repository.findByKey('KEY-1');

    assert.equal(client.calls.length, 6);
    assert.equal(client.calls[5].select, 'license_key,is_active,hwid,last_used_at');
});

test('repository: binds HWID atomically only when it is NULL and active', async () => {
    const client = createFakeSupabase();
    client.queue({ data: { hwid: 'device-1' }, error: null });

    const repository = new LicenseRepository(client);
    const bound = await repository.bindHwid('KEY-1', 'device-1');

    assert.equal(bound, true);

    const call = client.calls[0];
    assert.equal(call.operation, 'update');
    assert.deepEqual(call.values, { hwid: 'device-1' });
    assert.deepEqual(call.filters, [
        ['eq', 'license_key', 'KEY-1'],
        ['eq', 'is_active', true],
        ['is', 'hwid', null]
    ]);
    assert.equal(call.select, 'hwid');
});

test('repository: reports a lost binding race when no row was updated', async () => {
    const client = createFakeSupabase();
    client.queue({ data: null, error: null });

    const repository = new LicenseRepository(client);
    const bound = await repository.bindHwid('KEY-1', 'device-1');

    assert.equal(bound, false);
});

test('repository: skips last_used_at when the column is unavailable', async () => {
    const client = createFakeSupabase();
    const repository = new LicenseRepository(client);
    repository.capabilities = { expiresAt: true, lastUsedAt: false };

    const updated = await repository.touchLastUsed('KEY-1', NOW.toISOString());

    assert.equal(updated, false);
    assert.equal(client.calls.length, 0);
});

test('repository: downgrades last_used_at support on an undefined-column error', async () => {
    const client = createFakeSupabase();
    client.queue({ data: null, error: { code: '42703', message: 'column "last_used_at" does not exist' } });

    const repository = new LicenseRepository(client);
    repository.capabilities = { expiresAt: true, lastUsedAt: true };

    const updated = await repository.touchLastUsed('KEY-1', NOW.toISOString());

    assert.equal(updated, false);
    assert.deepEqual(repository.capabilities, { expiresAt: true, lastUsedAt: false });

    const secondAttempt = await repository.touchLastUsed('KEY-1', NOW.toISOString());
    assert.equal(secondAttempt, false);
    assert.equal(client.calls.length, 1);
});

test('repository: maps duplicate inserts to a 409 HttpError', async () => {
    const client = createFakeSupabase();
    client.queue({
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' }
    });

    const repository = new LicenseRepository(client);
    repository.capabilities = { expiresAt: true, lastUsedAt: true };

    await assert.rejects(
        repository.create({ license_key: 'KEY-1', is_active: true }),
        (error) => error instanceof HttpError && error.status === 409 && error.code === 'LICENSE_EXISTS'
    );
});

test('repository: wraps database failures in a DatabaseError', async () => {
    const client = createFakeSupabase();
    client.queue({
        data: null,
        error: { code: '08006', message: 'connection failure' }
    });

    const repository = new LicenseRepository(client);

    await assert.rejects(
        repository.findByKey('KEY-1'),
        (error) => error instanceof DatabaseError
    );
    assert.equal(client.calls.length, 1);
});

test('repository: builds list filters, ordering and pagination', async () => {
    const client = createFakeSupabase();
    client.queue({
        data: [{ license_key: 'KEY-1' }],
        error: null,
        count: 1
    });

    const repository = new LicenseRepository(client);
    repository.capabilities = { expiresAt: true, lastUsedAt: true };

    const result = await repository.list({
        limit: 10,
        offset: 5,
        status: 'expired',
        query: 'key',
        now: NOW
    });

    assert.deepEqual(result, { licenses: [{ license_key: 'KEY-1' }], total: 1 });

    const call = client.calls[0];
    assert.equal(call.options.count, 'exact');
    assert.deepEqual(call.filters, [
        ['not', 'expires_at', 'is', null],
        ['lte', 'expires_at', NOW.toISOString()],
        ['ilike', 'license_key', '%key%']
    ]);
    assert.deepEqual(call.order, { column: 'license_key', ascending: true });
    assert.deepEqual(call.range, [5, 14]);
});

test('repository: rejects expiration filters when the column is unavailable', async () => {
    const client = createFakeSupabase();
    const repository = new LicenseRepository(client);
    repository.capabilities = { expiresAt: false, lastUsedAt: false };

    await assert.rejects(
        repository.list({ limit: 10, offset: 0, status: 'expired', query: null, now: NOW }),
        (error) => error instanceof HttpError && error.code === 'EXPIRATION_UNSUPPORTED'
    );
    assert.equal(client.calls.length, 0);
});

test('repository: updates and deletes by license key', async () => {
    const client = createFakeSupabase();
    client.queue(
        { data: { license_key: 'KEY-1', is_active: false }, error: null },
        { data: { license_key: 'KEY-1' }, error: null }
    );

    const repository = new LicenseRepository(client);
    repository.capabilities = { expiresAt: true, lastUsedAt: true };

    const updated = await repository.updateByKey('KEY-1', { is_active: false });
    assert.equal(updated.is_active, false);

    const deleted = await repository.deleteByKey('KEY-1');
    assert.equal(deleted, true);

    assert.equal(client.calls[0].operation, 'update');
    assert.deepEqual(client.calls[0].values, { is_active: false });
    assert.equal(client.calls[1].operation, 'delete');
});

test('repository: recognizes PostgREST undefined-column errors', () => {
    assert.equal(isUndefinedColumnError({ code: '42703' }), true);
    assert.equal(isUndefinedColumnError({ code: 'PGRST204' }), true);
    assert.equal(
        isUndefinedColumnError({ message: "Could not find the 'expires_at' column of 'licenses' in the schema cache" }),
        true
    );
    assert.equal(isUndefinedColumnError({ code: '23505', message: 'duplicate key' }), false);
    assert.equal(isUndefinedColumnError(null), false);
});
