'use strict';

const { HttpError } = require('./errors');

const DURATION_UNITS = {
    d: 'days',
    w: 'weeks',
    m: 'months',
    y: 'years'
};

const DURATION_PATTERN = /^(\d+)\s*([dwmy])$/i;
const LIFETIME_PATTERN = /^(l|lifetime)$/i;

function invalidDuration(message = 'Invalid duration. Use a positive number with d, w, m, y, or L for lifetime.') {
    return new HttpError(400, 'INVALID_DURATION', message);
}

function parseDuration(input) {
    if (typeof input !== 'string') {
        throw invalidDuration();
    }

    const value = input.trim();
    if (!value) {
        throw invalidDuration();
    }

    if (LIFETIME_PATTERN.test(value)) {
        return { lifetime: true, amount: null, unit: null };
    }

    const match = DURATION_PATTERN.exec(value);
    if (!match) {
        throw invalidDuration();
    }

    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw invalidDuration();
    }

    return {
        lifetime: false,
        amount,
        unit: DURATION_UNITS[match[2].toLowerCase()]
    };
}

function addCalendarMonths(date, months) {
    const result = new Date(date.getTime());
    const day = result.getUTCDate();

    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    if (!Number.isFinite(result.getTime())) {
        throw invalidDuration('Duration is too large.');
    }

    const daysInTargetMonth = new Date(
        Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
    ).getUTCDate();

    result.setUTCDate(Math.min(day, daysInTargetMonth));
    return result;
}

function addDuration(date, duration) {
    if (duration.lifetime) {
        return null;
    }

    const result = new Date(date.getTime());
    switch (duration.unit) {
        case 'days':
            result.setUTCDate(result.getUTCDate() + duration.amount);
            break;
        case 'weeks':
            result.setUTCDate(result.getUTCDate() + duration.amount * 7);
            break;
        case 'months':
            return addCalendarMonths(date, duration.amount);
        case 'years':
            return addCalendarMonths(date, duration.amount * 12);
        default:
            throw invalidDuration();
    }

    if (!Number.isFinite(result.getTime())) {
        throw invalidDuration('Duration is too large.');
    }
    return result;
}

function evaluateExpiration(expiresAt, now = new Date()) {
    if (expiresAt === null || expiresAt === undefined) {
        return { lifetime: true, expired: false, invalid: false, expiresAt: null };
    }

    const date = expiresAt instanceof Date ? new Date(expiresAt.getTime()) : new Date(expiresAt);
    if (!Number.isFinite(date.getTime())) {
        return { lifetime: false, expired: false, invalid: true, expiresAt: null };
    }

    return {
        lifetime: false,
        expired: date.getTime() <= now.getTime(),
        invalid: false,
        expiresAt: date
    };
}

module.exports = {
    parseDuration,
    addDuration,
    evaluateExpiration
};
