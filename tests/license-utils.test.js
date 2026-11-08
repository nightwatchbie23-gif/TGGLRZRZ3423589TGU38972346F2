'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDuration, addDuration, evaluateExpiration } = require('../lib/license-utils');

function isInvalidDuration(error) {
    return error.status === 400 && error.code === 'INVALID_DURATION';
}

test('duration: parses days, weeks, months and years', () => {
    assert.deepEqual(parseDuration('5d'), { lifetime: false, amount: 5, unit: 'days' });
    assert.deepEqual(parseDuration('5w'), { lifetime: false, amount: 5, unit: 'weeks' });
    assert.deepEqual(parseDuration('20w'), { lifetime: false, amount: 20, unit: 'weeks' });
    assert.deepEqual(parseDuration('5m'), { lifetime: false, amount: 5, unit: 'months' });
    assert.deepEqual(parseDuration('15m'), { lifetime: false, amount: 15, unit: 'months' });
    assert.deepEqual(parseDuration('5y'), { lifetime: false, amount: 5, unit: 'years' });
    assert.deepEqual(parseDuration('10y'), { lifetime: false, amount: 10, unit: 'years' });
});

test('duration: accepts case-insensitive input and surrounding whitespace', () => {
    assert.deepEqual(parseDuration('  10Y '), { lifetime: false, amount: 10, unit: 'years' });
    assert.deepEqual(parseDuration('2W'), { lifetime: false, amount: 2, unit: 'weeks' });
});

test('duration: parses Lifetime aliases', () => {
    for (const value of ['L', 'l', 'lifetime', 'LIFETIME', ' Lifetime ']) {
        assert.deepEqual(parseDuration(value), { lifetime: true, amount: null, unit: null });
    }
});

test('duration: rejects invalid values', () => {
    for (const value of [
        null,
        undefined,
        5,
        '',
        '   ',
        '0d',
        '00w',
        '-1d',
        '1.5m',
        'd',
        'm',
        '5x',
        '5 m 5',
        '1e3d',
        'L5',
        '999999999999999999999d'
    ]) {
        assert.throws(() => parseDuration(value), isInvalidDuration, String(value));
    }
});

test('duration: adds days and weeks in UTC', () => {
    const start = new Date('2026-11-08T12:00:00.000Z');

    assert.equal(
        addDuration(start, parseDuration('10d')).toISOString(),
        '2026-11-18T12:00:00.000Z'
    );
    assert.equal(
        addDuration(start, parseDuration('5w')).toISOString(),
        '2026-12-13T12:00:00.000Z'
    );
    assert.equal(
        addDuration(start, parseDuration('20w')).toISOString(),
        '2027-03-28T12:00:00.000Z'
    );
});

test('duration: adds calendar months with day-of-month clamping', () => {
    const january = new Date('2026-01-31T10:15:00.000Z');
    assert.equal(
        addDuration(january, parseDuration('1m')).toISOString(),
        '2026-02-28T10:15:00.000Z'
    );

    const leapJanuary = new Date('2028-01-31T10:15:00.000Z');
    assert.equal(
        addDuration(leapJanuary, parseDuration('1m')).toISOString(),
        '2028-02-29T10:15:00.000Z'
    );

    const start = new Date('2026-11-08T12:00:00.000Z');
    assert.equal(
        addDuration(start, parseDuration('5m')).toISOString(),
        '2027-04-08T12:00:00.000Z'
    );
    assert.equal(
        addDuration(start, parseDuration('15m')).toISOString(),
        '2028-02-08T12:00:00.000Z'
    );
});

test('duration: adds calendar years and clamps leap days', () => {
    const leapDay = new Date('2028-02-29T10:15:00.000Z');
    assert.equal(
        addDuration(leapDay, parseDuration('1y')).toISOString(),
        '2029-02-28T10:15:00.000Z'
    );

    const start = new Date('2026-11-08T12:00:00.000Z');
    assert.equal(
        addDuration(start, parseDuration('10y')).toISOString(),
        '2036-11-08T12:00:00.000Z'
    );
});

test('duration: Lifetime resolves to a NULL expiration', () => {
    assert.equal(addDuration(new Date(), parseDuration('L')), null);
});

test('duration: rejects amounts that overflow the calendar', () => {
    assert.throws(
        () => addDuration(new Date('2026-11-08T12:00:00.000Z'), parseDuration('999999999999999y')),
        isInvalidDuration
    );
});

test('expiration: treats NULL as Lifetime', () => {
    assert.deepEqual(evaluateExpiration(null), {
        lifetime: true,
        expired: false,
        invalid: false,
        expiresAt: null
    });
    assert.equal(evaluateExpiration(undefined).lifetime, true);
});

test('expiration: detects expired, valid and invalid timestamps', () => {
    const now = new Date('2026-11-08T12:00:00.000Z');

    assert.equal(evaluateExpiration('2026-11-08T11:59:59.000Z', now).expired, true);
    assert.equal(evaluateExpiration('2026-11-08T12:00:00.000Z', now).expired, true);
    assert.equal(evaluateExpiration('2026-11-08T12:00:01.000Z', now).expired, false);
    assert.equal(evaluateExpiration('not-a-date', now).invalid, true);
    assert.equal(evaluateExpiration(new Date('2027-01-01T00:00:00.000Z'), now).expired, false);
});
