// ==========================================================================
// Keyboard shortcuts dialog
// ==========================================================================
//
// The footer keyboard button (#show-shortcuts-btn) opens a modal listing the
// keyboard shortcuts and mouse gestures. The list itself is static markup in
// index.html (#shortcuts-modal), translated through data-i18n; this module
// only opens/closes it and fills the modifier keys ([data-mod]) for the
// current platform: ⌘ ⌥ ⇧ on macOS, Ctrl / Alt / Shift elsewhere.

import { t } from './i18n.js';
import { openModal, closeModal } from './modal.js';

const MAC_SYMBOLS = { primary: '⌘', alt: '⌥', shift: '⇧' };
const OTHER_KEYS = { primary: 'shortcuts.keyCtrl', alt: 'shortcuts.keyAlt', shift: 'shortcuts.keyShift' };

/// Label of a modifier key ('primary' | 'alt' | 'shift'). `translate` is
/// only used off macOS (the symbols are universal there). Pure, unit-tested.
export function modifierLabel(mod, { mac, translate = key => key }) {
    if (mac) return MAC_SYMBOLS[mod] ?? mod;
    return OTHER_KEYS[mod] ? translate(OTHER_KEYS[mod]) : mod;
}

/// macOS detection, from the user agent (the Tauri webview is WebKit on
/// macOS and reports "Macintosh").
export const isMacPlatform = (ua = navigator.userAgent) => /Mac/i.test(ua);

if (typeof document !== 'undefined') {
    const modal = document.querySelector('#shortcuts-modal');
    const openBtn = document.querySelector('#show-shortcuts-btn');
    const closeBtn = document.querySelector('#shortcuts-close');

    // Filled on every opening, so the labels follow the active locale
    const fillModifiers = () => {
        const mac = isMacPlatform();
        modal.querySelectorAll('[data-mod]').forEach(el => {
            el.textContent = modifierLabel(el.dataset.mod, { mac, translate: t });
        });
    };

    const close = () => closeModal(modal);

    if (modal && openBtn) {
        openBtn.addEventListener('click', () => {
            fillModifiers();
            openModal(modal, { initialFocus: closeBtn });
        });
        closeBtn?.addEventListener('click', close);
        // A click on the dimmed backdrop (outside the box) closes it too
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });
    }
}
