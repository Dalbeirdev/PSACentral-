import { enrolledDeployment, heartbeat } from './agent';
import { E2E_BASE_URL } from './env';
import { apiLogin, csrfHeaders, expect, test, USERS } from './fixtures';

/**
 * Module 15 — Secure decommissioning and deployment removal in the browser: the full-page decommission
 * flow with a typed confirmation, the simulated agent being refused with `decommissioned`, the removal
 * instructions, removal of the record, the retention settings page, and the honest states for readers.
 */
test.describe('decommissioning', () => {
  test('decommission from a full page (reason + typed ID); the agent is refused; removal instructions; remove the record', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const a = await enrolledDeployment(page);
    await page.goto(`/deployments/${a.id}`);
    await page.getByTestId('decommission-link').click();
    await expect(page).toHaveURL(new RegExp(`/deployments/${a.id}/decommission$`));
    await expect(page.getByRole('heading', { name: `Decommission ${a.code}` })).toBeVisible();
    await expect(page.getByText('Nothing is deleted on the host.')).toBeVisible();
    // Inline validation: reason and the exact deployment ID.
    await page.getByTestId('decommission-submit').click();
    await expect(page.getByText('Give a reason (at least 3 characters).')).toBeVisible();
    await page.getByTestId('decommission-reason').fill('Contract ended; site closed');
    await page.getByTestId('decommission-confirm').fill('DEP-00000');
    await page.getByTestId('decommission-submit').click();
    await expect(page.getByText(`Type ${a.code} exactly to confirm.`)).toBeVisible();
    await page.getByTestId('decommission-confirm').fill(a.code);
    await page.getByTestId('decommission-submit').click();
    await expect(page).toHaveURL(new RegExp(`/deployments/${a.id}\\?saved=decommissioned$`));
    await expect(page.getByText(`${a.code} decommissioned.`)).toBeVisible();
    await expect(page.getByLabel(/Lifecycle:/)).toContainText('Decommissioned');
    await expect(page.getByText('Reason: Contract ended; site closed.')).toBeVisible();
    await expect(page.getByText(/Retired: 1 certificate\(s\)/)).toBeVisible();
    await expect(page.getByTestId('removal-instructions')).toContainText(`scripts/uninstall.sh --wipe --confirm ${a.code}`);
    await expect(page.getByTestId('decommission-link')).toHaveCount(0);
    await expect(page.getByTestId('suspend-deployment')).toHaveCount(0);
    // The simulated agent: its certificate is refused with `decommissioned` (410), not `revoked`.
    const hb = await heartbeat(a);
    expect(hb.status).toBe(410);
    expect(hb.body.error).toBe('decommissioned');
    // Operations and health say why; the identity card keeps the history.
    await page.goto(`/deployments/${a.id}/operations`);
    await expect(page.getByText('Commands cannot be issued yet')).toBeVisible();
    await expect(page.getByText('its appliance identity was retired')).toBeVisible();
    await page.goto(`/deployments/${a.id}/health`);
    await expect(page.getByText('The deployment is decommissioned', { exact: true })).toBeVisible();
    await page.goto(`/deployments/${a.id}/logs`);
    await expect(page.getByText('deployment.decommissioned').first()).toBeVisible();
    await expect(page.getByText('agent.certificate.revoked')).toHaveCount(0); // decommissioning is its own event, not a plain revocation
    // The list shows the final state as a stage card and filter.
    await page.goto('/deployments?lifecycle=decommissioned');
    await expect(page.getByTestId('stage-decommissioned')).toBeVisible();
    await expect(page.getByText(a.code).first()).toBeVisible();
    // Remove the record with the typed ID; afterwards it is a real 404.
    await page.goto(`/deployments/${a.id}`);
    await page.getByTestId('remove-deployment').click();
    await page.getByTestId('remove-confirm').fill('DEP-00000');
    await page.getByTestId('remove-submit').click();
    await expect(page.getByText(`Type ${a.code} exactly to confirm.`)).toBeVisible();
    await page.getByTestId('remove-confirm').fill(a.code);
    await page.getByTestId('remove-submit').click();
    await expect(page).toHaveURL(/\/deployments$/);
    expect((await page.goto(`/deployments/${a.id}`))!.status()).toBe(404);
    expect((await heartbeat(a)).status).toBe(401);
  });

  test('retention settings: default, inline validation, save, purge now; readers see nothing to decommission', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    await page.goto('/settings/retention');
    await expect(page.getByRole('heading', { level: 1, name: 'Data retention' })).toBeVisible();
    await expect(page.getByTestId('retention-stats')).toBeVisible();
    await page.getByTestId('retention-days').fill('3');
    await page.getByTestId('retention-save').click();
    await expect(page.getByText('At least 7 days.')).toBeVisible();
    await page.getByTestId('retention-days').fill('45');
    await page.getByTestId('retention-save').click();
    await expect(page.getByTestId('retention-notice')).toContainText('purged 45 days after decommissioning');
    await page.getByTestId('retention-purge').click();
    await page.getByTestId('retention-purge-confirm').click();
    await expect(page.getByTestId('retention-notice')).toContainText(/Purged the retained metadata|Nothing was due/);
    await page.goto('/audit?q=retention_policy');
    await expect(page.getByText('retention_policy.updated').first()).toBeVisible();
    // Technical Administrators (deployments.write) do not see the decommission link; viewers see neither.
    await apiLogin(page, USERS.tech);
    const deployments = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/deployments?lifecycle=verified&pageSize=5`)).json()).items as { id: string }[];
    await page.goto(`/deployments/${deployments[0]!.id}`);
    await expect(page.getByTestId('decommission-link')).toHaveCount(0);
    expect((await page.request.post(`${E2E_BASE_URL}/api/v1/deployments/${deployments[0]!.id}/decommission`, { data: { reason: 'try', confirmCode: 'x' }, headers: await csrfHeaders(page) })).status()).toBe(403);
    expect((await page.goto('/settings/retention'))!.status()).toBe(404);
    await apiLogin(page, USERS.viewer);
    await page.goto(`/deployments/${deployments[0]!.id}`);
    await expect(page.getByTestId('decommission-link')).toHaveCount(0);
    // A synthetic decommissioned sample reads as final, with no removal controls for readers.
    const synthetic = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/deployments?lifecycle=decommissioned&pageSize=20`)).json()).items.find((d: { isSynthetic: boolean }) => d.isSynthetic);
    if (synthetic) {
      await page.goto(`/deployments/${synthetic.id}`);
      await expect(page.getByText('Synthetic sample record')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Decommissioned' })).toBeVisible();
      await expect(page.getByTestId('remove-deployment')).toHaveCount(0);
    }
  });
});
