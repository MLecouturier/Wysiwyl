// Session lifecycle: the current file, dirty tracking, the window
// title, the unsaved-changes modal and the close confirmation.

import { t } from '../core/i18n.js';
import { registerShortcut, activateScope, deactivateScope, SCOPE } from '../core/shortcuts.js';

// Session lifecycle state: the current file path/name, the dirty flag and
// the window title, the unsaved-changes modal, the delegated dirty
// tracking, and the close-confirmation flow. The save/load operations
// themselves stay in main.js (they rebuild the whole UI); this module
// owns the state they read and write, plus the events that flip it.
//
// Extracted as a factory with injected cross-domain hooks: the metronome
// input (a tempo edit is a session change despite living in the excluded
// metronome area), the projection window (closed with the app), and the
// save operation the modal's Save button triggers.

// The saved state lives in inputs (sliders, selects, number fields) and
// in buttons (loop, direction, note lengths, channel toggles…). Delegated
// listeners catch the user's edits wherever they happen; programmatic
// assignments (`.value =` during a load or a reset) fire no DOM event, so
// the restore paths never leave a false trace. The transform/crop panels
// only hold a live preview: the session image changes when their Apply
// button is clicked (targeted marks in main.js).
const SAVED_CONTROL_CONTAINERS = '#controls, .synth-block';
const NON_SAVED_CONTAINERS = '#transform-panel, #crop-bar, #metronome, #language-switcher, .magic-wand-tolerance';

// Saved-state buttons inside the synth cards emit clicks, not input/change
// events. The transport and other non-saved actions are excluded; the
// mode-arming zone tools are too (the actual zone commit is marked where
// the zones are sent to the backend).
const NON_SAVED_SYNTH_BUTTONS = [
    '.synth-play', '.synth-rewind', '.synth-step-forward',
    '.synth-eye-btn', '.synth-toggle-full-options', '.synth-save-template',
    '.synth-add-zone-btn', '.synth-lasso-add-zone-btn',
    '.synth-magic-wand-add-zone-btn', '.synth-remove',
    '.synth-color-band', '.synth-color-picker',
].join(',');

