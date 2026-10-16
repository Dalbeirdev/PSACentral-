'use client';

import { type SectionTab, SectionTabs } from '@/components/ui/section-tabs';

export function ClientTabs({ tabs }: { tabs: SectionTab[] }) {
  return <SectionTabs tabs={tabs} label="Client sections" />;
}
