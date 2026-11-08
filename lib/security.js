'use strict';

const crypto = require('node:crypto');

function timingSafeEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) {
        return false;
    }

    const leftHash = crypto.createHash('sha256').update(left, 'utf8').digest();
    const rightHash = crypto.createHash('sha256').update(right, 'utf8').digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
}

function extractBearerToken(req) {
    let header = req.headers ? req.headers.authorization : undefined;
    if (Array.isArray(header)) {
        header = header[0];
    }
    if (typeof header !== 'string') {
        return '';
    }

    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : '';
}

function extractApiKey(req) {
    let value = req.headers ? req.headers['x-api-key'] : undefined;
    if (Array.isArray(value)) {
        value = value[0];
    }
    return typeof value === 'string' ? value.trim() : '';
}

function extractAdminToken(req) {
    return extractBearerToken(req) || extractApiKey(req);
}

function escapeLike(value) {
    return value.replace(/[\\%_]/g, '\\$&');
}

function generateLicenseKey() {
    const bytes = crypto.randomBytes(12).toString('hex').toUpperCase();
    const groups = bytes.match(/.{1,6}/g) || [];
    return `TGGLR-${groups.join('-')}`;
}

module.exports = {
    timingSafeEqual,
    extractAdminToken,
    escapeLike,
    generateLicenseKey
};
