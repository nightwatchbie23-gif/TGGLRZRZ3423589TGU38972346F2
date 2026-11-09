'use strict';

// Compound duration parsing and calendar-safe expiration computation.
// Supported: 7d, 2w, 3m, 1y, 1y2m3w5d, L / LIFETIME (case-insensitive).
// Months and years use UTC calendar arithmetic with day-of-month clamping.

const { addDuration } = require('../../../lib/license-utils');

const UNIT_ALIASES = {
    d: 'days',
    w: 'weeks',
    m: 'months',
    y: 'years'
};

const LIFETIME_PATTERN = /^(l|lifetime)$/i;
const COMPOUND_PATTERN = /^(?:(\d+)y)?(?:(\d+)m)?(?:(\d+)w)?(?:(\d+)d)?$/i;

function invalid(message = 'Invalid duration. Use values like 7d, 2w, 3m, 1y, 1y2m3w5d, or L for lifetime.') {
    const error = new Error(message);
    error.code = 'INVALID_DURATION';
    throw error;
}

// Parses into { lifetime } or { lifetime:false, parts: [{amount, unit}, ...] }.
function parseDuration(input) {
    if (typeof input !== 'string') {
        invalid();
    }

    const value = input.trim();
    if (!value) {
        invalid();
    }

    if (LIFETIME_PATTERN.test(value)) {
        return { lifetime: true, parts: [] };
    }

    const match = COMPOUND_PATTERN.exec(value);
    if (!match) {
        invalid();
    }

    const parts = [];
    const groups = [match[1], match[2], match[3], match[4]];
    groups.forEach((amount, index) => {
        if (amount === undefined) {
            return;
        }
        const key = ['y', 'm', 'w', 'd'][index];
        parts.push({ amount: Number(amount), unit: UNIT_ALIASES[key] });
        if (Number(amount) === 0) {
            invalid('Duration components must be positive numbers.');
        }
    });

    if (parts.length === 0) {
        invalid();
    }

    return { lifetime: false, parts };
}

function describe(spec) {
    if (spec.lifetime) {
        return 'Lifetime';
    }
    return spec.parts
        .map((part) => `${part.amount} ${part.unit}`)
        .join(' + ');
}

// Computes the absolute expiry from a base date using the backend's own
// calendar addDuration, always in UTC.
function computeExpiresAt(base, spec) {
    if (spec.lifetime) {
        return null;
    }

    let date = new Date(base.getTime());
    for (const part of spec.parts) {
        date = addDuration(date, { lifetime: false, amount: part.amount, unit: part.unit });
        if (!date) {
            invalid();
        }
    }
    return date;
}

module.exports = { computeExpiresAt, describe, parseDuration };
