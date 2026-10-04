// ==========================================================================
// Per-synth actions menu + "copy from another synth" dialog
// ==========================================================================
//
// Each synth card carries a "more" button (.synth-toggle-menu) opening a
// small popover with three actions:
//   - save this synth as the default template;
//   - copy another synth's parameters onto this one;
//   - copy another synth's zones onto this one (merge or replace).
//
// The last two open a modal: a dropdown picks the source synthesizer, then
// the action buttons apply it (Merge / Replace / Copy) or cancel. Parameters
// are copied by the backend (the config lives there); zones are copied in
// the frontend (the zone geometry lives here, already tested) and pushed
// through the usual sendSynthZones/sendSynthMuteZones path.
//
// cards.js reaches this module through the `initSynthMenu` hook it calls
// when a card is built, so there is no cards -> menu import (and no cycle).

import { t } from '../core/i18n.js';
import { openModal, closeModal } from '../core/modal.js';
import { registerEscape } from '../core/shortcuts.js';
import { appEvents, synthHighlights } from '../core/state.js';
import { mergeZones } from '../core/geometry.js';
import { synthDisplayName, updateZonesLabel, updateProgramDisplay } from './model.js';
import { applySynthConfig, updateVolumeSharedChannelWarnings } from './cards.js';
import { sendSynthZones, sendSynthMuteZones, redrawAllHighlights } from './selection.js';

// Deferred so importing this module does not touch the Tauri globals.
const invoke = (...args) => window.__TAURI__.core.invoke(...args);

const hasDom = typeof document !== 'undefined';
const els = hasDom ? {
    modal: document.querySelector('#synth-copy-modal'),
    title: document.querySelector('#synth-copy-title'),
    hint: document.querySelector('#synth-copy-hint'),
    source: document.querySelector('#synth-copy-source'),
    merge: document.querySelector('#synth-copy-merge'),
    replace: document.querySelector('#synth-copy-replace'),
    confirm: document.querySelector('#synth-copy-confirm'),
    cancel: document.querySelector('#synth-copy-cancel'),
} : {};

// { kind: 'params' | 'zones', targetEl, targetId } — the action (merge,
// replace, copy) comes from the button the user clicks.
let copyRequest = null;

const synthBlocks = () => Array.from(document.querySelectorAll('.synth-block'));
const cloneZones = zones => zones.map(z => ({
    order: z.order,
    runs: z.runs.map(r => ({ ...r })),
}));

function closeAllMenus() {
    document.querySelectorAll('.synth-menu').forEach(menu => menu.classList.add('hidden'));
}

function closeColorPickers() {
    document.querySelectorAll('.synth-color-picker').forEach(p => p.classList.add('hidden'));
}

// ---- Per-card menu ----

function saveAsTemplate(el) {
    const id = Number(el.dataset.synthId);
    const btn = el.querySelector('.synth-toggle-menu');
    invoke('set_default_synth_from', { id })
        .then(() => {
            btn.classList.add('active');
            setTimeout(() => btn.classList.remove('active'), 800);
        })
        .catch(err => console.error('Error in set_default_synth_from:', err));
}

export function initSynthMenu(el) {
    const btn = el.querySelector('.synth-toggle-menu');
    const menu = el.querySelector('.synth-menu');
    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation(); // the document listener below must not re-close it
        const willOpen = menu.classList.contains('hidden');
        closeAllMenus();
        if (!willOpen) return;
        closeColorPickers();
        // Copying needs at least one other synth to copy from
        const disabled = synthBlocks().length < 2;
        menu.querySelector('.synth-menu-copy-params').disabled = disabled;
        menu.querySelector('.synth-menu-copy-zones').disabled = disabled;
        menu.classList.remove('hidden');
    });

    menu.querySelector('.synth-menu-save-template').addEventListener('click', () => {
        menu.classList.add('hidden');
        saveAsTemplate(el);
    });
    menu.querySelector('.synth-menu-copy-params').addEventListener('click', () => {
        menu.classList.add('hidden');
        openCopyModal('params', el);
    });
    menu.querySelector('.synth-menu-copy-zones').addEventListener('click', () => {
        menu.classList.add('hidden');
        openCopyModal('zones', el);
    });
}

