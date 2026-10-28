// Parses key chords like "Control+Shift+K" into Chrome DevTools Protocol
// Input.dispatchKeyEvent parameters. Pure; unit tested.

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  location?: number;
}

export interface Chord {
  modifiers: Modifier[];
  key: KeyDef;
  /** CDP modifier bitmask: Alt=1, Control=2, Meta=4, Shift=8. */
  mask: number;
  /** macOS editing commands (CDP `commands`), e.g. Meta+A → selectAll. */
  commands: string[];
}

export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

const MODIFIER_BITS: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export const MODIFIER_KEYS: Record<Modifier, KeyDef> = {
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
};

const NAMED: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const ALIASES: Record<string, string> = {
  ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta', super: 'Meta',
  alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift',
  esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter', tab: 'Tab', space: 'Space', spacebar: 'Space',
  backspace: 'Backspace', del: 'Delete', delete: 'Delete', ins: 'Insert', insert: 'Insert',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', pgup: 'PageUp', pgdn: 'PageDown',
};

const SHIFTED_DIGITS = ')!@#$%^&*(';
const PUNCTUATION: Record<string, [string, number]> = {
  '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221],
  '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188],
  '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192],
};

const MAC_COMMANDS: Record<string, string> = {
  'Meta+a': 'selectAll', 'Meta+c': 'copy', 'Meta+x': 'cut', 'Meta+v': 'paste',
  'Meta+z': 'undo', 'Meta+Shift+z': 'redo',
};

function charKey(ch: string): KeyDef {
  if (/^[a-z]$/i.test(ch)) {
    return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  }
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  const shiftedDigit = SHIFTED_DIGITS.indexOf(ch);
  if (shiftedDigit >= 0) return { key: ch, code: `Digit${shiftedDigit}`, keyCode: 48 + shiftedDigit, text: ch };
  const punct = PUNCTUATION[ch];
  if (punct) return { key: ch, code: punct[0], keyCode: punct[1], text: ch };
  // Anything else (e.g. Bangla letters): no physical key; text only.
  return { key: ch, code: '', keyCode: 0, text: ch };
}

/**
 * "Control+Shift+K", "ctrl+a", "Enter", "Shift+Tab", "ControlOrMeta+A".
 * A trailing "+" means the plus key ("Control++").
 */
export function parseChord(input: string, isMac = false): Chord {
  const raw = input.trim();
  if (!raw) throw new Error('empty key');
  if (raw === '+') return { modifiers: [], key: charKey('+'), mask: 0, commands: [] };
  const parts = raw.endsWith('++') ? [...raw.slice(0, -2).split('+').filter(Boolean), '+'] : raw.split('+');
  if (parts.some((p) => p === '')) throw new Error(`cannot parse key chord "${input}"`);

  const modifiers: Modifier[] = [];
  let main: KeyDef | undefined;
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    const lower = part.toLowerCase();
    const name = lower === 'controlormeta' ? (isMac ? 'Meta' : 'Control') : (ALIASES[lower] ?? part);
    if (!last) {
      if (!(name in MODIFIER_BITS)) throw new Error(`"${part}" is not a modifier (use Control, Alt, Shift or Meta)`);
      if (!modifiers.includes(name as Modifier)) modifiers.push(name as Modifier);
      return;
    }
    if (name in MODIFIER_BITS) {
      main = MODIFIER_KEYS[name as Modifier];
    } else if (NAMED[name]) {
      main = NAMED[name];
    } else if ([...part].length === 1) {
      main = charKey(part);
    } else {
      throw new Error(`unknown key "${part}"`);
    }
  });
  if (!main) throw new Error(`cannot parse key chord "${input}"`);

  const mask = modifiers.reduce((m, mod) => m | MODIFIER_BITS[mod], 0);
  let key = main;
  // Shortcuts with Control/Alt/Meta do not insert text.
  if (modifiers.some((m) => m !== 'Shift') && key.text) key = { ...key, text: undefined };
  // Shift+letter types the upper-case letter.
  if (modifiers.length === 1 && modifiers[0] === 'Shift' && key.text && /^[a-z]$/.test(key.text)) {
    key = { ...key, key: key.text.toUpperCase(), text: key.text.toUpperCase() };
  }
  const commandKey = [...modifiers].sort((a, b) => (a === 'Meta' ? -1 : b === 'Meta' ? 1 : 0)).join('+') + `+${main.key.toLowerCase()}`;
  const commands = isMac && MAC_COMMANDS[commandKey] ? [MAC_COMMANDS[commandKey]!] : [];
  return { modifiers, key, mask, commands };
}
