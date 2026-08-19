import React, { useState, useEffect, useCallback } from 'react';
import { usersAPI } from '../services/api';
import { Button, Card, Badge, Spinner, EmptyState, Pagination, Input, Select, Modal } from '../components/ui';
import toast from 'react-hot-toast';
import { Users, Plus, Pencil, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { useAuth } from '../context/AuthContext';

const roleBadge = { admin: 'warning', agent: 'info', accountant: 'purple', super_admin: 'danger' };

export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState({ open: false, user: null });
  const [form, setForm] = useState({ name: '', email: '', role: 'agent', password: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    usersAPI.list({ page, limit: 20, search })
      .then(res => { setUsers(res.data.data); setMeta(res.data.meta); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page, search]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm({ name: '', email: '', role: 'agent', password: '' });
    setModal({ open: true, user: null });
  };

  const openEdit = (u) => {
    setForm({ name: u.name, email: u.email, role: u.role, password: '' });
    setModal({ open: true, user: u });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (modal.user) {
        await usersAPI.update(modal.user.id, { name: form.name, role: form.role });
        toast.success('User updated');
      } else {
        await usersAPI.create(form);
        toast.success('User created');
      }
      setModal({ open: false, user: null });
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to save user');
    } finally { setSaving(false); }
  };

  const handleDelete = async (u) => {
    if (!window.confirm(`Delete ${u.name}?`)) return;
    try {
      await usersAPI.delete(u.id);
      toast.success('User deleted');
      load();
    } catch { toast.error('Failed to delete user'); }
  };

  const handleToggleActive = async (u) => {
    try {
      await usersAPI.update(u.id, { name: u.name, role: u.role, is_active: !u.is_active });
      toast.success(u.is_active ? 'User deactivated' : 'User activated');
      load();
    } catch { toast.error('Failed to update user'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Team</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{meta.total} staff members</p>
        </div>
        <Button onClick={openCreate}><Plus className="w-4 h-4" /> Add Member</Button>
      </div>

      <Card className="p-4">
        <Input
          placeholder="Search by name or email..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          className="max-w-md"
        />
      </Card>

      <Card>
        {loading ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : users.length === 0 ? (
          <EmptyState icon={Users} title="No team members" description="Add your first staff member." action={<Button onClick={openCreate}><Plus className="w-4 h-4" /> Add</Button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  {['Name', 'Email', 'Role', 'Status', 'Last login', ''].map(h => (
                    <th key={h} className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {users.map(u => (
                  <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{u.name} {u.id === me?.id && <span className="text-xs text-blue-500">(you)</span>}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{u.email}</td>
                    <td className="px-4 py-3"><Badge variant={roleBadge[u.role]}>{u.role.replace('_', ' ')}</Badge></td>
                    <td className="px-4 py-3">
                      <button onClick={() => u.id !== me?.id && handleToggleActive(u)} disabled={u.id === me?.id}>
                        <Badge variant={u.is_active ? 'success' : 'danger'}>{u.is_active ? 'Active' : 'Inactive'}</Badge>
                      </button>
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                      {u.last_login ? format(new Date(u.last_login), 'dd MMM yyyy HH:mm') : 'Never'}
                    </td>
                    <td className="px-4 py-3">
                      {u.id !== me?.id && (
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(u)}>
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(u)}
                            className="text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-4 pb-4">
          <Pagination page={page} totalPages={meta.totalPages} onChange={setPage} />
        </div>
      </Card>

      <Modal open={modal.open} onClose={() => setModal({ open: false, user: null })} title={modal.user ? 'Edit Team Member' : 'Add Team Member'}>
        <form onSubmit={handleSave} className="space-y-4">
          <Input label="Full name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
          {!modal.user && (
            <Input label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
          )}
          <Select label="Role" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="admin">Admin</option>
            <option value="agent">Agent</option>
            <option value="accountant">Accountant</option>
          </Select>
          {!modal.user && (
            <Input label="Password" type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Min 8 characters" required />
          )}
          <div className="flex gap-3 pt-2">
            <Button type="submit" loading={saving}>{modal.user ? 'Save Changes' : 'Create User'}</Button>
            <Button type="button" variant="secondary" onClick={() => setModal({ open: false, user: null })}>Cancel</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