export function createSessionState({
    getMetronomeInput, isProjectionOpen, closeProjection, saveSession,
}) {
    const { getVersion } = window.__TAURI__.app;
    const { getCurrentWindow } = window.__TAURI__.window;

    const unsavedModal = document.querySelector('#session-unsaved-modal');
    const unsavedModalMessage = document.querySelector('#session-unsaved-message');
    const unsavedSaveBtn = document.querySelector('#session-unsaved-save');
    const unsavedDiscardBtn = document.querySelector('#session-unsaved-discard');
    const unsavedCancelBtn = document.querySelector('#session-unsaved-cancel');

    let currentPath = null;
    let currentName = null;
    let dirty = false;
    let suppress = false;   // disables tracking while a load rebuilds the UI
    let allowClose = false; // set once the close outcome is settled

    // Mirrors the configured window title ("Wysiwyl <version>"), extended
    // with the loaded session's name and a "*" while changes are unsaved.
    async function refreshTitle() {
        let title = 'Wysiwyl';
        try {
            title = `Wysiwyl ${await getVersion()}`;
        } catch (err) {
            // Fall back to the plain name
        }
        if (currentName) title += ` — ${currentName}`;
        if (dirty) title += ' *';
        try {
            await getCurrentWindow().setTitle(title);
        } catch (err) {
            console.error('Error while updating the window title:', err);
        }
    }

    function setDirty(value) {
        if (dirty === value) return;
        dirty = value;
        refreshTitle();
    }

    function markDirty() {
        if (suppress || dirty) return;
        dirty = true;
        refreshTitle();
    }

    function setPath(path) {
        currentPath = path;
        currentName = path ? sessionNameFromPath(path) : null;
        refreshTitle();
    }

    // ---- Focus management ----
    // The modal is modal for the keyboard too: focus moves into it, Tab is
    // trapped inside, and the previously focused element is restored on
    // close. Its own Escape binding lives in the modal scope, which blocks
    // every global shortcut (Cmd+S/O included) while it is open.
    let focusBeforeModal = null;

    function modalFocusables() {
        return Array.from(unsavedModal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ));
    }

    function trapModalFocus(e) {
        if (e.key !== 'Tab') return;
        const focusables = modalFocusables();
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!unsavedModal.contains(document.activeElement)) {
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

    function showModal() {
        unsavedModalMessage.textContent = currentName
            ? t('session.unsavedMessage', { name: currentName })
            : t('session.unsavedMessageUntitled');
        focusBeforeModal = document.activeElement;
        unsavedModal.classList.remove('hidden');
        activateScope(SCOPE.MODAL);
        // Initial focus on Cancel: the safe, non-committing choice.
        unsavedCancelBtn.focus();
        document.addEventListener('keydown', trapModalFocus, true);
    }

    function hideModal() {
        unsavedModal.classList.add('hidden');
        deactivateScope(SCOPE.MODAL);
        document.removeEventListener('keydown', trapModalFocus, true);
        if (focusBeforeModal && typeof focusBeforeModal.focus === 'function') {
            focusBeforeModal.focus();
        }
        focusBeforeModal = null;
    }

    registerShortcut({
        id: 'modal-escape', key: 'Escape', scope: SCOPE.MODAL, preventDefault: false,
        run: () => hideModal(),
    });

    const isModalOpen = () => !unsavedModal.classList.contains('hidden');

    // Destroys the projection mirror, then closes the main window. The
    // mirror is bypassed directly (its close-requested handler would
    // needlessly report back to a dying window).
    async function proceedWithClose() {
        allowClose = true;
        hideModal();
        await closeProjection();
        try {
            await getCurrentWindow().close();
        } catch (err) {
            console.error('Error while closing the main window:', err);
        }
    }

    // ---- Delegated dirty tracking ----
    function markDirtyFromInputEvent(e) {
        if (suppress) return;
        const target = e.target;
        if (!(target instanceof Element)) return;
        // The tempo is part of the session, though its field lives inside
        // the (otherwise excluded) metronome area
        if (target === getMetronomeInput()) {
            markDirty();
            return;
        }
        if (target.closest(NON_SAVED_CONTAINERS)) return;
        if (target.closest(SAVED_CONTROL_CONTAINERS)) markDirty();
    }
    document.addEventListener('input', markDirtyFromInputEvent, true);
    document.addEventListener('change', markDirtyFromInputEvent, true);

    document.addEventListener('click', (e) => {
        if (suppress) return;
        if (!(e.target instanceof Element)) return;
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.closest(NON_SAVED_CONTAINERS)) {
            // The BPM steppers of the metronome area do change saved state
            if (btn.classList.contains('bpm-step') || btn.classList.contains('bpm-spinner-btn')) {
                markDirty();
            }
            return;
        }
        if (btn.closest('.synth-block') && !btn.closest(NON_SAVED_SYNTH_BUTTONS)) {
            markDirty();
        }
    }, true);

    // ---- Unsaved-changes modal ----
    unsavedSaveBtn.addEventListener('click', async () => {
        // A canceled Save As (first save) keeps the session open
        if (await saveSession()) await proceedWithClose();
        else hideModal();
    });
    unsavedDiscardBtn.addEventListener('click', () => proceedWithClose());
    unsavedCancelBtn.addEventListener('click', hideModal);

    // ---- Close confirmation ----
    // Closing the main window closes the projection too: without this the
    // app would live on with a mirror whose source of events is gone. A
    // session with unsaved changes first asks for a decision (Save /
    // Discard / Cancel): the mirror is only destroyed once the outcome is
    // settled, so a canceled close leaves the whole setup intact.
    getCurrentWindow().onCloseRequested(async (event) => {
        if (dirty && !allowClose) {
            event.preventDefault();
            showModal();
            return;
        }
        if (!isProjectionOpen()) return;
        await closeProjection();
        // No preventDefault: the main window then closes normally
    });

    return {
        markDirty,
        setDirty,
        setPath,
        refreshTitle,
        getPath: () => currentPath,
        isDirty: () => dirty,
        beginRestore: () => { suppress = true; },
        endRestore: () => { suppress = false; },
        isModalOpen,
        showModal,
        hideModal,
    };
}

// Session file naming: the display name shown in the title bar and the
// unsaved-changes dialog. Pure, no DOM.

// Extracts the display name of a session from its file path: the file
// base name without the .wysiwyl (or legacy .soundmap) extension.
export function sessionNameFromPath(path) {
    const base = path.split(/[\\/]/).pop() || '';
    return base.replace(/\.(wysiwyl|soundmap)$/i, '') || base;
}
