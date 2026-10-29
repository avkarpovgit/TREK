import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { BookingReviewDraft } from '../../src/components/Planner/parsedItemToDraft';
import { ReservationModal } from '../../src/components/Planner/ReservationModal';
import MReservationSheet from '../../src/mobile/screens/trip/sheets/MReservationSheet';
import { useBookingEdits } from '../../src/pages/tripPlanner/useBookingEdits';
import { useAuthStore } from '../../src/store/authStore';
import { useBackgroundTasksStore } from '../../src/store/backgroundTasksStore';
import { useTripStore, type TripStoreState } from '../../src/store/tripStore';
import { _resetNetworkMode } from '../../src/sync/networkMode';
import { buildReservation, buildTrip, buildUser } from '../helpers/factories';
import { buildPlanner } from '../helpers/mobileTrip';
import { act, fireEvent, render, screen, waitFor } from '../helpers/render';
import { resetAllStores, seedStore } from '../helpers/store';

function setupMobile({ gate, failSecond = false }: { gate?: Promise<void>; failSecond?: boolean } = {}) {
  resetAllStores();
  _resetNetworkMode();
  useBackgroundTasksStore.setState({ tasks: [] });
  const trip = buildTrip({ id: 1 });
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useTripStore, { trip, budgetItems: [] });
  const empty: never[] = [];
  const noop = vi.fn();
  const close = vi.fn();
  const saved = buildReservation({ id: 77, title: 'Mobile fixture booking', type: 'other' });
  const add = vi.fn(async () => saved);
  const update = vi.fn(async () => saved);
  let failed = false;
  const upload = vi.fn(async (_tripId: number, fd: FormData) => {
    if ((fd.get('file') as File).name === 'second.pdf' && failSecond && !failed) {
      failed = true;
      throw new Error('upload failed');
    }
    if (gate !== undefined) await gate;
  });
  const actions = {
    ...useTripStore.getState(),
    addReservation: add,
    updateReservation: update,
    addFile: upload,
  } as unknown as TripStoreState;
  const prefill: BookingReviewDraft = {
    title: 'Mobile fixture booking',
    type: 'other',
    _sourceFiles: (failSecond ? ['first.pdf', 'second.pdf'] : ['ticket.pdf']).map(
      (name) => new File(['fixture'], name, { type: 'application/pdf' })
    ),
  };
  const toast = { success: noop, error: noop, warning: noop, info: noop };
  function MobileEditor() {
    const [open, setOpen] = useState(true);
    const [reservation, setReservation] = useState<ReturnType<typeof buildReservation> | null>(null);
    const booking = useBookingEdits({
      tripId: 1,
      trip,
      tripActions: actions,
      toast,
      t: ((key: string) => key) as never,
      places: empty,
      selectedDayId: null,
      canUploadFiles: true,
      setTripAccommodations: noop,
      editingReservation: reservation,
      setEditingReservation: setReservation,
      setShowReservationModal: (value) => {
        close(value);
        setOpen(value);
      },
      editingTransport: null,
      setEditingTransport: noop,
      setShowTransportModal: noop,
      setTransportModalDayId: noop,
    });
    const planner = buildPlanner({
      tripId: 1,
      trip,
      days: empty,
      places: empty,
      tripActions: actions,
      showReservationModal: open,
      editingReservation: reservation,
      reservationPrefill: prefill,
      handleSaveReservation: booking.handleSaveReservation,
      canUploadFiles: true,
      tripMembers: empty,
    });
    return <MReservationSheet planner={planner} onOpenExpense={noop} />;
  }
  render(<MobileEditor />);
  return { add, update, upload, close };
}

