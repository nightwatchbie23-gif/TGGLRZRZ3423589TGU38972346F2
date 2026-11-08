'use strict';

const { HttpError, DatabaseError } = require('./errors');

function json(res, status, payload) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(status).json(payload);
}

function success(res, status, message, data) {
    const payload = { success: true, message };
    if (data !== undefined) {
        payload.data = data;
    }
    return json(res, status, payload);
}

function failure(res, status, code, message) {
    return json(res, status, { success: false, message, code });
}

function methodNotAllowed(res, allowed) {
    res.setHeader('Allow', allowed);
    return failure(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}

function handleError(res, error, context) {
    if (error instanceof HttpError) {
        if (error.status >= 500) {
            console.error(`[${context}]`, error.message);
        }
        if (error.status === 401) {
            res.setHeader('WWW-Authenticate', 'Bearer');
        }
        return failure(res, error.status, error.code, error.message);
    }

    if (error instanceof DatabaseError) {
        const cause = error.cause && error.cause.message ? error.cause.message : error.message;
        console.error(`[${context}] database error:`, cause);
        return failure(res, 500, 'DATABASE_ERROR', 'Database error');
    }

    console.error(`[${context}] unexpected error:`, error);
    return failure(res, 500, 'INTERNAL_ERROR', 'Internal server error');
}

module.exports = { success, failure, methodNotAllowed, handleError };
