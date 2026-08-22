/* Admin dashboard behaviour. */
(function () {
  const modalEl = document.getElementById('detailModal');
  const modal = new bootstrap.Modal(modalEl);
  const content = document.getElementById('detailContent');

  async function openDetail(id) {
    content.innerHTML = '<div class="p-4 text-center text-muted">Loading…</div>';
    modal.show();
    const res = await fetch(`/admin/bookings/${id}`);
    content.innerHTML = await res.text();
    wireActions(id);
  }

  async function patch(url, body) {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.json();
  }

  function wireActions(id) {
    content.querySelectorAll('.js-pay').forEach((btn) =>
      btn.addEventListener('click', async () => {
        await patch(`/admin/bookings/${id}/payment`, { mode: btn.dataset.mode });
        refreshAfterAction(id);
      })
    );

    const jobBtn = content.querySelector('.js-job');
    if (jobBtn) jobBtn.addEventListener('click', async () => {
      await patch(`/admin/bookings/${id}/job`);
      refreshAfterAction(id);
    });

    const certForm = content.querySelector('.js-cert');
    if (certForm) certForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(certForm).entries());
      const out = await patch(`/admin/bookings/${id}/certificate`, data);
      if (out.ok) alert('Certificate details saved.');
    });

    const cancelForm = content.querySelector('.js-cancel');
    if (cancelForm) cancelForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(cancelForm, e.submitter).entries());
      const out = await patch(`/admin/bookings/${id}/cancel`, data);
      if (out.ok) refreshAfterAction(id);
      else alert(out.error || 'Could not cancel this booking.');
    });

    const settleForm = content.querySelector('.js-settle');
    if (settleForm) settleForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(settleForm).entries());
      const out = await patch(`/admin/bookings/${id}/settle-quote`, data);
      if (out.ok) refreshAfterAction(id);
    });
  }

  async function refreshAfterAction(id) {
    // Re-load the fragment to reflect new state, and reload the page list soon.
    const res = await fetch(`/admin/bookings/${id}`);
    content.innerHTML = await res.text();
    wireActions(id);
  }

  document.querySelectorAll('.booking-tile').forEach((tile) =>
    tile.addEventListener('click', () => openDetail(tile.dataset.id))
  );

  // The Calendar tab opens the same detail modal rather than building its own.
  window.openBookingDetail = openDetail;

  // Refresh whatever view is on screen when the modal closes. Reloading the
  // page from the Calendar tab would bounce the operator back to the list, so
  // that case just tells the calendar to refetch.
  modalEl.addEventListener('hidden.bs.modal', () => {
    if (document.querySelector('#pane-calendar.active')) {
      document.dispatchEvent(new CustomEvent('hallel:booking-changed'));
      return;
    }
    window.location.reload();
  });
})();
