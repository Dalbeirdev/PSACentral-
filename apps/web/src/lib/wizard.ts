import { DATA_STEPS, ONBOARDING_STEPS, type OnboardingDraftDto, type OnboardingStepKey } from '@psacc/contracts';

export const STEP_KEYS = ONBOARDING_STEPS.map((s) => s.key) as OnboardingStepKey[];
export const isStepKey = (s: string): s is OnboardingStepKey => (STEP_KEYS as string[]).includes(s);

export function stepHref(draftId: string, step: OnboardingStepKey) {
  return `/clients/new/${draftId}/${step}`;
}

export function firstIncomplete(draft: Pick<OnboardingDraftDto, 'completedSteps'>): OnboardingStepKey {
  return DATA_STEPS.find((s) => !draft.completedSteps.includes(s)) ?? 'review';
}

export type StepAvailability = 'done' | 'current' | 'open' | 'locked';

/** Which steps a user may open. Steps unlock in order; creation closes steps 1–7 and opens 8–10. */
export function availability(draft: Pick<OnboardingDraftDto, 'status' | 'completedSteps'>, step: OnboardingStepKey, viewing: OnboardingStepKey): StepAvailability {
  const idx = STEP_KEYS.indexOf(step);
  const created = draft.status === 'completed';
  if (draft.status === 'abandoned') return 'locked';
  if (created) {
    if (idx <= STEP_KEYS.indexOf('create')) return 'done';
    return step === viewing ? 'current' : 'open';
  }
  if (idx >= STEP_KEYS.indexOf('download')) return 'locked';
  const dataIdx = (DATA_STEPS as readonly string[]).indexOf(step);
  const prerequisites = dataIdx >= 0 ? DATA_STEPS.slice(0, dataIdx) : DATA_STEPS;
  const unlocked = prerequisites.every((s) => draft.completedSteps.includes(s));
  if (!unlocked) return 'locked';
  if (step === viewing) return 'current';
  return dataIdx >= 0 && draft.completedSteps.includes(DATA_STEPS[dataIdx]!) ? 'done' : 'open';
}

export function nextStep(step: OnboardingStepKey): OnboardingStepKey {
  return STEP_KEYS[Math.min(STEP_KEYS.indexOf(step) + 1, STEP_KEYS.length - 1)]!;
}
export function prevStep(step: OnboardingStepKey): OnboardingStepKey | null {
  const i = STEP_KEYS.indexOf(step);
  return i > 0 ? STEP_KEYS[i - 1]! : null;
}
