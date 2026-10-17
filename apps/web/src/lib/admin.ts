import type {
  AdminAccountActionResponse,
  AdminAuditListResponse,
  AdminCreateInviteRequest,
  AdminCreateInviteResponse,
  AdminInviteListResponse,
  AdminOverviewResponse,
  AdminRestoreRequest,
  AdminRevokeInviteRequest,
  AdminRosterResponse,
  AdminSelfResponse,
  AdminSuspendRequest,
  AdminUserSearchResponse,
} from "@libellum/shared";

import { useEffect, useState } from "react";

import { isFirstBatchAccountNumber } from "@libellum/shared";

import { apiFetch, ApiRequestError } from "./api.js";

/**
 * The admin console's calls, in one place.
 *
 * ⚠️ **This file is a thin wrapper and it must stay thin.** There is no client-side permission
 * check here and no cached "am I an admin" — every call is answered by the server, and a 403 is
 * a 403. A second, client-side copy of the authorization rule is the shape this project records
 * as *"how a hole appears"*.
 */

/** Whether the console should be offered at all. `false` on any refusal, never an exception. */
export async function fetchAdminSelf(): Promise<AdminSelfResponse | null> {
  try {
    return await apiFetch<AdminSelfResponse>("/admin/self");
  } catch (error) {
    /** ⚠️ 401/403 mean "not for you" — every other failure is a real error and must show up. */
    if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
      return null;
    }

    throw error;
  }
}

export function fetchAdminOverview(): Promise<AdminOverviewResponse> {
  return apiFetch<AdminOverviewResponse>("/admin/overview");
}

export function fetchAdminInvites(): Promise<AdminInviteListResponse> {
  return apiFetch<AdminInviteListResponse>("/admin/invites");
}

/** ⚠️ The only response that carries the plaintext, and it is never stored client-side. */
export function createAdminInvite(
  body: AdminCreateInviteRequest,
): Promise<AdminCreateInviteResponse> {
  return apiFetch<AdminCreateInviteResponse>("/admin/invites", { method: "POST", body });
}

export function revokeAdminInvite(
  id: string,
  body: AdminRevokeInviteRequest,
): Promise<AdminInviteListResponse> {
  return apiFetch<AdminInviteListResponse>(`/admin/invites/${id}/revoke`, {
    method: "POST",
    body,
  });
}

export function fetchAdminRoster(): Promise<AdminRosterResponse> {
  return apiFetch<AdminRosterResponse>("/admin/admins");
}

/** ⚠️ Exact match only — the server ignores anything that is not a full number or full name. */
export function searchAdminUsers(query: string): Promise<AdminUserSearchResponse> {
  return apiFetch<AdminUserSearchResponse>("/admin/users", { query: { q: query } });
}

export function suspendAdminUser(
  userId: string,
  body: AdminSuspendRequest,
): Promise<AdminAccountActionResponse> {
  return apiFetch<AdminAccountActionResponse>(`/admin/accounts/${userId}/suspend`, {
    method: "POST",
    body,
  });
}

export function restoreAdminUser(
  userId: string,
  body: AdminRestoreRequest,
): Promise<AdminAccountActionResponse> {
  return apiFetch<AdminAccountActionResponse>(`/admin/accounts/${userId}/restore`, {
    method: "POST",
    body,
  });
}

export function fetchAdminAudit(): Promise<AdminAuditListResponse> {
  return apiFetch<AdminAuditListResponse>("/admin/audit");
}
/**
 * **The browser-side gate** — a cheap check first, the server's answer second.
 *
 * The owner's instruction (2026-10-17):
 *
 * > *"管理入口是服务器要判断，客户端再进行一次判断……利用客户本地端可以看到的信息，
 * > 判断这个用户是不是管理员用户。如果不是管理员用户的话，直接隐藏管理入口就行，或者说压根不渲染。
 * > 例如，可以通过账号编号是不是前 100 来判断之类的。"*
 *
 * ⚠️ **Two layers, and the second one is the only real one.** The account number says whether
 * the account **may** hold administration (a qualification, not a grant); the server says
 * whether it **does**. The number check exists so an ordinary account **never even asks** —
 * no request, no flash of admin UI, nothing to discover by watching the network.
 *
 * ⚠️ **Nothing here replaces the server's check and nothing here may ever be trusted by it.**
 * `isFirstBatchAccountNumber` is the same rule the guard applies as one of its five checks; the
 * server keeps its own copy of the range on purpose (see `apps/api/test/adminRangeParity.test.ts`).
 */
export function mayHoldAdministration(accountNumber: string | undefined): boolean {
  return accountNumber !== undefined && isFirstBatchAccountNumber(accountNumber);
}

/**
 * **Whether to render the console entry** — client check, then one server confirmation.
 *
 * ⚠️ **Ordinary accounts cause zero requests**: the number is not in the first batch, so the
 * hook returns `false` before it would call `/admin/self`. That is the "压根不渲染" half of the
 * owner's requirement.
 *
 * ⚠️ **A first-batch account that is not an administrator is asked about once**, and the entry
 * stays hidden until the server says yes. "In the first batch" is not "is an administrator".
 */
export function useAdminEntry(accountNumber: string | undefined): boolean {
  const eligible = mayHoldAdministration(accountNumber);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!eligible) {
      setConfirmed(false);
      return;
    }

    let cancelled = false;

    void fetchAdminSelf()
      .then((self) => {
        if (!cancelled) setConfirmed(self !== null);
      })
      .catch(() => {
        if (!cancelled) setConfirmed(false);
      });

    return () => {
      cancelled = true;
    };
  }, [eligible, accountNumber]);

  return eligible && confirmed;
}

/**
 * **Whether to offer the console at all** — asked once per screen that needs it.
 *
 * ⚠️ **`false` while unknown, and `false` on refusal.** The default has to be "do not show":
 * rendering the entry point optimistically would flash an admin row at every ordinary user
 * before the answer arrived.
 *
 * ⚠️ **This is a hint, never a permission.** Every admin call re-checks on the server.
 */
export function useAdminSelf(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void fetchAdminSelf()
      .then((self) => {
        if (!cancelled) setIsAdmin(self !== null);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return isAdmin;
}