/* Hallel AquaCare — booking form behaviour (runs in the browser). */
(function () {
  const cfg = JSON.parse(document.getElementById('bookingConfig').textContent);
  const priceList = cfg.priceList || [];
  const base = cfg.baseLocation || { lat: 5.7167, lng: -0.2 };

  const money = (n) => 'GHS ' + Number(n || 0).toFixed(2);

  // ---------------- Map ----------------
  const map = L.map('map').setView([base.lat, base.lng], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  // Base marker (business)
  L.circle([base.lat, base.lng], { radius: cfg.freeRadiusKm * 1000, color: '#1b9dd9', weight: 1, fillOpacity: 0.05 }).addTo(map);
  L.marker([base.lat, base.lng], { title: base.name || 'Base' }).addTo(map).bindPopup('Our base');

  // Look up a human-readable address for a dropped/dragged pin (Nominatim reverse).
  async function reverseGeocode(lat, lng) {
    try {
      const url = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data = await res.json();
      return data && data.display_name ? data.display_name : '';
    } catch (_) { return ''; }
  }

  let clientMarker = null;
  function setClient(lat, lng, label) {
    document.getElementById('lat').value = lat;
    document.getElementById('lng').value = lng;
    if (label) {
      document.getElementById('address').value = label;
    } else {
      // No label (map click / my-location) — resolve the address from the pin.
      reverseGeocode(lat, lng).then((name) => { if (name) document.getElementById('address').value = name; });
    }
    if (!clientMarker) {
      clientMarker = L.marker([lat, lng], { draggable: true }).addTo(map);
      clientMarker.on('dragend', () => {
        const p = clientMarker.getLatLng();
        document.getElementById('lat').value = p.lat;
        document.getElementById('lng').value = p.lng;
        reverseGeocode(p.lat, p.lng).then((name) => { if (name) document.getElementById('address').value = name; });
        refreshQuote();
      });
    } else {
      clientMarker.setLatLng([lat, lng]);
    }
    map.setView([lat, lng], 14);
    refreshQuote();
  }

  map.on('click', (e) => setClient(e.latlng.lat, e.latlng.lng));

  document.getElementById('myLocationBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return alert('Geolocation not supported.');
    navigator.geolocation.getCurrentPosition(
      (pos) => setClient(pos.coords.latitude, pos.coords.longitude),
      () => alert('Could not get your location. Please drop the pin manually.')
    );
  });

  async function geocode() {
    const q = document.getElementById('addressSearch').value.trim();
    if (!q) return;
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q + ', Ghana');
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data = await res.json();
      if (data && data[0]) setClient(parseFloat(data[0].lat), parseFloat(data[0].lon), data[0].display_name);
      else alert('Location not found. Try dropping the pin on the map.');
    } catch (_) {
      alert('Search failed. Please drop the pin on the map.');
    }
  }
  document.getElementById('searchBtn').addEventListener('click', geocode);
  document.getElementById('addressSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); geocode(); }
  });

  // ---------------- Tank rows ----------------
  const rowsEl = document.getElementById('tankRows');

  function optionsHtml() {
    return priceList.map((p) => `<option value="${p.sizeKey}">${p.label}</option>`).join('');
  }

  function addRow() {
    const row = document.createElement('div');
    row.className = 'tank-row p-2 d-flex flex-wrap gap-2 align-items-center';
    row.innerHTML = `
      <select class="form-select form-select-sm tank-size flex-grow-1" style="min-width:150px">${optionsHtml()}</select>
      <select class="form-select form-select-sm tank-tier" style="max-width:160px">
        <option value="standard">Standard</option>
        <option value="preserve">Clean &amp; Preserve</option>
      </select>
      <input type="number" class="form-control form-control-sm tank-qty" style="max-width:80px" min="1" value="1" />
      <button type="button" class="btn btn-sm btn-outline-danger remove-tank">&times;</button>`;
    rowsEl.appendChild(row);
    row.querySelector('.tank-size').addEventListener('change', refreshQuote);
    row.querySelector('.tank-tier').addEventListener('change', refreshQuote);
    row.querySelector('.tank-qty').addEventListener('input', refreshQuote);
    row.querySelector('.remove-tank').addEventListener('click', () => { row.remove(); refreshQuote(); });
    refreshQuote();
  }
  document.getElementById('addTank').addEventListener('click', addRow);

  function collectTanks() {
    return [...rowsEl.querySelectorAll('.tank-row')].map((r) => ({
      sizeKey: r.querySelector('.tank-size').value,
      tier: r.querySelector('.tank-tier').value === 'preserve' ? 'preserve' : 'standard',
      quantity: Math.max(1, parseInt(r.querySelector('.tank-qty').value, 10) || 1),
    }));
  }

  // ---------------- Live quote ----------------
  let lastQuote = null;
  let debounce;
  function refreshQuote() {
    clearTimeout(debounce);
    debounce = setTimeout(doQuote, 250);
  }

  async function doQuote() {
    const tanks = collectTanks();
    document.getElementById('tanksInput').value = JSON.stringify(tanks);
    if (!tanks.length) {
      document.getElementById('summaryLines').textContent = 'Add a tank to see pricing…';
      return;
    }
    const payload = {
      tanks: JSON.stringify(tanks), // each tank carries its own tier
      lat: document.getElementById('lat').value,
      lng: document.getElementById('lng').value,
    };
    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const { quote } = await res.json();
      lastQuote = quote;
      renderQuote(quote);
      syncSchedule(quote);
    } catch (_) { /* leave last render */ }
  }

  function renderQuote(q) {
    document.getElementById('summaryLines').innerHTML = q.lines
      .map((l) => `<div class="d-flex justify-content-between"><span>${l.quantity}× ${l.label} <span class="text-white-50">(${l.tier === 'preserve' ? 'Clean & Preserve' : 'Standard'})</span></span><span>${money(l.lineTotal)}</span></div>`)
      .join('');
    document.getElementById('sumSubtotal').textContent = money(q.tanksSubtotal);
    document.getElementById('minCalloutNote').classList.toggle('d-none', !q.minCalloutApplied);

    const transportEl = document.getElementById('sumTransport');
    const distNote = document.getElementById('distanceNote');
    if (q.free) {
      transportEl.innerHTML = '<span class="badge badge-free">FREE</span>';
      distNote.textContent = q.distanceKm ? `(${q.distanceKm} km)` : '';
    } else {
      transportEl.innerHTML = `<span class="badge badge-fee">${money(q.transportFee)}</span>`;
      distNote.textContent = `(${q.distanceKm} km, ${q.extraKm} km out)`;
    }
    const isCustom = q.hasCustom && q.hasCustom.length;
    const sumTotalEl = document.getElementById('sumTotal');
    sumTotalEl.textContent = isCustom ? 'A custom quote is required' : money(q.total);
    sumTotalEl.classList.toggle('total-custom', !!isCustom);

    // Custom-priced sizes → total isn't settled; pay-now is locked off.
    const customNote = document.getElementById('customNote');
    const payNote = document.getElementById('payNote');
    const paySelect = document.getElementById('payNowChoice');
    if (isCustom) {
      customNote.textContent = 'You will receive a call soon to scope out the total cost of the service.';
      customNote.classList.remove('d-none');
      paySelect.value = 'later';
      paySelect.disabled = true;
      payNote.classList.add('d-none');
      // No settled total, so there is nothing to take a deposit on yet.
      renderDeposit(q);
      return;
    }
    customNote.classList.add('d-none');
    paySelect.disabled = false;

    // Every booking takes a commitment deposit, so there is always something
    // to pay now. The choice is only deposit-now vs everything-now.
    payNote.classList.add('d-none');
    renderDeposit(q);
  }

  // What the client actually has to pay before the slot is confirmed.
  function renderDeposit(q) {
    const row = document.getElementById('depositRow');
    const note = document.getElementById('depositNote');
    const paySelect = document.getElementById('payNowChoice');
    if (!q || (q.hasCustom && q.hasCustom.length)) {
      row.classList.add('d-none');
      note.classList.add('d-none');
      return;
    }
    const payFull = paySelect.value === 'now';
    const dueNow = payFull ? q.total : q.mandatoryAmount;
    document.getElementById('sumDueNow').textContent = money(dueNow);
    row.classList.remove('d-none');

    if (payFull) {
      note.textContent = 'You are paying the full amount online.';
    } else if (q.transportFee > 0) {
      note.textContent = `A ${q.commitmentDepositPct}% commitment deposit (${money(q.commitmentDeposit)}) plus the ${money(q.transportFee)} transport fee secures your slot. The balance is paid on-site.`;
    } else {
      note.textContent = `A ${q.commitmentDepositPct}% commitment deposit (${money(q.commitmentDeposit)}) secures your slot. The balance is paid on-site.`;
    }
    note.classList.remove('d-none');
  }

  // ---------------- Arrival window ----------------
  // The picker only renders what /api/availability returns; POST /booking
  // re-checks the chosen time, so nothing here decides feasibility.
  let picker = null;
  let lastAvailabilitySig = '';

  function el(id) { return document.getElementById(id); }

  function hasLocation() {
    return !!(el('lat').value && el('lng').value);
  }

  // Availability depends on the cart (job length) and the pin (drive time),
  // so any change to either invalidates an already-chosen window.
  function availabilitySignature() {
    return JSON.stringify(collectTanks()) + '|' + el('lat').value + '|' + el('lng').value;
  }

  function clearSlot() {
    el('startAt').value = '';
    el('bookingDate').value = '';
    el('chosenSlot').classList.add('d-none');
  }

  function humanDuration(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    const hp = h ? h + (h === 1 ? ' hour' : ' hours') : '';
    const mp = m ? m + ' mins' : '';
    return [hp, mp].filter(Boolean).join(' ');
  }

  function prettyDay(key) {
    const d = new Date(key + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
    });
  }

  function buildPicker() {
    return HallelSlotPicker.create({
      root: el('slotPicker'),
      promptText: 'Pick a date to see the times our crew can come.',
      load: function (from, to) {
        return fetch('/api/availability', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tanks: JSON.stringify(collectTanks()),
            lat: el('lat').value,
            lng: el('lng').value,
            from: from,
            to: to,
          }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.durationMin) {
              el('durationNote').textContent =
                'This job takes about ' + humanDuration(data.durationMin) +
                ', including the 2-hour disinfection hold. We hold the whole window for you.';
            }
            return data;
          });
      },
      onSelect: function (startAt, label, dateKey) {
        el('startAt').value = startAt;
        el('bookingDate').value = dateKey;
        const chosen = el('chosenSlot');
        chosen.textContent = 'Our crew will arrive on ' + prettyDay(dateKey) + ' between ' + label + '.';
        chosen.classList.remove('d-none');
      },
    });
  }

  function syncSchedule(q) {
    const wrap = el('slotPickerWrap');
    const prompt = el('schedulePrompt');
    const customWrap = el('customDateWrap');
    const isCustom = !!(q && q.hasCustom && q.hasCustom.length);

    // Custom-priced tanks cannot be estimated, so they ask for a day instead
    // of a window and we confirm the time by phone.
    if (isCustom) {
      wrap.classList.add('d-none');
      prompt.classList.add('d-none');
      customWrap.classList.remove('d-none');
      clearSlot();
      lastAvailabilitySig = '';
      return;
    }
    customWrap.classList.add('d-none');

    if (!hasLocation() || !q || !q.lines.length) {
      wrap.classList.add('d-none');
      prompt.classList.remove('d-none');
      clearSlot();
      lastAvailabilitySig = '';
      return;
    }

    prompt.classList.add('d-none');
    wrap.classList.remove('d-none');

    const sig = availabilitySignature();
    if (picker && sig === lastAvailabilitySig) return;
    lastAvailabilitySig = sig;
    clearSlot();
    if (!picker) picker = buildPicker();
    picker.reset();
    picker.refresh();
  }

  el('customDate').addEventListener('change', function () {
    el('bookingDate').value = el('customDate').value;
  });

  document.getElementById('payNowChoice').addEventListener('change', () => {
    if (lastQuote) renderDeposit(lastQuote);
  });

  // ---------------- Submit guard ----------------
  document.getElementById('bookingForm').addEventListener('submit', (e) => {
    const tanks = collectTanks();
    if (!tanks.length) { e.preventDefault(); alert('Please add at least one tank.'); return; }
    if (!document.getElementById('lat').value || !document.getElementById('lng').value) {
      e.preventDefault();
      alert('Please pick your service location on the map.');
      return;
    }
    const custom = !!(lastQuote && lastQuote.hasCustom && lastQuote.hasCustom.length);
    if (!custom && !document.getElementById('startAt').value) {
      e.preventDefault();
      alert('Please choose an arrival window.');
      return;
    }
    if (custom && !document.getElementById('bookingDate').value) {
      e.preventDefault();
      alert('Please pick a preferred service date.');
      return;
    }
    document.getElementById('tanksInput').value = JSON.stringify(tanks);
  });

  // Service-type info cards: lift on tap for touch devices (desktop uses :hover CSS).
  const serviceCards = [...document.querySelectorAll('.service-type-card')];
  serviceCards.forEach((card) => {
    card.addEventListener('click', () => {
      const wasLifted = card.classList.contains('lifted');
      serviceCards.forEach((c) => c.classList.remove('lifted'));
      if (!wasLifted) card.classList.add('lifted');
    });
  });

  // Start with one tank row.
  addRow();
})();
