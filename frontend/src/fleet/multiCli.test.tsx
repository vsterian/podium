import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { makeSession } from './fixtures';
import { filterSessions, sessionTokens } from './logic';
import { FactsBar } from './components/FactsBar';
import { Toolbar } from './components/Wall';

afterEach(cleanup);
it('uses observed cumulative usage for native session token totals', () => {
  const s = makeSession({ tokensTotal: 220, context: { tokens: 100, window: 1000, percent: 10 },
    integration: { engine: 'copilot', nativeId: 's', mode: 'extension', metrics: ['tokens', 'context'] } });
  expect(sessionTokens(s)).toBe(220);
});
it('filters by engine independently of model and defaults legacy sessions to Claude', () => {
  const codex = makeSession({ id: 'codex:s', integration: { engine: 'codex', nativeId: 's', mode: 'hooks', metrics: [] } });
  const claude = makeSession({ id: 'legacy' });
  expect(filterSessions([codex, claude], { status: 'all', q: '', engine: 'codex' })).toEqual([codex]);
  expect(filterSessions([codex, claude], { status: 'all', q: '', engine: 'claude-code' })).toEqual([claude]);
  expect(filterSessions([codex], { status: 'all', q: 'codex' })).toEqual([codex]);
});
it('shows unavailable native telemetry and the actual reporter type', () => {
  const s = makeSession({ integration: { engine: 'copilot', nativeId: 's', mode: 'hooks', metrics: [] }, costUsd: null });
  const { container } = render(<FactsBar s={s} now={Date.now()} onAgent={() => {}} />);
  const facts = [...container.querySelectorAll('.fact')];
  expect(facts.find((f) => f.querySelector('.k')?.textContent === 'Tokens')?.textContent).toContain('unavailable');
  expect(screen.getByText('copilot · hooks')).toBeInTheDocument();
  expect(facts.find((f) => f.querySelector('.k')?.textContent === 'Blowouts')?.textContent).toContain('unavailable');
});
it('offers an accessible CLI selector without losing the other filters', () => {
  let selected: unknown;
  render(<Toolbar filter={{ status: 'waiting', q: 'repo' }} onFilter={(f) => { selected = f; }} sort="status" onSort={() => {}} shown={1} cleared={0} />);
  fireEvent.change(screen.getByLabelText('Filter by CLI'), { target: { value: 'copilot' } });
  expect(selected).toEqual({ status: 'waiting', q: 'repo', engine: 'copilot' });
});
