/**
 * Shared arrival-window picker: a month calendar plus the windows for the chosen
 * day. Used by the booking form and by the client's manage/reschedule page, which
 * differ only in which endpoint supplies the windows.
 *
 * It renders whatever the server returns and never decides availability itself —
 * services/availability.js is the authority, exactly as pricing is.
 *
 * Usage:
 *   var picker = HallelSlotPicker.create({
 *     root: document.getElementById('slotPicker'),
 *     load: function (fromISO, toISO) { return fetch(...).then(r => r.json()); },
 *     onSelect: function (startAtISO, label, dateKey) { ... }
 *   });
 *   picker.refresh();   // re-fetch (cart or location changed)
 *   picker.reset();     // clear the selection and show the prompt
 */
(function () {
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // The engine works in UTC because Ghana is UTC+0, so all date keys are UTC.
  function utc(y, m, d) { return new Date(Date.UTC(y, m, d)); }
  function keyOf(date) { return date.toISOString().slice(0, 10); }
  function startOfMonth(date) { return utc(date.getUTCFullYear(), date.getUTCMonth(), 1); }
  function endOfMonth(date) { return utc(date.getUTCFullYear(), date.getUTCMonth() + 1, 0); }
  function today() { var n = new Date(); return utc(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); }
  // Monday-first column index.
  function col(date) { return (date.getUTCDay() + 6) % 7; }

  function longDate(key) {
    var d = new Date(key + 'T00:00:00Z');
    return DOW[col(d)] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }

  function create(opts) {
    var root = opts.root;
    var load = opts.load;
    var onSelect = opts.onSelect || function () {};
    var promptText = opts.promptText || 'Pick a date to see arrival times.';

    var cursor = startOfMonth(today());
    var days = {};        // dateKey -> [window]
    var selectedDay = null;
    var selectedStart = null;
    var loading = false;
    var loadedMonths = {};

    root.innerHTML =
      '<div class="slot-picker">' +
      '  <div class="slot-head">' +
      '    <button type="button" class="btn btn-sm btn-outline-secondary sp-prev" aria-label="Previous month">&#8249;</button>' +
      '    <span class="sp-month fw-semibold"></span>' +
      '    <button type="button" class="btn btn-sm btn-outline-secondary sp-next" aria-label="Next month">&#8250;</button>' +
      '  </div>' +
      '  <div class="slot-dow"></div>' +
      '  <div class="slot-grid"></div>' +
      '  <div class="slot-times"></div>' +
      '</div>';

    var elMonth = root.querySelector('.sp-month');
    var elDow = root.querySelector('.slot-dow');
    var elGrid = root.querySelector('.slot-grid');
    var elTimes = root.querySelector('.slot-times');

    elDow.innerHTML = DOW.map(function (d) { return '<span>' + d + '</span>'; }).join('');

    root.querySelector('.sp-prev').addEventListener('click', function () { step(-1); });
    root.querySelector('.sp-next').addEventListener('click', function () { step(1); });

    function step(delta) {
      var next = utc(cursor.getUTCFullYear(), cursor.getUTCMonth() + delta, 1);
      // Never page back before the current month — nothing there is bookable.
      if (delta < 0 && next < startOfMonth(today())) return;
      cursor = next;
      renderGrid();
      fetchMonth();
    }

    function monthRange() {
      var from = startOfMonth(cursor);
      var t = today();
      if (from < t) from = t;
      return { from: keyOf(from), to: keyOf(endOfMonth(cursor)) };
    }

    function fetchMonth(force) {
      var range = monthRange();
      var cacheKey = range.from + '_' + range.to;
      if (!force && loadedMonths[cacheKey]) return Promise.resolve();
      loading = true;
      renderGrid();
      return Promise.resolve(load(range.from, range.to))
        .then(function (data) {
          loading = false;
          if (!data || !data.days) { renderGrid(); return; }
          data.days.forEach(function (d) { days[d.date] = d.windows; });
          loadedMonths[cacheKey] = true;
          renderGrid();
          if (selectedDay) renderTimes();
        })
        .catch(function () {
          loading = false;
          renderGrid();
        });
    }

    function renderGrid() {
      elMonth.textContent = MONTHS[cursor.getUTCMonth()] + ' ' + cursor.getUTCFullYear();
      var first = startOfMonth(cursor);
      var last = endOfMonth(cursor);
      var cells = [];
      for (var i = 0; i < col(first); i++) cells.push('<span class="slot-day empty"></span>');

      for (var d = 1; d <= last.getUTCDate(); d++) {
        var date = utc(cursor.getUTCFullYear(), cursor.getUTCMonth(), d);
        var key = keyOf(date);
        var list = days[key];
        var open = list && list.length;
        var cls = 'slot-day';
        if (open) cls += ' open';
        else if (list) cls += ' closed';
        else cls += ' unknown';
        if (key === selectedDay) cls += ' selected';
        cells.push(
          '<button type="button" class="' + cls + '" data-day="' + key + '"' +
          (open ? '' : ' disabled') + '>' + d +
          (open ? '<i class="slot-dot"></i>' : '') + '</button>'
        );
      }
      elGrid.innerHTML = cells.join('');
      elGrid.classList.toggle('is-loading', loading);

      Array.prototype.forEach.call(elGrid.querySelectorAll('.slot-day.open'), function (btn) {
        btn.addEventListener('click', function () {
          selectedDay = btn.getAttribute('data-day');
          selectedStart = null;
          renderGrid();
          renderTimes();
        });
      });

      if (!selectedDay) {
        elTimes.innerHTML = '<p class="text-muted small mb-0">' +
          (loading ? 'Checking our schedule&hellip;' : promptText) + '</p>';
      }
    }

    function renderTimes() {
      var list = days[selectedDay] || [];
      if (!list.length) {
        elTimes.innerHTML = '<p class="text-muted small mb-0">No arrival times left on that day.</p>';
        return;
      }
      var html = '<div class="slot-times-head">Arrival window on ' + longDate(selectedDay) + '</div>' +
        '<div class="slot-chips">' +
        list.map(function (w) {
          var active = w.startAt === selectedStart ? ' active' : '';
          return '<button type="button" class="slot-chip' + active + '" data-start="' + w.startAt + '">' +
            w.label + '</button>';
        }).join('') +
        '</div>';
      elTimes.innerHTML = html;

      Array.prototype.forEach.call(elTimes.querySelectorAll('.slot-chip'), function (btn) {
        btn.addEventListener('click', function () {
          selectedStart = btn.getAttribute('data-start');
          renderTimes();
          var w = list.filter(function (x) { return x.startAt === selectedStart; })[0];
          onSelect(selectedStart, w ? w.label : '', selectedDay);
        });
      });
    }

    function reset() {
      selectedDay = null;
      selectedStart = null;
      renderGrid();
    }

    renderGrid();

    return {
      refresh: function () {
        loadedMonths = {};
        days = {};
        return fetchMonth(true);
      },
      reset: reset,
      getSelected: function () { return selectedStart; },
    };
  }

  window.HallelSlotPicker = { create: create };
})();
