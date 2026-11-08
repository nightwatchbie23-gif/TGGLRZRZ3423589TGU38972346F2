'use strict';

class HttpError extends Error {
    constructor(status, code, message, options) {
        super(message, options);
        this.name = 'HttpError';
        this.status = status;
        this.code = code;
    }
}

class DatabaseError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'DatabaseError';
    }
}

module.exports = { HttpError, DatabaseError };
