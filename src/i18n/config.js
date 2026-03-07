/**
 * i18n Configuration
 *
 * Configures i18next for internationalization support.
 * Features:
 * - Lazy-loading of non-default language bundles
 * - Language detection from localStorage
 * - Fallback to zh-CN for missing translations
 * - Development mode warnings for missing keys
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
// eslint-disable-next-line import-x/order
import LanguageDetector from 'i18next-browser-languagedetector';

// Only import the default language (zh-CN) statically - others loaded on demand
import zhCommon from './locales/zh-CN/common.json';
import zhSettings from './locales/zh-CN/settings.json';
import zhAuth from './locales/zh-CN/auth.json';
import zhSidebar from './locales/zh-CN/sidebar.json';
import zhChat from './locales/zh-CN/chat.json';
// eslint-disable-next-line import-x/order
import zhCodeEditor from './locales/zh-CN/codeEditor.json';

// Import supported languages configuration
import { languages } from './languages.js';

// Lazy-load language bundles
const languageLoaders = {
  en: () => Promise.all([
    import('./locales/en/common.json'),
    import('./locales/en/settings.json'),
    import('./locales/en/auth.json'),
    import('./locales/en/sidebar.json'),
    import('./locales/en/chat.json'),
    import('./locales/en/codeEditor.json'),
    import('./locales/en/tasks.json'),
  ]).then(([common, settings, auth, sidebar, chat, codeEditor, tasks]) => ({
    common: common.default, settings: settings.default, auth: auth.default,
    sidebar: sidebar.default, chat: chat.default, codeEditor: codeEditor.default, tasks: tasks.default,
  })),
  ko: () => Promise.all([
    import('./locales/ko/common.json'),
    import('./locales/ko/settings.json'),
    import('./locales/ko/auth.json'),
    import('./locales/ko/sidebar.json'),
    import('./locales/ko/chat.json'),
    import('./locales/ko/codeEditor.json'),
  ]).then(([common, settings, auth, sidebar, chat, codeEditor]) => ({
    common: common.default, settings: settings.default, auth: auth.default,
    sidebar: sidebar.default, chat: chat.default, codeEditor: codeEditor.default,
  })),
  ja: () => Promise.all([
    import('./locales/ja/common.json'),
    import('./locales/ja/settings.json'),
    import('./locales/ja/auth.json'),
    import('./locales/ja/sidebar.json'),
    import('./locales/ja/chat.json'),
    import('./locales/ja/codeEditor.json'),
    import('./locales/ja/tasks.json'),
  ]).then(([common, settings, auth, sidebar, chat, codeEditor, tasks]) => ({
    common: common.default, settings: settings.default, auth: auth.default,
    sidebar: sidebar.default, chat: chat.default, codeEditor: codeEditor.default, tasks: tasks.default,
  })),
};

// Get saved language preference from localStorage
const getSavedLanguage = () => {
  try {
    const saved = localStorage.getItem('userLanguage');
    // Validate that the saved language is supported
    if (saved && languages.some(lang => lang.value === saved)) {
      return saved;
    }
    return 'zh-CN';
  } catch {
    return 'zh-CN';
  }
};

const savedLng = getSavedLanguage();

// Initialize i18next
i18n
  .use(LanguageDetector) // Detect user language
  .use(initReactI18next) // Pass i18n instance to react-i18next
  .init({
    // Only bundle default language; others loaded on demand
    partialBundledLanguages: true,
    resources: {
      'zh-CN': {
        common: zhCommon,
        settings: zhSettings,
        auth: zhAuth,
        sidebar: zhSidebar,
        chat: zhChat,
        codeEditor: zhCodeEditor,
      },
    },

    // Always start with zh-CN to avoid flicker; switch after bundle loads
    lng: 'zh-CN',

    // Fallback language when a translation is missing
    fallbackLng: 'zh-CN',

    // Enable debug mode in development (logs missing keys to console)
    debug: import.meta.env.DEV,

    // Namespaces - load only what's needed
    ns: ['common', 'settings', 'auth', 'sidebar', 'chat', 'codeEditor', 'tasks'],
    defaultNS: 'common',

    // Key separator for nested keys (default: '.')
    keySeparator: '.',

    // Namespace separator (default: ':')
    nsSeparator: ':',

    // Save missing translations (disabled - requires manual review)
    saveMissing: false,

    // Interpolation settings
    interpolation: {
      escapeValue: false, // React already escapes values
    },

    // React-specific settings
    react: {
      useSuspense: true, // Use Suspense for lazy-loading
      bindI18n: 'languageChanged', // Re-render on language change
      bindI18nStore: false, // Don't re-render on resource changes
    },

    // Detection options
    detection: {
      // Order of language detection (local storage first)
      order: ['localStorage'],

      // Keys to look for in localStorage
      lookupLocalStorage: 'userLanguage',

      // Cache user language
      caches: ['localStorage'],
    },
  });

// Load non-default language on startup if needed
export const loadLanguageBundle = async (lng) => {
  if (lng === 'zh-CN' || !languageLoaders[lng]) return;
  if (i18n.hasResourceBundle(lng, 'common')) return;

  try {
    const bundles = await languageLoaders[lng]();
    for (const [ns, data] of Object.entries(bundles)) {
      i18n.addResourceBundle(lng, ns, data, true, true);
    }
  } catch (error) {
    console.error(`Failed to load language bundle for ${lng}:`, error);
  }
};

// Load saved language if it's not the default
if (savedLng && savedLng !== 'zh-CN') {
  loadLanguageBundle(savedLng).then(() => {
    // Switch only after bundles are loaded — no flicker
    i18n.changeLanguage(savedLng);
  });
}

// Save language preference and lazy-load bundles when language changes
i18n.on('languageChanged', (lng) => {
  try {
    localStorage.setItem('userLanguage', lng);
  } catch (error) {
    console.error('Failed to save language preference:', error);
  }
});

export default i18n;
