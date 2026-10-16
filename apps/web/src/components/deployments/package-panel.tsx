'use client';

import { type DeploymentDetail, TOKEN_VALIDITY_HOURS } from '@psacc/contracts';
import { Ban, Download, FileArchive, KeyRound, PackagePlus, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/field';
import { apiDownload, apiMutate } from '@/lib/api-client';
import { formatDateTime, relativeTime } from '@/lib/format';
import { PackageStatusBadge, TokenStatusBadge } from './badges';

type Notice = { variant: 'success' | 'error' | 'info'; title: string; body?: string } | null;

function bytes(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/**
 * Generate, download and revoke the deployment package — all inline on the page (no pop-ups).
 * Shared by the deployment Installation page and onboarding step 8.
 */
export function PackagePanel({ d, canGenerate, timezone }: { d: DeploymentDetail; canGenerate: boolean; timezone: string }) {
  const router = useRouter();
  const pkg = d.currentPackage;
  const ready = d.readiness.every((c) => c.ok);
  const [validity, setValidity] = useState<number>(24);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const [busy, setBusy] = useState<'generate' | 'download' | 'revoke' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function generate(replaceExisting: boolean) {
    setBusy('generate');
    setNotice(null);
    const r = await apiMutate<DeploymentDetail>('POST', `/deployments/${d.id}/packages`, { tokenValidityHours: validity, replaceExisting });
    setBusy(null);
    setConfirmReplace(false);
    if (!r.ok) return setNotice({ variant: 'error', title: 'The package was not generated.', body: r.problem.detail });
    const p = r.data.currentPackage!;
    setNotice({ variant: 'success', title: `Package #${p.number} generated.`, body: `Its single-use enrollment token is valid until ${formatDateTime(p.token.expiresAt, timezone)}. Download it and install it on the client’s host.` });
    router.refresh();
  }

  async function download() {
    if (!pkg) return;
    setBusy('download');
    setNotice(null);
    const r = await apiDownload(`/deployments/${d.id}/packages/${pkg.id}/download`);
    setBusy(null);
    if (!r.ok) {
      setNotice({ variant: 'error', title: 'The package could not be downloaded.', body: r.problem.detail });
      return router.refresh();
    }
    setNotice({
      variant: 'success',
      title: `Downloaded ${r.fileName}.`,
      body: `SHA-256 ${r.sha256 ?? pkg.sha256}. Downloading is recorded but does not mean the appliance is installed; the deployment shows as enrolled only after its agent connects.`,
    });
    router.refresh();
  }

  async function revoke() {
    if (!pkg) return;
    if (reason.trim().length < 3) return setReasonError('Give a reason (at least 3 characters).');
    setBusy('revoke');
    setNotice(null);
    const r = await apiMutate<DeploymentDetail>('POST', `/deployments/${d.id}/packages/${pkg.id}/revoke`, { reason: reason.trim() });
    setBusy(null);
    if (!r.ok) return setNotice({ variant: 'error', title: 'The package was not revoked.', body: r.problem.detail });
    setRevoking(false);
    setReason('');
    setNotice({ variant: 'info', title: `Package #${pkg.number} revoked.`, body: 'Its enrollment token no longer works. The deployment is back to draft; settings can be changed and a new package generated.' });
    router.refresh();
  }

  const validitySelect = (
    <Field label="Enrollment token valid for" hint="Short-lived and single-use. Install within this time, or generate a new package.">
      {(p) => (
        <Select {...p} value={String(validity)} onChange={(e) => setValidity(Number(e.target.value))} className="sm:w-56">
          {TOKEN_VALIDITY_HOURS.map((h) => <option key={h} value={h}>{h === 1 ? '1 hour' : `${h} hours`}</option>)}
        </Select>
      )}
    </Field>
  );

  return (
    <div className="space-y-4">
      {notice ? <Alert variant={notice.variant} title={notice.title}>{notice.body}</Alert> : null}

      {pkg ? (
        <div className="rounded-xl border border-slate-200 bg-white" data-testid="current-package">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-slate-900">
                <FileArchive className="size-4 text-blue-600" aria-hidden="true" /> Package #{pkg.number}
                <PackageStatusBadge status={pkg.status} />
                <TokenStatusBadge status={pkg.token.status} />
              </p>
              <p className="mt-1 font-mono text-[12.5px] text-slate-600">{pkg.fileName}</p>
            </div>
            {canGenerate ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={download} disabled={!pkg.downloadable || busy !== null} loading={busy === 'download'}>
                  <Download /> Download package
                </Button>
                {!revoking ? (
                  <Button variant="secondary" onClick={() => { setRevoking(true); setConfirmReplace(false); }} disabled={busy !== null}>
                    <Ban /> Revoke
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
            <div><dt className="text-slate-500">Generated</dt><dd className="font-medium text-slate-800">{formatDateTime(pkg.generatedAt, timezone)}{pkg.generatedBy ? ` by ${pkg.generatedBy}` : ''}</dd></div>
            <div><dt className="text-slate-500">Enrollment token</dt><dd className="font-medium text-slate-800"><span className="font-mono">{pkg.token.prefix}</span> · expires {formatDateTime(pkg.token.expiresAt, timezone)} <span className="text-slate-500">({relativeTime(pkg.token.expiresAt)})</span></dd></div>
            <div><dt className="text-slate-500">Downloads</dt><dd className="font-medium text-slate-800">{pkg.downloadCount === 0 ? 'Not downloaded yet' : `${pkg.downloadCount} · last ${formatDateTime(pkg.lastDownloadedAt, timezone)}`}</dd></div>
            <div><dt className="text-slate-500">Installation ID</dt><dd className="break-all font-mono text-[12.5px] text-slate-800">{pkg.installationId}</dd></div>
            <div><dt className="text-slate-500">Edge image</dt><dd className="break-all font-mono text-[12.5px] text-slate-800">{pkg.image.repository}:{pkg.image.version}{pkg.image.digest ? `@${pkg.image.digest}` : ''}</dd></div>
            <div><dt className="text-slate-500">Size</dt><dd className="font-medium text-slate-800">{bytes(pkg.sizeBytes)} · {pkg.files.length} files</dd></div>
            <div className="sm:col-span-2 lg:col-span-3"><dt className="text-slate-500">SHA-256 of the ZIP</dt><dd className="break-all font-mono text-[12.5px] text-slate-800" data-testid="package-sha256">{pkg.sha256}</dd></div>
          </dl>

          {revoking ? (
            <div className="border-t border-red-100 bg-red-50/50 px-5 py-4" role="group" aria-label="Revoke package">
              <p className="text-sm font-semibold text-red-900">Revoke package #{pkg.number}?</p>
              <p className="mt-0.5 text-[13px] text-red-900/80">Its enrollment token stops working immediately and the archive is deleted. Use this if the package was sent to the wrong place or may have leaked.</p>
              <Field label="Reason" error={reasonError} required className="mt-3 max-w-xl">
                {(p) => <Textarea {...p} rows={2} value={reason} maxLength={200} onChange={(e) => { setReason(e.target.value); setReasonError(undefined); }} />}
              </Field>
              <div className="mt-3 flex gap-2">
                <Button variant="danger" onClick={revoke} loading={busy === 'revoke'} disabled={busy !== null}>Yes, revoke</Button>
                <Button variant="ghost" onClick={() => { setRevoking(false); setReasonError(undefined); }} disabled={busy !== null}>Cancel</Button>
              </div>
            </div>
          ) : null}

          <details className="border-t border-slate-100 px-5 py-3">
            <summary className="cursor-pointer text-[13px] font-medium text-blue-700">Package contents ({pkg.files.length} files)</summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[12.5px]">
                <thead><tr className="text-slate-500"><th className="py-1.5 pr-4 font-medium">File</th><th className="py-1.5 pr-4 font-medium">Size</th><th className="py-1.5 font-medium">SHA-256</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {pkg.files.map((f) => (
                    <tr key={f.path}>
                      <td className="py-1.5 pr-4 font-mono text-slate-800">
                        {f.path}
                        {f.containsToken ? <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200"><KeyRound className="size-3" aria-hidden="true" />single-use token</span> : null}
                      </td>
                      <td className="py-1.5 pr-4 text-slate-600">{bytes(f.size)}</td>
                      <td className="py-1.5 font-mono text-[11.5px] text-slate-500">{f.sha256.slice(0, 16)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      ) : null}

      {canGenerate ? (
        pkg ? (
          !revoking ? (
            confirmReplace ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-5 py-4" role="group" aria-label="Replace package">
                <p className="text-sm font-semibold text-amber-950">Generate a new package and replace #{pkg.number}?</p>
                <p className="mt-0.5 text-[13px] text-amber-900/80">The current package’s enrollment token stops working. Anyone holding the old ZIP must use the new one.</p>
                <div className="mt-3">{validitySelect}</div>
                <div className="mt-3 flex gap-2">
                  <Button variant="primary" onClick={() => generate(true)} loading={busy === 'generate'} disabled={busy !== null}>Yes, replace</Button>
                  <Button variant="ghost" onClick={() => setConfirmReplace(false)} disabled={busy !== null}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button variant="secondary" onClick={() => setConfirmReplace(true)} disabled={!ready || busy !== null}><RefreshCw /> Generate a new package</Button>
            )
          ) : null
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-5 py-5">
            <p className="text-sm font-semibold text-slate-900">{d.packages.length ? 'No usable package' : 'No package generated yet'}</p>
            <p className="mt-0.5 text-[13px] text-slate-600">
              {ready
                ? 'Generating creates the installation ID and a single-use enrollment token, renders the Compose configuration, scripts and documentation, and packages them as a ZIP. It is not a Docker image.'
                : 'Resolve the readiness checks first.'}
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              {validitySelect}
              <Button variant="primary" onClick={() => generate(false)} disabled={!ready || busy !== null} loading={busy === 'generate'}>
                <PackagePlus /> Generate deployment package
              </Button>
            </div>
          </div>
        )
      ) : !pkg ? (
        <p className="text-sm text-slate-500">No usable package. Generating packages requires the “Generate deployment packages” permission.</p>
      ) : null}
    </div>
  );
}
