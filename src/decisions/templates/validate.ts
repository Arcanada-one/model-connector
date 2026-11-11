import { denyListHit } from './deny-list';
import { DecisionTemplate, getTemplate } from './registry';

export type TemplateValidateOk = {
  ok: true;
  template: DecisionTemplate;
};

export type TemplateValidateErr = {
  ok: false;
  code:
    | 'unknown_template'
    | 'invalid_state'
    | 'deny_list_field'
    | 'invalid_template_params'
    | 'inline_questions_forbidden';
  message: string;
};

export type TemplateValidateResult = TemplateValidateOk | TemplateValidateErr;

const ASCII_SLUG = /^[a-z][a-z0-9_]{0,63}$/;
const ASCII_VALUE = /^[\x20-\x7E]{0,256}$/;

function walkKeys(
  value: unknown,
  path: string[],
  onKey: (key: string, path: string[]) => void,
): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) walkKeys(value[i], [...path, String(i)], onKey);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    onKey(k, [...path, k]);
    walkKeys(v, [...path, k], onKey);
  }
}

function validateObjectBranch(
  branch: unknown,
  allowed: readonly string[],
  branchName: 'trusted' | 'untrusted',
): TemplateValidateErr | null {
  if (branch === undefined) return null;
  if (branch === null || typeof branch !== 'object' || Array.isArray(branch)) {
    return {
      ok: false,
      code: 'invalid_state',
      message: `state.${branchName} must be an object`,
    };
  }
  const keys = Object.keys(branch as object);
  for (const key of keys) {
    // Explicit catalog whitelist wins at the branch root (e.g. trusted.context_labels
    // contains the substring "label" but is an admitted field name in §0.1).
    if (!allowed.includes(key)) {
      const hit = denyListHit(key);
      if (hit) {
        return {
          ok: false,
          code: 'deny_list_field',
          message: `state.${branchName}.${key} hits deny-list token "${hit}"`,
        };
      }
      return {
        ok: false,
        code: 'invalid_state',
        message: `state.${branchName}.${key} is outside the whitelist for this template`,
      };
    }
  }
  // Nested deny-list (e.g. untrusted.candidates[].reviewer_note). Whitelisted
  // root keys themselves are skipped; their children still face the deny-list.
  let nestedHit: TemplateValidateErr | null = null;
  walkKeys(branch, [branchName], (key, path) => {
    if (nestedHit) return;
    // path = [branch, topKey, ...] — skip the already-whitelisted top-level key
    // (e.g. trusted.context_labels contains substring "label" but is admitted).
    if (path.length <= 2) return;
    const hit = denyListHit(key);
    if (hit) {
      nestedHit = {
        ok: false,
        code: 'deny_list_field',
        message: `state.${path.join('.')} hits deny-list token "${hit}"`,
      };
    }
  });
  return nestedHit;
}

/**
 * validate(template, state) — ARCA-JEV-02 shaped API used by POST /v1/decisions.
 */
export function validateTemplateRequest(input: {
  templateId: string;
  templateVersion?: number;
  state: unknown;
  templateParams?: Record<string, unknown>;
  /** Reject if the caller tried to smuggle inline questions. */
  hasInlineQuestions?: boolean;
}): TemplateValidateResult {
  if (input.hasInlineQuestions) {
    return {
      ok: false,
      code: 'inline_questions_forbidden',
      message: 'Inline questions/instructions/criteria are forbidden; use a registered template',
    };
  }

  const template = getTemplate(input.templateId, input.templateVersion);
  if (!template) {
    return {
      ok: false,
      code: 'unknown_template',
      message:
        `Unknown template "${input.templateId}"` +
        (input.templateVersion !== undefined ? ` version ${input.templateVersion}` : ''),
    };
  }

  if (input.templateParams) {
    for (const [name, value] of Object.entries(input.templateParams)) {
      if (!template.paramsSchema.includes(name)) {
        return {
          ok: false,
          code: 'invalid_template_params',
          message: `template_params.${name} is not in the template params schema`,
        };
      }
      if (typeof value !== 'string' || !ASCII_SLUG.test(name) || !ASCII_VALUE.test(value)) {
        return {
          ok: false,
          code: 'invalid_template_params',
          message: `template_params.${name} must be an ASCII value`,
        };
      }
      // AC-09: refuse free-text that tries to smuggle instructions via params.
      if (/instructions|criteria/i.test(value)) {
        return {
          ok: false,
          code: 'invalid_template_params',
          message: `template_params.${name} must not carry instructions or criteria text`,
        };
      }
    }
  }

  // Health: string state only.
  if (template.group === 'health') {
    if (typeof input.state !== 'string' || input.state.length < 1 || input.state.length > 18000) {
      return {
        ok: false,
        code: 'invalid_state',
        message: 'health template requires a non-empty string state',
      };
    }
    return { ok: true, template };
  }

  if (input.state === null || typeof input.state !== 'object' || Array.isArray(input.state)) {
    return {
      ok: false,
      code: 'invalid_state',
      message: 'state must be an object with trusted/untrusted branches',
    };
  }

  const state = input.state as Record<string, unknown>;
  const extraRoots = Object.keys(state).filter((k) => k !== 'trusted' && k !== 'untrusted');
  if (extraRoots.length > 0) {
    return {
      ok: false,
      code: 'invalid_state',
      message: `state root keys outside trusted/untrusted: ${extraRoots.join(',')}`,
    };
  }

  const trustedErr = validateObjectBranch(
    state.trusted,
    template.stateWhitelist.trusted,
    'trusted',
  );
  if (trustedErr) return trustedErr;

  if (template.stateWhitelist.untrusted.length === 0) {
    if (
      state.untrusted !== undefined &&
      !(
        typeof state.untrusted === 'object' &&
        state.untrusted !== null &&
        !Array.isArray(state.untrusted) &&
        Object.keys(state.untrusted as object).length === 0
      )
    ) {
      return {
        ok: false,
        code: 'invalid_state',
        message: 'state.untrusted must be absent or empty for this template',
      };
    }
  } else {
    const untrustedErr = validateObjectBranch(
      state.untrusted,
      template.stateWhitelist.untrusted,
      'untrusted',
    );
    if (untrustedErr) return untrustedErr;
  }

  return { ok: true, template };
}
