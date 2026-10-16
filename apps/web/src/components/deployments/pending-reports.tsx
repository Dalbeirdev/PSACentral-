import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';

/**
 * Honest placeholder for deployment sections whose data comes from agent reports that later modules
 * deliver. Shows what will appear and why nothing is shown yet — no sample values, no controls.
 */
export function PendingReports({ title, icon, module, items, reason }: { title: string; icon: ReactNode; module: number; items: string[]; reason: string }) {
  return (
    <Card>
      <CardHeader title={title} icon={icon} description={`Planned · Module ${module}`} />
      <CardBody className="pt-1">
        <p className="text-sm font-medium text-slate-800">No reports received</p>
        <p className="mt-0.5 text-[13px] text-slate-600">{reason}</p>
        <p className="mt-4 text-[13px] font-medium text-slate-700">This page will show</p>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] text-slate-600">
          {items.map((i) => <li key={i}>{i}</li>)}
        </ul>
      </CardBody>
    </Card>
  );
}