// ---- Copy dialog ----

// Fills the source dropdown with every synth except the target. Returns the
// number of sources offered.
function renderSourceOptions() {
    if (!els.source) return 0;
    els.source.innerHTML = '';
    let count = 0;
    for (const block of synthBlocks()) {
        const id = Number(block.dataset.synthId);
        if (id === copyRequest.targetId) continue;
        const option = document.createElement('option');
        option.value = String(id);
        option.textContent = synthDisplayName(id);
        els.source.appendChild(option);
        count += 1;
    }
    els.source.value = els.source.options[0]?.value ?? '';
    return count;
}

function openCopyModal(kind, targetEl) {
    if (!els.modal) return;
    copyRequest = { kind, targetEl, targetId: Number(targetEl.dataset.synthId) };
    els.title.textContent = t(kind === 'params' ? 'synth.copyParamsTitle' : 'synth.copyZonesTitle');
    els.hint.textContent = t('synth.copyChooseSource');
    // Zones offer Merge/Replace, parameters a single Copy action
    els.merge?.classList.toggle('hidden', kind !== 'zones');
    els.replace?.classList.toggle('hidden', kind !== 'zones');
    els.confirm?.classList.toggle('hidden', kind !== 'params');
    const count = renderSourceOptions();
    els.merge && (els.merge.disabled = count === 0);
    els.replace && (els.replace.disabled = count === 0);
    els.confirm && (els.confirm.disabled = count === 0);
    openModal(els.modal, { initialFocus: els.source, onRequestClose: closeCopyModal });
}

function closeCopyModal() {
    copyRequest = null;
    if (els.modal) closeModal(els.modal);
}

async function applyCopy(action) {
    if (!copyRequest || !els.source) return;
    const sourceId = Number(els.source.value);
    if (!Number.isInteger(sourceId)) return;
    const { targetEl, targetId } = copyRequest;

    if (action === 'params') {
        try {
            const view = await invoke('copy_synth_params', { fromId: sourceId, toId: targetId });
            applySynthConfig(targetEl, view);
            updateProgramDisplay(targetEl);
            updateVolumeSharedChannelWarnings();
        } catch (err) {
            console.error('Error in copy_synth_params:', err);
            return;
        }
    } else {
        const source = synthHighlights.get(sourceId);
        const target = synthHighlights.get(targetId);
        if (!source || !target) return;
        if (action === 'merge') {
            target.zones = mergeZones(target.zones, source.zones);
            target.muteZones = mergeZones(target.muteZones, source.muteZones);
        } else {
            target.zones = cloneZones(source.zones);
            target.muteZones = cloneZones(source.muteZones);
        }
        sendSynthZones(targetId);
        sendSynthMuteZones(targetId);
        updateZonesLabel(targetId);
        redrawAllHighlights();
    }

    appEvents.emit('session-dirty');
    closeCopyModal();
}

// ---- Wiring ----

if (els.modal) {
    els.merge?.addEventListener('click', () => applyCopy('merge'));
    els.replace?.addEventListener('click', () => applyCopy('replace'));
    els.confirm?.addEventListener('click', () => applyCopy('params'));
    els.cancel?.addEventListener('click', closeCopyModal);
}

if (hasDom) {
    // Any click outside a menu closes every open menu (the toggle button
    // stops propagation, so opening one is not immediately closed).
    document.addEventListener('click', closeAllMenus);
}

// Escape closes an open menu, above the color pickers (50) and below the
// modal scope.
registerEscape(60, () => !!document.querySelector('.synth-menu:not(.hidden)'), closeAllMenus);
