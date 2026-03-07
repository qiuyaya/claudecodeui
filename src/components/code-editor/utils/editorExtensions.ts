import { StreamLanguage } from '@codemirror/language';
import { getChunks } from '@codemirror/merge';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { showMinimap } from '@replit/codemirror-minimap';
import type { Extension } from '@codemirror/state';
import type { CodeEditorFile } from '../types/types';

// Lightweight lexer for `.env` files (including `.env.*` variants).
const envLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.match(/^#.*/)) return 'comment';
    if (stream.sol() && stream.match(/^[A-Za-z_][A-Za-z0-9_.]*(?==)/)) return 'variableName.definition';
    if (stream.match(/^=/)) return 'operator';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^\$\{[^}]*\}?/)) return 'variableName.special';
    if (stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/)) return 'variableName.special';
    if (stream.match(/^\d+/)) return 'number';

    stream.next();
    return null;
  },
});

// Cache for dynamically loaded language extensions
const languageCache = new Map<string, Extension[]>();

// Dynamically load language extensions on demand
export const getLanguageExtensions = async (filename: string): Promise<Extension[]> => {
  const lowerName = filename.toLowerCase();
  if (lowerName === '.env' || lowerName.startsWith('.env.')) {
    return [envLanguage];
  }

  const ext = filename.split('.').pop()?.toLowerCase() || '';

  // Return cached if available
  if (languageCache.has(ext)) {
    return languageCache.get(ext)!;
  }

  let extensions: Extension[] = [];

  switch (ext) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      extensions = [javascript({ jsx: true, typescript: ext.includes('ts') })];
      break;
    }
    case 'py': {
      const { python } = await import('@codemirror/lang-python');
      extensions = [python()];
      break;
    }
    case 'html':
    case 'htm': {
      const { html } = await import('@codemirror/lang-html');
      extensions = [html()];
      break;
    }
    case 'css':
    case 'scss':
    case 'less': {
      const { css } = await import('@codemirror/lang-css');
      extensions = [css()];
      break;
    }
    case 'json': {
      const { json } = await import('@codemirror/lang-json');
      extensions = [json()];
      break;
    }
    case 'md':
    case 'markdown': {
      const { markdown } = await import('@codemirror/lang-markdown');
      extensions = [markdown()];
      break;
    }
    case 'env':
      extensions = [envLanguage];
      break;
    default:
      extensions = [];
  }

  // Cache the result
  if (extensions.length > 0) {
    languageCache.set(ext, extensions);
  }

  return extensions;
};

export const createMinimapExtension = ({
  file,
  showDiff,
  minimapEnabled,
  isDarkMode,
}: {
  file: CodeEditorFile;
  showDiff: boolean;
  minimapEnabled: boolean;
  isDarkMode: boolean;
}) => {
  if (!file.diffInfo || !showDiff || !minimapEnabled) {
    return [];
  }

  const gutters: Record<number, string> = {};

  return [
    showMinimap.compute(['doc'], (state) => {
      const chunksData = getChunks(state);
      const chunks = chunksData?.chunks || [];

      Object.keys(gutters).forEach((key) => {
        delete gutters[Number(key)];
      });

      chunks.forEach((chunk) => {
        const fromLine = state.doc.lineAt(chunk.fromB).number;
        const toLine = state.doc.lineAt(Math.min(chunk.toB, state.doc.length)).number;

        for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
          gutters[lineNumber] = isDarkMode ? 'rgba(34, 197, 94, 0.8)' : 'rgba(34, 197, 94, 1)';
        }
      });

      return {
        create: () => ({ dom: document.createElement('div') }),
        displayText: 'blocks',
        showOverlay: 'always',
        gutters: [gutters],
      };
    }),
  ];
};

export const createScrollToFirstChunkExtension = ({
  file,
  showDiff,
}: {
  file: CodeEditorFile;
  showDiff: boolean;
}) => {
  if (!file.diffInfo || !showDiff) {
    return [];
  }

  return [
    ViewPlugin.fromClass(class {
      constructor(view: EditorView) {
        // Wait for merge decorations so the first chunk location is stable.
        setTimeout(() => {
          const chunksData = getChunks(view.state);
          const firstChunk = chunksData?.chunks?.[0];

          if (firstChunk) {
            view.dispatch({
              effects: EditorView.scrollIntoView(firstChunk.fromB, { y: 'center' }),
            });
          }
        }, 100);
      }

      update() {}

      destroy() {}
    }),
  ];
};
