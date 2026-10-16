import { webcrypto } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import * as x509 from '@peculiar/x509';
import { unzipSync } from 'fflate';
import { ensureLicense } from './agent';
import { apiLogin, csrfHeaders, expect, test, USERS } from './fixtures';
import { E2E_BASE_URL, E2E_GATEWAY_PORT } from './env';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

/** Creates a deployment and package, then enrolls an agent identity with the package's token (as the edge agent does). */
async function enrolledDeployment(page: Page) {
  const client = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/clients?q=Lumen`)).json()).items[0];
  const psa = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/psa-instances?clientId=${client.id}&status=active`)).json()).items[0];
  const headers = await csrfHeaders(page);
  await ensureLicense(page, client.id);
  const dep = await (await page.request.post(`${E2E_BASE_URL}/api/v1/deployments`, { data: { clientId: client.id, psaInstanceId: psa.id, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64' }, headers })).json();
  const pkg = (await (await page.request.post(`${E2E_BASE_URL}/api/v1/deployments/${dep.id}/packages`, { data: { tokenValidityHours: 1 }, headers })).json()).currentPackage;
  const zip = await (await page.request.post(`${E2E_BASE_URL}/api/v1/deployments/${dep.id}/packages/${pkg.id}/download`, { headers })).body();
  const en = JSON.parse(Buffer.from(unzipSync(new Uint8Array(zip))[`psacc-${dep.code.toLowerCase()}/enrollment/enrollment.json`]!).toString());
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: `CN=${en.installationId}`, keys, signingAlgorithm: ALG });
  const res = await new Promise<{ status: number; body: { serial: string } }>((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port: E2E_GATEWAY_PORT, path: '/agent/v1/enroll', method: 'POST', ca: en.caCertificate, headers: { 'content-type': 'application/json' } }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => resolve({ status: r.statusCode!, body: JSON.parse(b) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ token: en.token, deploymentId: en.deploymentId, installationId: en.installationId, csr: csr.toString('pem'), agentVersion: '0.1.0' }));
  });
  expect(res.status).toBe(201);
  return { id: dep.id as string, code: dep.code as string, serial: res.body.serial };
}

test.describe('agent enrollment and machine identity', () => {
  test('an enrolled deployment shows its machine certificate; revoking it is inline and returns the deployment to draft', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const dep = await enrolledDeployment(page);
    await page.goto(`/deployments/${dep.id}`);
    await expect(page.getByRole('listitem', { name: 'Installed & enrolled: done' })).toBeVisible();
    await expect(page.getByText('Enrolled (mutual TLS)')).toBeVisible();
    const card = page.getByTestId('active-certificate');
    await expect(card).toContainText(dep.serial);
    await expect(card).toContainText(`CN=`);
    await page.getByRole('button', { name: 'Revoke certificate' }).click();
    await page.getByRole('button', { name: 'Yes, revoke' }).click();
    await expect(page.getByText('Give a reason (at least 3 characters).')).toBeVisible();
    await page.getByLabel('Reason').fill('E2E: host replaced');
    await page.getByRole('button', { name: 'Yes, revoke' }).click();
    await expect(page.getByText('Certificate revoked', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByLabel(/Lifecycle: Draft/)).toBeVisible();
    await expect(page.getByText('Certificate revoked — re-enroll with a new package')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Certificate history' })).toContainText('E2E: host replaced');
    await expect(page.getByText('agent.certificate.revoked')).toBeVisible();
    await expect(page.getByText('agent.enrolled')).toBeVisible();
  });

  test('read-only users see the identity but cannot revoke it; the page has no serious accessibility violations', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const dep = await enrolledDeployment(page);
    await page.context().clearCookies();
    await apiLogin(page, USERS.viewer);
    await page.goto(`/deployments/${dep.id}`);
    await expect(page.getByTestId('active-certificate')).toContainText(dep.serial);
    await expect(page.getByRole('button', { name: 'Revoke certificate' })).toHaveCount(0);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  });
});
