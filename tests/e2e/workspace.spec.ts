import { randomUUID } from 'node:crypto';
import { test as base, expect, request, type Page } from '@playwright/test';

type StorageState = Awaited<ReturnType<Awaited<ReturnType<typeof request.newContext>>['storageState']>>;
const origin = 'http://127.0.0.1:4173';
const test = base.extend<{ runtimeErrors: void }, { workspaceState: StorageState }>({
  workspaceState: [async ({}, use) => {
    const client = await request.newContext({ baseURL: origin });
    const response = await client.post('/api/auth/login', { data: { password: 'browser-test-password' } });
    expect(response.ok()).toBeTruthy();
    await use(await client.storageState());
    await client.dispose();
  }, { scope: 'worker' }],
  storageState: async ({ workspaceState }, use) => use(workspaceState),
  runtimeErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use();
    expect(errors, 'The browser should have no uncaught application errors.').toEqual([]);
  }, { auto: true }],
});

async function navigate(page: Page, name: string) {
  await expect(page.locator('.app-shell')).toBeVisible();
  const open = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await open.isVisible()) await open.click();
  await page.locator('nav').getByRole('button', { name, exact: true }).click();
}

test.describe('sign-in', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('rejects a bad password and keeps the successful session on reload', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Workspace password').fill('incorrect-password');
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Incorrect password');
    await page.getByLabel('Workspace password').fill('browser-test-password');
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.locator('nav').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator('nav').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
    expect((await page.context().cookies()).find(cookie => cookie.name === 'super_system_session')).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Workspace password')).toBeVisible();
    expect((await page.request.get('/api/agents')).status()).toBe(401);
  });
});

test('streams a run, restores its approval after reload, and executes only once', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Chat');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const title = `Approval test ${randomUUID().slice(0, 8)}`;
  await page.getByLabel('Conversation title').fill(title);
  await page.getByRole('button', { name: 'Create conversation', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New conversation' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel('Message your agent')).toBeEnabled();
  const before = await (await page.request.get('/api/test-fixture/stats')).json();
  const prompt = `Save the priorities note ${randomUUID().slice(0, 8)}`;
  await page.getByLabel('Message your agent').fill(prompt);
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
  const streamed = page.waitForResponse(response => response.url().includes('/events?after=') && response.headers()['content-type']?.includes('text/event-stream') === true);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const run = await (await accepted).json();
  await streamed;
  await expect(page.getByText('Your approval is needed', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Message your agent')).toBeDisabled();
  await expect(page.getByText('I can prepare the change.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Your approval is needed', { exact: true })).toBeVisible();
  await expect(page.locator('.tool-event summary')).toContainText('save_note');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('I can prepare the change. Your note is saved.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Message your agent')).toBeEnabled();
  const snapshot = await (await page.request.get(`/api/runs/${run.id}`)).json();
  expect(snapshot.status).toBe('completed');
  expect(snapshot.response).toBe('I can prepare the change. Your note is saved.');
  await page.locator('.tool-event summary').click();
  await expect(page.getByText('Note saved.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('I can prepare the change. Your note is saved.', { exact: true })).toHaveCount(1);
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
  const after = await (await page.request.get('/api/test-fixture/stats')).json();
  expect(after.executions).toBe(before.executions + 1);
});

test('protects a stale memory draft, then saves reviewed changes and records history', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Memory');
  await page.getByRole('button', { name: /Working preferences/ }).click();
  await page.getByRole('button', { name: 'Edit memory', exact: true }).click();
  const draft = `Keep answers concise. Draft ${randomUUID().slice(0, 8)}.`;
  await page.getByLabel('Memory content').fill(draft);
  // A second client changes the same record while this editor keeps its old version.
  const current = (await (await page.request.get('/api/agents/agent-memo/memory')).json()).items[0];
  const external = `Changed in another client ${randomUUID().slice(0, 8)}.`;
  const response = await page.request.patch('/api/agents/agent-memo/memory/memory-profile', { data: { content: external, expectedVersion: current.version } });
  expect(response.ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  const conflict = page.getByRole('dialog', { name: 'This memory has changed' });
  await expect(conflict).toBeVisible();
  await expect(conflict.getByText(external, { exact: true })).toBeVisible();
  await expect(conflict.getByText(draft, { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/agents/agent-memo/memory')).json()).items[0].content).toBe(external);
  await conflict.getByRole('button', { name: 'Use current version as baseline', exact: true }).click();
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.memory-content')).toContainText(draft);
  await page.getByRole('button', { name: 'Revision history', exact: true }).click();
  await page.locator('.revision summary').first().click();
  await expect(page.locator('.revision').first()).toContainText(external);
  await expect(page.locator('.revision').first()).toContainText(draft);
  const history = await (await page.request.get('/api/agents/agent-memo/memory/memory-profile/history')).json();
  expect(history[0]).toMatchObject({ before: external, after: draft });
});

test('creates and deletes a server routine with an explicit timezone', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Routines');
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a routine' });
  const name = `Weekday briefing ${randomUUID().slice(0, 8)}`;
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('What should your agent do?').fill('Review the open tasks and prepare a short briefing.');
  await dialog.getByLabel('Cron expression').fill('0 8 * * 1-5');
  await dialog.getByLabel('Schedule timezone').fill('Europe/Vienna');
  await dialog.getByRole('button', { name: 'Create routine', exact: true }).click();
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card).toContainText('Europe/Vienna');
  await expect(card).toContainText('0 8 * * 1-5');
  await expect(card.getByRole('button', { name: 'Run now', exact: true })).toHaveCount(0);
  const routines = await (await page.request.get('/api/agents/agent-memo/routines')).json();
  expect(routines.find((routine: { name: string }) => routine.name === name)).toMatchObject({ cron: '0 8 * * 1-5', timezone: 'Europe/Vienna' });
  await page.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete this routine?' }).getByRole('button', { name: 'Delete routine', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  expect((await (await page.request.get('/api/agents/agent-memo/routines')).json()).some((routine: { name: string }) => routine.name === name)).toBe(false);
});

test('filters attached files and explains unsupported machine capabilities', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Files');
  await expect(page.getByRole('cell', { name: /Project brief.md/ })).toBeVisible();
  await page.getByLabel('Search loaded files…').fill('Research');
  await expect(page.getByRole('cell', { name: /Research notes.pdf/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /Project brief.md/ })).toHaveCount(0);
  await navigate(page, 'System');
  await expect(page.getByRole('heading', { name: 'Machine status is unavailable' })).toBeVisible();
  await expect(page.getByText('This server does not report machine status.').last()).toBeVisible();
  expect((await page.request.get('/api/machines')).status()).toBe(501);
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
});

test('keeps all navigation usable without document overflow on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  for (const name of ['Home', 'Chat', 'Memory', 'Routines', 'Files', 'System']) {
    await navigate(page, name);
    await expect(page).toHaveURL(new RegExp(`#${name.toLowerCase()}$`));
    await expect(page.locator('#main-content h1')).toBeVisible();
    await expect(page.locator('#main-content .loading-state')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await navigate(page, 'Routines');
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Create a routine' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
});
