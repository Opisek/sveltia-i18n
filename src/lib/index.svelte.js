import { MessageFormat } from 'messageformat';
import { DraftFunctions } from 'messageformat/functions';
import { SvelteMap, SvelteURLSearchParams } from 'svelte/reactivity';

// Polyfill
Intl.MessageFormat ??= MessageFormat;

/**
 * @typedef {object} Formats
 * @property {Record<string, Intl.NumberFormatOptions>} [number] Custom number format presets.
 * @property {Record<string, Intl.DateTimeFormatOptions>} [date] Custom date format presets.
 * @property {Record<string, Intl.DateTimeFormatOptions>} [time] Custom time format presets.
 */

/**
 * @callback MissingKeyHandler
 * @param {string} key The missing message key.
 * @param {string} locale The active locale.
 * @param {string | undefined} defaultValue The default value passed to `format()`, if any.
 * @returns {string | void} A replacement string, or `undefined` to fall through to the default.
 */

/**
 * @typedef {object} MessageObject
 * @property {string} id Message key.
 * @property {Record<string, any>} [values] Variables to interpolate into the message.
 * @property {string} [locale] Locale override for this call.
 * @property {string} [default] Fallback string if the key is not found.
 */

/**
 * Date/time formatting options, extending `Intl.DateTimeFormatOptions` with `locale` and `format`
 * overrides.
 * @typedef {Intl.DateTimeFormatOptions & { locale?: string, format?: string }} DateFormatOptions
 */

/**
 * Number formatting options, extending `Intl.NumberFormatOptions` with `locale` and `format`
 * overrides.
 * @typedef {Intl.NumberFormatOptions & { locale?: string, format?: string }} NumberFormatOptions
 */

// --- State ---

/** @type {string} */
let _locale = $state('');
/**
 * All registered locales.
 * @type {string[]}
 */
const locales = $state([]);
/**
 * All registered resources.
 * @type {Record<string, Record<string, Intl.MessageFormat>>}
 */
const dictionary = $state({});
/**
 * Whether locale messages are currently being loaded. Returns `true` after a locale is set but
 * before its messages are available.
 * @returns {boolean} `true` if messages are pending for the current locale, `false` otherwise.
 */
const isLoading = () => !!_locale && !dictionary[_locale];

// Languages written right-to-left; used as a fallback when Intl.Locale.textInfo is not available
// (e.g. Firefox).
const RTL_LANGS = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'ha',
  'he',
  'khw',
  'ks',
  'ku',
  'nqo',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);

/**
 * Return the text direction for a resolved `Intl.Locale` object. Uses `textInfo.direction` when
 * available (Chrome/Safari) and falls back to the `RTL_LANGS` set (Firefox).
 * @param {Intl.Locale} localeObj The locale object to inspect.
 * @returns {'ltr' | 'rtl'} The text direction of the locale.
 */
const getTextDirection = (localeObj) => {
  /* v8 ignore next */
  const dir = /** @type {any} */ (localeObj).textInfo?.direction;

  /* v8 ignore next */
  return dir ?? (RTL_LANGS.has(localeObj.language) ? 'rtl' : 'ltr');
};

/**
 * Whether the current locale is written right-to-left. Reactive: re-evaluates whenever the locale
 * changes.
 * @returns {boolean} `true` if the active locale is RTL, `false` otherwise.
 */
const isRTL = () => {
  if (!_locale) return false;

  try {
    return getTextDirection(new Intl.Locale(_locale)) === 'rtl';
  } catch {
    return false;
  }
};

// --- Messages ---

/**
 * Recursively flatten a nested message map into dot-separated keys. `{ field: { name: 'Name' } }` →
 * `{ 'field.name': 'Name' }` Top-level keys that already contain dots are preserved as-is.
 * @param {Record<string, any>} map Nested or flat message map to flatten.
 * @param {string} [prefix] Key prefix for recursive calls.
 * @returns {Record<string, string>} Flat map with dot-separated keys.
 */
const flattenMessages = (map, prefix = '') =>
  Object.entries(map).reduce((acc, [key, value]) => {
    const flatKey = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(acc, flattenMessages(value, flatKey));
    } else {
      acc[flatKey] = value;
    }

    return acc;
  }, /** @type {Record<string, string>} */ ({}));