it('mobile keeps the booking sheet open until the actual save pipeline finishes PDF upload', async () => {
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const x = setupMobile({ gate });
  await userEvent.click(screen.getByRole('button', { name: /^common.add$/ }));
  try {
    await waitFor(() => expect(x.upload).toHaveBeenCalledTimes(1));
    expect(x.close).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  } finally {
    await act(async () => {
      complete();
      await gate;
    });
  }
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('mobile retry uploads only the remaining PDF against the saved booking', async () => {
  const x = setupMobile({ failSecond: true });
  await userEvent.click(screen.getByRole('button', { name: /^common.add$/ }));
  await waitFor(() => expect(x.upload).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.queryByText('first.pdf')).not.toBeInTheDocument();
  expect(screen.getByText('second.pdf')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^common.add$/ }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(x.add).toHaveBeenCalledTimes(1);
  expect(x.update).toHaveBeenCalledTimes(1);
  expect(x.upload.mock.calls.map(([, fd]) => (fd.get('file') as File).name)).toEqual([
    'first.pdf',
    'second.pdf',
    'second.pdf',
  ]);
  const args = x.update.mock.calls[0] as unknown as [number, number, Record<string, unknown>];
  expect(args[1]).toBe(77);
  expect(Object.keys(args[2]).filter((k) => k.startsWith('_'))).toEqual([]);
});

vi.mock('react-router', async (importActual) => {
  const actual = await importActual<typeof import('react-router')>();
  return { ...actual, useParams: () => ({ id: '1' }) };
});

function setup({
  editing = false,
  files = ['ticket.pdf'],
  gate,
  failFile,
  canUpload = true,
}: {
  editing?: boolean;
  files?: string[];
  gate?: Promise<void>;
  failFile?: string;
  canUpload?: boolean;
} = {}) {
  resetAllStores();
  _resetNetworkMode();
  useBackgroundTasksStore.setState({ tasks: [] });
  const trip = buildTrip({ id: 1 });
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useTripStore, { trip, budgetItems: [] });
  const trace: string[] = [];
  let failed = false;
  const upload = vi.fn(async (_tripId: number, fd: FormData) => {
    const name = (fd.get('file') as File).name;
    trace.push('upload-started:' + name);
    if (name === failFile && !failed) {
      failed = true;
      throw new Error('upload failed');
    }
    if (gate !== undefined) await gate;
    trace.push('upload-finished:' + name);
  });
  const saved = buildReservation({ id: editing ? 9 : 77, title: 'PDF booking', type: 'other' });
  const add = vi.fn(async () => {
    trace.push('booking-created');
    return saved;
  });
  const update = vi.fn(async () => {
    trace.push('booking-updated');
    return saved;
  });
  const actions = {
    ...useTripStore.getState(),
    addReservation: add,
    updateReservation: update,
    addFile: upload,
  } as unknown as TripStoreState;
  const prefill: BookingReviewDraft = {
    title: 'PDF booking',
    type: 'other',
    _sourceFiles: files.map((name) => new File(['fixture'], name, { type: 'application/pdf' })),
  };
  const empty: never[] = [];
  const noop = vi.fn();
  const directUpload = vi.fn((fd: FormData) => actions.addFile(1, fd));
  const toast = { success: noop, error: noop, warning: noop, info: noop };
  function ComposedEditor() {
    const [open, setOpen] = useState(true);
    const [reservation, setReservation] = useState(editing ? saved : null);
    const bookings = useBookingEdits({
      tripId: 1,
      trip,
      tripActions: actions,
      toast,
      t: ((key: string) => key) as never,
      places: empty,
      selectedDayId: null,
      canUploadFiles: canUpload,
      setTripAccommodations: noop,
      editingReservation: reservation,
      setEditingReservation: setReservation,
      setShowReservationModal: (value) => {
        trace.push('dialog-closed');
        setOpen(value);
      },
      editingTransport: null,
      setEditingTransport: noop,
      setShowTransportModal: noop,
      setTransportModalDayId: noop,
    });
    return (
      <ReservationModal
        isOpen={open}
        onClose={noop}
        onSave={bookings.handleSaveReservation}
        reservation={reservation}
        days={empty}
        places={empty}
        assignments={{}}
        selectedDayId={null}
        files={empty}
        accommodations={empty}
        tripMembers={empty}
        onFileUpload={canUpload ? directUpload : undefined}
        onFileDelete={async () => {}}
        prefill={prefill}
      />
    );
  }
  render(<ComposedEditor />);
  return { trace, upload, add, update, directUpload };
}

it('keeps the actual booking dialog open until PDF upload finishes', async () => {
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const x = setup({ gate });
  expect(screen.getByText('ticket.pdf')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
  try {
    await waitFor(() => expect(x.upload).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(x.trace).toEqual(['booking-created', 'upload-started:ticket.pdf']);
  } finally {
    await act(async () => {
      complete();
      await gate;
    });
  }
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(x.trace).toEqual([
    'booking-created',
    'upload-started:ticket.pdf',
    'upload-finished:ticket.pdf',
    'dialog-closed',
  ]);
  expect(x.directUpload).not.toHaveBeenCalled();
});

it('retries only remaining files on the already-created booking without duplicate booking or first PDF', async () => {
  const x = setup({ files: ['first.pdf', 'second.pdf'], failFile: 'second.pdf' });
  await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
  await waitFor(() => expect(x.upload).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('second.pdf')).toBeInTheDocument();
  expect(screen.queryByText('first.pdf')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(x.add).toHaveBeenCalledTimes(1);
  expect(x.update).toHaveBeenCalledTimes(1);
  expect(x.upload.mock.calls.map(([, fd]) => (fd.get('file') as File).name)).toEqual([
    'first.pdf',
    'second.pdf',
    'second.pdf',
  ]);
  const args = x.update.mock.calls[0] as unknown as [number, number, Record<string, unknown>];
  expect(args[1]).toBe(77);
  expect(Object.keys(args[2]).filter((key) => key.startsWith('_'))).toEqual([]);
});

it('keeps an edited booking PDF visible and retryable after upload failure', async () => {
  const x = setup({ editing: true, failFile: 'edited.pdf' });
  fireEvent.change(document.querySelector('input[type=file]') as HTMLInputElement, {
    target: { files: [new File(['fixture'], 'edited.pdf')] },
  });
  expect(screen.getByText('edited.pdf')).toBeInTheDocument();
  expect(x.upload).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: /^Update$/i }));
  await waitFor(() => expect(x.upload).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('edited.pdf')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^Update$/i }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(x.add).not.toHaveBeenCalled();
  expect(x.update).toHaveBeenCalledTimes(2);
});

it('saves without uploading parsed source files when the member has no upload capability', async () => {
  const x = setup({ canUpload: false });
  await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(x.add).toHaveBeenCalledTimes(1);
  expect(x.upload).not.toHaveBeenCalled();
});
