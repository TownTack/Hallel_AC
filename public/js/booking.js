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
    row.className = 'tank-row p-2 d-flex gap-2 align-items-center';
    row.innerHTML = `
      <select class="form-select form-select-sm tank-size">${optionsHtml()}</select>
      <input type="number" class="form-control form-control-sm tank-qty" style="max-width:90px" min="1" value="1" />
      <button type="button" class="btn btn-sm btn-outline-danger remove-tank">&times;</button>`;
    rowsEl.appendChild(row);
    row.querySelector('.tank-size').addEventListener('change', refreshQuote);
    row.querySelector('.tank-qty').addEventListener('input', refreshQuote);
    row.querySelector('.remove-tank').addEventListener('click', () => { row.remove(); refreshQuote(); });
    refreshQuote();
  }
  document.getElementById('addTank').addEventListener('click', addRow);

  function collectTanks() {
    return [...rowsEl.querySelectorAll('.tank-row')].map((r) => ({
      sizeKey: r.querySelector('.tank-size').value,
      quantity: Math.max(1, parseInt(r.querySelector('.tank-qty').value, 10) || 1),
    }));
  }

  // ---------------- Live quote ----------------
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
      tanks: JSON.stringify(tanks),
      serviceTier: document.querySelector('input[name="serviceTier"]:checked').value,
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
      renderQuote(quote);
    } catch (_) { /* leave last render */ }
  }

  function renderQuote(q) {
    document.getElementById('summaryLines').innerHTML = q.lines
      .map((l) => `<div class="d-flex justify-content-between"><span>${l.quantity}× ${l.label}</span><span>${money(l.lineTotal)}</span></div>`)
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
      return;
    }
    customNote.classList.add('d-none');
    paySelect.disabled = false;

    // Pay-now rule: outside radius forces the transport fee as a commitment.
    if (q.payNowRequired) {
      paySelect.value = 'now';
      payNote.textContent = `You're outside our free radius — the transport fee of ${money(q.transportFee)} is required now as a commitment. The rest is paid on-site.`;
      payNote.classList.remove('d-none');
    } else {
      payNote.classList.add('d-none');
    }
  }

  // ---------------- Submit guard ----------------
  document.getElementById('bookingForm').addEventListener('submit', (e) => {
    const tanks = collectTanks();
    if (!tanks.length) { e.preventDefault(); alert('Please add at least one tank.'); return; }
    if (!document.getElementById('lat').value || !document.getElementById('lng').value) {
      e.preventDefault();
      alert('Please pick your service location on the map.');
      return;
    }
    document.getElementById('tanksInput').value = JSON.stringify(tanks);
  });

  // Re-quote when tier changes.
  document.querySelectorAll('input[name="serviceTier"]').forEach((r) => r.addEventListener('change', refreshQuote));

  // Start with one tank row.
  addRow();
})();
