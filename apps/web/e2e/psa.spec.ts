import AxeBuilder from '@axe-core/playwright';
import { apiLogin, csrfHeaders, expect, test, USERS } from './fixtures';
import { E2E_BASE_URL } from './env';

test.describe('PSA management', () => {
  test('the instance list filters by provider (tiles and filter form) on the server', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    await page.goto('/psa');
    await expect(page.getByRole('heading', { level: 1, name: 'PSA Management' })).toBeVisible();
    await page.getByRole('link', { name: /^HaloPSA/ }).click();
    await expect(page).toHaveURL(/provider=halopsa/);
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    for (const t of await rows.locator('td:nth-child(3)').allTextContents()) expect(t).toContain('HaloPSA');
    await page.goto('/psa');
    await page.getByLabel('Connection').selectOption('succeeded');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('No PSA instances match these filters')).toBeVisible(); // nothing is "verified" without a real test
  });

  test('create a ConnectWise on-premise instance for a client on a full page, with adapter validation', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const client = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/clients?q=Lumen`)).json()).items[0];
    await page.goto(`/clients/${client.id}/psa`);
    await page.getByRole('link', { name: 'Add PSA instance' }).click();
    await expect(page).toHaveURL(new RegExp(`/psa/new\\?clientId=${client.id}$`));
    await expect(page.getByText('Lumen Pediatrics').first()).toBeVisible(); // client preselected
    await page.getByText('ConnectWise PSA', { exact: true }).click();
    await expect(page.getByLabel('Instance name')).toHaveValue('Lumen Pediatrics — ConnectWise PSA');
    await page.getByLabel('Site').selectOption('onprem');
    await expect(page.getByLabel('Server host name')).toBeVisible(); // conditional field appears
    await page.getByLabel('Company ID').fill('bad id!');
    await page.getByRole('button', { name: 'Create PSA instance' }).click();
    await expect(page.getByText('Use the login company identifier (letters, numbers, - and _).')).toBeVisible();
    await expect(page.getByText('Server host name is required.')).toBeVisible();
    await page.getByLabel('Company ID').fill('lumenpeds');
    await page.getByLabel('Server host name').fill('PSA.Lumen.example');
    await expect(page.getByTestId('endpoint-preview')).toHaveText('https://psa.lumen.example/v4_6_release/apis/3.0');
    await expect(page.getByRole('listitem').filter({ hasText: 'Private key' })).toContainText('secret'); // listed as appliance-side, never an input
    await page.getByRole('button', { name: 'Create PSA instance' }).click();

    await expect(page).toHaveURL(/\/psa\/[0-9a-f-]{36}\?saved=created$/);
    await expect(page.getByText('PSA instance created.')).toBeVisible();
    await expect(page.getByText('Untested').first()).toBeVisible();
    await expect(page.getByText('Pending on appliance').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Test connection/ })).toHaveCount(0); // no control-plane PSA calls
    await expect(page.getByTestId('connection-explainer')).toContainText('never calls the PSA API');
    await expect(page.getByText('https://psa.lumen.example/v4_6_release/apis/3.0')).toBeVisible();
  });

  test('configure: change settings, see the endpoint re-derived, and a stale edit is refused', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const inst = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/psa-instances?provider=autotask&status=active`)).json()).items[0];
    await page.goto(`/psa/${inst.id}`);
    await page.getByRole('link', { name: 'Configure' }).click();
    await expect(page).toHaveURL(new RegExp(`/psa/${inst.id}/configure$`));
    await page.getByLabel('Web services zone').selectOption('webservices12');
    await expect(page.getByTestId('endpoint-preview')).toHaveText('https://webservices12.autotask.net/ATServicesRest');
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText('Configuration saved and recorded in the activity history.')).toBeVisible();
    await expect(page.getByText('webservices12.autotask.net').first()).toBeVisible();
    await expect(page.getByText('psa_instance.updated')).toBeVisible();

    // Two editors: the second save with an old version is refused.
    await page.goto(`/psa/${inst.id}/configure`);
    const fresh = await (await page.request.get(`${E2E_BASE_URL}/api/v1/psa-instances/${inst.id}`)).json();
    await page.request.patch(`${E2E_BASE_URL}/api/v1/psa-instances/${inst.id}`, {
      data: { version: fresh.version, displayName: fresh.displayName, authMethod: fresh.authMethod, config: fresh.config, enabledServiceIds: fresh.enabledServices.map((s: { id: string }) => s.id), status: fresh.status, notes: 'Changed elsewhere' },
      headers: await csrfHeaders(page),
    });
    await page.getByLabel('Notes').fill('My change');
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByText(/changed by someone else/)).toBeVisible();
  });

  test('associate a deployment with another PSA instance of the same client (inline confirmation)', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const instances = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/psa-instances?q=Meridian`)).json()).items as { id: string; providerKey: string }[];
    const sn = instances.find((i) => i.providerKey === 'servicenow')!;
    const cw = instances.find((i) => i.providerKey === 'connectwise')!;
    await page.goto(`/psa/${sn.id}`);
    const row = page.locator('li').filter({ has: page.getByRole('button', { name: 'Use this instance' }) }).first();
    const code = (await row.locator('a').first().textContent())!;
    await row.getByRole('button', { name: 'Use this instance' }).click();
    await page.getByRole('button', { name: 'Yes, move' }).click();
    await expect(page.locator('li').filter({ hasText: code }).getByText('Uses this instance')).toBeVisible();
    // Restore for other tests.
    const dep = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/psa-instances/${sn.id}`)).json()).deployments.find((d: { code: string }) => d.code === code);
    await page.request.put(`${E2E_BASE_URL}/api/v1/deployments/${dep.id}/psa-instance`, { data: { psaInstanceId: cw.id }, headers: await csrfHeaders(page) });
  });

  test('read-only users see PSA details without any write controls', async ({ page }) => {
    await apiLogin(page, USERS.viewer);
    await page.goto('/psa');
    await expect(page.getByRole('link', { name: 'New PSA instance' })).toHaveCount(0);
    await page.locator('table tbody tr a').first().click();
    await expect(page.getByRole('link', { name: 'Configure' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use this instance' })).toHaveCount(0);
    expect((await page.goto('/psa/new'))!.status()).toBe(404);
  });

  test('PSA detail and configure pages have no serious accessibility violations', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const inst = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/psa-instances?q=PSA-00002`)).json()).items[0];
    for (const path of [`/psa/${inst.id}`, `/psa/${inst.id}/configure`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id), path).toEqual([]);
    }
  });
});
