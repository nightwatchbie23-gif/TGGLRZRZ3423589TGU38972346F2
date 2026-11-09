'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createVerifyHandler } = require('../api/verify');
const { FakeLicenseRepository } = require('./helpers/fake-repository');
const { invokeHandler } = require('./helpers/harness');

const NOW = new Date('2026-11-08T12:00:00.000Z');
const CONFIG = {
    adminToken: 'admin-secret',
    supabaseUrl: 'https://example.supabase.co',
    supabaseKey: 'service-role-secret'
};

function fakeClient({ ban, missingTable = false }) {
    const calls = { inserts: [], updates: [] };
    function builder(table) {
        const state = { table, filters: {}, op: null, payload: null };
        const api = {
            select() { return api; },
            insert(payload) { state.op = 'insert'; state.payload = payload; calls.inserts.push({ table, payload }); return Promise.resolve({ error: null }); },
            update(patch) { state.op = 'update'; state.patch = patch; return api; },
            eq(column, value) { state.filters[column] = value; return api; },
            is(column, value) { state.filters[column] = value; return api; },
            limit() { return api; },
            order() { return api; },
            range() { return api; },
            maybeSingle() { return api.resolve(); },
            single() { return api.resolve(); },
            then(onFulfilled, onRejected) { return api.resolve().then(onFulfilled, onRejected); }
        };
        api.resolve = () => {
            if (state.op === 'update') {
                calls.updates.push({ table, patch: state.patch, filters: state.filters });
                return Promise.resolve({ data: [], error: null });
            }
            if (table === 'hwid_bans') {
                if (missingTable) {
                    return Promise.resolve({ data: null, error: { code: 'PGRST205', message: 'Could not find the table hwid_bans in the schema cache' } });
                }
                return Promise.resolve({ data: ban ? [{ id: 1, reason: 'sharing' }] : [], error: null });
            }
            if (table === 'bot_events') {
                return Promise.resolve({ data: null, error: null });
            }
            if (table === 'licenses') {
                return Promise.resolve({ data: [], error: null });
            }
            return Promise.resolve({ data: [], error: null });
        };
        return api;
    }
    return { client: { from: builder }, calls };
}

function makeHandler(client) {
    const repository = new FakeLicenseRepository({
        licenses: [{ license_key: 'KEY-1', is_active: true, hwid: 'device-1', expires_at: null, last_used_at: null }]
    });
    repository.client = client.client;
    return createVerifyHandler({ repository, config: CONFIG, now: () => NOW });
}

test('verify: rejects banned devices with 403 HWID_BANNED', async () => {
    const handler = makeHandler(fakeClient({ ban: true }));
    const res = await invokeHandler(handler, { body: { license_key: 'KEY-1', hwid: 'device-9' } });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'HWID_BANNED');
    assert.equal(res.body.message, 'This device is banned from using TGGLR');
});

test('verify: accepts non-banned devices and records success events', async () => {
    const client = fakeClient({ ban: false });
    const handler = makeHandler(client);
    const res = await invokeHandler(handler, {
        body: {
            license_key: 'KEY-1',
            hwid: 'device-1',
            minecraft_username: 'Notch',
            mc_uuid: 'uuid-123',
            tgglr_version: '1.2.0'
        }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, 'License verified successfully');

    const event = client.calls.inserts.find((insert) => insert.table === 'bot_events');
    assert.ok(event, 'login event recorded');
    assert.equal(event.payload.payload.outcome, 'verified');
    assert.equal(event.payload.payload.license_key, 'KEY-1');
    assert.equal(event.payload.payload.request.minecraft_username, 'Notch');
});

test('verify: keeps behaving identically without a database client (tests/fakes)', async () => {
    const repository = new FakeLicenseRepository({
        licenses: [{ license_key: 'KEY-1', is_active: true, hwid: 'device-1', expires_at: null, last_used_at: null }]
    });
    const handler = createVerifyHandler({ repository, config: CONFIG, now: () => NOW });
    const res = await invokeHandler(handler, { body: { license_key: 'KEY-1', hwid: 'device-1' } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
});

test('verify: bans are not enforced when the ban table is unavailable (fail-open, logged)', async () => {
    const handler = makeHandler(fakeClient({ ban: true, missingTable: true }));
    const res = await invokeHandler(handler, { body: { license_key: 'KEY-1', hwid: 'device-1' } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
});
