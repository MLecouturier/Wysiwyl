// Frontend/backend IPC contract: checks, by static analysis of the
// sources, that every `invoke('<command>', { ... })` of the frontend
// targets a command registered in src-tauri/src/lib.rs, with exactly the
// argument keys its Rust signature expects (Tauri 2 maps snake_case
// parameters to camelCase keys); that every registered command exists;
// that every backend error code has a translation; and that the events
// the backend emits are listened to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

function walk(dir, ext) {
    return readdirSync(join(root, dir)).flatMap(name => {
        const rel = join(dir, name);
        if (statSync(join(root, rel)).isDirectory()) return walk(rel, ext);
        return rel.endsWith(ext) ? [rel] : [];
    });
}

const rustFiles = walk('src-tauri/src', '.rs');
const jsFiles = walk('src/js', '.js');

// Rust parameter types injected by Tauri, never sent by the frontend
const INJECTED = /^(State|AppHandle|Window|WebviewWindow|tauri::State|tauri::AppHandle)\b/;

const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// Splits a parameter list on its top-level commas (generic arguments such
// as State<'_, ConfigState> contain commas too)
function splitParams(list) {
    const out = [];
    let depth = 0;
    let current = '';
    for (const ch of list) {
        if (ch === '<' || ch === '(' || ch === '[') depth++;
        if (ch === '>' || ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) {
            out.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    out.push(current);
    return out.map(p => p.trim()).filter(Boolean);
}

// Registered commands: `module::name` entries of generate_handler!
function registeredCommands() {
    const lib = read('src-tauri/src/lib.rs');
    const block = lib.slice(lib.indexOf('generate_handler!['), lib.indexOf('])', lib.indexOf('generate_handler![')));
    return [...block.matchAll(/(\w+)::(\w+)\s*,/g)].map(m => m[2]);
}

// Every #[tauri::command] function and its frontend argument keys
function commandSignatures() {
    const commands = new Map();
    for (const file of rustFiles) {
        const src = read(file);
        const re = /#\[tauri::command[^\]]*\]\s*pub\s+(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\s*\(([^)]*)\)/g;
        for (const m of src.matchAll(re)) {
            const params = splitParams(m[2])
                .map(p => {
                    const [name, ...type] = p.split(':');
                    return { name: name.trim(), type: type.join(':').trim() };
                })
                .filter(p => !INJECTED.test(p.type));
            commands.set(m[1], {
                file,
                keys: params.map(p => camel(p.name)).sort(),
                optional: params.filter(p => p.type.startsWith('Option<')).map(p => camel(p.name)),
            });
        }
    }
    return commands;
}

// Frontend call sites: invoke('name') / invoke('name', { a, b: c, ... })
function invokeCalls() {
    const calls = [];
    for (const file of jsFiles) {
        const src = read(file);
        for (const m of src.matchAll(/invoke\(\s*'(\w+)'\s*(?:,\s*\{([^}]*)\})?\s*\)/g)) {
            const body = (m[2] || '').trim();
            const keys = body
                ? body.split(',').map(k => k.trim()).filter(Boolean).map(k => k.split(':')[0].trim())
                : [];
            calls.push({ file, name: m[1], keys: keys.sort() });
        }
        // An invoke with a non-literal argument object cannot be checked
        for (const m of src.matchAll(/invoke\(\s*'(\w+)'\s*,\s*(?!\{)([A-Za-z_]\w*)/g)) {
            calls.push({ file, name: m[1], keys: null });
        }
    }
    return calls;
}

test('every registered command is defined as a #[tauri::command]', () => {
    const signatures = commandSignatures();
    for (const name of registeredCommands()) {
        assert.ok(signatures.has(name), `${name} is registered but not defined`);
    }
});

test('every #[tauri::command] is registered', () => {
    const registered = new Set(registeredCommands());
    for (const [name, { file }] of commandSignatures()) {
        assert.ok(registered.has(name), `${name} (${file}) is never registered in lib.rs`);
    }
});

test('every frontend invoke targets a registered command with the right keys', () => {
    const registered = new Set(registeredCommands());
    const signatures = commandSignatures();
    const calls = invokeCalls();
    assert.ok(calls.length > 40, 'the invoke scanner found the call sites');
    for (const call of calls) {
        assert.ok(registered.has(call.name), `${call.file}: invoke('${call.name}') is not registered`);
        if (call.keys === null) continue;
        const { keys, optional } = signatures.get(call.name);
        const missing = keys.filter(k => !call.keys.includes(k) && !optional.includes(k));
        const extra = call.keys.filter(k => !keys.includes(k));
        assert.deepEqual(
            { missing, extra }, { missing: [], extra: [] },
            `${call.file}: invoke('${call.name}', {${call.keys}}) — expected {${keys}}`,
        );
    }
});

test('every backend error code is translated in every locale', () => {
    const codes = new Set();
    for (const file of rustFiles) {
        for (const m of read(file).matchAll(/err\("(\w+)"\)/g)) codes.add(m[1]);
    }
    assert.ok(codes.size > 10);
    for (const locale of ['en', 'fr']) {
        const errors = JSON.parse(read(`src/i18n/${locale}.json`)).errors;
        for (const code of codes) {
            assert.ok(errors[code], `errors.${code} is missing from ${locale}.json`);
        }
    }
});

test('every event emitted by the backend is listened to by the frontend', () => {
    const emitted = new Set();
    for (const file of rustFiles) {
        for (const m of read(file).matchAll(/\.emit\(\s*"([\w:-]+)"/g)) emitted.add(m[1]);
    }
    const listened = new Set();
    for (const file of jsFiles) {
        for (const m of read(file).matchAll(/listen\(\s*'([\w:-]+)'/g)) listened.add(m[1]);
    }
    assert.ok(emitted.size >= 6);
    for (const event of emitted) {
        assert.ok(listened.has(event), `event '${event}' is emitted but never listened to`);
    }
});

test('the tempo select only offers ratios the backend keeps exact', () => {
    const card = read('src/templates/synth-card.html');
    const select = card.slice(card.indexOf('class="synth-tempo"'), card.indexOf('</select>', card.indexOf('class="synth-tempo"')));
    const values = [...select.matchAll(/value="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(values, ['3/2', '4/3', '5/4', '1', '3/4', '2/3', '1/2']);
});