/**
 * Add new messages for a locale. Accepts flat or nested maps; nested objects are flattened to
 * dot-separated keys (`field.name`). Multiple dicts can be passed and are merged in order, matching
 * svelte-i18n's `addMessages(locale, ...dicts)` signature.
 * @param {string} localeCode Locale.
 * @param {...Record<string, any>} maps One or more message maps (flat or nested).
 * @see https://messageformat.github.io/messageformat/api/messageformat.messageformat/
 */
const addMessages = (localeCode, ...maps) => {
  if (!locales.includes(localeCode)) {
    locales.push(localeCode);
  }

  dictionary[localeCode] ??= {};

  maps.forEach((map) => {
    Object.entries(flattenMessages(map)).forEach(([key, value]) => {
      dictionary[localeCode][key] = new Intl.MessageFormat(localeCode, String(value), {
        functions: DraftFunctions,
      });
    });
  });
};

// --- Loader ---

/** @type {SvelteMap<string, () => Promise<Record<string, string>>>} */
const loaderQueue = new SvelteMap();
/** @type {SvelteMap<string, Promise<void>>} */
const loaderPromises = new SvelteMap();

/**
 * Register an async loader for a locale. The loader is called the first time
 * `waitLocale(localeCode)` is invoked for that locale.
 * @param {string} localeCode Locale.
 * @param {() => Promise<Record<string, string>>} loader Function returning a message map.
 */
const register = (localeCode, loader) => {
  loaderQueue.set(localeCode, loader);
  // Invalidate any cached promise so the new loader is picked up on next waitLocale call.
  loaderPromises.delete(localeCode);

  if (!locales.includes(localeCode)) {
    locales.push(localeCode);
  }
};

/**
 * Execute the registered loader for the given locale (or the current locale if omitted) and wait
 * until the messages are loaded. Subsequent calls for the same locale return the same promise.
 * @param {string} [localeCode] Defaults to `locale.current`.
 * @returns {Promise<void>}
 */
const waitLocale = (localeCode = _locale) => {
  if (!localeCode) return Promise.resolve();

  if (!loaderPromises.has(localeCode)) {
    const loader = loaderQueue.get(localeCode);

    if (loader) {
      const promise = Promise.resolve(loader()).then(
        (map) => {
          addMessages(localeCode, map);
        },
        () => {
          loaderPromises.delete(localeCode);
        },
      );

      loaderPromises.set(localeCode, promise);
    } else {
      loaderPromises.set(localeCode, Promise.resolve());
    }
  }

  /* v8 ignore next */
  return loaderPromises.get(localeCode) ?? Promise.resolve();
};

// --- Locale ---

/**
 * Negotiate the best available locale for a requested tag.
 * 1. Exact match  2. Same language subtag (e.g. En-CA → en-US)  3. Original value.
 * @param {string} requested The requested locale tag.
 * @param {string[]} available List of available locale codes.
 * @returns {string} The best-matching available locale, or `requested` if no match is found.
 */
const negotiateLocale = (requested, available) => {
  if (!requested || !available.length) return requested;
  if (available.includes(requested)) return requested;

  try {
    const lang = new Intl.Locale(requested).language;

    return (
      available.find((l) => {
        try {
          return new Intl.Locale(l).language === lang;
        } catch {
          return false;
        }
      }) ?? requested
    );
  } catch {
    return requested;
  }
};

/**
 * Current locale.
 */
const locale = {
  /**
   * Returns the current locale code.
   * @returns {string} The active locale code.
   */
  get current() {
    return _locale;
  },
  /**
   * Set the current locale. Negotiates against registered locales (e.g. En-CA → en-US), updates
   * `<html lang>` / `<html dir>`, and auto-triggers any registered loader.
   * @param {string} value The locale to set.
   * @returns {Promise<void>}
   */
  set(value) {
    const resolved = locales.length ? negotiateLocale(value, locales) : value;

    _locale = resolved;

    if (typeof document !== 'undefined' && resolved) {
      document.documentElement.lang = resolved;

      try {
        const localeObj = new Intl.Locale(resolved);

        document.documentElement.dir = getTextDirection(localeObj);
      } catch {
        // resolved is not a valid BCP 47 tag; skip dir update
      }
    }

    return waitLocale(resolved);
  },
};

