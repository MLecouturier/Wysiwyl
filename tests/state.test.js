// Unit tests for the frontend state foundations
// (src/js/state/store.js and src/js/state/events.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/js/core/state.js';
import { createEventBus } from '../src/js/core/state.js';

test('store notifies subscribers only on a real change', () => {
    const store = createStore(1);
    const seen = [];
    const unsubscribe = store.subscribe((v) => seen.push(v));

    // subscribe calls the listener once with the current value
    assert.deepEqual(seen, [1]);

    store.set(1); // identical: no notification
    store.set(2);
    store.update((v) => v + 1);
    assert.deepEqual(seen, [1, 2, 3]);

    unsubscribe();
    store.set(99);
    assert.deepEqual(seen, [1, 2, 3]);
});

test('store get reflects the latest value', () => {
    const store = createStore({ a: 1 });
    store.update((s) => ({ ...s, b: 2 }));
    assert.deepEqual(store.get(), { a: 1, b: 2 });
});

test('event bus dispatches to every listener', () => {
    const bus = createEventBus();
    const calls = [];
    bus.on('ping', (p) => calls.push(['a', p]));
    bus.on('ping', (p) => calls.push(['b', p]));
    bus.emit('ping', 42);
    assert.deepEqual(calls, [['a', 42], ['b', 42]]);
});

test('event bus on returns an unsubscribe function', () => {
    const bus = createEventBus();
    let count = 0;
    const unsubscribe = bus.on('tick', () => count++);
    bus.emit('tick');
    unsubscribe();
    bus.emit('tick');
    assert.equal(count, 1);
});

test('event bus off removes a listener', () => {
    const bus = createEventBus();
    let count = 0;
    const fn = () => count++;
    bus.on('tick', fn);
    bus.off('tick', fn);
    bus.emit('tick');
    assert.equal(count, 0);
});

test('event bus emit on an unknown event is a no-op', () => {
    const bus = createEventBus();
    assert.doesNotThrow(() => bus.emit('nobody-listens'));
});
