import { categoricalColor } from "../chart/theme.js";
import type { Transaction } from "@libellum/shared";
import type { ConflictRecord } from "./localLedger.js";
import { FIELD_LABELS, mergeEntries, type MergeField } from "./merge.js";

export interface ConflictOption { readonly label: string; readonly value: unknown }
export interface ConflictQuestion { readonly field: MergeField; readonly label: string; readonly options: readonly ConflictOption[] }

function valueOf(entry: Transaction, field: MergeField): unknown {
  return field === "tags" ? entry.tags.map(tag => tag.id) : entry[field];
}
function key(field: MergeField, value: unknown): string | undefined {
  return JSON.stringify(field === "tags" && Array.isArray(value) ? [...value].sort() : value);
}

/** Server claims survive refreshes and are available on every device, including the winner. */
export function conflictQuestions(conflict: ConflictRecord): readonly ConflictQuestion[] {
  if (conflict.fields === undefined) {
    return mergeEntries(conflict.base, conflict.mine, conflict.theirs).conflicts
      .filter(item => item.field !== "occurredAt")
      .map(item => ({ field: item.field, label: item.label, options: [
        { label: "这台设备", value: item.mine }, { label: "服务器", value: item.theirs },
      ] }));
  }
  return conflict.fields.flatMap(item => {
    const field = (item.field === "tagIds" ? "tags" : item.field) as MergeField;
    if (!(field in FIELD_LABELS) || field === "occurredAt") return [];
    const options: ConflictOption[] = [{ label: "服务器", value: valueOf(conflict.theirs, field) }];
    for (const claim of item.claims ?? []) {
      if (claim.chain.length === 0) continue;
      options.push({ label: `设备 ${claim.deviceId.slice(0, 8)} 提交`, value: claim.chain.at(-1) });
    }
    // Older persisted conflicts may predate the claims payload.
    if ((item.claims?.length ?? 0) === 0) options.push({ label: "这台设备", value: valueOf(conflict.mine, field) });
    const unique = options.filter((option, index) => options.findIndex(other => key(field, other.value) === key(field, option.value)) === index);
    return unique.length < 2 ? [] : [{ field, label: FIELD_LABELS[field], options: unique }];
  });
}

export function applyConflictChoices(
  entry: Transaction,
  choices: ReadonlyMap<MergeField, unknown>,
  names: { categories?: readonly { id: string; name: string; isSystem?: boolean }[] | undefined;
    paymentMethods?: readonly { id: string; name: string }[] | undefined;
    tags?: readonly { id: string; name: string; color?: string }[] | undefined },
  sources: readonly Transaction[],
): Transaction {
  const result = { ...entry };
  for (const [field, value] of choices) {
    if (field === "tags") {
      const known = new Map([...sources.flatMap(source => source.tags), ...(names.tags ?? [])].map(tag => [tag.id, tag]));
      result.tags = (value as string[]).map(id => ({ id, name: known.get(id)?.name ?? id, color: known.get(id)?.color ?? categoricalColor(0) }));
    } else (result as unknown as Record<string, unknown>)[field] = value;
  }
  if (choices.has("categoryId")) {
    const category = names.categories?.find(item => item.id === result.categoryId);
    const source = sources.find(item => item.categoryId === result.categoryId);
    result.categoryName = category?.name ?? source?.categoryName ?? result.categoryId;
    result.categoryIsSystem = category?.isSystem ?? source?.categoryIsSystem ?? false;
  }
  if (choices.has("paymentMethodId")) result.paymentMethodName = result.paymentMethodId === null ? null :
    names.paymentMethods?.find(item => item.id === result.paymentMethodId)?.name ??
    sources.find(item => item.paymentMethodId === result.paymentMethodId)?.paymentMethodName ?? result.paymentMethodId;
  return result;
}
