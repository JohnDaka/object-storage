/** What `typeof` answers, for the checks below. */
const TYPE_OF = {
  /** Any text, the empty one included. */
  STRING: 'string',
} as const;

/**
 * Whether the value is a string. A type guard rather than an inline `typeof`: TypeScript narrows
 * on a guard, not on a comparison with a named constant.
 */
export const isString = (value: unknown): value is string => typeof value === TYPE_OF.STRING;
