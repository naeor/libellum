import type { Transaction } from "@libellum/shared";
import type { QueryClient } from "@tanstack/react-query";
import { asLocalPage, filterLocally, type LocalFilters } from "./offline/localLedger.js";

/** Apply the complete view filter after merging: persisted query pages may predate this fix. */
export function mergeLedgerEntries(
  local: readonly Transaction[], remote: readonly Transaction[], pending: ReadonlySet<string>, filters: LocalFilters,
): readonly Transaction[] {
  const byId = new Map(remote.map(entry => [entry.id, entry]));
  for (const entry of local) {
    const server = byId.get(entry.id);
    if (server === undefined || pending.has(entry.id) || entry.version >= server.version) byId.set(entry.id, entry);
  }
  return filterLocally([...byId.values()], filters);
}

/** A local write must retain each query's income/expense, category and currency constraints. */
export function updateTransactionViews(client: QueryClient, entries: readonly Transaction[]): void {
  const months = new Set(entries.map(entry => entry.occurredLocalDate.slice(0, 7)));
  for (const query of client.getQueryCache().getAll()) {
    const [name, raw] = query.queryKey;
    if (name !== "transactions" || typeof raw !== "object" || raw === null) continue;
    const filters = raw as LocalFilters;
    if (filters.month === undefined || !months.has(filters.month)) continue;
    client.setQueryData(query.queryKey, { pages: [asLocalPage(filterLocally(entries, filters))], pageParams: [undefined] });
  }
}
