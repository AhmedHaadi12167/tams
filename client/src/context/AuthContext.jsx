import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authAPI } from '../services/api';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async () => {
    const token = localStorage.getItem('tams_token');
    if (!token) { setLoading(false); return; }
    try {
      const res = await authAPI.me();
      setUser(res.data.data);
    } catch {
      localStorage.removeItem('tams_token');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUser(); }, [loadUser]);

  const login = async (email, password) => {
    const res = await authAPI.login({ email, password });
    const { token, user: userData } = res.data.data;
    localStorage.setItem('tams_token', token);
    setUser(userData);
    return userData;
  };

  /**
   * Tell the server first, so it clears the stored session and the token
   * stops working everywhere — not just in this browser. Forgetting the
   * token locally is not the same as retiring it; a copy taken beforehand
   * would otherwise stay valid until it expired on its own.
   *
   * The local clear happens either way. If the network call fails there is
   * nothing useful to say about it, and refusing to sign someone out
   * because the server was briefly unreachable would be worse than the
   * problem it solves.
   */
  const logout = async () => {
    try {
      await authAPI.logout();
    } catch {
      /* sign out locally regardless */
    }
    localStorage.removeItem('tams_token');
    setUser(null);
  };

  const hasRole = (...roles) => user && roles.includes(user.role);
  const isSuperAdmin = () => user?.role === 'super_admin';
  const isAdmin = () => ['super_admin', 'admin'].includes(user?.role);
  const canWrite = () => ['super_admin', 'admin', 'agent'].includes(user?.role);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, hasRole, isSuperAdmin, isAdmin, canWrite }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
