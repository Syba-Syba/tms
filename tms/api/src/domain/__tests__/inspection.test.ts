import { describe, expect, it } from 'vitest';
import { outgoingWindow, ROOM_TEMPLATE } from '../inspection';

describe('outgoingWindow', () => {
  it('opens three days before the lease ends', () => {
    const { opens, closes } = outgoingWindow(new Date('2027-08-31'));
    expect(opens.toISOString().slice(0, 10)).toBe('2027-08-28');
    expect(closes.toISOString().slice(0, 10)).toBe('2027-08-31');
  });
  it('crosses a month boundary cleanly', () => {
    const { opens } = outgoingWindow(new Date('2027-03-01'));
    expect(opens.toISOString().slice(0, 10)).toBe('2027-02-26');
  });
});

describe('ROOM_TEMPLATE', () => {
  it('covers every room a walkthrough visits', () => {
    expect(Object.keys(ROOM_TEMPLATE)).toEqual(
      expect.arrayContaining(['Entrance', 'Lounge', 'Kitchen', 'Bedroom', 'Bathroom', 'Exterior']),
    );
  });
  it('lists no room twice and no empty room', () => {
    for (const [room, items] of Object.entries(ROOM_TEMPLATE)) {
      expect(items.length, room).toBeGreaterThan(0);
      expect(new Set(items).size, room).toBe(items.length);
    }
  });
});
