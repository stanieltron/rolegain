import type { IncomingMessage } from "node:http";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfiguration } from "../config/runtime.js";

export interface AuthenticatedActor {
  userId: string;
  email?: string;
  name?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface RequestAuthenticator {
  authenticate(request: IncomingMessage): Promise<AuthenticatedActor>;
}

export interface UserAccountAdmin {
  delete(userId: string): Promise<void>;
}

export function createUserAccountAdmin(
  configuration: RuntimeConfiguration,
): UserAccountAdmin {
  if (configuration.authMode === "local")
    return { delete: async () => undefined };

  const supabase = createClient(
    configuration.supabaseUrl!,
    configuration.supabaseServiceRoleKey!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
  return {
    delete: async (userId) => {
      const { error } = await supabase.auth.admin.deleteUser(userId);
      if (error && !/not found|does not exist/i.test(error.message))
        throw new HttpError(
          502,
          `The authentication account could not be removed: ${error.message}`,
          "auth_user_delete_failed",
        );
    },
  };
}

export function createRequestAuthenticator(
  configuration: RuntimeConfiguration,
): RequestAuthenticator {
  if (configuration.authMode === "local")
    return {
      authenticate: async () => ({
        userId: "candidate-1",
        email: "local@rolegain.invalid",
        name: "Local user",
      }),
    };

  const supabase = createClient(
    configuration.supabaseUrl!,
    configuration.supabasePublishableKey!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
  return new SupabaseRequestAuthenticator(supabase);
}

class SupabaseRequestAuthenticator implements RequestAuthenticator {
  constructor(private readonly supabase: SupabaseClient) {}

  async authenticate(
    request: IncomingMessage,
  ): Promise<AuthenticatedActor> {
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match)
      throw new HttpError(401, "Authentication required", "unauthenticated");

    const { data, error } = await this.supabase.auth.getUser(match[1]);
    if (error || !data.user)
      throw new HttpError(401, "Invalid or expired session", "invalid_session");

    return {
      userId: data.user.id,
      email: data.user.email,
      name:
        typeof data.user.user_metadata.full_name === "string"
          ? data.user.user_metadata.full_name
          : typeof data.user.user_metadata.name === "string"
            ? data.user.user_metadata.name
            : undefined,
    };
  }
}
