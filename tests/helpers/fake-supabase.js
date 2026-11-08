'use strict';

function createFakeSupabase() {
    const responses = [];
    const calls = [];

    function nextResponse() {
        if (responses.length === 0) {
            throw new Error('No queued Supabase response');
        }

        const response = responses.shift();
        if (response instanceof Error) {
            throw response;
        }
        return response;
    }

    function createBuilder(table) {
        const call = { table, filters: [] };
        calls.push(call);

        const builder = {
            select(columns, options) {
                call.select = columns;
                call.options = options;
                return builder;
            },
            insert(values) {
                call.operation = 'insert';
                call.values = values;
                return builder;
            },
            update(values) {
                call.operation = 'update';
                call.values = values;
                return builder;
            },
            delete() {
                call.operation = 'delete';
                return builder;
            },
            eq(column, value) {
                call.filters.push(['eq', column, value]);
                return builder;
            },
            is(column, value) {
                call.filters.push(['is', column, value]);
                return builder;
            },
            not(column, operator, value) {
                call.filters.push(['not', column, operator, value]);
                return builder;
            },
            lte(column, value) {
                call.filters.push(['lte', column, value]);
                return builder;
            },
            ilike(column, pattern) {
                call.filters.push(['ilike', column, pattern]);
                return builder;
            },
            order(column, options) {
                call.order = { column, ...options };
                return builder;
            },
            limit(count) {
                call.limit = count;
                return builder;
            },
            range(from, to) {
                call.range = [from, to];
                return builder;
            },
            maybeSingle() {
                return Promise.resolve(nextResponse());
            },
            single() {
                return Promise.resolve(nextResponse());
            },
            then(resolve, reject) {
                return Promise.resolve().then(nextResponse).then(resolve, reject);
            }
        };

        return builder;
    }

    return {
        from(table) {
            return createBuilder(table);
        },
        queue(...items) {
            responses.push(...items);
        },
        calls,
        remaining() {
            return responses.length;
        }
    };
}

module.exports = { createFakeSupabase };
