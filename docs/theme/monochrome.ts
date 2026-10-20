import type { ThemeRegistration } from 'shiki';

/**
 * Grayscale Shiki themes: syntax is told apart by weight, shade and slant, never hue.
 */
function monochrome(
  name: string,
  type: 'light' | 'dark',
  ink: { text: string; strong: string; muted: string; faint: string; bg: string }
): ThemeRegistration {
  return {
    name,
    type,
    colors: { 'editor.background': ink.bg, 'editor.foreground': ink.text },
    settings: [
      { settings: { foreground: ink.text, background: ink.bg } },
      {
        scope: ['comment', 'punctuation.definition.comment'],
        settings: { foreground: ink.faint, fontStyle: 'italic' }
      },
      {
        scope: [
          'keyword',
          'storage',
          'storage.type',
          'storage.modifier',
          'keyword.control',
          'keyword.operator.new',
          'keyword.operator.expression',
          'variable.language'
        ],
        settings: { foreground: ink.strong, fontStyle: 'bold' }
      },
      {
        scope: ['string', 'string.template', 'punctuation.definition.string'],
        settings: { foreground: ink.muted }
      },
      {
        scope: ['constant.numeric', 'constant.language', 'constant.character'],
        settings: { foreground: ink.muted }
      },
      {
        scope: [
          'entity.name.function',
          'support.function',
          'meta.function-call entity.name.function'
        ],
        settings: { foreground: ink.strong }
      },
      {
        scope: [
          'entity.name.type',
          'support.type',
          'entity.name.class',
          'entity.other.inherited-class'
        ],
        settings: { foreground: ink.strong, fontStyle: 'italic' }
      },
      {
        scope: ['entity.name.tag', 'support.class.component'],
        settings: { foreground: ink.strong, fontStyle: 'bold' }
      },
      { scope: ['entity.other.attribute-name'], settings: { foreground: ink.muted } },
      {
        scope: ['punctuation', 'meta.brace', 'keyword.operator'],
        settings: { foreground: ink.muted }
      },
      { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
      { scope: ['markup.italic'], settings: { fontStyle: 'italic' } }
    ]
  };
}

export const monochromeLight = monochrome('monochrome-light', 'light', {
  text: '#0a0a0a',
  strong: '#000000',
  muted: '#5c5c5c',
  faint: '#707070',
  bg: '#fafafa'
});

export const monochromeDark = monochrome('monochrome-dark', 'dark', {
  text: '#ededed',
  strong: '#ffffff',
  muted: '#a3a3a3',
  faint: '#7d7d7d',
  bg: '#050505'
});
