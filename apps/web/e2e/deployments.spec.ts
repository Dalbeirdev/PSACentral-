import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { apiLogin, csrfHeaders, expect, test, USERS } from './fixtures';
import { E2E_BASE_URL } from './env';

async function clientId(page: Page, q: string) {
  return (await (await page.request.get(`${E2E_BASE_URL}/api/v1/clients?q=${encodeURIComponent(q)}`)).json()).items[0].id as string;
}

/** A fresh draft deployment for a client (through the API), so tests do not depend on each other. */
async function draftDeployment(page: Page, clientQuery = 'Lumen') {
  const id = await clientId(page, clientQuery);
  const psa = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/psa-instances?clientId=${id}&status=active`)).json()).items[0];
  const r = await page.request.post(`${E2E_BASE_URL}/api/v1/deployments`, {
    data: { clientId: id, psaInstanceId: psa.id, targetEnvironment: 'linux_docker', targetOs: 'linux', targetArch: 'amd64', hostLabel: 'e2e-edge' },
    headers: await csrfHeaders(page),
  });
  expect(r.status()).toBe(201);
  return (await r.json()) as { id: string; code: string };
}

test.describe('deployments', () => {
  test('the list filters by lifecycle stage on the server; stage counts come from the API', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const stats = await (await page.request.get(`${E2E_BASE_URL}/api/v1/deployments/stats`)).json();
    await page.goto('/deployments');
    await expect(page.getByRole('heading', { level: 1, name: 'Deployments' })).toBeVisible();
    await expect(page.getByTestId('stage-verified')).toHaveText(String(stats.verified));
    await page.getByRole('navigation', { name: 'Lifecycle stages' }).getByRole('link', { name: /Verified/ }).click();
    await expect(page).toHaveURL(/lifecycle=verified/);
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(Math.min(stats.verified, 20));
    for (const label of await rows.locator('td:nth-child(5)').allTextContents()) expect(label).toContain('Verified');
    await page.goto('/deployments?q=Bluepeak');
    for (const c of await page.locator('table tbody tr td:nth-child(2)').allTextContents()) expect(c).toContain('Bluepeak');
  });

  test('create a deployment for an existing client on a full page, with validation', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const id = await clientId(page, 'Harbor');
    await page.goto(`/clients/${id}/deployments`);
    await page.getByRole('link', { name: 'New deployment' }).click();
    await expect(page).toHaveURL(new RegExp(`/deployments/new\\?clientId=${id}$`));
    await expect(page.getByText(/Harbor/).first()).toBeVisible();
    await expect(page.getByRole('radio').first()).toBeChecked(); // the client's PSA instance is preselected
    await page.getByRole('button', { name: 'Create deployment' }).click();
    await expect(page.getByText('Choose where the appliance will run.')).toBeVisible();
    await page.getByText('Windows Docker host', { exact: true }).click();
    await expect(page.getByLabel('Host operating system')).toHaveValue('windows');
    await expect(page.getByLabel('Host operating system')).toBeDisabled();
    await page.getByLabel('Host label').fill('bad;label');
    await page.getByRole('button', { name: 'Create deployment' }).click();
    await expect(page.getByText('Use letters, numbers, spaces and . _ - only.')).toBeVisible();
    await page.getByLabel('Host label').fill('harbor-win-01');
    await page.getByRole('button', { name: 'Create deployment' }).click();
    await expect(page).toHaveURL(/\/deployments\/[0-9a-f-]{36}\?saved=created$/);
    await expect(page.getByText(/^Deployment DEP-\d{5} created\.$/)).toBeVisible();
    await expect(page.getByRole('listitem', { name: 'Package generated: not yet' })).toBeVisible();
    await expect(page.getByText(/A download is not an installation/)).toBeVisible();
  });

  test('installation: generate, download (SHA-256 verified), replace, revoke — all inline', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const dep = await draftDeployment(page);
    await page.goto(`/deployments/${dep.id}/installation`);
    await expect(page.getByText('Ready', { exact: true })).toBeVisible();
    await page.getByLabel('Enrollment token valid for').selectOption('4');
    await page.getByRole('button', { name: 'Generate deployment package' }).click();
    await expect(page.getByText('Package #1 generated.')).toBeVisible();
    const card = page.getByTestId('current-package');
    await expect(card).toContainText('Token valid');
    await expect(card).toContainText('Not downloaded yet');

    const sha = (await page.getByTestId('package-sha256').textContent())!.trim();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download package' }).click()]);
    const zip = readFileSync((await download.path())!);
    expect(createHash('sha256').update(zip).digest('hex')).toBe(sha);
    const files = Object.keys(unzipSync(new Uint8Array(zip)));
    const root = `psacc-${dep.code.toLowerCase()}/`;
    for (const f of ['compose.yaml', 'compose.production.yaml', 'config/edge.json', 'enrollment/enrollment.json', 'scripts/install.sh', 'scripts/verify.ps1', 'scripts/upgrade.sh', 'scripts/uninstall.sh', 'scripts/uninstall.ps1', 'INSTALL.md', 'UNINSTALL.md', 'CHECKSUMS.sha256']) {
      expect(files).toContain(root + f);
    }
    await expect(card).toContainText('1 · last');
    await expect(page.getByRole('main').getByLabel(/Lifecycle: Package downloaded/)).toBeVisible();

    // Settings are locked while a package exists.
    await page.getByRole('navigation', { name: 'Deployment sections' }).getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByText('Settings are locked')).toBeVisible();
    await page.getByRole('link', { name: 'revoke the package' }).click();

    // Replace: inline confirmation, the old package is superseded.
    await page.getByRole('button', { name: 'Generate a new package' }).click();
    await expect(page.getByRole('group', { name: 'Replace package' })).toContainText('Generate a new package and replace #1?');
    await page.getByRole('button', { name: 'Yes, replace' }).click();
    await expect(page.getByText('Package #2 generated.')).toBeVisible();
    const history = page.locator('table').last();
    await expect(history.locator('tr').filter({ hasText: '#1' })).toContainText('Replaced');
    await expect(history.locator('tr').filter({ hasText: '#1' })).toContainText('Token revoked');

    // Revoke: a reason is required.
    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Yes, revoke' }).click();
    await expect(page.getByText('Give a reason (at least 3 characters).')).toBeVisible();
    await page.getByLabel('Reason').fill('E2E: package sent to the wrong place');
    await page.getByRole('button', { name: 'Yes, revoke' }).click();
    await expect(page.getByText('Package #2 revoked.')).toBeVisible();
    await expect(page.getByText('No usable package')).toBeVisible();
    await expect(history.locator('tr').filter({ hasText: '#2' })).toContainText('E2E: package sent to the wrong place');

    // Back to draft: settings can be changed again.
    await page.getByRole('navigation', { name: 'Deployment sections' }).getByRole('link', { name: 'Settings' }).click();
    await page.getByLabel('CPU architecture').selectOption('arm64');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved and recorded in the activity history.')).toBeVisible();
    await expect(page.getByText('deployment.updated')).toBeVisible();
    await expect(page.getByText('deployment.package.revoked · package #2')).toBeVisible();
  });

  test('read-only users see packages without any write control; synthetic records cannot get packages', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const dep = await draftDeployment(page);
    await page.request.post(`${E2E_BASE_URL}/api/v1/deployments/${dep.id}/packages`, { data: { tokenValidityHours: 1 }, headers: await csrfHeaders(page) });
    await page.context().clearCookies();
    await apiLogin(page, USERS.viewer);
    await page.goto(`/deployments/${dep.id}/installation`);
    await expect(page.getByTestId('current-package')).toContainText('Ready to download');
    await expect(page.getByRole('button', { name: /Download package|Revoke|Generate/ })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Deployment sections' }).getByRole('link', { name: 'Settings' })).toHaveCount(0);
    expect((await page.goto('/deployments/new'))!.status()).toBe(404);
    expect((await page.goto(`/deployments/${dep.id}/settings`))!.status()).toBe(404);

    await page.context().clearCookies();
    await apiLogin(page, USERS.ops);
    const synthetic = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/deployments?q=DEP-00002`)).json()).items[0];
    await page.goto(`/deployments/${synthetic.id}/installation`);
    await expect(page.getByText('Synthetic sample record').first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Readiness checks' }).getByRole('listitem').filter({ hasText: 'Real deployment record' })).toContainText('Synthetic sample records cannot receive real packages.');
    await expect(page.getByRole('button', { name: 'Generate deployment package' })).toBeDisabled();
    await page.goto(`/deployments/${synthetic.id}/health`);
    await expect(page.getByText('Planned · Module 8')).toBeVisible();
    await expect(page.getByText('No reports received')).toBeVisible();
  });

  test('deployment pages have no serious accessibility violations', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const dep = await draftDeployment(page);
    await page.request.post(`${E2E_BASE_URL}/api/v1/deployments/${dep.id}/packages`, { data: { tokenValidityHours: 1 }, headers: await csrfHeaders(page) });
    for (const sub of ['', '/installation', '/health', '/database', '/logs', '/settings']) {
      await page.goto(`/deployments/${dep.id}${sub}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.target}`), sub || 'overview').toEqual([]);
    }
  });
});
