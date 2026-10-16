import { z } from 'zod';

/**
 * Plain-language validation messages, applied wherever @psacc/contracts is loaded (API and UI).
 * Schema-specific messages always take precedence; this only replaces zod's generic wording.
 */
z.config({
  customError: (issue) => {
    if (issue.code === 'invalid_type' && issue.input === undefined) return 'This field is required.';
    if (issue.code === 'invalid_type' && issue.input === null) return 'This field is required.';
    if (issue.code === 'invalid_type') return 'This value has the wrong format.';
    if (issue.code === 'too_small' && issue.origin === 'string') return issue.minimum === 1 ? 'This field is required.' : `Use at least ${issue.minimum} characters.`;
    if (issue.code === 'too_big' && issue.origin === 'string') return `Use at most ${issue.maximum} characters.`;
    if (issue.code === 'unrecognized_keys') return `Unexpected field(s): ${issue.keys.join(', ')}.`;
    if (issue.code === 'invalid_value') return 'Choose one of the available options.';
    return undefined;
  },
});
