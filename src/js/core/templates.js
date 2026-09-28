// ---------- HTML layout templates ----------
// The synth card, tab and note-range layouts live as plain editable
// HTML files under src/templates/, fetched once here at startup and
// cloned per synth by main.js, which then injects what a static file
// can't express (i18n-driven options, palette swatches, colors). The
// contract between these templates and the code is the set of class
// names and data-i18n* attributes they carry — renaming any of them
// breaks the app.

const TEMPLATE_NAMES = ['synth-card', 'synth-tab', 'synth-note-range'];

// Root element each template must carry. Two distinct HTML-serving
// layers inject a <script> into every text/html response: the CLI's
// builtin dev server adds its auto-reload script, and the app's asset
// protocol (used in bundled builds) adds the Tauri API scripts. The
// injected script lands in a phantom <head> ahead of the template's
// own root, so it parses as the fragment's FIRST element — hence the
// querySelector extraction (and cloning) of the root by class below,
// which also guards against wrong content such as the index.html
// fallback both layers serve for unknown paths.
const EXPECTED_ROOTS = {
    'synth-card': '.synth-block',
    'synth-tab': '.synth-tab',
    'synth-note-range': '.synth-note-range',
};

// Map<name, Element> of each template's root element
const cache = new Map();

// Fetches and parses every template; resolves once all are ready. A
// missing template is fatal (no synth UI can be built without it), so
// the error propagates and stops the module.
export async function loadTemplates() {
    await Promise.all(TEMPLATE_NAMES.map(async (name) => {
        const url = new URL(`../../templates/${name}.html`, import.meta.url);
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to load template "${name}" (HTTP ${res.status})`);
        }
        const tpl = document.createElement('template');
        tpl.innerHTML = await res.text();
        const root = tpl.content.querySelector(EXPECTED_ROOTS[name]);
        if (!root) {
            throw new Error(
                `Template "${name}" does not contain its expected root element `
                + `(${EXPECTED_ROOTS[name]}): the served content is not the template file. `
                + `Check that src/templates/${name}.html exists and was included in the app assets.`
            );
        }
        cache.set(name, root);
    }));
}

// Deep clone of a template's root element; the caller owns the
// returned node (mutating it never touches the cached original)
export function getTemplate(name) {
    const root = cache.get(name);
    if (!root) throw new Error(`Template "${name}" is not loaded`);
    return root.cloneNode(true);
}
