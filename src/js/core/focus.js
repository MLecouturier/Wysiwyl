// ==========================================================================
// Focus policy
// ==========================================================================
//
// Centralises two things that were previously spread across the shortcut
// handlers:
//   - which focused widgets "consume" a given key (typing a digit in a
//     number field, pressing a focused button with Space, …);
//   - where focus goes after a pointer interaction: clicking an action
//     button must not leave that button focused, otherwise the next Space
//     re-activates it instead of driving the global play/pause shortcut.
//
// Keyboard-activated buttons (Tab then Space/Enter) keep their focus: the
// click event they emit has `detail === 0`, which the policy ignores.

/// True for a real text entry (typing digits should never trigger a
/// shortcut there): text-like inputs, number inputs, textareas, selects and
/// contenteditable hosts.
export function isTextEntry(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    if (tag === 'INPUT') {
        const type = (el.type || 'text').toLowerCase();
        return type !== 'range' && type !== 'checkbox' && type !== 'radio'
            && type !== 'button' && type !== 'submit' && type !== 'reset';
    }
    return false;
}

/// True where Enter must be left to the focused widget (it submits/activates
/// rather than committing a crop/transform).
export function enterConsumed(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON';
}

/// True where the native Space behavior must be preserved (typing a space,
/// pressing a focused button, opening a select). Range and number inputs let
/// Space through to the global shortcut.
export function spaceConsumed(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return el.type !== 'number' && el.type !== 'range';
    return false;
}

/// True where a bare digit must not be interpreted as a shortcut (typing).
export function digitConsumed(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'SELECT' || tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return el.type !== 'range';
    return false;
}

/// Moves focus back to the image viewer (the app's neutral resting place),
/// so global shortcuts keep working after a pointer click. The container
/// carries tabindex="-1" in index.html to be programmatically focusable.
export function restoreFocusToViewer() {
    const target = document.querySelector('#image-viewer-container');
    if (target && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
    } else if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
    }
}

/// Installs the delegated pointer policy. Must be called once from the
/// composition root (main.js).
export function installFocusPolicy() {
    document.addEventListener('click', (event) => {
        // Only real pointer clicks (detail >= 1); keyboard activation of a
        // focused button has detail === 0 and must keep its focus.
        if (event.detail === 0) return;
        const active = document.activeElement;
        if (!active || active.tagName !== 'BUTTON') return;
        // The unsaved-session modal owns its own focus (trap + restore).
        if (active.closest('#session-unsaved-modal')) return;
        restoreFocusToViewer();
    }, true);
}
