    // ---- Google Calendar: a meeting was booked from the dashboard ----
    // Paste this block inside doPost, just below the "if (d.secret !== SECRET) ..." line.
    if (d.type === "meeting") {
      const cal = CalendarApp.getDefaultCalendar();
      const start = new Date(d.start), end = new Date(d.end);
      let ev = null;
      if (d.event_id) { try { ev = cal.getEventById(d.event_id); } catch (e) { ev = null; } }
      if (ev) {
        ev.setTime(start, end);           // meeting moved: update the existing event
        ev.setTitle(d.title || "DigitalRyze call");
        ev.setDescription(d.description || "");
      } else {
        const opts = { description: d.description || "" };
        if (d.guest) { opts.guests = d.guest; opts.sendInvites = true; }   // email an invite to the lead
        ev = cal.createEvent(d.title || "DigitalRyze call", start, end, opts);
      }
      ev.addPopupReminder(15);
      return out(JSON.stringify({ ok: true, id: ev.getId() }));
    }