/**
 * Get the user's preferred locale from the browser.
 * @returns {string | undefined} The first navigator language, or `undefined` in non-browser
 * environments.
 */
const getLocaleFromNavigator = () =>
  typeof navigator === 'undefined' ? undefined : (navigator.languages?.[0] ?? navigator.language);

/**
 * Get the locale from a pattern matched against `window.location.hostname`.
 * @param {RegExp} hostnamePattern Pattern with a capture group for the locale code.
 * @returns {string | undefined} The matched locale code, or `undefined` if not in a browser or no
 * match.
 */
const getLocaleFromHostname = (hostnamePattern) =>
  typeof window === 'undefined' || !window.location
    ? undefined
    : window.location.hostname.match(hostnamePattern)?.[1];

/**
 * Get the locale from a pattern matched against `window.location.pathname`.
 * @param {RegExp} pathnamePattern Pattern with a capture group for the locale code.
 * @returns {string | undefined} The matched locale code, or `undefined` if not in a browser or no
 * match.
 */
const getLocaleFromPathname = (pathnamePattern) =>
  typeof window === 'undefined' || !window.location
    ? undefined
    : window.location.pathname.match(pathnamePattern)?.[1];

/**
 * Get the locale from a URL query string parameter.
 * @param {string} queryKey The query string key to read.
 * @returns {string | undefined} The query parameter value, or `undefined` if not in a browser or
 * not found.
 */
const getLocaleFromQueryString = (queryKey) =>
  typeof window === 'undefined' || !window.location
    ? undefined
    : (new SvelteURLSearchParams(window.location.search).get(queryKey) ?? undefined);

/**
 * Get the locale from a `key=value` pair in `window.location.hash`.
 * @param {string} hashKey The key to look for in the hash.
 * @returns {string | undefined} The hash parameter value, or `undefined` if not in a browser or not
 * found.
 */
