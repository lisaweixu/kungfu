import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App.jsx';
import { createFakeServer } from './fakeServer.js';

let server;
let user;

beforeEach(() => {
  server = createFakeServer();
  server.install();
  user = userEvent.setup();
});

afterEach(() => {
  server.uninstall();
});

async function renderApp() {
  render(<App />);
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: /KungFu/i })).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.queryByText(/Loading…/i)).not.toBeInTheDocument();
  });
}

describe('Main toolbar', () => {
  it('renders the four primary toolbar buttons', async () => {
    await renderApp();
    expect(screen.getByRole('button', { name: /^New member$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Refresh$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Summary$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Settings/i })).toBeInTheDocument();
  });

  it('does NOT render the old Manage class types button on main page', async () => {
    await renderApp();
    expect(screen.queryByRole('button', { name: /Manage class types/i })).not.toBeInTheDocument();
  });

  it('Summary button navigates to the Club summary page (regression for the bug we just fixed)', async () => {
    await renderApp();
    await user.click(screen.getByRole('button', { name: /^Summary$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Club summary/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^Back$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^KungFu$/i })).toBeInTheDocument();
    });
  });

  it('Settings button opens the Settings page; Back returns to main', async () => {
    await renderApp();
    await user.click(screen.getByRole('button', { name: /Settings/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Settings$/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^Back$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^KungFu$/i })).toBeInTheDocument();
    });
  });

  it('New member opens the form; Back cancels', async () => {
    await renderApp();
    await user.click(screen.getByRole('button', { name: /^New member$/i }));
    expect(screen.getByRole('heading', { name: /^New member$/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Back$/i }));
    expect(screen.getByRole('heading', { name: /^KungFu$/i })).toBeInTheDocument();
  });

  it('Refresh button reloads the member list', async () => {
    await renderApp();
    const initialCalls = server.state.requests.filter(
      (r) => r.method === 'GET' && r.url === '/api/members',
    ).length;
    await user.click(screen.getByRole('button', { name: /Refresh/i }));
    await waitFor(() => {
      const after = server.state.requests.filter(
        (r) => r.method === 'GET' && r.url === '/api/members',
      ).length;
      expect(after).toBeGreaterThan(initialCalls);
    });
  });
});

describe('Member list and search', () => {
  it('lists all members from the API', async () => {
    await renderApp();
    expect(screen.getByText(/Alice Test/i)).toBeInTheDocument();
    expect(screen.getByText(/Bob Demo/i)).toBeInTheDocument();
  });

  it('filters members by search query', async () => {
    await renderApp();
    const search = screen.getByRole('searchbox');
    await user.type(search, 'Alice');
    await waitFor(() => {
      expect(screen.getByText(/Alice Test/i)).toBeInTheDocument();
      expect(screen.queryByText(/Bob Demo/i)).not.toBeInTheDocument();
    });
  });
});

describe('New member form', () => {
  it('creates a member and opens its detail page', async () => {
    await renderApp();
    await user.click(screen.getByRole('button', { name: /^New member$/i }));
    await user.type(screen.getByLabelText(/^Name/i), 'Charlie New');
    await user.type(screen.getByLabelText(/^Phone/i), '555-1234');
    await user.type(screen.getByLabelText(/^Email/i), 'charlie@new.com');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Charlie New/i })).toBeInTheDocument();
    });
    expect(server.state.members.find((m) => m.name === 'Charlie New')).toBeTruthy();
  });
});

