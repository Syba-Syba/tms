import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { call, mount } from './harness';
import { Register } from '../screens/register';
import { Home } from '../screens/home';
import { SettingsAccount } from '../screens/settings-account';
import { SettingsTeam } from '../screens/settings-team';

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });
const stamp = Date.now();

/** A landlord signs themselves up, works through the checklist, and adds an agent. */
describe('a new landlord', () => {
  it('signs up from the register screen and lands on their own empty dashboard', async () => {
    localStorage.clear();
    mount(
      '/register?as=landlord',
      <>
        <Route path="/register" element={<Register />} />
        <Route path="/" element={<Home />} />
      </>,
    );
    type(screen.getByLabelText('Business name'), `Clicks Rentals ${stamp}`);
    type(screen.getByLabelText('Phone'), '082 000 1111');
    type(screen.getByPlaceholderText('Your full name'), 'Clicks Owner');
    type(screen.getByPlaceholderText('Email'), `owner-${stamp}@example.co.za`);
    type(screen.getByPlaceholderText('Password, at least 8 characters'), 'a-long-password');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Create the account' }));

    const checklist = await screen.findByRole('region', { name: 'Set up your account' });
    expect(within(checklist).getByText('4 of 4 to go')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('tms.user')!).role).toBe('landlord');
    // None of the seeded landlord's tenants leak onto a new account.
    expect(screen.queryByText(/Naledi/)).toBeNull();
  });

  it('adds the bank account, and the bank fills its own branch code', async () => {
    mount('/settings/account', <Route path="/settings/account" element={<SettingsAccount />} />);
    const save = await screen.findByRole('button', { name: 'Save bank account' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Bank'), { target: { value: 'Capitec' } });
    expect((screen.getByLabelText('Branch code') as HTMLInputElement).value).toBe('470010');
    type(screen.getByLabelText('Account holder'), 'Clicks Owner');
    type(screen.getByLabelText('Account number'), '1234567890');
    fireEvent.click(save);
    await screen.findByText('Bank account saved');
    const account = await call('GET', '/landlord');
    expect(account.onboarding.bank).toBe(true);
    expect(account.account.bank).toMatchObject({ name: 'Capitec', branchCode: '470010' });
  });

  it('invites an agent from the team screen, who then waits to join', async () => {
    mount('/settings/team', <Route path="/settings/team" element={<SettingsTeam />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    type(screen.getByLabelText('Their name'), 'Clicks Agent');
    type(screen.getByLabelText('Their email'), `agent-${stamp}@example.co.za`);
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByText(`Invitation sent to agent-${stamp}@example.co.za`);
    const waiting = await screen.findByRole('region', { name: 'Waiting to join' });
    await waitFor(() => expect(within(waiting).getByText('Clicks Agent')).toBeTruthy());
  });
});
