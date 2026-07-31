import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route } from 'react-router-dom';
import { mount, signInAs } from './harness';
import { Login } from '../screens/login';
import { Register } from '../screens/register';
import { AppShell } from '../components/app-shell';
import { Home } from '../screens/home';

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });

describe('signing in and out', () => {
  it('refuses a wrong password with a toast and signs in with the right one', async () => {
    localStorage.clear();
    mount(
      '/login',
      <>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>PROBE-HOME</div>} />
      </>,
    );

    type(screen.getByPlaceholderText('Email'), 'landlord@example.co.za');
    type(screen.getByPlaceholderText('Password'), 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Sign in failed');

    type(screen.getByPlaceholderText('Password'), 'dev');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('PROBE-HOME');
    expect(JSON.parse(localStorage.getItem('tms.user')!)).toMatchObject({
      sub: 'sub-landlord',
      role: 'landlord',
    });
    expect(localStorage.getItem('CapacitorStorage.id_token')).toBeTruthy();
  });

  it('creates an account from the register screen and lands on the application', async () => {
    localStorage.clear();
    mount(
      '/register',
      <>
        <Route path="/register" element={<Register />} />
        <Route path="/apply" element={<div>PROBE-APPLY</div>} />
      </>,
    );

    type(screen.getByPlaceholderText('Full name'), 'Click Tester');
    type(screen.getByPlaceholderText('Email'), `clicks-${Date.now()}@example.co.za`);
    type(screen.getByPlaceholderText('Password, at least 8 characters'), 'a-long-password');
    fireEvent.click(screen.getByRole('button', { name: 'Create the account' }));
    await screen.findByText('PROBE-APPLY');
    expect(JSON.parse(localStorage.getItem('tms.user')!).role).toBe('tenant');
  });

  it('shows who is signed in and logs out from the shell', async () => {
    await signInAs('landlord@example.co.za');
    mount(
      '/',
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
      </Route>,
    );
    await screen.findByText('Mokoena Properties');
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => {
      expect(localStorage.getItem('tms.user')).toBeNull();
      expect((window as any).__assignedUrls?.at(-1)).toBe('/login');
    });
  });
});
