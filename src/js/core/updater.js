// ==========================================================================
// Auto-update (GitHub Releases)
// ==========================================================================
//
// Thin wrapper over the two Rust updater commands (see
// src-tauri/src/updater.rs). The footer button (#check-update-btn) runs a
// manual check and, when a newer stable release exists, opens a modal that
// offers to download and install it — the download progress is streamed over
// a Tauri channel. A silent check also runs once at startup; when it finds an
// update, `onUpdateAvailable` lets the host (session.js, through main.js)
// mark the native window title.
//
// The plugin's JavaScript API is not used: everything goes through the app's
// own Rust commands, like the rest of the IPC surface.

import { t, translateError } from './i18n.js';
import { openModal, closeModal } from './modal.js';

/// Integer percentage (0-100) of a download, or `null` while the total size
/// is unknown (some servers omit `Content-Length`). Pure, unit-tested.
export function downloadPercent(downloaded, total) {
    if (!total || total <= 0) return null;
    const percent = Math.floor((downloaded / total) * 100);
    return Math.max(0, Math.min(100, percent));
}

/// Human-readable byte size, binary units. Pure, unit-tested.
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rounded = unit === 0 ? String(value) : value.toFixed(value >= 10 ? 0 : 1);
    return `${rounded} ${units[unit]}`;
}

/// Wires the update UI. `onUpdateAvailable(version | null)` is called after
/// every check so the host can reflect the availability elsewhere (the window
/// title). Runs a silent startup check.
export function initUpdater({ onUpdateAvailable = () => {} } = {}) {
    const { invoke, Channel } = window.__TAURI__.core;

    const btn = document.querySelector('#check-update-btn');
    const modal = document.querySelector('#update-modal');
    if (!btn || !modal) return;

    const versionsEl = document.querySelector('#update-versions');
    const notesEl = document.querySelector('#update-notes');
    const progressWrap = document.querySelector('#update-progress-wrap');
    const progressBar = document.querySelector('#update-progress');
    const installBtn = document.querySelector('#update-install');
    const laterBtn = document.querySelector('#update-later');

    let pending = null;   // metadata of the update offered in the modal
    let installing = false;
    let downloaded = 0;
    let total = 0;

    function renderProgress() {
        const percent = downloadPercent(downloaded, total);
        // Without a known total, fall back to a full bar and a plain label.
        progressBar.style.width = `${percent === null ? 100 : percent}%`;
        installBtn.textContent = percent === null
            ? t('update.installing')
            : t('update.installingPercent', { percent });
    }

    function resetProgress() {
        downloaded = 0;
        total = 0;
        progressBar.style.width = '0';
        progressWrap.classList.add('hidden');
        installBtn.disabled = false;
        laterBtn.disabled = false;
        installBtn.textContent = t('update.install');
    }

    function open(meta) {
        pending = meta;
        installing = false;
        versionsEl.textContent = t('update.versions', {
            current: meta.currentVersion,
            next: meta.version,
        });
        notesEl.textContent = meta.notes || '';
        notesEl.classList.toggle('hidden', !meta.notes);
        resetProgress();
        openModal(modal, { initialFocus: installBtn, onRequestClose: requestClose });
    }

    function requestClose() {
        if (installing) return; // an install is in flight: keep the modal open
        closeModal(modal);
    }

    const setBadge = (on) => btn.classList.toggle('has-update', on);

    // Transient green confirmation (same pattern as the config button): the
    // manual check found nothing to install.
    function flashUpToDate() {
        btn.classList.add('config-reloaded');
        setTimeout(() => btn.classList.remove('config-reloaded'), 1000);
    }

    async function runCheck({ manual }) {
        try {
            const meta = await invoke('check_update');
            if (meta) {
                setBadge(true);
                onUpdateAvailable(meta.version);
                if (manual) open(meta);
            } else {
                setBadge(false);
                onUpdateAvailable(null);
                if (manual) flashUpToDate();
            }
        } catch (err) {
            // A silent startup check stays quiet (e.g. no release published
            // yet, or offline): only the manual one reports to the user.
            console.error('Error while checking for updates:', err);
            if (manual) alert(translateError(err));
        }
    }

    async function install() {
        if (!pending || installing) return;
        installing = true;
        installBtn.disabled = true;
        laterBtn.disabled = true;
        progressWrap.classList.remove('hidden');
        renderProgress();

        try {
            const onEvent = new Channel();
            onEvent.onmessage = (message) => {
                if (message.event === 'started') {
                    total = message.data?.contentLength || 0;
                } else if (message.event === 'progress') {
                    downloaded += message.data?.chunkLength || 0;
                }
                renderProgress();
            };

            await invoke('install_update', { onEvent });
            // On success the Rust side relaunches the app: nothing more to do.
        } catch (err) {
            console.error('Error while installing the update:', err);
            installing = false;
            resetProgress();
            alert(translateError(err));
        }
    }

    btn.addEventListener('click', () => runCheck({ manual: true }));
    installBtn.addEventListener('click', install);
    laterBtn.addEventListener('click', requestClose);
    modal.addEventListener('click', (e) => { if (e.target === modal) requestClose(); });

    runCheck({ manual: false });
}
