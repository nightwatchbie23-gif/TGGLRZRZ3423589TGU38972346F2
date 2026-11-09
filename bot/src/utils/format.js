'use strict';

// Central formatting and masking helpers. Sensitive values are masked in every
// non-ephemeral context; admins see full keys only through ephemeral replies.

const COLORS = {
    primary: 0x00a8ff,
    success: 0x2ecc71,
    error: 0xe74c3c,
    warn: 0xf39c12,
    neutral: 0x95a5a6
};

function maskKey(key) {
    if (typeof key !== 'string' || !key) {
        return 'unknown';
    }
    const parts = key.split('-');
    if (parts.length <= 2) {
        return `${key.slice(0, 6)}\u2026`;
    }
    return `${parts[0]}-${parts[1]}\u2026${parts[parts.length - 1]}`;
}

function maskHwid(hwid) {
    if (typeof hwid !== 'string' || !hwid) {
        return 'unbound';
    }
    return `${hwid.slice(0, 8)}\u2026 (${hwid.length} chars)`;
}

function fmtDate(value) {
    if (!value) {
        return 'never';
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'invalid date';
    }
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function base(title, color = COLORS.primary) {
    return {
        color,
        title,
        timestamp: new Date().toISOString(),
        footer: { text: 'LicenseManagerTGG' }
    };
}

function result(title, description, color) {
    const embed = base(title, color);
    if (description) {
        embed.description = description;
    }
    return embed;
}

module.exports = {
    COLORS,
    base,
    error: (title, description) => result(title, description, COLORS.error),
    fmtDate,
    info: (title, description) => result(title, description, COLORS.primary),
    maskHwid,
    maskKey,
    success: (title, description) => result(title, description, COLORS.success),
    warn: (title, description) => result(title, description, COLORS.warn)
};
