'use strict';

const { HttpError } = require('./errors');
const { extractAdminToken, timingSafeEqual } = require('./security');

function authenticateAdmin(req, config) {
    if (!config.adminToken) {
        throw new HttpError(500, 'SERVER_CONFIG', 'Server configuration error');
    }

    const token = extractAdminToken(req);
    if (!token || !timingSafeEqual(token, config.adminToken)) {
        throw new HttpError(401, 'UNAUTHORIZED', 'Unauthorized');
    }
}

module.exports = { authenticateAdmin };
