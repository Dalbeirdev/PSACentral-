import AxeBuilder from '@axe-core/playwright';
import { enrolledDeployment, reports, sendReports } from './agent';
import { E2E_BASE_URL } from './env';
import { apiLogin, expect, test, USERS } from './fixtures';

/**
 * Module 11 — the Integrations page and the PSA instance page show what the appliance reported after
 * running the real connection test there. A simulated agent (real mTLS enrollment) sends the reports.
 */
test.describe('integrations (PSA connections)', () => {
  test('the fleet view is untested until an appliance reports; a verified test shows with its code, latency and history', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    await page.goto('/integrations');
    await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
    await expect(page.getByTestId('integration-count-succeeded')).toHaveText('0'); // nothing is verified without a real test
    await page.getByLabel('Connection').selectOption('succeeded');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('No integrations match these filters')).toBeVisible();

    const agent = await enrolledDeployment(page, 'Lumen');
    const dep = await (await page.request.get(`${E2E_BASE_URL}/api/v1/deployments/${agent.id}`)).json();
    const inst = dep.psaInstance as { id: string; code: string };
    const t1 = new Date(Date.now() - 90_000).toISOString();
    const t2 = new Date(Date.now() - 30_000).toISOString();
    const psa = (over: Record<string, unknown>) => ({ provider: dep.psaInstance.providerKey ?? 'autotask', instanceCode: inst.code, status: 'credentials_present', credentialFields: 3, credentialsPresent: 3, lastTestAt: null, lastTestResult: null, apiCallsImplemented: true, ...over });
    expect((await sendReports(agent, reports({ psa_integration_status: psa({ status: 'failed', lastTestAt: t1, lastTestCode: 'auth_failed', lastTestHttpStatus: 401, lastTestLatencyMs: 220, lastTestedBy: 'local_admin', consecutiveFailures: 1 }) }))).status).toBe(200);
    expect((await sendReports(agent, reports({
      psa_integration_status: psa({ status: 'verified', lastTestAt: t2, lastTestCode: 'ok', lastTestHttpStatus: 200, lastTestLatencyMs: 310, lastTestedBy: 'worker', lastSuccessAt: t2, remoteIdentity: { api: 'Autotask REST v1.0', host: 'webservices5.autotask.net' } }),
      synchronization: { lastRunAt: t2, lastStatus: 'succeeded', itemsReceived: 12, itemsSent: 2, itemsFailed: 0, errorCode: null, httpStatus: null, recentErrors: [], errorsLast24h: 0, implemented: true, lastSucceededAt: t2, runsLast24h: 4, failedRunsLast24h: 0, watermark: t2 },
      ticket_processing_metrics: { ticketsTotal: 40, ticketsOpen: 7, eventsLast24h: 15, failedLast24h: 0, lastProcessedAt: t2, pendingOutbound: 1, conflictsLast24h: 0, localOnly: 0, pushFailed: 0 },
    }))).status).toBe(200);

    await page.goto(`/integrations?q=${encodeURIComponent(inst.code)}`);
    const row = page.getByTestId(`integration-${inst.code}`);
    await expect(row).toContainText('Verified');
    await expect(row).toContainText('Succeeded');
    await expect(row).toContainText('HTTP 200 · 310 ms · periodic');
    await expect(row.getByRole('link', { name: agent.code })).toBeVisible();
    await expect(row.getByTestId('sync-cell')).toContainText('succeeded');
    await expect(row.getByTestId('sync-cell')).toContainText('12 in · 2 out');
    await expect(row.getByTestId('tickets-cell')).toContainText('7 open / 40');
    await expect(row.getByTestId('tickets-cell')).toContainText('1 waiting to push');
    await expect(page.getByTestId('integration-count-succeeded')).toHaveText('1');
    // The deployment's health page shows the same counts, and nothing else about tickets.
    await page.goto(`/deployments/${agent.id}/health`);
    await expect(page.getByTestId('tickets-sync-card')).toContainText('7 open of 40');
    await expect(page.getByTestId('tickets-sync-card')).toContainText('succeeded');
    await expect(page.getByTestId('tickets-sync-card')).toContainText('1 change(s) waiting to push');

    await page.goto(`/psa/${inst.id}`);
    await expect(page.getByTestId('connection-card')).toContainText('Verified');
    await expect(page.getByTestId('connection-card')).toContainText('Autotask REST v1.0');
    const history = page.getByRole('table', { name: 'Connection tests' });
    await expect(history.locator('tbody tr')).toHaveCount(2);
    await expect(history.locator('tbody tr').first()).toContainText('Succeeded');
    await expect(history.locator('tbody tr').nth(1)).toContainText('Authentication rejected');
    await expect(history.locator('tbody tr').nth(1)).toContainText('401');
    await expect(page.getByText('psa_instance.connection.reported').first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });

  test('read-only users see the fleet view without any control that would call a PSA', async ({ page }) => {
    for (const user of [USERS.viewer, USERS.technician]) {
      await apiLogin(page, user);
      await page.goto('/integrations');
      await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
      await expect(page.getByRole('button', { name: /test|retry|connect|sync/i })).toHaveCount(0); // tests run on the appliance only
      await expect(page.getByText('never calls a PSA API')).toBeVisible();
    }
  });
});
