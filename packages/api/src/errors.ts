import type { ZodError } from 'zod';

export type ErrorKind = 'invalid_request' | 'not_found' | 'invalid_config';

export function errorBody(kind: ErrorKind, message: string) {
  return { error: { kind, message } };
}

/** 入力の値を含めない: 値が API キーなどの秘密でも応答に出さないため */
export function describeIssues(error: ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? '(body)' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');
}
