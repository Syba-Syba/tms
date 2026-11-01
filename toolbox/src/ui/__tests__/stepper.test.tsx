import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Stepper } from '../stepper';

describe('Stepper', () => {
  it('lets a step say it is done out of order', () => {
    const { container } = render(
      <Stepper current={0} steps={[{ title: 'Landlord', done: false }, { title: 'Tenant', done: true }]} />,
    );
    const dots = container.querySelectorAll('li > span:nth-child(2) > span:first-child');
    expect(dots[0]!.className).not.toContain('bg-brand-500');
    expect(dots[1]!.className).toContain('bg-brand-500');
  });
});
