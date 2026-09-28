// ==========================================================================
// i18n — minimal internationalization module
// ==========================================================================
//
// To add a new language:
//   1. Create src/i18n/<code>.json using en.json as a template (same keys).
//   2. Add an entry { code: "<code>", file: "<code>.json" } to AVAILABLE_LOCALES.
// That's it — the language selector and detection logic pick it up automatically.

export const AVAILABLE_LOCALES = [
    { code: 'en', file: 'en.json' },
    { code: 'fr', file: 'fr.json' },
];

const FALLBACK_LOCALE = 'en';

let currentLocale = FALLBACK_LOCALE;
let dictionaries = {}; // code -> flattened dictionary { "a.b.c": "value" }

// Flattens a nested object into dot-separated keys: { a: { b: "x" } } -> { "a.b": "x" }
function flatten(obj, prefix = '', out = {}) {
    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flatten(value, fullKey, out);
        } else {
            out[fullKey] = value;
        }
    }
    return out;
}

async function loadDictionary(locale) {
    if (dictionaries[locale]) return dictionaries[locale];
    const entry = AVAILABLE_LOCALES.find(l => l.code === locale);
    if (!entry) return null;
    const res = await fetch(`i18n/${entry.file}`);
    if (!res.ok) return null;
    const json = await res.json();
    const flat = flatten(json);
    dictionaries[locale] = flat;
    return flat;
}

// Picks the best available locale for a given navigator.language value
// (e.g. "fr-FR" matches "fr"), falling back to English if none match.
function resolveSystemLocale() {
    const candidates = (navigator.languages && navigator.languages.length)
        ? navigator.languages
        : [navigator.language];

    for (const candidate of candidates) {
        if (!candidate) continue;
        const short = candidate.slice(0, 2).toLowerCase();
        const match = AVAILABLE_LOCALES.find(l => l.code === short);
        if (match) return match.code;
    }
    return FALLBACK_LOCALE;
}

const STORAGE_KEY = 'wysiwyl.locale';

/// Initializes i18n: loads the stored locale (if any) or detects the system
/// locale, falling back to English, then loads its dictionary (and English
/// as a safety net if a different locale is used, so lookups never fail).
export async function initI18n() {
    const stored = localStorage.getItem(STORAGE_KEY);
    const isValidStored = stored && AVAILABLE_LOCALES.some(l => l.code === stored);
    const locale = isValidStored ? stored : resolveSystemLocale();

    await loadDictionary(FALLBACK_LOCALE); // always available as a safety net
    await setLocale(locale, { persist: false });
}

/// Switches the active locale, loading its dictionary if needed.
export async function setLocale(locale, { persist = true } = {}) {
    const entry = AVAILABLE_LOCALES.find(l => l.code === locale);
    const resolved = entry ? locale : FALLBACK_LOCALE;

    const dict = await loadDictionary(resolved);
    currentLocale = dict ? resolved : FALLBACK_LOCALE;

    if (persist) localStorage.setItem(STORAGE_KEY, currentLocale);
    document.documentElement.lang = currentLocale;

    applyTranslations();
    window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale: currentLocale } }));
}

export function getLocale() {
    return currentLocale;
}

/// Translates a dot-separated key, interpolating {param} placeholders from
/// the params object. Falls back to English, then to the key itself if
/// nothing is found (so a missing translation is still visible/debuggable).
export function t(key, params = {}) {
    const dict = dictionaries[currentLocale] || {};
    const fallbackDict = dictionaries[FALLBACK_LOCALE] || {};
    let template = dict[key] ?? fallbackDict[key] ?? key;

    for (const [paramKey, value] of Object.entries(params)) {
        template = template.replaceAll(`{${paramKey}}`, String(value));
    }
    return template;
}

/// Applies translations to all static elements marked with data-i18n
/// attributes in the current DOM (used for the initial HTML markup).
/// - data-i18n="key"        -> sets textContent
/// - data-i18n-title="key"  -> sets the title attribute
/// - data-i18n-placeholder="key" -> sets the placeholder attribute
export function applyTranslations(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = t(el.dataset.i18nTitle);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    root.querySelectorAll('[data-i18n-alt]').forEach(el => {
        el.alt = t(el.dataset.i18nAlt);
    });
}

/// Translates a structured backend error ({ code, params }) or falls back
/// to a generic message if the shape is unexpected (e.g. a raw string).
export function translateError(error) {
    if (error && typeof error === 'object' && typeof error.code === 'string') {
        return t(`errors.${error.code}`, error.params || {});
    }
    return t('errors.generic', { details: String(error) });
}
