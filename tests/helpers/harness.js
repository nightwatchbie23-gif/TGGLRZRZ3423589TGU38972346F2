'use strict';

function createMockResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        setHeader(name, value) {
            this.headers[name.toLowerCase()] = value;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

async function invokeHandler(handler, options = {}) {
    const req = {
        method: options.method || 'POST',
        url: options.url || '/',
        headers: options.headers || {},
        body: options.body,
        query: options.query
    };
    const res = createMockResponse();

    await handler(req, res);
    return res;
}

async function withoutConsoleError(callback) {
    const original = console.error;
    console.error = () => {};

    try {
        return await callback();
    } finally {
        console.error = original;
    }
}

module.exports = { createMockResponse, invokeHandler, withoutConsoleError };
