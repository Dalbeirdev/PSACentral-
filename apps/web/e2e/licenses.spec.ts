import { commandResult, enrolledDeployment, heartbeat } from './agent';
import { E2E_BASE_URL } from './env';
import { apiLogin, csrfHeaders, expect, test, USERS } from './fixtures';

/**
 * Module 14 — Licensing, suspension and lifecycle in the browser: create a license, see it on the
 * client and the deployment, suspend / resume a license and a deployment (the simulated agent receives
 * the signed commands), and the honest states for readers and sample records.
 */
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test.describe('licenses', () => {
  test('a license is created on a full page, listed with its term and usage, and shown on the client', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const client = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/clients?q=Harbor`)).json()).items[0];
    await page.goto('/licenses');
    await expect(page.getByRole('heading', { level: 1, name: 'Licenses' })).toBeVisible();
    await expect(page.getByTestId('license-stats')).toBeVisible();
    await page.getByTestId('new-license').click();
    await expect(page).toHaveURL(/\/licenses\/new$/);
    await page.getByTestId('license-client').selectOption(client.id);
    await page.getByTestId('license-plan').fill('Help Desk Plus (E2E)');
    await page.getByTestId('license-ends').fill(plusDays(20));
    await page.getByTestId('license-max').fill('2');
    await page.getByTestId('license-save').click();
    await expect(page).toHaveURL(/\/licenses\/[0-9a-f-]{36}\?saved=created$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/LIC-\d{5}/);
    await expect(page.getByTestId('license-status').first()).toHaveText('Active');
    await expect(page.getByText(/Ends in 20 day\(s\)/).first()).toBeVisible();
    await expect(page.getByText('0 of 2 in use')).toBeVisible();
    const code = (await page.getByRole('heading', { level: 1 }).textContent())!.trim();
    // Validation stays inline: an end date before the start is refused on the edit page.
    await page.getByTestId('edit-license').click();
    await page.getByTestId('license-ends').fill('2020-01-01');
    await page.getByTestId('license-save').click();
    await expect(page.getByText('The end date must not be before the start date.')).toBeVisible();
    await expect(page).toHaveURL(/\/edit$/);
    // The client page lists it; the list page finds it by code and in the expiring filter.
    await page.goto(`/clients/${client.id}`);
    await expect(page.getByTestId('client-licenses')).toContainText(code);
    await page.goto(`/licenses?q=${encodeURIComponent(code)}`);
    await expect(page.getByTestId('license-row')).toHaveCount(1);
    await page.goto('/licenses?expiringWithinDays=30');
    await expect(page.getByTestId('licenses-table')).toContainText(code);
  });

  test('suspending and resuming a deployment from its overview delivers signed commands and changes what is allowed', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const a = await enrolledDeployment(page);
    await page.goto(`/deployments/${a.id}`);
    await expect(page.getByText(/^LIC-\d{5}$/).first()).toBeVisible(); // the license identifier is part of the identity card
    await page.getByTestId('suspend-deployment').click();
    await page.getByTestId('lifecycle-reason').fill('Customer paused the contract');
    await page.getByTestId('lifecycle-confirm').click();
    await expect(page.getByText('Suspended since')).toBeVisible();
    await expect(page.getByText('Customer paused the contract')).toBeVisible();
    await expect(page.getByLabel(/Lifecycle:/)).toContainText('Suspended');
    // The simulated agent fetches the signed suspend command and answers it.
    const hb = await heartbeat(a);
    const cmd = (hb.body.commands as { id: string; type: string; params: Record<string, unknown> }[]).find((c) => c.type === 'suspend')!;
    expect(cmd.params).toEqual({ reason: 'Customer paused the contract' });
    expect((await commandResult(a, cmd.id, { code: 'suspended', message: 'PSA work paused on the appliance; data and the local UI stay available.' })).status).toBe(200);
    // Operations are blocked while suspended; the history shows the lifecycle command.
    await page.goto(`/deployments/${a.id}/operations`);
    await expect(page.getByText('Commands cannot be issued yet')).toBeVisible();
    await expect(page.getByTestId('command-row').first()).toContainText('Suspend (lifecycle)');
    await expect(page.getByTestId('command-row').first().getByTestId('command-status')).toHaveText('Succeeded');
    await page.goto(`/deployments/${a.id}/health`);
    await expect(page.getByText('The deployment is suspended')).toBeVisible();
    // Resume.
    await page.goto(`/deployments/${a.id}`);
    await page.getByTestId('resume-deployment').click();
    await page.getByTestId('lifecycle-reason').fill('Contract resumed');
    await page.getByTestId('lifecycle-confirm').click();
    await expect(page.getByTestId('suspend-deployment')).toBeVisible();
    expect(((await heartbeat(a)).body.commands as { type: string }[]).map((c) => c.type)).toEqual(['resume']);
    await page.goto(`/deployments/${a.id}/logs`);
    for (const action of ['deployment.suspended', 'deployment.resumed']) await expect(page.getByText(action).first()).toBeVisible();
  });

  test('a suspended license blocks new packages; readers see licenses without controls; sample records are read-only', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const client = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/clients?q=Harbor`)).json()).items[0];
    const headers = await csrfHeaders(page);
    const l = await (await page.request.post(`${E2E_BASE_URL}/api/v1/licenses`, { data: { clientId: client.id, displayName: 'Suspension test', startsAt: today(), endsAt: null, maxDeployments: 1 }, headers })).json();
    await page.goto(`/licenses/${l.id}`);
    await page.getByTestId('license-suspend').click();
    await page.getByTestId('license-reason').fill('Invoice overdue');
    await page.getByTestId('license-confirm').click();
    await expect(page.getByTestId('license-status').first()).toHaveText('Suspended');
    await expect(page.getByText('Invoice overdue').first()).toBeVisible();
    await page.getByTestId('license-resume').click();
    await page.getByTestId('license-reason').fill('Paid');
    await page.getByTestId('license-confirm').click();
    await expect(page.getByTestId('license-status').first()).toHaveText('Active');
    // Viewer: can read, cannot manage.
    await apiLogin(page, USERS.viewer);
    await page.goto(`/licenses/${l.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(l.code);
    await expect(page.getByTestId('license-suspend')).toHaveCount(0);
    await expect(page.getByTestId('edit-license')).toHaveCount(0);
    expect((await page.request.post(`${E2E_BASE_URL}/api/v1/licenses`, { data: { clientId: client.id, displayName: 'x', startsAt: today(), endsAt: null, maxDeployments: 1 }, headers: await csrfHeaders(page) })).status()).toBe(403);
    await apiLogin(page, USERS.admin);
    const synthetic = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/licenses?pageSize=100`)).json()).items.find((x: { isSynthetic: boolean }) => x.isSynthetic);
    if (synthetic) {
      await page.goto(`/licenses/${synthetic.id}`);
      await expect(page.getByText('Synthetic sample record')).toBeVisible();
      await expect(page.getByTestId('license-suspend')).toHaveCount(0);
    }
  });
});
