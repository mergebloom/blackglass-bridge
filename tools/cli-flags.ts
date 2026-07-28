export interface ParsedFlags {
  values: ReadonlyMap<string, string>;
  booleans: ReadonlySet<string>;
}

export function parseStrictFlags(
  arguments_: string[],
  options: { valueFlags?: readonly string[]; booleanFlags?: readonly string[] },
): ParsedFlags {
  const valueFlags = new Set(options.valueFlags ?? []);
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument || (!valueFlags.has(argument) && !booleanFlags.has(argument))) {
      throw new Error(`Unknown argument: ${argument ?? "<empty>"}`);
    }
    if (values.has(argument) || booleans.has(argument)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    if (booleanFlags.has(argument)) {
      booleans.add(argument);
      continue;
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for argument: ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }
  return { values, booleans };
}
