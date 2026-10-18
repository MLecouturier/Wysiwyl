// Projection effect controls of the main window: the dropdown listing
// the mirror's masking effects and the options panel of the active
// effect, both built from the shared registry (mirror/effects.js).
// The canonical effect state lives in the mirror factory (window.js);
// this module only renders it and reports user changes through the
// injected callbacks — a session restore updates the state on the
// factory, then calls sync() to rebuild the widgets. Effects that
// target the synths' playhead cursors (synthFilter) also get a row of
// colored toggles on top of the panel selecting which synths the effect
// applies to; the selection lives in the shared synthEffectExcluded set
// (core/state.js).

import { t } from '../core/i18n.js';
import { EFFECTS, effectOrDefault } from './effects.js';
import { registerEscape } from '../core/shortcuts.js';
import { synthColors, synthEffectExcluded } from '../core/state.js';
import { synthDisplayName } from '../synth/model.js';

export function createMirrorEffectControls({ getState, onEffectChange, onOptionChange, onSynthToggle }) {
    const select  = document.querySelector('#mirror-effect-select');
    const optsBtn = document.querySelector('#mirror-effect-opts-btn');
    const panel   = document.querySelector('#mirror-effect-panel');

    let open = false; // options panel visibility

    function currentEffect() {
        return effectOrDefault(getState().effect);
    }

    // Rebuilds the dropdown's options with the translated effect names.
    // The labels are set here rather than via data-i18n: the elements
    // are recreated on every locale change anyway.
    function buildSelect() {
        select.textContent = '';
        for (const def of EFFECTS) {
            const option = document.createElement('option');
            option.value = def.id;
            option.textContent = t(def.labelKey);
            select.append(option);
        }
        select.value = currentEffect().id;
    }

    // Rebuilds the options panel of the active effect: the synth
    // selection row on top for effects that target the cursors, then one
    // row per declared option — a checkbox for a boolean option, a
    // label + slider row otherwise, mirroring the image control rows.
    function buildPanel() {
        const def = currentEffect();
        const options = getState().options ?? {};
        panel.textContent = '';

        buildSynthRow(def);

        for (const opt of def.options) {
            const value = options[opt.id] ?? opt.def;

            const label = document.createElement('label');
            label.title = t(opt.helpKey);

            const head = document.createElement('span');
            head.className = 'control-head';
            const name = document.createElement('span');
            name.textContent = t(opt.labelKey);
            head.append(name);

            if (opt.type === 'bool') {
                // Boolean option: the checkbox replaces the value/slider.
                // It travels as 0/1 through the numeric option pipeline.
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.id = `mirror-effect-${opt.id}`;
                box.checked = value >= 0.5;
                box.addEventListener('change', () => onOptionChange?.(opt.id, box.checked ? 1 : 0));
                head.append(box);
                label.append(head);
                panel.append(label);
                continue;
            }

            const valueEl = document.createElement('span');
            valueEl.className = 'control-value';
            valueEl.textContent = String(value);
            head.append(valueEl);

            const input = document.createElement('input');
            input.type = 'range';
            input.id = `mirror-effect-${opt.id}`;
            input.min = opt.min;
            input.max = opt.max;
            input.step = 1;
            input.value = value;

            input.addEventListener('input', () => {
                valueEl.textContent = input.value;
                onOptionChange?.(opt.id, Number(input.value));
            });
            // Double-click resets the option to its default, like the
            // image sliders
            input.addEventListener('dblclick', () => {
                if (Number(input.value) === opt.def) return;
                input.value = opt.def;
                valueEl.textContent = String(opt.def);
                onOptionChange?.(opt.id, opt.def);
            });

            label.append(head, input);
            panel.append(label);
        }
    }

    // Synth selection row of a cursor-targeting effect: one colored
    // toggle per synthesizer, tinted like its card. Pressed (the default)
    // = the effect applies; releasing adds the synth to the shared
    // excluded set. The synth name only shows as a hover tooltip, keeping
    // the row to a minimum footprint. Rebuilt on every sync: main.js
    // emits 'synth-list-changed' on every composition change (add,
    // remove, reorder, renumbering).
    function buildSynthRow(def) {
        if (!def.synthFilter) return;
        const blocks = Array.from(document.querySelectorAll('.synth-list-body .synth-block'));
        if (blocks.length === 0) return;

        const list = document.createElement('div');
        list.className = 'effect-synth-list';

        for (const el of blocks) {
            const sid = Number(el.dataset.synthId);
            const color = synthColors.get(sid) || '#808080';
            const pressed = !synthEffectExcluded.has(sid);

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'effect-synth-toggle';
            btn.title = synthDisplayName(sid);
            btn.setAttribute('aria-pressed', String(pressed));
            btn.style.setProperty('--synth-color', color);
            // Flip the button's own state: the callback updates the shared
            // set and the mirror, but never rebuilds this panel.
            btn.addEventListener('click', () => {
                const next = btn.getAttribute('aria-pressed') !== 'true';
                btn.setAttribute('aria-pressed', String(next));
                onSynthToggle?.(sid, next);
            });

            list.append(btn);
        }

        panel.append(list);
    }

    // The options button only leads somewhere when the active effect
    // declares something to adjust (numeric options, a synth selection
    // row); its active state reflects the open panel.
    function hasPanelContent() {
        const def = currentEffect();
        return def.options.length > 0 || !!def.synthFilter;
    }

    function updateButton() {
        optsBtn.disabled = !hasPanelContent();
        optsBtn.classList.toggle('active', open && hasPanelContent());
    }

    function openPanel() {
        open = true;
        // Rebuild from the canonical state on every open: the checkbox
        // row follows the live synth stack, and a composition change
        // that arrived while the panel was closed must never leave a
        // stale list on screen.
        buildPanel();
        panel.classList.remove('hidden');
        updateButton();
    }

    function closePanel() {
        open = false;
        panel.classList.add('hidden');
        updateButton();
    }

    // Rebuilds every widget from the canonical state: startup, session
    // restore, locale change, effect switch (the options of the new
    // effect replace the previous ones), synth composition change.
    function sync() {
        buildSelect();
        buildPanel();
        if (!hasPanelContent()) closePanel();
        updateButton();
    }

    select.addEventListener('change', () => {
        onEffectChange?.(select.value);
        sync(); // the new effect's options replace the previous ones
    });

    optsBtn.addEventListener('click', () => {
        if (optsBtn.disabled) return;
        open ? closePanel() : openPanel();
    });

    // Escape closes the options panel; priority 50 sits above the
    // interactive modes (crop/transform at 40) — a transient popover
    // goes first.
    registerEscape(50, () => open, closePanel);

    window.addEventListener('locale-changed', sync);

    sync();

    return { sync };
}
