'use strict';

// Short-lived registry for confirmation-button callbacks. A command that needs
// confirmation registers a closure; the button handler in interactionCreate
// consumes it. Entries expire after two minutes.

const PENDING = new Map();
const TTL_MS = 120_000;

function registerPendingAction(id, handler) {
    PENDING.set(id, { handler, expires: Date.now() + TTL_MS });
}

function takePendingAction(id) {
    const entry = PENDING.get(id);
    if (!entry) {
        return null;
    }
    PENDING.delete(id);
    if (Date.now() > entry.expires) {
        return null;
    }
    return entry.handler;
}

module.exports = { registerPendingAction, takePendingAction };
