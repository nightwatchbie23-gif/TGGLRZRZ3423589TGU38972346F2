'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseRequestBody,
    validateVerifyPayload,
    validateLicenseKey,
    validateCreatePayload,
    validateUpdatePayload,
    validateListQuery
} = require('../lib/validation');

function hasCode(code) {
    return (error) => error.status === 400 && error.code === code;
}

test('validation: parses object, JSON string and Buffer bodies', () => {
    assert.deepEqual(parseRequestBody({ a: 1 }), { a: 1 });
    assert.deepEqual(parseRequestBody('{"a":1}'), { a: 1 });
    assert.deepEqual(parseRequestBody(Buffer.from('{"a":1}')), { a: 1 });
});

test('validation: rejects malformed bodies', () => {
    for (const body of [undefined, null, '', '   ', '{', 'null', '[]', [], 5, true]) {
        assert.throws(() => parseRequestBody(body), hasCode('INVALID_BODY'), String(body));
    }
});

test('validation: trims verification credentials', () => {
    assert.deepEqual(
        validateVerifyPayload({ license_key: '  KEY-1 ', hwid: ' device-1 ' }),
        { licenseKey: 'KEY-1', hwid: 'device-1' }
    );
});

test('validation: rejects missing, blank, oversized or control-character credentials', () => {
    for (const body of [
        {},
        { license_key: 'KEY-1' },
        { hwid: 'device-1' },
        { license_key: '   ', hwid: 'device-1' },
        { license_key: 'KEY-1', hwid: '  ' },
        { license_key: 'K'.repeat(257), hwid: 'device-1' },
        { license_key: 'KEY-1', hwid: 'H'.repeat(257) },
        { license_key: 'KEY\u0000', hwid: 'device-1' },
        { license_key: 'KEY-1', hwid: 'device\u007f' }
    ]) {
        assert.throws(() => validateVerifyPayload(body), hasCode('INVALID_CREDENTIALS'));
    }
});

test('validation: validates license keys', () => {
    assert.equal(validateLicenseKey('  KEY-1 '), 'KEY-1');
    assert.throws(() => validateLicenseKey(undefined), hasCode('INVALID_LICENSE_KEY'));
    assert.throws(() => validateLicenseKey('   '), hasCode('INVALID_LICENSE_KEY'));
    assert.throws(() => validateLicenseKey('K'.repeat(257)), hasCode('INVALID_LICENSE_KEY'));
});

test('validation: parses create payloads with a duration', () => {
    const input = validateCreatePayload({ duration: '5m' });

    assert.equal(input.licenseKey, null);
    assert.deepEqual(input.duration, { lifetime: false, amount: 5, unit: 'months' });
    assert.equal(input.expiresAt, null);
    assert.equal(input.isActive, true);
});

test('validation: parses create payloads with an explicit expiration and optional fields', () => {
    const input = validateCreatePayload({
        license_key: ' CUSTOM-KEY ',
        expires_at: '2027-01-01T00:00:00Z',
        is_active: false
    });

    assert.equal(input.licenseKey, 'CUSTOM-KEY');
    assert.equal(input.duration, null);
    assert.equal(input.expiresAt, '2027-01-01T00:00:00.000Z');
    assert.equal(input.isActive, false);
});

test('validation: rejects create payloads without exactly one expiration source', () => {
    assert.throws(() => validateCreatePayload({}), hasCode('DURATION_REQUIRED'));
    assert.throws(
        () => validateCreatePayload({ duration: '5m', expires_at: '2027-01-01T00:00:00Z' }),
        hasCode('VALIDATION_ERROR')
    );
    assert.throws(() => validateCreatePayload({ duration: '5x' }), hasCode('INVALID_DURATION'));
    assert.throws(() => validateCreatePayload({ expires_at: 'never' }), hasCode('INVALID_EXPIRATION'));
    assert.throws(
        () => validateCreatePayload({ duration: 'L', is_active: 'yes' }),
        hasCode('VALIDATION_ERROR')
    );
});

test('validation: parses update payloads and normalizes actions', () => {
    const input = validateUpdatePayload({
        license_key: 'KEY-1',
        action: 'RESET-HWID'
    });

    assert.equal(input.licenseKey, 'KEY-1');
    assert.equal(input.action, 'reset_hwid');
});

test('validation: rejects invalid updates', () => {
    assert.throws(() => validateUpdatePayload({ action: 'disable' }), hasCode('INVALID_LICENSE_KEY'));
    assert.throws(
        () => validateUpdatePayload({ license_key: 'KEY-1', action: 'explode' }),
        hasCode('INVALID_ACTION')
    );
    assert.throws(
        () => validateUpdatePayload({ license_key: 'KEY-1', action: 'update' }),
        hasCode('NO_UPDATES')
    );
    assert.throws(
        () => validateUpdatePayload({
            license_key: 'KEY-1',
            action: 'update',
            duration: '5m',
            expires_at: '2027-01-01T00:00:00Z'
        }),
        hasCode('VALIDATION_ERROR')
    );
    assert.throws(
        () => validateUpdatePayload({ license_key: 'KEY-1', action: 'update', duration: '5x' }),
        hasCode('INVALID_DURATION')
    );
});

test('validation: validates list queries and defaults', () => {
    assert.deepEqual(validateListQuery({}), {
        limit: 50,
        offset: 0,
        status: 'all',
        query: null
    });

    assert.deepEqual(
        validateListQuery({ limit: '10', offset: '20', status: 'EXPIRED', q: ' TGGLR ' }),
        { limit: 10, offset: 20, status: 'expired', query: 'TGGLR' }
    );

    assert.equal(validateListQuery({ q: '   ' }).query, null);
});

test('validation: rejects invalid list queries', () => {
    for (const query of [
        { limit: '0' },
        { limit: '201' },
        { limit: '1.5' },
        { limit: 'abc' },
        { offset: '-1' },
        { offset: '1000001' },
        { status: 'unknown' },
        { q: 'x'.repeat(101) },
        { q: 5 }
    ]) {
        assert.throws(() => validateListQuery(query), hasCode('INVALID_QUERY'), JSON.stringify(query));
    }
});
