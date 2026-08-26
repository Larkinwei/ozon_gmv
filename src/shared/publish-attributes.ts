/**
 * Returns whether an attribute contains a value that can be sent to Ozon.
 * Dictionary attributes may be represented as IDs, `{value}` objects, or
 * Ozon's `{values}` payload, so checking only String(value) is insufficient.
 */
export function hasPublishAttributeValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.some(hasPublishAttributeValue);
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 && normalized !== "0";
  }
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "boolean") return true;
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ("values" in record) return hasPublishAttributeValue(record.values);
  if ("dictionary_value_id" in record) return hasPublishAttributeValue(record.dictionary_value_id);
  if ("dictionaryValueId" in record) return hasPublishAttributeValue(record.dictionaryValueId);
  if ("value" in record) return hasPublishAttributeValue(record.value);
  return Object.values(record).some(hasPublishAttributeValue);
}
