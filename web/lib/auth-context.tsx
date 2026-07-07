'use client';
import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

export interface AuthUser {
  sub: string;
  email: string;
  groups: string[];
}

export interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  isAdmin: boolean;
  login: () => void;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  isAdmin: false,
  login: () => {},
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

const COGNITO_DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? '';
const CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? '';
const REDIRECT_URI =
  typeof window !== 'undefined' ? `${window.location.origin}/` : '';

function parseJwt(token: string): Record<string, unknown> {
  const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(base64));
}

function extractTokenFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  return params.get('id_token');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    // Check URL hash for token from Cognito redirect
    const hashToken = extractTokenFromHash();
    if (hashToken) {
      sessionStorage.setItem('id_token', hashToken);
      window.history.replaceState(null, '', window.location.pathname);
      applyToken(hashToken);
      return;
    }
    // Check sessionStorage for existing token
    const stored = sessionStorage.getItem('id_token');
    if (stored) applyToken(stored);
  }, []);

  function applyToken(idToken: string) {
    try {
      const claims = parseJwt(idToken);
      const groups = (claims['cognito:groups'] as string[]) ?? [];
      setUser({
        sub: claims.sub as string,
        email: claims.email as string,
        groups,
      });
      setToken(idToken);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      // Invalid token — clear it
      sessionStorage.removeItem('id_token');
    }
  }

  const login = useCallback(() => {
    const url =
      `${COGNITO_DOMAIN}/login?client_id=${CLIENT_ID}` +
      `&response_type=token&scope=openid+email+profile` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    window.location.href = url;
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem('id_token');
    setUser(null);
    setToken(null);
    const url =
      `${COGNITO_DOMAIN}/logout?client_id=${CLIENT_ID}` +
      `&logout_uri=${encodeURIComponent(REDIRECT_URI)}`;
    window.location.href = url;
  }, []);

  const isAdmin = user?.groups.includes('admin') ?? false;

  return (
    <AuthContext.Provider value={{ user, token, isAdmin, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
