import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Button, Input, Card } from '../components/ui';
import toast from 'react-hot-toast';
import { Plane } from 'lucide-react';

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    business_name: '', business_email: '', business_phone: '',
    admin_name: '', admin_email: '', admin_password: '',
  });
  const [loading, setLoading] = useState(false);

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await register(form);
      toast.success('Agency registered! Welcome to TAMS.');
      navigate('/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl shadow-lg mb-4">
            <Plane className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Register Your Agency</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">Set up TAMS for your travel agency</p>
        </div>

        <Card className="p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 uppercase tracking-wide">Agency Info</h3>
              <div className="space-y-3">
                <Input label="Agency name" placeholder="Mogadishu Travel Co." value={form.business_name} onChange={set('business_name')} required />
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Agency email" type="email" placeholder="info@agency.com" value={form.business_email} onChange={set('business_email')} required />
                  <Input label="Phone" type="tel" placeholder="+252 XX XXX XXXX" value={form.business_phone} onChange={set('business_phone')} />
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 uppercase tracking-wide">Admin Account</h3>
              <div className="space-y-3">
                <Input label="Your full name" placeholder="Ahmed Hassan" value={form.admin_name} onChange={set('admin_name')} required />
                <Input label="Admin email" type="email" placeholder="admin@agency.com" value={form.admin_email} onChange={set('admin_email')} required />
                <Input label="Password" type="password" placeholder="Min 8 characters" value={form.admin_password} onChange={set('admin_password')} required />
              </div>
            </div>

            <Button type="submit" loading={loading} className="w-full" size="lg">
              Create Agency Account
            </Button>
          </form>
          <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-4">
            Already registered?{' '}
            <Link to="/login" className="text-blue-600 hover:underline font-medium">Sign in</Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
