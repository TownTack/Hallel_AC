/**
 * Admin Calendar tab.
 *
 * A second view of the same bookings the card grid shows. It renders what
 * /admin/calendar/events returns and writes only through
 * PATCH /admin/bookings/:id/schedule, which re-validates every move against
 * services/availability.js — so a drag can be rejected and snapped back.
 *
 * Clicking an event reuses the existing detail modal from admin.js rather than
 * building a second detail UI, so every action there works from here too.
 *
 * Times are UTC throughout: Ghana is UTC+0 and the scheduler stores UTC, so the
 * calendar is pinned to UTC to avoid a browser in another timezone shifting jobs.
 */
(function () {
  var host = document.getElementById('adminCalendar');
  if (!host || typeof FullCalendar === 'undefined') return;

  var cfgEl = document.getElementById('calendarConfig');
  var cfg = cfgEl ? JSON.parse(cfgEl.textContent) : {};
  var workingDays = cfg.workingDays || [1, 2, 3, 4, 5, 6];
  var stepMin = cfg.slotStepMin || 15;
  var calendar = null;
  var booted = false;

  function stepDuration(min) {
    var h = Math.floor(min / 60);
    var m = min % 60;
    return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2) + ':00';
  }

  function toast(message, ok) {
    var box = document.getElementById('calFlash');
    if (!box) {
      box = document.createElement('div');
      box.id = 'calFlash';
      box.className = 'cal-flash';
      host.parentNode.insertBefore(box, host);
    }
    box.textContent = message;
    box.className = 'cal-flash ' + (ok ? 'ok' : 'err');
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.className = 'cal-flash'; box.textContent = ''; }, 6000);
  }

  // The one write path. The server owns feasibility; a rejection reverts the drag.
  function persistMove(id, startAt) {
    return fetch('/admin/bookings/' + id + '/schedule', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startAt: startAt }),
    }).then(function (r) {
      return r.json().then(function (data) { return { status: r.status, data: data }; });
    });
  }

  function onDrop(info) {
    var startAt = info.event.start.toISOString();
    persistMove(info.event.id, startAt)
      .then(function (res) {
        if (res.data && res.data.ok) {
          toast('Moved ' + (info.event.extendedProps.reference || '') + '. The client has been texted.', true);
          calendar.refetchEvents();
        } else {
          info.revert();
          toast((res.data && res.data.error) || 'That move was rejected.', false);
        }
      })
      .catch(function () {
        info.revert();
        toast('Could not reach the server.', false);
      });
  }

  function build() {
    calendar = new FullCalendar.Calendar(host, {
      initialView: 'timeGridWeek',
      timeZone: 'UTC',
      headerToolbar: {
        left: 'prev,next today',
        center: 'title',
        right: 'timeGridDay,timeGridWeek,dayGridMonth',
      },
      height: 'auto',
      firstDay: 1,
      nowIndicator: true,
      slotDuration: stepDuration(stepMin),
      snapDuration: stepDuration(stepMin),
      slotMinTime: cfg.workDayStart ? cfg.workDayStart + ':00' : '07:00:00',
      slotMaxTime: cfg.workDayEnd ? cfg.workDayEnd + ':00' : '17:00:00',
      businessHours: {
        daysOfWeek: workingDays,
        startTime: cfg.workDayStart || '07:00',
        endTime: cfg.workDayEnd || '17:00',
      },
      expandRows: true,
      editable: true,
      eventDurationEditable: false, // length comes from the cart, not from a drag
      eventStartEditable: true,
      droppable: true,
      events: '/admin/calendar/events',
      eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },

      eventClick: function (info) {
        if (info.event.display === 'background') return;
        // Reuse the card grid's detail modal (admin.js).
        if (typeof window.openBookingDetail === 'function') {
          window.openBookingDetail(info.event.id);
        }
      },

      eventDrop: onDrop,

      eventDidMount: function (info) {
        if (info.event.display === 'background') return;
        var p = info.event.extendedProps;
        var bits = [
          p.clientName,
          p.whatsapp,
          p.address,
          p.distanceKm != null ? p.distanceKm.toFixed(1) + ' km from base' : null,
          p.durationMin ? 'about ' + (p.durationMin / 60).toFixed(1) + ' h on site' : null,
          p.customPending ? 'CUSTOM QUOTE — not priced yet' : 'GHS ' + (p.total || 0).toFixed(2),
          'payment: ' + p.paymentStatus,
        ].filter(Boolean);
        info.el.title = bits.join('\n');
      },

      // External drop from the "Needs scheduling" strip.
      drop: function (info) {
        var id = info.draggedEl.getAttribute('data-id');
        if (!id) return;
        persistMove(id, info.date.toISOString()).then(function (res) {
          if (res.data && res.data.ok) {
            info.draggedEl.parentNode.removeChild(info.draggedEl);
            toast('Scheduled. The client has been texted.', true);
            calendar.refetchEvents();
          } else {
            toast((res.data && res.data.error) || 'That slot was rejected.', false);
          }
        });
      },
    });

    calendar.render();

    var strip = document.getElementById('unscheduledList');
    if (strip && FullCalendar.Draggable) {
      new FullCalendar.Draggable(strip, {
        itemSelector: '.unscheduled-item',
        eventData: function (el) {
          return { title: el.textContent.trim().split('\n')[0], duration: '03:00' };
        },
      });
    }
  }

  // A change made in the detail modal (payment, completion, cancellation) must
  // show up on the calendar without a page reload.
  document.addEventListener("hallel:booking-changed", function () {
    if (calendar) calendar.refetchEvents();
  });

  // Only build once the tab is actually shown: an unrendered FullCalendar in a
  // hidden pane measures zero height, and the card grid should paint first.
  var tab = document.getElementById('tab-calendar');
  if (tab) {
    tab.addEventListener('shown.bs.tab', function () {
      if (!booted) { booted = true; build(); }
      else { calendar.updateSize(); calendar.refetchEvents(); }
    });
  }
})();
