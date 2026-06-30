"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  performSilentRefresh,
  registerAuthCallbacks,
  setAccessToken,
} from "@/lib/api-client";
import * as authApi from "@/lib/api/auth";
import type { AuthUser, RegisterInput } from "@/lib/api-types";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const router = useRouter();
  const queryClient = useQueryClient();

  // Wire the api-client → React bridge once. A background refresh keeps `user`
  // fresh; a terminal 401 clears the session and bounces to login.
  useEffect(() => {
    registerAuthCallbacks({
      onRefreshed: (data) => setUser(data.user),
      onUnauthorized: () => {
        setUser(null);
        setStatus("unauthenticated");
        queryClient.clear();
      },
    });
  }, [queryClient]);

  // Silent re-authentication on first load. The single-flight refresh dedupes
  // React StrictMode's double-invoke, so the browser fires at most one request.
  useEffect(() => {
    let active = true;
    void performSilentRefresh().then((data) => {
      if (!active) return;
      setUser(data?.user ?? null);
      setStatus(data ? "authenticated" : "unauthenticated");
    });
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await authApi.login(email, password);
    setAccessToken(data.accessToken);
    setUser(data.user);
    setStatus("authenticated");
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const data = await authApi.register(input);
    setAccessToken(data.accessToken);
    setUser(data.user);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Clear locally regardless of the server response.
    }
    setAccessToken(null);
    setUser(null);
    setStatus("unauthenticated");
    queryClient.clear();
    router.push("/login");
  }, [queryClient, router]);

  return (
    <AuthContext.Provider value={{ user, status, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
