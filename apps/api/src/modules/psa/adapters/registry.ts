import { Inject, Injectable } from '@nestjs/common';
import type { PsaProviderKey } from '@psacc/contracts';
import { AppError } from '../../../common/problem.filter.js';
import type { PsaAdapter } from './psa-adapter.js';
import {
  AutotaskAdapter,
  ConnectWiseAdapter,
  CustomRestAdapter,
  FreshserviceAdapter,
  HaloPsaAdapter,
  KaseyaBmsAdapter,
  ServiceNowAdapter,
} from './providers.js';

export const PSA_ADAPTERS = Symbol('PSA_ADAPTERS');

/** Adding a provider = add its descriptor + adapter class and register it here. */
export const psaAdapterProviders = [
  {
    provide: PSA_ADAPTERS,
    useFactory: (): PsaAdapter[] => [
      new AutotaskAdapter(),
      new ConnectWiseAdapter(),
      new HaloPsaAdapter(),
      new KaseyaBmsAdapter(),
      new FreshserviceAdapter(),
      new ServiceNowAdapter(),
      new CustomRestAdapter(),
    ],
  },
];

@Injectable()
export class PsaAdapterRegistry {
  private readonly byKey: Map<PsaProviderKey, PsaAdapter>;

  constructor(@Inject(PSA_ADAPTERS) adapters: PsaAdapter[]) {
    this.byKey = new Map();
    for (const a of adapters) {
      if (this.byKey.has(a.key)) throw new Error(`Duplicate PSA adapter for ${a.key}`);
      this.byKey.set(a.key, a);
    }
  }

  get(key: string): PsaAdapter {
    const a = this.byKey.get(key as PsaProviderKey);
    if (!a) throw new AppError(422, 'unknown-provider', `No adapter is registered for PSA provider "${key}".`);
    return a;
  }

  all(): PsaAdapter[] {
    return [...this.byKey.values()].sort((a, b) => a.descriptor.sortOrder - b.descriptor.sortOrder);
  }
}