const getLocaleFromHash = (hashKey) => {
  if (typeof window === 'undefined' || !window.location) return undefined;

  const params = new SvelteURLSearchParams(window.location.hash.replace(/^#/, ''));

  return params.get(hashKey) ?? undefined;
};

// --- Configuration ---

let fallbackLocale = '';
/** @type {MissingKeyHandler | undefined} */
let missingMessageHandler;
/** @type {Formats} */
let customFormats = {};

/**
 * Initialize the locales.
 * @param {object} args Arguments.
 * @param {string} args.fallbackLocale Locale to be used for fallback.
 * @param {string} [args.initialLocale] Locale to be used for the initial selection.
 * @param {Formats} [args.formats] Custom named formats.
 * @param {MissingKeyHandler} [args.handleMissingMessage] Called when a message key is not found.
 * May return a string to use as a fallback.
 */
const init = (args) => {
  fallbackLocale = args.fallbackLocale;
  missingMessageHandler = args.handleMissingMessage;
  customFormats = args.formats ?? {};
  if (args.initialLocale) locale.set(args.initialLocale);
};

// --- Formatting ---

/**
 * Format a message by key.
 *
 * Supports two call signatures (matching svelte-i18n):
 * - `format(id, options?)` — key as first argument
 * - `format({ id, values, locale, default })` — options object only.
 * @param {string | MessageObject} key Message key, or an object with `id` and options.
 * @param {{ values?: Record<string, any>, locale?: string, default?: string }} [options] Formatting
 * options when `key` is a string.
 * @returns {string} The formatted message string.
 */
const format = (key, { values = {}, locale: localeOverride, default: defaultString } = {}) => {
  if (typeof key === 'object') {
    const { id, values: v = {}, locale: l, default: d } = key;

    return format(id, { values: v, locale: l, default: d });
  }

  const active = localeOverride ?? _locale;
  const fallback = fallbackLocale;

  const result =
    dictionary[active]?.[key]?.format(values) ??
    (active !== fallback ? dictionary[fallback]?.[key]?.format(values) : undefined);

  if (result !== undefined) return result;

  if (missingMessageHandler) {
    const handled = missingMessageHandler(key, active, defaultString);

    if (handled !== undefined) return handled;
  }

  return defaultString ?? key;
};

/**
 * Return a nested object of formatted strings for all keys under the given prefix. Equivalent to
 * svelte-i18n's `$json()`. Useful for iterating over a group of messages.
 * @param {string} prefix Key prefix (e.g. `'nav'` matches `nav.home`, `nav.about`, …).
 * @param {{ locale?: string }} [options] Lookup options.
 * @returns {Record<string, string> | undefined} Object mapping suffix keys to formatted strings, or
 * `undefined` if no keys match the prefix.
 */
const json = (prefix, { locale: localeOverride } = {}) => {
  const active = localeOverride ?? _locale;
  const fallback = fallbackLocale;
  const source = dictionary[active] ?? dictionary[fallback] ?? {};
  const pfx = `${prefix}.`;
  const result = /** @type {Record<string, string>} */ ({});

  Object.entries(source).forEach(([key, mf]) => {
    if (key.startsWith(pfx)) {
      result[key.slice(pfx.length)] = mf.format({});
    }
  });

  return Object.keys(result).length ? result : undefined;
};

// --- Date, time & number ---

// Built-in named formats matching svelte-i18n defaults
/** @type {Record<string, Intl.DateTimeFormatOptions>} */
const BUILT_IN_DATE_FORMATS = {
  short: { month: 'numeric', day: 'numeric', year: '2-digit' },
  medium: { month: 'short', day: 'numeric', year: 'numeric' },
  long: { month: 'long', day: 'numeric', year: 'numeric' },
  full: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
};

/** @type {Record<string, Intl.DateTimeFormatOptions>} */
const BUILT_IN_TIME_FORMATS = {
  short: { hour: 'numeric', minute: 'numeric' },
  medium: { hour: 'numeric', minute: 'numeric', second: 'numeric' },
  long: { hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'short' },
  full: { hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'short' },
};

/** @type {Record<string, Intl.NumberFormatOptions>} */
const BUILT_IN_NUMBER_FORMATS = {
  currency: { style: 'currency' },
  percent: { style: 'percent' },
  scientific: { notation: 'scientific' },
  engineering: { notation: 'engineering' },
  compactLong: { notation: 'compact', compactDisplay: 'long' },
  compactShort: { notation: 'compact', compactDisplay: 'short' },
};

/**
 * Format a date value as a localized date string.
 * @param {Date} value The date to format.
 * @param {DateFormatOptions} [options] Formatting options.
 * @returns {string} The formatted date string.
 */
const date = (value, { locale: loc, format: fmt, ...rest } = {}) => {
  const named = fmt ? (customFormats.date?.[fmt] ?? BUILT_IN_DATE_FORMATS[fmt] ?? {}) : {};

  return new Intl.DateTimeFormat(loc ?? _locale, { ...named, ...rest }).format(value);
};

/**
 * Format a date value as a localized time string.
 * @param {Date} value The date to format.
 * @param {DateFormatOptions} [options] Formatting options.
 * @returns {string} The formatted time string.
 */
const time = (value, { locale: loc, format: fmt, ...rest } = {}) => {
  const named = fmt ? (customFormats.time?.[fmt] ?? BUILT_IN_TIME_FORMATS[fmt] ?? {}) : {};

  return new Intl.DateTimeFormat(loc ?? _locale, { ...named, ...rest }).format(value);
};

/**
 * Format a number as a localized string.
 * @param {number} value The number to format.
 * @param {NumberFormatOptions} [options] Formatting options.
 * @returns {string} The formatted number string.
 */
const number = (value, { locale: loc, format: fmt, ...rest } = {}) => {
  const named = fmt ? (customFormats.number?.[fmt] ?? BUILT_IN_NUMBER_FORMATS[fmt] ?? {}) : {};

  return new Intl.NumberFormat(loc ?? _locale, { ...named, ...rest }).format(value);
};

// Export all public API as named exports, and also alias `format` as `_` and `t` for convenience.
// We cannot use `export const` syntax for each symbol because the TypeScript conversion fails to
// export the comments with the functions.
export {
  format as _,
  addMessages,
  date,
  dictionary,
  format,
  getLocaleFromHash,
  getLocaleFromHostname,
  getLocaleFromNavigator,
  getLocaleFromPathname,
  getLocaleFromQueryString,
  init,
  isLoading,
  isRTL,
  json,
  locale,
  locales,
  number,
  register,
  format as t,
  time,
  waitLocale,
};
