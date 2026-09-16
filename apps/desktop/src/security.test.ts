import { describe, expect, it } from 'vitest';
import { externalWebUrl, isWorkspaceNavigation, parseAppUrl, rendererPreferences } from './security.js';

describe('desktop URL boundary', () => {
  it.each([
    'https://workspace.example.com/',
    'http://127.0.0.1:5173/',
    'http://localhost:3001/chat',
    'http://[::1]:3001/',
  ])('allows a secure or loopback workspace: %s', (url) => {
    expect(parseAppUrl(url).href).toBe(url);
  });

  it.each([
    'http://workspace.example.com',
    'http://192.168.1.10:3001',
    'http://localhost.attacker.example',
    'https://operator:password@workspace.example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hello',
    '//workspace.example.com',
    'not a URL',
  ])('rejects unsafe workspace URLs: %s', (url) => {
    expect(() => parseAppUrl(url)).toThrow();
  });

  it('limits renderer navigation to the exact configured origin', () => {
    const workspace = parseAppUrl('https://workspace.example.com');
    expect(isWorkspaceNavigation('https://workspace.example.com/chat#message', workspace)).toBe(true);
    expect(isWorkspaceNavigation('https://workspace.example.com:444/', workspace)).toBe(false);
    expect(isWorkspaceNavigation('https://workspace.example.com.attacker.example/', workspace)).toBe(false);
    expect(isWorkspaceNavigation('http://workspace.example.com/', workspace)).toBe(false);
    expect(isWorkspaceNavigation('https://user:secret@workspace.example.com/', workspace)).toBe(false);
    expect(isWorkspaceNavigation('file:///tmp/page.html', workspace)).toBe(false);
  });

  it('passes only credential-free HTTP(S) links to the default browser', () => {
    expect(externalWebUrl('https://docs.letta.com/')).toBe('https://docs.letta.com/');
    expect(externalWebUrl('http://example.com/')).toBe('http://example.com/');
    for (const value of ['file:///tmp/a', 'mailto:user@example.com', 'javascript:alert(1)', 'vscode://file/a', 'https://a:b@example.com', 'garbage']) {
      expect(externalWebUrl(value)).toBeNull();
    }
  });

  it('keeps the shared renderer sandboxed without Node or webviews', () => {
    expect(rendererPreferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
  });
});
