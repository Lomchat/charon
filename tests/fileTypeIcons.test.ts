import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FILE_TYPES, fileType } from '../app/fileTypeIcons';
import { isFileIconStyle, resolveFileIcons, DEFAULT_FILE_ICONS } from '../app/fileIconStyle';
import { SETTINGS_WRITE_ALLOWLIST } from '../lib/server/hub/settingsKeys';

// The glyph a file gets in the `colored` / `mono` styles (`app.file_icons`).

describe('fileType', () => {
  it('a whole NAME beats the extension', () => {
    expect(fileType('package.json')).toBe('npm');
    expect(fileType('package-lock.json')).toBe('lock');
    expect(fileType('pnpm-lock.yaml')).toBe('lock');
    expect(fileType('Dockerfile')).toBe('docker');
    expect(fileType('docker-compose.yml')).toBe('docker');
    expect(fileType('Makefile')).toBe('build');
    expect(fileType('.gitignore')).toBe('git');
  });

  it('agent instructions, readmes and licences are roles of their own', () => {
    expect(fileType('CLAUDE.md')).toBe('agent');
    expect(fileType('AGENTS.md')).toBe('agent');
    expect(fileType('README.md')).toBe('readme');
    expect(fileType('readme')).toBe('readme');
    expect(fileType('LICENSE')).toBe('license');
    expect(fileType('notes.md')).toBe('md');
  });

  it('a test is a test before it is its language', () => {
    expect(fileType('auth.test.ts')).toBe('test');
    expect(fileType('auth.spec.tsx')).toBe('test');
    expect(fileType('test_git.py')).toBe('test');
    expect(fileType('server_test.go')).toBe('test');
    expect(fileType('attest.ts')).toBe('ts');
  });

  it('secrets and variants', () => {
    expect(fileType('.env')).toBe('env');
    expect(fileType('.env.local')).toBe('env');
    expect(fileType('prod.env')).toBe('env');
    expect(fileType('Dockerfile.dev')).toBe('docker');
    expect(fileType('tsconfig.build.json')).toBe('config');
  });

  it('languages by extension, case-insensitive', () => {
    expect(fileType('App.TSX')).toBe('ts');
    expect(fileType('main.py')).toBe('py');
    expect(fileType('lib.rs')).toBe('rs');
    expect(fileType('index.mjs')).toBe('js');
    expect(fileType('a.hpp')).toBe('cpp');
    expect(fileType('deploy.sh')).toBe('shell');
    expect(fileType('logo.svg')).toBe('image');
    expect(fileType('build.tar')).toBe('archive');
  });

  it('unknown stays generic, dotfiles without an extension too', () => {
    expect(fileType('notes')).toBe('file');
    expect(fileType('.bashrc')).toBe('file');
    expect(fileType('data.xyz')).toBe('file');
    expect(fileType('script.pl')).toBe('code');
  });

  it('every type has a hue rule or deliberately inherits the muted one', () => {
    // A type added to the set without a CSS line paints in --text-muted —
    // fine for neutral roles, a bug for a language. List the neutral ones.
    const css = readFileSync(path.resolve(__dirname, '../app/app.css'), 'utf8');
    const neutral = new Set(['config', 'lock', 'text', 'font', 'file', 'code']);
    for (const t of FILE_TYPES) {
      if (neutral.has(t)) continue;
      expect(css, `.fi-${t} has no hue`).toMatch(new RegExp(`\\.fi-${t.replace('+', '\\+')}\\b[^{]*\\{|\\.fi-${t}\\s*,`));
    }
  });
});

describe('app.file_icons', () => {
  it('validates and defaults', () => {
    expect(isFileIconStyle('colored')).toBe(true);
    expect(isFileIconStyle('mono')).toBe(true);
    expect(isFileIconStyle('classic')).toBe(true);
    expect(isFileIconStyle('rainbow')).toBe(false);
    expect(resolveFileIcons(undefined)).toBe(DEFAULT_FILE_ICONS);
    expect(resolveFileIcons('nope')).toBe(DEFAULT_FILE_ICONS);
  });

  it('is writable (a key missing from the allow-list is dropped SILENTLY)', () => {
    expect(SETTINGS_WRITE_ALLOWLIST).toContain('app.file_icons');
  });
});
