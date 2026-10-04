// ==========================================================================
// Modal manager
// ==========================================================================
//
// A single place for the app's modal dialogs: show/hide, focus trap, focus
// restore, and the exclusive `modal` shortcut scope. Modals are stacked, so
// a modal opened from another one (none today, but the API allows it) sits
// on top; one Escape binding (registered once, in the modal scope) cancels
// the top of the stack.
//
// The scope and the trap are installed with the first modal and released
// with the last, so global shortcuts stay blocked for as long as any modal
// is open — and never longer.

import { registerShortcut, activateScope, deactivateScope, SCOPE } from './shortcuts.js';

const stack = []; // { overlay, onRequestClose, previousFocus }
let trapInstalled = false;

const top = () => stack[stack.length - 1] || null;

function focusables(overlay) {
    return Array.from(overlay.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter(el => !el.disabled);
}

function onTrapKeydown(e) {
    if (e.key !== 'Tab') return;
    const current = top();
    if (!current) return;
    const list = focusables(current.overlay);
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (!current.overlay.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

function installTrap() {
    if (trapInstalled) return;
    document.addEventListener('keydown', onTrapKeydown, true);
    trapInstalled = true;
}

function removeTrap() {
    if (!trapInstalled) return;
    document.removeEventListener('keydown', onTrapKeydown, true);
    trapInstalled = false;
}

/// Opens `overlay` as a modal: shows it, traps Tab inside it, moves focus to
/// `initialFocus` (or its first focusable element) and activates the
/// exclusive modal shortcut scope. `onRequestClose` is called when the user
/// cancels with Escape; it should call `closeModal` itself (or perform its
/// own cleanup) so each modal keeps control of its side effects.
export function openModal(overlay, { initialFocus = null, onRequestClose = null } = {}) {
    if (stack.some(entry => entry.overlay === overlay)) return;
    stack.push({ overlay, onRequestClose, previousFocus: document.activeElement });
    overlay.classList.remove('hidden');
    activateScope(SCOPE.MODAL);
    installTrap();
    const target = initialFocus || focusables(overlay)[0];
    if (target && typeof target.focus === 'function') target.focus();
}

/// Closes `overlay`, restores the focus it had before opening, and releases
/// the modal scope once the stack is empty.
export function closeModal(overlay) {
    const index = stack.findIndex(entry => entry.overlay === overlay);
    if (index === -1) return;
    const [entry] = stack.splice(index, 1);
    entry.overlay.classList.add('hidden');
    if (stack.length === 0) {
        deactivateScope(SCOPE.MODAL);
        removeTrap();
    }
    if (entry.previousFocus && typeof entry.previousFocus.focus === 'function') {
        entry.previousFocus.focus();
    }
}

/// True while at least one modal is open.
export const isAnyModalOpen = () => stack.length > 0;

// The modal scope blocks every global shortcut; this single binding cancels
// the topmost modal on Escape.
registerShortcut({
    id: 'modal-escape', key: 'Escape', scope: SCOPE.MODAL, preventDefault: false,
    when: () => stack.length > 0,
    run: () => {
        const current = top();
        if (!current) return;
        if (current.onRequestClose) current.onRequestClose();
        else closeModal(current.overlay);
    },
});
