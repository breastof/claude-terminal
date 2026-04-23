"use client";

import { createContext, useContext, useEffect, useState } from "react";

export interface User {
  userId: number;
  login: string;
  firstName: string;
  lastName: string;
  role: "admin" | "user" | "guest";
}

interface UserContextValue {
  user: User | null;
  loading: boolean;
  isGuest: boolean;
}

const UserContext = createContext<UserContextValue>({
  user: null,
  loading: true,
  isGuest: false,
});

export function useUser() {
  return useContext(UserContext);
}

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const check = async (initial: boolean) => {
      try {
        const res = await fetch("/api/auth/check", { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
        } else if (res.status === 401) {
          setUser(null);
          if (!initial && window.location.pathname !== "/") {
            window.location.href = "/";
          }
        }
      } catch {}
    };

    check(true).finally(() => { if (!cancelled) setLoading(false); });
    const id = setInterval(() => check(false), 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const isGuest = user?.role === "guest";

  return (
    <UserContext.Provider value={{ user, loading, isGuest }}>
      {children}
    </UserContext.Provider>
  );
}
