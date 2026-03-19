import type { User } from "https://esm.sh/@supabase/supabase-js@2";
import { createServiceClient } from "./supabase.ts";

export type AdminRole = "admin" | "operator" | "viewer";

export interface AuthenticatedAdmin {
  user: User;
  role: AdminRole;
}

function resolveRole(user: User): AdminRole {
  const appRole = user.app_metadata?.role;
  const userRole = user.user_metadata?.role;
  const rawRole = appRole ?? userRole ?? "viewer";

  if (rawRole === "admin" || rawRole === "operator" || rawRole === "viewer") {
    return rawRole;
  }

  return "viewer";
}

export async function requireAdmin(
  req: Request,
  minRole: AdminRole = "viewer",
): Promise<AuthenticatedAdmin> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    throw new Error("Unauthorized");
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    throw new Error("Unauthorized");
  }

  const role = resolveRole(data.user);
  const roleOrder: Record<AdminRole, number> = { viewer: 1, operator: 2, admin: 3 };
  if (roleOrder[role] < roleOrder[minRole]) {
    throw new Error("Forbidden");
  }

  return { user: data.user, role };
}
