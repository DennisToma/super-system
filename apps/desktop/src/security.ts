const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** Never accept file URLs, opaque origins, embedded credentials, or remote cleartext. */
export function parseAppUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The workspace URL must be an absolute HTTPS URL.');
  }
  if (url.username || url.password) {
    throw new Error('Use the workspace login screen instead of credentials in its URL.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error('The workspace requires HTTPS. HTTP is allowed only for localhost, 127.0.0.1, or ::1.');
  }
  return url;
}

export function isWorkspaceNavigation(value: string, workspace: URL): boolean {
  try {
    const url = parseAppUrl(value);
    return url.origin === workspace.origin;
  } catch {
    return false;
  }
}

/** Only ordinary web links may be handed to the operating system's browser. */
export function externalWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export const rendererPreferences = {
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
} as const;
