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

  // Reload the dashboard list when the modal closes (to update dots/badges).
  modalEl.addEventListener('hidden.bs.modal', () => window.location.reload());
})();
