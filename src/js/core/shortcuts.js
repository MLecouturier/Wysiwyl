// ==========================================================================
// Keyboard shortcut registry
// ==========================================================================
//
// One single `keydown` listener drives every keyboard shortcut. Bindings are
// declarative and scoped; a scope stack decides which ones are eligible:
//
//   modal active  -> only `modal` bindings run (everything else is blocked)
//   otherwise     -> `edit`, then `mode`, then `global`, first match wins,
//                    falling through to the next scope when nothing matches
//
// This replaces the former collection of independent window listeners, whose
// ordering was implicit and where the modal guards were applied unevenly.
//
// Design rules encoded here (see also core/focus.js):
//   - auto-repeat is ignored unless a binding opts in with `repeat: true`;
//   - digit shortcuts are matched on `event.code` (layout/OS independent:
//     macOS turns Option+digit into a different `event.key`, and an AZERTY
//     number row needs Shift for the bare digits);
//   - `primary` means "Ctrl or Cmd" so a single binding serves both OSes.

export const SCOPE = Object.freeze({
    MODAL: 'modal',
    EDIT: 'edit',
    MODE: 'mode',
    GLOBAL: 'global',
});

// When no modal is open, scopes are tried in this order; the first binding
// that matches (and whose `when` passes) consumes the key.
const FALLBACK_ORDER = [SCOPE.EDIT, SCOPE.MODE, SCOPE.GLOBAL];

function matchToken(matcher, value) {
    if (matcher instanceof RegExp) return matcher.test(value);
    return matcher === value;
}

/// Physical digit index (1-8) of a keyboard event, or 0 when the event is
/// not a digit. Layout- and modifier-independent: Option+digit on macOS
/// rewrites `event.key`, an AZERTY number row needs Shift for the bare
/// digits, and some webviews report no `event.code` — so the lookup tries
/// `event.code` (Digit/Numpad), then `event.key`, then the legacy
/// `event.keyCode` (49-56 is the physical digit whatever the layout).
export function digitIndex(event) {
    const fromCode = /^(?:Digit|Numpad)([1-8])$/.exec(event.code || '');
    if (fromCode) return Number(fromCode[1]);
    const fromKey = /^[1-8]$/.exec(event.key || '');
    if (fromKey) return Number(fromKey[0]);
    const keyCode = event.keyCode || event.which;
    if (keyCode >= 49 && keyCode <= 56) return keyCode - 48;
    return 0;
}

/// Does a binding descriptor match a keyboard event? Pure and unit-tested.
/// `event` only needs key/code/ctrlKey/metaKey/altKey/shiftKey/repeat.
export function comboMatches(binding, event) {
    const primary = event.metaKey || event.ctrlKey;
    if (binding.primary === true && !primary) return false;
    if (binding.primary === false && primary) return false;
    if (binding.alt !== undefined && event.altKey !== binding.alt) return false;
    if (binding.shift !== undefined && event.shiftKey !== binding.shift) return false;
    // A custom predicate replaces the key/code match. Used by the digit
    // shortcuts, which must also accept the numpad and fall back to
    // event.key / event.keyCode when a webview reports no event.code.
    if (typeof binding.match === 'function') return binding.match(event);
    if (binding.code !== undefined && !matchToken(binding.code, event.code)) return false;
    if (binding.key !== undefined && !matchToken(binding.key, event.key)) return false;
    // A binding must pin at least one of key/code, otherwise it would match
    // every keystroke.
    return binding.key !== undefined || binding.code !== undefined;
}

export function createShortcutRegistry() {
    const bindings = [];
    const scopes = new Set([SCOPE.GLOBAL]);
    const escapeHandlers = [];

    /// Registers a binding. Returns an unregister function.
    function register(binding) {
        bindings.push(binding);
        return () => {
            const i = bindings.indexOf(binding);
            if (i >= 0) bindings.splice(i, 1);
        };
    }

    function activateScope(scope) { scopes.add(scope); }
    function deactivateScope(scope) { scopes.delete(scope); }
    function isScopeActive(scope) { return scopes.has(scope); }

    /// Registers an Escape target. The highest-priority *active* one is
    /// cancelled on each Escape; `priority` is higher-wins. Returns an
    /// unregister function.
    function registerEscape(priority, isActive, cancel) {
        const handler = { priority, isActive, cancel };
        escapeHandlers.push(handler);
        return () => {
            const i = escapeHandlers.indexOf(handler);
            if (i >= 0) escapeHandlers.splice(i, 1);
        };
    }

    /// Cancels the topmost active Escape target. Returns true if one ran.
    function runEscapeChain() {
        const active = escapeHandlers
            .filter(h => h.isActive())
            .sort((a, b) => b.priority - a.priority);
        if (active.length === 0) return false;
        active[0].cancel();
        return true;
    }

    /// Dispatches a keyboard event. Returns true when a binding consumed it.
    function handleEvent(event) {
        const order = scopes.has(SCOPE.MODAL)
            ? [SCOPE.MODAL]
            : FALLBACK_ORDER.filter(scope => scopes.has(scope));

        for (const scope of order) {
            for (const binding of bindings) {
                if (binding.scope !== scope) continue;
                if (!comboMatches(binding, event)) continue;
                if (event.repeat && !binding.repeat) continue;
                if (binding.when && !binding.when(event)) continue;
                if (binding.preventDefault !== false) event.preventDefault();
                binding.run(event);
                return true;
            }
        }
        return false;
    }

    return {
        register,
        activateScope,
        deactivateScope,
        isScopeActive,
        registerEscape,
        runEscapeChain,
        handleEvent,
        bindings,
    };
}

// Application-wide singleton (the app is a zero-build, single-page module
// graph; the tests build their own isolated registries).
export const shortcuts = createShortcutRegistry();

export const registerShortcut = (binding) => shortcuts.register(binding);
export const activateScope = (scope) => shortcuts.activateScope(scope);
export const deactivateScope = (scope) => shortcuts.deactivateScope(scope);
export const registerEscape = (priority, isActive, cancel) =>
    shortcuts.registerEscape(priority, isActive, cancel);
export const runEscapeChain = () => shortcuts.runEscapeChain();

// Install the single desktop listener. Guarded so the module stays
// importable in Node for the unit tests.
if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (event) => shortcuts.handleEvent(event));
}
