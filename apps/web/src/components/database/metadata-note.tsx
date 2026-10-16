import { ShieldCheck } from 'lucide-react';

/** The explorer's data boundary, stated on every page that shows appliance database metadata. */
export function MetadataOnlyNote() {
  return (
    <p className="flex items-start gap-2 text-[12.5px] leading-5 text-slate-500">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" />
      <span>Inspection is metadata-only, performed on the appliance by its <code className="font-mono">psa_edge_inspector</code> role, which has no privileges on any table. Row counts are planner estimates. There is no record browser, SQL console or query box, and nothing here can change the client database.</span>
    </p>
  );
}