describe('Member detail page', () => {
  async function openAlice() {
    await renderApp();
    await user.click(screen.getByRole('button', { name: /Alice Test/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Alice Test/i })).toBeInTheDocument();
    });
  }

  it('shows toolbar with Back, Mark inactive', async () => {
    await openAlice();
    expect(screen.getByRole('button', { name: /Back/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark inactive/i })).toBeInTheDocument();
  });

  it('shows the Member info card with Edit info button', async () => {
    await openAlice();
    expect(screen.getByRole('heading', { name: /Member info/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit info/i })).toBeInTheDocument();
  });

  it('Edit info opens form, Save persists, Cancel reverts', async () => {
    await openAlice();
    await user.click(screen.getByRole('button', { name: /Edit info/i }));
    expect(screen.getByRole('heading', { name: /Edit member/i })).toBeInTheDocument();

    const emailInput = screen.getByLabelText(/^Email/i);
    await user.clear(emailInput);
    await user.type(emailInput, 'alice-new@example.com');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(screen.getByText('alice-new@example.com')).toBeInTheDocument();
    });
    expect(server.state.members.find((m) => m.id === 1).email).toBe('alice-new@example.com');
  });

  it('Edit info Cancel discards changes', async () => {
    await openAlice();
    await user.click(screen.getByRole('button', { name: /Edit info/i }));
    const emailInput = screen.getByLabelText(/^Email/i);
    await user.clear(emailInput);
    await user.type(emailInput, 'temp@junk.com');
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByText('temp@junk.com')).not.toBeInTheDocument();
    expect(server.state.members.find((m) => m.id === 1).email).toBe('alice@test.com');
  });

  it('shows Credits card with + Add button', async () => {
    await openAlice();
    expect(screen.getByRole('heading', { name: /^Credits$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ Add/i })).toBeInTheDocument();
  });

  it('Credits + Add opens modal with form; Cancel closes it without changes', async () => {
    await openAlice();
    await user.click(screen.getByRole('button', { name: /\+ Add/i }));
    expect(screen.getByRole('heading', { name: /Add prepaid credits/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: /Add prepaid credits/i }),
      ).not.toBeInTheDocument();
    });
  });

  it('Credits + Add → Add credits creates a batch, closes modal, refreshes', async () => {
    await openAlice();
    const beforeBatches = server.state.batches[1].length;
    await user.click(screen.getByRole('button', { name: /\+ Add/i }));
    const creditsInput = screen.getByLabelText(/^Credits/i);
    await user.clear(creditsInput);
    await user.type(creditsInput, '7');
    await user.click(screen.getByRole('button', { name: /^Add credits$/i }));
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: /Add prepaid credits/i }),
      ).not.toBeInTheDocument();
    });
    expect(server.state.batches[1].length).toBe(beforeBatches + 1);
    const newBatch = server.state.batches[1].at(-1);
    expect(newBatch.quantity).toBe(7);
  });

  it('Take class records attendance and updates balance', async () => {
    await openAlice();
    await user.click(screen.getByRole('button', { name: /Subtract from this class/i }));
    await waitFor(() => {
      const attendReqs = server.state.requests.filter(
        (r) => r.method === 'POST' && r.url === '/api/members/1/attend',
      );
      expect(attendReqs.length).toBeGreaterThan(0);
    });
  });

  it('Mark inactive flips active state and label', async () => {
    await openAlice();
    await user.click(screen.getByRole('button', { name: /Mark inactive/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Mark active/i })).toBeInTheDocument();
    });
    expect(server.state.members.find((m) => m.id === 1).active).toBeFalsy();
  });

  it('Credits class header toggles batch list collapsed/expanded', async () => {
    await openAlice();
    const findBatchList = () => document.querySelector('.credits-batches');
    expect(findBatchList()).toBeTruthy();
    const buttons = screen.getAllByRole('button').filter((b) => /Long Fist/.test(b.textContent));
    const classToggle = buttons.find((b) => b.classList.contains('credits-class-head'));
    expect(classToggle).toBeTruthy();
    await user.click(classToggle);
    await waitFor(() => {
      expect(findBatchList()).toBeNull();
    });
    await user.click(classToggle);
    await waitFor(() => {
      expect(findBatchList()).toBeTruthy();
    });
  });

  it('Back returns to the member list', async () => {
    await openAlice();
    await user.click(screen.getByRole('button', { name: /Back/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^KungFu$/i })).toBeInTheDocument();
    });
  });
});

describe('Settings page', () => {
  async function openSettings() {
    await renderApp();
    await user.click(screen.getByRole('button', { name: /Settings/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Settings/i })).toBeInTheDocument();
    });
  }

  it('renders the Class types card with Manage button', async () => {
    await openSettings();
    expect(screen.getByRole('heading', { name: /Class types/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Manage$/i })).toBeInTheDocument();
  });

  it('Manage toggles the class types editor', async () => {
    await openSettings();
    await user.click(screen.getByRole('button', { name: /^Manage$/i }));
    expect(screen.getByRole('button', { name: /Save class type/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Done$/i }));
    expect(screen.queryByRole('button', { name: /Save class type/i })).not.toBeInTheDocument();
  });

  it('can add a new class type', async () => {
    await openSettings();
    await user.click(screen.getByRole('button', { name: /^Manage$/i }));
    await user.type(screen.getByLabelText(/^Name/i), '散打 Sanda');
    await user.click(screen.getByRole('button', { name: /Save class type/i }));
    await waitFor(() => {
      expect(server.state.classTypes.find((c) => c.name === '散打 Sanda')).toBeTruthy();
    });
  });

  it('can remove a class type when more than one exists', async () => {
    await openSettings();
    await user.click(screen.getByRole('button', { name: /^Manage$/i }));
    const removeButtons = screen.getAllByRole('button', { name: /^Remove$/i });
    await user.click(removeButtons[0]);
    await waitFor(() => {
      expect(server.state.classTypes.length).toBe(1);
    });
  });

  it('Save settings persists owner name + email', async () => {
    await openSettings();
    const ownerName = screen.getByLabelText(/Owner name/i);
    await user.clear(ownerName);
    await user.type(ownerName, 'Updated Owner');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      expect(server.state.settings.owner_name).toBe('Updated Owner');
    });
  });

  it('Send test email button is disabled and shows hint when SMTP is not configured', async () => {
    await openSettings();
    const heading = screen.getByRole('heading', { name: /Send test email/i });
    const card = heading.closest('.card');
    expect(within(card).getByRole('button', { name: /Send test email/i })).toBeDisabled();
    expect(within(card).getByText(/Save SMTP password first/i)).toBeInTheDocument();
  });
});

describe('Summary view', () => {
  async function openSummary() {
    await renderApp();
    await user.click(screen.getByRole('button', { name: /Summary/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Club summary/i })).toBeInTheDocument();
    });
  }

  it('renders the Club summary headline', async () => {
    await openSummary();
    expect(screen.getByRole('heading', { name: /Club summary/i })).toBeInTheDocument();
  });

  it('Back returns to the main page', async () => {
    await openSummary();
    await user.click(screen.getByRole('button', { name: /Back/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^KungFu$/i })).toBeInTheDocument();
    });
  });
});
