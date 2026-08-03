// Release and evidence identities must not depend on the host's locale or ICU data.
export function compareCodeUnitStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareCodeUnitStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Stable JSON supports only JSON-serializable values");
  }
  return encoded;
}

export function stableJsonFile(value: unknown): string {
  return `${stableJson(value)}\n`;
}
