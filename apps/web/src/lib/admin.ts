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